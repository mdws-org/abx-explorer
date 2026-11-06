'use strict';

/* Everything on this page that came from a chain was written by strangers. Rules:
   text goes through esc(); URLs go through safeHref()/imageSrc()/liveSrc(); records are
   shape-checked once in validContract() before anything renders them. */

const SHARED = [
    ['OneOfOneImageFactory', '0x2ff8828a9150401225bB217CAA8b9b5e666a1c97'],
    ['SeriesImageFactory', '0x83222f791cA243FEb0c1Fef93a8732eCe3001b4b'],
    ['SeriesCodeFactory', '0xEAB8a19fEada0DDba2FDE324715eBbB6234B5616'],
    ['OneOfOneEditionFactory', '0x4e9dFcC70dCC02FA5bad113Bc2CF0A2218358B1E'],
    ['EditionImageFactory', '0xCC29eD68f26693dc9Aa5f090B21F37985206cc19'],
    ['EditionCodeFactory', '0x86f9CFe597ab145452f4A66ac102291d54e8EB46'],
    ['AbxMetadataRenderer', '0xBfa4181cd005b2CA64f8F124456c9fb6111a3A27'],
    ['AbxChunkStore', '0x1Ca63a4ADEeF5e722ADA25b892BA40E3b2bcB905'],
    ['AbxSeedSource', '0xD01d4eDc17F8b4493A43A5e70DCD9813FB1b9A0A'],
    ['AbxFixedPriceMinter', '0xfb5C61274a3A7dA83CcDD88DdEC914438244E2c9'],
    ['AbxFixedPriceMinter1155', '0x2af9f0c477c34a23cBeC646a3b6BC0cA4Df5d37f'],
];
const EXPLORER = { 1: 'https://etherscan.io', 8453: 'https://basescan.org', 42161: 'https://arbiscan.io', 4663: null };
const OPENSEA = { 1: 'ethereum', 8453: 'base', 42161: 'arbitrum' };
const OCC_CHAIN = { 1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 4663: 'robinhood' };
const FOC_CHAIN = { 1: 'ethereum', 8453: 'base' };
const RPC = {
    1: 'https://ethereum-rpc.publicnode.com',
    8453: 'https://mainnet.base.org',
    42161: 'https://arb1.arbitrum.io/rpc',
    4663: 'https://rpc.mainnet.chain.robinhood.com',
};
const LOG_FIRST = 6;
const MINT_PAGE = 12;
const MAX_LISTED_TOKENS = 2000;   // newest N tokens of a collection are browsable here
const MAX_URI_BYTES = 2_000_000;  // larger on-chain metadata is skipped, not decoded
const FETCH_MS = 8000;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const isHash = (h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const day = (ts) => (Number.isFinite(ts) ? new Date(ts * 1000).toISOString().slice(0, 10) : '');
const fmtDate = (iso) => {
    const d = new Date(`${iso}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

/* Only http(s) links are ever rendered as links. */
function safeHref(u) {
    try {
        const url = new URL(u, location.href);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
        return null;
    }
}

const state = { all: [], q: '', chain: 'all', kind: 'all', status: 'all', sort: 'timestamp', dir: -1, wallet: null };
const PAGE = { rows: 20, grid: 20, ours: 12 };
const shown = { ...PAGE };

function resetPages() {
    shown.rows = PAGE.rows;
    shown.grid = PAGE.grid;
}

/* Show the first `shown[key]` children of `el`; a More button reveals the next page. */
function paginate(key, el, btn) {
    const kids = [...el.children];
    kids.forEach((k, i) => (k.hidden = i >= shown[key]));
    btn.hidden = kids.length <= shown[key];
    btn.textContent = `More · ${kids.length - shown[key]} left`;
    btn.onclick = () => { shown[key] += PAGE[key]; paginate(key, el, btn); };
}

/* ── data validation ─────────────────────────────────────────────────────── */

function validContract(c) {
    return c && Number.isInteger(c.chainId) && c.chainId in RPC && isAddr(c.address) && isAddr(c.owner)
        && Number.isFinite(c.timestamp) && Number.isInteger(c.block) && isHash(c.tx)
        && typeof c.kind === 'string' && typeof c.chain === 'string';
}

function validMint(m) {
    return m && Number.isInteger(m.chainId) && isAddr(m.address) && Number.isInteger(m.tokenId)
        && m.tokenId >= 0 && isHash(m.tx);
}

/* ABX's own rehearsal, canary and acceptance contracts: listed in the directory, kept out of the gallery and the news. */
const TEST_NAME = /^(Rehearsal \d{4}-\d{2}-\d{2}|ABX .*(Canary|Acceptance|QA( \d{4}-\d{2}-\d{2})?))$/;
const isTest = (c) => TEST_NAME.test(c.name || '');

/* ── names and mint terms ────────────────────────────────────────────────── */

function who(chainId, addr, name) {
    if (!isAddr(addr)) return '';
    const base = EXPLORER[chainId];
    const label = name ? esc(name) : `<span class="mono">${short(addr)}</span>`;
    return base ? `<a href="${base}/address/${addr}" title="${addr}">${label}</a>` : label;
}

function ethAmount(wei) {
    let w;
    try { w = BigInt(wei); } catch { return ''; }
    if (w === 0n) return 'Free';
    const whole = w / 10n ** 18n;
    const frac = (w % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
    return `${whole}${frac ? `.${frac}` : ''} ETH`;
}

function mintLabel(c) {
    const s = c.sale || {};
    const sale = (s.sales || []).find((x) => x.sold < x.allocation) || (s.sales || [])[0];
    const price = sale ? (sale.paymentToken === '0x0000000000000000000000000000000000000000' ? ethAmount(sale.price) : 'ERC-20 price') : '';
    switch (s.state) {
        case 'open': return price ? `Open · ${price}` : 'Open';
        case 'sold out': return 'Sold out';
        case 'paused': return 'Paused';
        case 'no sale set': return 'Not for sale';
        case 'owner only': return 'Owner mints only';
        case 'custom minter': return 'Own minter';
        default: return '';
    }
}

function minterLine(c) {
    const s = c.sale || {};
    const m = s.minterInfo;
    if (!isAddr(s.minter) || /^0x0+$/.test(s.minter)) return 'None (owner mints)';
    if (!m) return `ABX shared fixed-price minter (${who(c.chainId, s.minter)})`;
    if (!m.isContract) return `Wallet ${who(c.chainId, m.address, m.ens)}`;
    const owner = isAddr(m.owner) ? ` · owned by ${who(c.chainId, m.owner, m.ownerEns)}` : '';
    return `${who(c.chainId, m.address, m.contractName || m.ens)}${owner}`;
}

/* ── news ────────────────────────────────────────────────────────────────── */

function renderNewCollections(contracts) {
    const rows = contracts.filter((c) => !isTest(c)).sort((a, b) => b.timestamp - a.timestamp);
    $('#newcols').innerHTML = rows.map((c, i) => `
        <li${i >= LOG_FIRST * 2 ? ' hidden' : ''}>
            <time datetime="${day(c.timestamp)}">${fmtDate(day(c.timestamp))}</time>
            <div>
                <h3><a href="#c-${c.chainId}-${c.address}" data-k="${c.chainId}:${c.address}">${esc(c.name || short(c.address))}</a></h3>
                <p>${esc(c.kind)} on ${esc(c.chain)}${c.ownerName ? ` by ${esc(c.ownerName)}` : ''}${c.sale && c.sale.state === 'open' ? ` &middot; <span class="open">${esc(mintLabel(c))}</span>` : ''}</p>
            </div>
        </li>`).join('');
    const more = $('#newcols-more');
    more.onclick = () => {
        document.querySelectorAll('#newcols li[hidden]').forEach((li) => (li.hidden = false));
        more.hidden = true;
        state.newcolsOpen = true;
    };
}

/* Side by side, show only as many new collections as fit beside the news column. */
function balanceNews() {
    if (state.newcolsOpen) return;
    const items = [...document.querySelectorAll('#newcols li')];
    const more = $('#newcols-more');
    const [left, right] = [...document.querySelectorAll('.news-cols > div')];
    const sideBySide = right && left && right.getBoundingClientRect().left > left.getBoundingClientRect().left;
    if (!sideBySide) {
        items.forEach((li, i) => (li.hidden = i >= LOG_FIRST * 2));
        more.hidden = items.length <= LOG_FIRST * 2;
        return;
    }
    const target = $('#log').getBoundingClientRect().bottom;
    items.forEach((li) => (li.hidden = false));
    let fit = items.length;
    for (let i = 0; i < items.length; i++) {
        if (items[i].getBoundingClientRect().bottom > target + 1) { fit = i; break; }
    }
    items.forEach((li, i) => (li.hidden = i >= Math.max(fit, 1)));
    more.hidden = fit >= items.length;
}

function sourceLinks(sources) {
    return (sources || []).map(([label, url]) => {
        const href = safeHref(url);
        return href ? `<a href="${esc(href)}" rel="noopener noreferrer">${esc(label)}</a>` : esc(label);
    }).join(' &middot; ');
}

function renderLog(news, contracts) {
    renderNewCollections(contracts);
    const items = news.filter((n) => fmtDate(n.date)).sort((a, b) => b.date.localeCompare(a.date));
    $('#log').innerHTML = items.map((n, i) => `
        <li${i >= LOG_FIRST ? ' hidden' : ''}>
            <time datetime="${esc(n.date)}">${fmtDate(n.date)}</time>
            <div>
                <h3>${esc(n.title)}</h3>
                <p>${esc(n.body)}</p>
                <div class="src">${sourceLinks(n.sources)}</div>
            </div>
        </li>`).join('');
    const more = $('#log-more');
    more.hidden = items.length <= LOG_FIRST;
    more.onclick = () => {
        document.querySelectorAll('#log li[hidden]').forEach((li) => (li.hidden = false));
        more.hidden = true;
        balanceNews();
    };
    let pending = 0;
    const rebalance = () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(balanceNews); };
    balanceNews();
    if (document.fonts) document.fonts.ready.then(rebalance);
    window.addEventListener('resize', rebalance);
}

/* ── directory and gallery ───────────────────────────────────────────────── */

function compare(a, b) {
    const x = a[state.sort], y = b[state.sort];
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * state.dir;
    return String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true, sensitivity: 'base' }) * state.dir;
}

function filtered() {
    const q = state.q.trim().toLowerCase();
    return state.all
        .filter((c) => state.chain === 'all' || String(c.chainId) === state.chain)
        .filter((c) => state.kind === 'all' || c.kind === state.kind)
        .filter((c) => state.status === 'all' || (c.sale && c.sale.state === 'open'))
        .filter((c) => !q || [c.name, c.symbol, c.address, c.owner, c.ownerName]
            .some((v) => String(v || '').toLowerCase().includes(q)))
        .sort(compare);
}

function chips(el, key, values) {
    el.innerHTML = values.map(([v, label, n]) =>
        `<button class="chip${state[key] === v ? ' on' : ''}" aria-pressed="${state[key] === v}" data-v="${esc(v)}">${esc(label)}<span class="c">${n}</span></button>`).join('');
    el.onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        state[key] = b.dataset.v;
        resetPages();
        renderFilters();
        renderData();
    };
}

function renderFilters() {
    const count = (f) => state.all.filter(f).length;
    const chains = [...new Map(state.all.map((c) => [String(c.chainId), c.chain])).entries()];
    chips($('#chains'), 'chain', [['all', 'All chains', state.all.length],
        ...chains.map(([id, name]) => [id, name, count((c) => String(c.chainId) === id)])]);
    const kinds = [...new Set(state.all.map((c) => c.kind))].sort();
    chips($('#kinds'), 'kind', [['all', 'All kinds', state.all.length],
        ...kinds.map((k) => [k, k, count((c) => c.kind === k)])]);
    chips($('#status'), 'status', [['all', 'Any status', state.all.length],
        ['open', 'Open now', count((c) => c.sale && c.sale.state === 'open')]]);
}

/* Show a symbol only when it says something the name does not. */
function distinctSymbol(c) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const sym = norm(c.symbol), name = norm(c.name);
    return sym && !name.includes(sym) ? c.symbol : '';
}

function renderData() {
    const rows = filtered();
    const active = state.q.trim() || state.chain !== 'all' || state.kind !== 'all' || state.status !== 'all';
    const note = (n, total) => (active
        ? `${n} of ${total} &middot; <button class="clear" type="button">Clear filters</button>` : '');
    $('#dir-count').innerHTML = note(rows.length, state.all.length);
    const inGallery = (c) => imageSrc(c.image) && !isTest(c);
    $('#gal-count').innerHTML = note(rows.filter(inGallery).length, state.all.filter(inGallery).length);
    $('#rows').innerHTML = rows.length ? rows.map((c) => `
        <tr id="c-${c.chainId}-${c.address}">
            <td class="name"><a href="#c-${c.chainId}-${c.address}" data-k="${c.chainId}:${c.address}">${esc(c.name || 'Unnamed')}</a>${distinctSymbol(c) ? `<span class="sym">${esc(c.symbol)}</span>` : ''}</td>
            <td class="kind">${esc(c.kind)}</td>
            <td>${esc(c.chain)}</td>
            <td>${who(c.chainId, c.address)}</td>
            <td class="owner">${who(c.chainId, c.owner, c.ownerName)}</td>
            <td class="mintcol${c.sale && c.sale.state === 'open' ? ' open' : ''}">${esc(mintLabel(c))}</td>
            <td class="r">${day(c.timestamp)}</td>
        </tr>`).join('') : '<tr><td colspan="7" class="empty">No collections match.</td></tr>';
    const withImg = rows.filter(inGallery);
    const missing = rows.filter((c) => !imageSrc(c.image) && !isTest(c)).length;
    $('#grid').innerHTML = withImg.map((c) => `
        <button class="card" type="button" data-k="${c.chainId}:${c.address}">
            <div class="img"><img src="${esc(imageSrc(c.image))}" alt="" loading="lazy" /></div>
            <div class="n">${esc(c.name || 'Unnamed')}</div>
            ${c.sale && c.sale.state === 'open' ? `<div class="y open">${esc(mintLabel(c))}</div>` : ''}
        </button>`).join('');
    $('#gal-note').textContent = missing ? `${missing} more without an onchain image are in the directory.` : '';
    paginate('rows', $('#rows'), $('#rows-more'));
    paginate('grid', $('#grid'), $('#grid-more'));
}

/* ── reading tokens from the chain ───────────────────────────────────────── */

async function getJson(url, init = {}) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_MS), credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

async function ethCall(chainId, to, data) {
    const j = await getJson(RPC[chainId], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    });
    if (j.error || typeof j.result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(j.result) || j.result === '0x') {
        throw new Error('call failed');
    }
    return j.result;
}

/* Decode an ABI-encoded `string` return value, refusing out-of-range offsets. */
function abiString(hex) {
    const h = hex.slice(2);
    if (h.length < 128) throw new Error('short return');
    const off = parseInt(h.slice(0, 64), 16) * 2;
    if (!Number.isSafeInteger(off) || off + 64 > h.length) throw new Error('bad offset');
    const len = parseInt(h.slice(off, off + 64), 16) * 2;
    if (!Number.isSafeInteger(len) || len > MAX_URI_BYTES * 2 || off + 64 + len > h.length) throw new Error('bad length');
    const body = h.slice(off + 64, off + 64 + len);
    const bytes = new Uint8Array(len / 2);
    for (let i = 0; i < len; i += 2) bytes[i / 2] = parseInt(body.slice(i, i + 2), 16);
    return new TextDecoder().decode(bytes);
}

function dataPayload(uri) {
    const comma = uri.indexOf(',');
    if (comma < 0) throw new Error('bad data uri');
    const head = uri.slice(0, comma), body = uri.slice(comma + 1);
    if (head.includes(';base64')) {
        return new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\s/g, '')), (ch) => ch.charCodeAt(0)));
    }
    try { return decodeURIComponent(body); } catch { return body; }
}

const ipfs = (u) => `https://ipfs.io/ipfs/${u.slice(7)}`;

async function tokenMeta(uri) {
    if (uri.length > MAX_URI_BYTES) throw new Error('metadata too large');
    let meta;
    if (uri.startsWith('data:')) meta = JSON.parse(dataPayload(uri));
    else if (uri.startsWith('https://')) meta = await getJson(uri);
    else if (uri.startsWith('ipfs://')) meta = await getJson(ipfs(uri));
    else throw new Error('unsupported uri');
    if (!meta || typeof meta !== 'object') throw new Error('metadata is not an object');
    return meta;
}

/* Images: https, ipfs (via gateway) and data:image/* only. */
function imageSrc(src) {
    if (typeof src !== 'string' || src.length > MAX_URI_BYTES) return null;
    if (src.startsWith('ipfs://')) return ipfs(src);
    if (src.startsWith('img/') && /^img\/[\w.-]+$/.test(src)) return src;
    if (src.startsWith('data:image/svg+xml') && !src.includes(';base64')) {
        try { return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(dataPayload(src))}`; } catch { return null; }
    }
    if (/^data:image\/(png|gif|jpeg|webp|svg\+xml)[;,]/.test(src) || src.startsWith('https://')) return src;
    return null;
}

/* Live views: https, ipfs (via gateway) and data:text/html only; always in an opaque-origin sandbox. */
function liveSrc(src) {
    if (typeof src !== 'string' || src.length > MAX_URI_BYTES) return null;
    if (src.startsWith('ipfs://')) return ipfs(src);
    if (src.startsWith('https://') || src.startsWith('data:text/html')) return src;
    return null;
}

const isEdition = (c) => c.kind.startsWith('Edition') || c.kind === '1/1 edition';
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

async function loadToken(c, id, holder) {
    const w = word(id);
    let uri = abiString(await ethCall(c.chainId, c.address, (isEdition(c) ? '0x0e89341c' : '0xc87b56dd') + w));
    if (isEdition(c)) uri = uri.replace('{id}', w);   // ERC-1155 id substitution
    const meta = await tokenMeta(uri);
    let owner = null, held = null;
    if (!isEdition(c)) {
        try { owner = `0x${(await ethCall(c.chainId, c.address, `0x6352211e${w}`)).slice(-40)}`; } catch { /* burned */ }
        held = holder ? owner && owner.toLowerCase() === holder : null;
    } else if (holder) {
        held = BigInt(await ethCall(c.chainId, c.address, `0x00fdd58e${holder.slice(2).padStart(64, '0')}${w}`)) > 0n;
    }
    return { id, meta, owner, held };
}

function art(t) {
    const img = imageSrc(t.meta.image);
    if (img) return `<img src="${esc(img)}" alt="" loading="lazy" />`;
    const live = liveSrc(t.meta.animation_url);
    if (!live) return '';
    let host = 'on-chain HTML';
    try { if (!live.startsWith('data:')) host = new URL(live).host; } catch { /* keep default */ }
    return `<button class="live" type="button" data-live="${esc(live)}" title="Run third-party code from ${esc(host)}">
        Live view<span>${esc(host)}</span></button>`;
}

/* find3r's own artwork-page link format (its "Copy artwork link"); find3r reads Ethereum, Base and Arbitrum. */
const FIND3R_CHAINS = new Set([1, 8453, 42161]);
const find3rToken = (c, id) => (FIND3R_CHAINS.has(c.chainId)
    ? `https://find3r.app/artwork.html?chain=${c.chainId}&contract=${c.address}&token=${encodeURIComponent(id)}&adapter=auto`
    : null);

/* A token caption: a find3r link where find3r can show it, plain text elsewhere. */
function tokenCaption(c, id, inner) {
    const link = find3rToken(c, id);
    return link ? `<a class="n" href="${link}" target="_blank" rel="noopener noreferrer">${inner}</a>` : `<span class="n">${inner}</span>`;
}

function tokenTile(c, t) {
    return `<div class="mint">
        <div class="img">${art(t)}</div>
        ${tokenCaption(c, t.id, `#${esc(t.id)}${isAddr(t.owner) ? ` · <span class="mono">${short(t.owner)}</span>` : ''}`)}
    </div>`;
}

async function loadMints(c, cursor, grid, more, note) {
    more.hidden = true;
    const batch = cursor.next(MINT_PAGE);
    const results = await Promise.allSettled(batch.map((id) => loadToken(c, id)));
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => tokenTile(c, r.value));
    grid.insertAdjacentHTML('beforeend', ok.join(''));
    const failed = results.length - ok.length;
    note.textContent = failed ? `${failed} of ${results.length} tokens in that batch could not be read.` : '';
    if (!grid.children.length && !cursor.left()) note.textContent = 'No tokens could be read from the chain.';
    more.hidden = !cursor.left();
}

/* Token ids to browse, newest first, produced lazily so a huge collection costs nothing up front. */
function mintCursor(c) {
    const s = c.sale || {};
    let ids;
    if (isEdition(c)) {
        ids = (s.sales || []).map((x) => x.id).filter(Number.isInteger);
        let i = 0;
        return { next: (n) => ids.slice(i, (i += n)), left: () => i < ids.length, first: () => ids[0] };
    }
    const n = Math.min(Number.isSafeInteger(s.minted) ? s.minted : 0, MAX_LISTED_TOKENS);
    let top = (Number.isSafeInteger(s.minted) ? s.minted : 0) - 1;
    const stop = top - n;
    return {
        next: (k) => { const out = []; while (out.length < k && top > stop) out.push(top--); return out; },
        left: () => top > stop,
        first: () => (n > 0 ? 0 : undefined),
    };
}

/* ── detail dialog ───────────────────────────────────────────────────────── */

function detailLinks(c) {
    const ex = EXPLORER[c.chainId];
    const sample = mintCursor(c).first();
    const has = sample !== undefined;
    return [
        FIND3R_CHAINS.has(c.chainId) && ['find3r', `https://find3r.app/#address=${c.address}&chain=${c.chainId}`],
        ['ABX inspector', `https://resolver.abx.io/introspect/${c.chainId}/${c.address}`],
        has && OCC_CHAIN[c.chainId] && ['OnChainChecker', `https://onchainchecker.xyz/collection/${OCC_CHAIN[c.chainId]}/${c.address}/${sample}`],
        has && FOC_CHAIN[c.chainId] && ['Fully On Chain', `https://www.fullyonchain.art/scan/${FOC_CHAIN[c.chainId]}/${c.address}/${sample}`],
        ex && ['Explorer', `${ex}/address/${c.address}`],
        OPENSEA[c.chainId] && ['OpenSea', `https://opensea.io/assets/${OPENSEA[c.chainId]}/${c.address}`],
        ex && ['Deploy tx', `${ex}/tx/${c.tx}`],
    ].filter(Boolean);
}

function supplyNote(c) {
    const s = c.sale || {};
    if (Number.isSafeInteger(s.cap) && s.cap > 0) return ` &middot; ${esc(s.minted)} of ${esc(s.cap)} minted`;
    if (Number.isSafeInteger(s.minted)) return ` &middot; ${esc(s.minted)} minted`;
    return '';
}

function openDetail(key, opener) {
    const c = state.all.find((x) => `${x.chainId}:${x.address}` === key);
    if (!c) return;
    const dlg = $('#dlg');
    const img = imageSrc(c.image);
    dlg.innerHTML = `
        <button class="close" aria-label="Close">&times;</button>
        <div class="big">${img ? `<img src="${esc(img)}" alt="" />` : '<span class="ph">No preview</span>'}</div>
        <h3 id="dlg-title">${esc(c.name || 'Unnamed')} <span class="sym">${esc(c.symbol || '')}</span></h3>
        <dl>
            <dt>Kind</dt><dd>${esc(c.kind)}</dd>
            <dt>Chain</dt><dd>${esc(c.chain)}</dd>
            <dt>Contract</dt><dd class="mono">${esc(c.address)}</dd>
            <dt>Deployer</dt><dd>${who(c.chainId, c.owner, c.ownerName)}</dd>
            <dt>Deployed</dt><dd>${day(c.timestamp)} &middot; block ${esc(c.block)}</dd>
            <dt>Mint</dt><dd>${esc(mintLabel(c))}${supplyNote(c)}</dd>
            <dt>Minter</dt><dd>${minterLine(c)}</dd>
        </dl>
        <div class="links">${detailLinks(c).map(([l, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(l)}</a>`).join('')}</div>
        <h4 class="mints-h">Mints</h4>
        <div class="mints" id="mints" aria-live="polite"></div>
        <p class="disclose" id="mints-note" role="status"></p>
        <button class="more" id="mints-more" type="button" hidden>More</button>`;
    dlg.setAttribute('aria-labelledby', 'dlg-title');
    dlg.querySelector('.close').onclick = () => dlg.close();
    dlg.onclose = () => { if (opener && opener.focus) opener.focus(); };
    dlg.showModal();
    const cursor = mintCursor(c);
    const grid = dlg.querySelector('#mints'), more = dlg.querySelector('#mints-more'), note = dlg.querySelector('#mints-note');
    if (!cursor.left()) {
        note.textContent = 'Nothing minted yet.';
        return;
    }
    more.onclick = () => loadMints(c, cursor, grid, more, note);
    loadMints(c, cursor, grid, more, note);
}

/* A live view runs only after a click, inside an opaque-origin sandbox with no referrer. */
function startLive(btn) {
    const src = liveSrc(btn.dataset.live);
    if (!src) return;
    const f = document.createElement('iframe');
    f.src = src;
    f.setAttribute('sandbox', 'allow-scripts');   // never add allow-same-origin
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('allow', '');
    f.title = 'Third-party live artwork';
    btn.replaceWith(f);
}

function wire() {
    $('#q').addEventListener('input', (e) => {
        state.q = e.target.value;
        resetPages();
        renderData();
    });
    document.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
        const k = b.dataset.sort;
        state.dir = state.sort === k ? -state.dir : (k === 'timestamp' ? -1 : 1);
        state.sort = k;
        document.querySelectorAll('[data-sort]').forEach((x) => {
            const on = x === b;
            x.classList.toggle('on', on);
            x.dataset.dir = on ? (state.dir < 0 ? '↓' : '↑') : '';
            x.closest('th').setAttribute('aria-sort', on ? (state.dir < 0 ? 'descending' : 'ascending') : 'none');
        });
        resetPages();
        renderData();
    }));
    document.addEventListener('click', (e) => {
        if (e.target.closest('button.clear')) {
            Object.assign(state, { q: '', chain: 'all', kind: 'all', status: 'all' });
            $('#q').value = '';
            resetPages();
            renderFilters();
            renderData();
            return;
        }
        const live = e.target.closest('button.live');
        if (live) { startLive(live); return; }
        const hit = e.target.closest('[data-k]');
        const link = e.target.closest('a');
        if (!hit || (link && link !== hit)) return;
        if (link) e.preventDefault();
        openDetail(hit.dataset.k, hit);
    });
    $('#dlg').addEventListener('click', (e) => { if (e.target.id === 'dlg') e.target.close(); });
    $('#shared').innerHTML = SHARED.map(([n, a]) => `<tr><td>${n}</td><td class="mono">${a}</td></tr>`).join('');
}

/* ── minted here ─────────────────────────────────────────────────────────── */

async function renderOurs(ours) {
    if (!isAddr(ours.wallet)) throw new Error('bad wallet');
    const wallet = ours.wallet.toLowerCase();
    $('#ours-wallet').innerHTML = who(42161, ours.wallet);
    const grid = $('#ours-grid');
    const rows = await Promise.allSettled((ours.mints || []).filter(validMint).map(async (m) => {
        const c = state.all.find((x) => x.chainId === m.chainId && x.address.toLowerCase() === m.address.toLowerCase());
        if (!c) throw new Error('unknown collection');
        return { c, t: await loadToken(c, m.tokenId, wallet), m };
    }));
    const held = rows.filter((r) => r.status === 'fulfilled' && r.value.t.held).map((r) => r.value);
    grid.innerHTML = held.length ? held.map(({ c, t, m }) => {
        const ex = EXPLORER[m.chainId];
        const tx = ex ? ` &middot; <a href="${ex}/tx/${m.tx}" target="_blank" rel="noopener noreferrer">tx</a>` : '';
        return `<div class="mint">
            <div class="img">${art(t)}</div>
            ${tokenCaption(c, t.id, `${esc(c.name)} #${esc(t.id)}`)}
            <div class="y">${fmtDate(m.date)} &middot; ${m.price === '0' ? 'free' : esc(ethAmount(m.price))}${tx}</div>
        </div>`;
    }).join('') : '<p class="disclose">Nothing yet.</p>';
    if (held.length) paginate('ours', grid, $('#ours-more'));
}

/* ── start ───────────────────────────────────────────────────────────────── */

async function main() {
    wire();
    const [news, data] = await Promise.allSettled([getJson('news.json'), getJson('contracts.json')]);
    if (data.status !== 'fulfilled') throw new Error('contracts.json unavailable');
    state.all = (data.value.contracts || []).filter(validContract);
    const chains = new Set(state.all.map((c) => c.chain)).size;
    const failed = data.value.failedChains || [];
    const when = new Date(data.value.generated * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    const stale = Date.now() / 1000 - data.value.generated > 3600 ? ' · this data is over an hour old, so recent changes may be missing' : '';
    $('#meta').textContent = `${state.all.length} collections on ${chains} chains · read ${when}${failed.length ? ` · not yet read: ${failed.join(', ')}` : ''}${stale}`;
    renderLog(news.status === 'fulfilled' ? news.value.entries || [] : [], state.all);
    renderFilters();
    renderData();
    getJson('ours.json').then(renderOurs)
        .catch(() => { $('#ours-grid').innerHTML = '<p class="disclose">Could not read the wallet.</p>'; });
}

main().catch((e) => { $('#meta').textContent = `Could not read the data: ${e.message}`; });
