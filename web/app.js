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
/* A second endpoint for token metadata the first one refuses. A token whose art is built
   on-chain can need hundreds of millions of gas to read (Squeegee: about 269M), above the
   read cap of most public RPCs; they answer with a revert that carries no data. */
const RPC_HEAVY = {
    1: 'https://rpc.mevblocker.io',
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

/* ABX FS orgs: Series code collections deployed by the ABX FS org factory (same address on every chain).
   Each token is a project, a website or set of files, so the page lists them as sites, not as art. */
const ABXFS_FACTORY = '0xc5abf9fbd94659cdfc173af30c6052700fa62798';
const SITE_KIND = 'ABX FS site';
const isSiteOrg = (c) => c.owner.toLowerCase() === ABXFS_FACTORY && c.symbol === 'ABXFS';
const MAX_SITES = 12;
const SITE_SEL = { next: '0x75794a3c', ownerOf: '0x6352211e', param: '0x6bd39222', paramData: '0x84f6687f' };
const SITE_KEY = {
    cid: '61627866732e6369640000000000000000000000000000000000000000000000',  // "abxfs.cid"
    name: '61627866732e6e616d6500000000000000000000000000000000000000000000', // "abxfs.name"
    view: '61627866732e7669657700000000000000000000000000000000000000000000', // "abxfs.view"
};

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

/* What each kind of collection is, and what each mint state means, for a reader new to ABX. */
const KIND_HELP = {
    '1/1 image': 'One token with one image.',
    'Series image': 'A numbered series of tokens, each with its own image.',
    'Series code': 'A numbered series whose art a program draws for each token from that token\'s own seed.',
    '1/1 edition': 'One artwork that can be held in many identical copies.',
    'Edition image': 'Images, each of which can be held in many identical copies.',
    'Edition code': 'Artworks drawn by a program, each of which can be held in many identical copies.',
};
const MINT_HELP = {
    'owner only': 'Only the collection\'s owner can mint.',
    'custom minter': 'Tokens are sold by a contract of the collection\'s own.',
    'no sale set': 'No sale is set up.',
    paused: 'The sale is set up but stopped.',
};
const hint = (text) => (text ? `<br><span class="hint">${esc(text)}</span>` : '');

/* A collection's own description, as its contract stores it: written by whoever deployed it, so it is shown
   as their words, as plain text, without control or direction characters that could rearrange the panel. */
const ABOUT_MAX = 1200;
function aboutText(c) {
    const d = typeof c.description === 'string' ? c.description : '';
    const clean = d.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').trim();
    return clean.length > ABOUT_MAX ? `${clean.slice(0, ABOUT_MAX).trimEnd()}…` : clean;
}
function aboutBlock(c) {
    const text = aboutText(c);
    return text
        ? `<p class="about">${esc(text)}</p><p class="about-src">The collection's description, as stored in its contract by whoever deployed it.</p>`
        : '<p class="about-src">The contract holds no description of this collection.</p>';
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
            <td class="name"><a href="#c-${c.chainId}-${c.address}" data-k="${c.chainId}:${c.address}">${esc(c.name || 'Unnamed')}</a>${distinctSymbol(c) ? `<span class="sym">${esc(c.symbol)}</span>` : ''}${isTest(c) ? '<span class="test" title="One of ABX\'s own rehearsal, canary or acceptance contracts">ABX test</span>' : ''}</td>
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
            <div class="img">${imgTag(sources(c), c.name, { thumb: true })}</div>
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

const rpcCall = (url, to, data) => getJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
});

/* A revert with no data: what an RPC returns when a read runs past its gas cap. */
const bareRevert = (j) => !!j.error && (j.error.data === undefined || j.error.data === '0x');

/* `heavy` marks a read that may need more gas than the chain's first endpoint allows; a bare
   revert there is retried once on RPC_HEAVY. */
async function ethCall(chainId, to, data, heavy = false) {
    let j = await rpcCall(RPC[chainId], to, data);
    if (heavy && RPC_HEAVY[chainId] && bareRevert(j)) j = await rpcCall(RPC_HEAVY[chainId], to, data);
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

/* Images load from our own copy first (the Worker keeps copies of images on other hosts under img/), then
   from the original address, then fall back to an initials card, so a blocked or dead host never shows
   a broken image. On the live host Cloudflare serves gallery thumbnails resized; anywhere else (a mirror,
   a local copy) has no /cdn-cgi/image route and loads the files whole. */
const RESIZE = location.hostname === 'abx.thebenmeadows.com';
const OWN = /^img\/[\w.-]+$/;
const resized = (path, w) => `/cdn-cgi/image/width=${w},fit=scale-down,format=auto,onerror=redirect/${path}`;

function sources(c) {
    const copy = c.copy && typeof c.copy.key === 'string' && OWN.test(c.copy.key) ? c.copy.key : null;
    return [...new Set([copy, imageSrc(c.image)].filter(Boolean))];
}

function initials(name) {
    const words = (typeof name === 'string' ? name : '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    const letters = words.slice(0, 2).map((w) => [...w.replace(/^[^\p{L}\p{N}]+/u, '')][0] || '').join('').toUpperCase();
    return `<span class="initials" aria-hidden="true"><span>${esc(letters || '?')}</span></span>`;
}

/* Addresses that already failed on this visit, so a re-render (search, filters) does not retry them. */
const FAILED = new Set();

/** An <img> for `list` (first choice first); `thumb` asks for a resized gallery thumbnail.
    `name` comes from metadata and may be any JSON value. */
function imgTag(list, name, { thumb = false, lazy = true } = {}) {
    const label = typeof name === 'string' ? name.slice(0, 200) : '';
    const live = list.filter((u) => !FAILED.has(u));
    if (!live.length) return initials(label);
    const [first, ...rest] = live;
    let src = `src="${esc(first)}"`;
    if (thumb && RESIZE && OWN.test(first) && !first.endsWith('.svg') && !FAILED.has(resized(first, 600))) {
        src = `src="${esc(resized(first, 600))}" srcset="${esc(resized(first, 600))} 600w, ${esc(resized(first, 1200))} 1200w"`
            + ' sizes="(max-width: 640px) 50vw, 300px"';
        rest.unshift(first); // a failed resize falls back to the file itself before the outside host
    }
    return `<img ${src} alt=""${lazy ? ' loading="lazy"' : ''} data-next="${esc(JSON.stringify(rest))}" data-name="${esc(label)}" />`;
}

/* An image that fails moves to its next address; the last failure becomes the initials card. */
function onImageError(e) {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.hasAttribute('data-next')) return;
    FAILED.add(img.getAttribute('src'));
    let next = [];
    try { next = JSON.parse(img.dataset.next); } catch { /* treat as none left */ }
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    if (Array.isArray(next) && next.length) {
        img.dataset.next = JSON.stringify(next.slice(1));
        img.src = next[0];
    } else {
        img.outerHTML = initials(img.dataset.name);
    }
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
    let uri = abiString(await ethCall(c.chainId, c.address, (isEdition(c) ? '0x0e89341c' : '0xc87b56dd') + w, true));
    if (isEdition(c)) uri = uri.replace('{id}', w);   // ERC-1155 id substitution
    const meta = await tokenMeta(uri);
    let owner = null, held = null;
    if (!isEdition(c)) {
        try { owner = `0x${(await ethCall(c.chainId, c.address, `0x6352211e${w}`)).slice(-40)}`; } catch { /* burned */ }
        held = holder ? owner && owner.toLowerCase() === holder : null;
    } else if (holder) {
        held = BigInt(await ethCall(c.chainId, c.address, `0x00fdd58e${holder.slice(2).padStart(64, '0')}${w}`)) > 0n;
    }
    return { id, meta, owner, held, uri };
}

function art(t) {
    const img = imageSrc(t.meta.image);
    if (img) return imgTag([img], t.meta.name);
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
    ? `https://find3r.thebenmeadows.com/artwork.html?chain=${c.chainId}&contract=${c.address}&token=${encodeURIComponent(id)}&adapter=auto`
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
    const read = results.filter((r) => r.status === 'fulfilled');
    const ok = read.map((r) => tokenTile(c, r.value));
    if (read.length && dependsView && dependsView.c === c) dependsView.sample(read[0].value);
    grid.insertAdjacentHTML('beforeend', ok.join(''));
    const failed = results.length - ok.length;
    note.textContent = failed ? `${failed} of ${results.length} tokens in that batch could not be read.` : '';
    if (!grid.children.length && !cursor.left()) note.textContent = 'No tokens could be read from the chain.';
    more.hidden = !cursor.left();
}

/* What the contract says was minted, read when a detail view opens (web/mints.js weighs it against the data
   file, which is a day old at best and has no count for a collection with no public sale). A series answers
   nextTokenId(); a 1/1 image has no such function and answers totalSupply(); an edition answers
   totalSupply(id), asked from id 0 until an id has none. A failed read is null. */
const MINT_SEL = { next: '0x75794a3c', supply: '0x18160ddd', idSupply: '0xbd85b039' };
const MAX_EDITION_IDS = 12;
async function readMinted(c) {
    const num = async (data) => {
        try {
            const r = await ethCall(c.chainId, c.address, data);
            return r.length === 66 && BigInt(r) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(BigInt(r)) : null;
        } catch { return null; }
    };
    if (!isEdition(c)) {
        const next = await num(MINT_SEL.next);
        return { next, supply: next === null ? await num(MINT_SEL.supply) : null };
    }
    const supplies = [];
    if (!((c.sale || {}).sales || []).length) {
        for (let id = 0; id < MAX_EDITION_IDS; id++) {
            const s = await num(MINT_SEL.idSupply + word(id));
            supplies.push(s);
            if (!s) break;
        }
    }
    return { supplies };
}

/* Token ids to browse, newest first, produced lazily so a huge collection costs nothing up front. `live` is
   what readMinted returned; without it the data file alone decides. `known` is false when nothing said how
   many were minted. */
function mintCursor(c, live = {}) {
    const s = c.sale || {};
    if (isEdition(c)) {
        // contracts.json writes edition ids as decimal strings (schema/contracts.schema.json).
        const ids = abxMints.editionIds({ saleIds: (s.sales || []).map((x) => x.id), supplies: live.supplies });
        let i = 0;
        return { next: (n) => ids.slice(i, (i += n)), left: () => i < ids.length, first: () => ids[0], known: ids.length > 0 || (live.supplies || [])[0] === 0 };
    }
    const count = abxMints.count({ minted: s.minted, next: live.next, supply: live.supply });
    const n = Math.min(count || 0, MAX_LISTED_TOKENS);
    let top = (count || 0) - 1;
    const stop = top - n;
    return {
        next: (k) => { const out = []; while (out.length < k && top > stop) out.push(top--); return out; },
        left: () => top > stop,
        first: () => (n > 0 ? 0 : undefined),
        known: count !== null,
    };
}

/* ── ABX FS sites ────────────────────────────────────────────────────────── */

/* The official gateway's address for a project; the owner's own abxfs.view URL wins when set. */
const gatewayUrl = (c, id) => `https://${c.chainId}-${c.address.slice(2).toLowerCase()}-${id}.abxfs.app/`;
const tokenArg = (id, key) => word(id) + key;

/* The from-chain viewer (mdws-org/abxfs-rs) reads a project with no gateway. The link opens the viewer's check
   page, which says how the project's current version was established (by proof, or by endpoints agreeing)
   before any of the project's own scripts run, and links on to the project. An empty value leaves the link out. */
const VIEW_BASE = 'fromchain.dynv6.net';
const VIEW_CHAINS = new Set([1, 8453, 42161, 4663]);
function fromChainUrl(c, id) {
    if (!VIEW_CHAINS.has(c.chainId)) return null;
    const label = `${c.chainId}-${c.address.slice(2).toLowerCase()}-${id}`;
    return VIEW_BASE ? `https://check.${VIEW_BASE}/#${label}` : null;
}

async function paramString(c, id, key) {
    try {
        return abiString(await ethCall(c.chainId, c.address, SITE_SEL.paramData + tokenArg(id, key))).trim();
    } catch {
        return '';
    }
}

async function readSite(c, id) {
    const [owner, cid, name, view] = await Promise.all([
        ethCall(c.chainId, c.address, SITE_SEL.ownerOf + word(id)).catch(() => null),
        ethCall(c.chainId, c.address, SITE_SEL.param + tokenArg(id, SITE_KEY.cid)).catch(() => null),
        paramString(c, id, SITE_KEY.name),
        paramString(c, id, SITE_KEY.view),
    ]);
    const root = cid && cid.length >= 66 ? `0x${cid.slice(2, 66)}` : null;
    return {
        id,
        owner: owner && owner.length >= 66 ? `0x${owner.slice(26, 66)}` : null,
        root: root && !/^0x0+$/.test(root) ? root : null,
        name,
        view: view.startsWith('https://') ? safeHref(view) : null,
    };
}

function siteRow(c, s, total) {
    const label = esc(s.name || (total === 1 ? c.name : '') || `Project ${s.id}`);
    if (!s.root) return `<li><span class="n">${label}</span> <span class="disclose">nothing published yet</span></li>`;
    const href = s.view || gatewayUrl(c, s.id);
    const direct = fromChainUrl(c, s.id);
    return `<li>
        <a class="n" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>
        <span class="host">${esc(new URL(href).host)}</span>
        ${direct ? `<a class="direct" href="${esc(direct)}" target="_blank" rel="noopener noreferrer">read from chain</a>` : ''}
        ${s.owner ? `<span class="by">by ${who(c.chainId, s.owner)}</span>` : ''}
        <span class="mono root" title="${esc(s.root)}">root ${short(s.root)}</span>
    </li>`;
}

async function loadSites(c, list, note) {
    let total;
    try {
        total = Number(BigInt(await ethCall(c.chainId, c.address, SITE_SEL.next)));
    } catch {
        note.textContent = 'Could not read the projects from chain.';
        return;
    }
    if (!total) {
        note.textContent = 'No projects yet.';
        return;
    }
    const ids = [...Array(Math.min(total, MAX_SITES)).keys()];
    const sites = [];
    for (const id of ids) sites.push(await readSite(c, id));   // one project at a time: public RPCs throttle bursts
    list.innerHTML = sites.map((s) => siteRow(c, s, total)).join('');
    note.textContent = `${total} project${total === 1 ? '' : 's'}${total > MAX_SITES ? `, first ${MAX_SITES} shown` : ''} · read live from chain. Links open the project on ABX FS's gateway unless the owner set their own address.${sites.some((x) => x.root && fromChainUrl(c, x.id)) ? ' "Read from chain" opens it with no gateway, each file checked in your browser.' : ''}`;
}

/* ── detail dialog ───────────────────────────────────────────────────────── */

/* ── what a collection depends on ────────────────────────────────────────── */

/* Read from the collection's own contract when its detail view opens (web/depends.js turns the answers into
   rows). A read that fails is null, and its row says "Not read". */
const DEP_SEL = {
    uriLocked: '0xac998f45', renderer: '0xd50bac33', base: '0x261220a3',                    // tokenURILocked, tokenURIRenderer, tokenURIBase
    chunks: '0x92d9906f', scriptLocked: '0x7d0b7ae4', depCount: '0xd90f5df2', depsLocked: '0xea58f971',
    hooks: '0x3c59f1bb', hooksLocked: '0x6c59f759',                                         // paramHooks, paramHooksLocked
    field: '0x55828c50', fieldLocked: '0x2e73cddb',                                         // contractField(bytes32), contractFieldLocked(bytes32)
};
const DEP_STATE = { chain: 'On chain', pinned: 'Pinned', host: 'Server', open: 'Changeable', unknown: 'Unknown' };
const DEP_NOTE = 'Read from the contract just now through one public endpoint, not proved. Not checked: that a file kept off chain is the one the artist meant, or that a server named here still answers.';
const isCode = (c) => c.kind.endsWith('code');
const tagHex = (s) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('').padEnd(64, '0');
const hexBytes = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
/* One ABI word as an address: the address, null for the zero address, undefined for a word that is not an
   address at all (anything in its upper 12 bytes), which callers treat as not read. */
const addrWord = (w) => (!/^0{24}[0-9a-f]{40}$/i.test(w) ? undefined : /^0+$/.test(w) ? null : `0x${w.slice(24).toLowerCase()}`);
const utf8 = (bytes) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; } };
const TEXT_REPS = new Set(['url', 'url-template', 'ipfs', 'arweave', 'inline']);
const MAX_FIELD_HEX = 4096;   // longer values are named by their representation and not decoded

/* contractField(bytes32) returns (bytes32 representation, bytes value). The result is { rep, value }: the tag
   as text, and the value as an address for a renderer or a reader, as text where the representation carries text, and
   null otherwise (a value that is binary, too long, or not what its representation says). Null when the
   field is not set or the reply is not that tuple. */
function fieldValue(hex) {
    const h = hex.slice(2);
    // Two head words, then the bytes at offset 0x40: its length word and its data.
    if (h.length < 192 || h.length % 64 || !/^0{62}40$/.test(h.slice(64, 128))) return null;
    const rep = (utf8(hexBytes(h.slice(0, 64))) || '').replace(/\0+$/, '');
    if (!/^[a-z0-9-]{1,31}$/.test(rep)) return null;
    const len = parseInt(h.slice(128, 192), 16) * 2;
    if (!Number.isSafeInteger(len) || 192 + len > h.length) return null;
    const body = h.slice(192, 192 + len);
    if (rep === 'renderer') return { rep, value: (len === 64 && addrWord(body)) || null };
    // A reader's value is (reader, pointer): the reader is the contract to name.
    if (rep === 'reader' || rep === 'reader-gzip') return { rep, value: (len === 128 && addrWord(body.slice(0, 64))) || null };
    if (!TEXT_REPS.has(rep) || len > MAX_FIELD_HEX) return { rep, value: null };
    return { rep, value: utf8(hexBytes(body)) };
}

async function readDepends(c) {
    // A public endpoint refuses a burst now and then: one more try, a moment later, before a read is given up.
    const once = (data) => ethCall(c.chainId, c.address, data);
    const call = (data) => once(data).catch(() => new Promise((ok) => setTimeout(ok, 600)).then(() => once(data))).catch(() => null);
    // A bool is the word 1 or the word 0; anything else is not read.
    const flag = (r) => (!r || r.length !== 66 ? null : /^0x0{63}1$/.test(r) ? true : /^0x0{64}$/.test(r) ? false : null);
    const count = (r) => (r && r.length === 66 && BigInt(r) <= 100000n ? Number(BigInt(r)) : null);
    const field = async (name) => {
        const [r, lock] = await Promise.all([call(DEP_SEL.field + tagHex(name)), call(DEP_SEL.fieldLocked + tagHex(name))]);
        const f = r ? fieldValue(r) : null;
        return f && flag(lock) !== null ? { ...f, locked: flag(lock) } : f;
    };
    const code = isCode(c);
    // Two rounds, so one detail view never sends more than ten reads at once.
    const [uriLocked, renderer, base, image, creator] = await Promise.all([
        call(DEP_SEL.uriLocked), call(DEP_SEL.renderer), call(DEP_SEL.base), field('image'), field('creator'),
    ]);
    const more = code ? await Promise.all([
        call(DEP_SEL.chunks), call(DEP_SEL.scriptLocked), call(DEP_SEL.depCount), call(DEP_SEL.depsLocked),
        call(DEP_SEL.hooks), call(DEP_SEL.hooksLocked), field('code'), field('animation_url'),
    ]) : [];
    const [chunks, scriptLocked, depCount, depsLocked, hooks, hooksLocked, codeField, live] = more;
    let baseText = null;
    try { baseText = base ? abiString(base) : null; } catch { /* not read */ }
    const hookWords = hooks && hooks.length === 194 ? [0, 1, 2].map((i) => addrWord(hooks.slice(2 + i * 64, 66 + i * 64))) : null;
    // A hook word that is not an address leaves the whole row unread: it is never shown as no hook.
    const hooksRead = hookWords && !hookWords.includes(undefined);
    // A renderer word that is not an address is not "no renderer": metadata is then not read.
    const rendererWord = renderer && renderer.length === 66 ? addrWord(renderer.slice(2)) : undefined;
    return {
        kind: c.kind,
        uriLocked: flag(uriLocked),
        renderer: rendererWord || null,
        rendererUnread: rendererWord === undefined && flag(uriLocked) !== null,
        base: baseText,
        script: code ? { chunks: count(chunks), locked: flag(scriptLocked) } : null,
        deps: code ? { count: count(depCount), locked: flag(depsLocked) } : null,
        fields: { code: codeField || null, animation_url: live || null, image },
        hooks: hooksRead ? { configure: hookWords[0], augment: hookWords[1], transfer: hookWords[2], locked: flag(hooksLocked) } : null,
        creator: creator && creator.rep === 'inline' && creator.value ? creator.value.slice(0, 200) : null,
        creatorLocked: creator ? creator.locked : undefined,
        sample: null,
    };
}

function renderDepends(el, facts) {
    el.innerHTML = abxDepends.rows(facts).map((r) =>
        `<dt>${esc(r.label)}</dt><dd><span class="dep">${esc(DEP_STATE[r.state] || DEP_STATE.unknown)}</span> ${esc(r.text)}</dd>`).join('');
}

/* The newest detail view's list: { c, sample(token) }. The first token read for the mints grid fills in what
   the contract itself does not say (where that token's image and live view come from). */
let dependsView = null;

function startDepends(c, el, listed) {
    let facts = null, token = null;
    const draw = () => {
        if (!facts || !el.isConnected) return;   // the view was closed or replaced
        const t = token && { uri: token.uri, image: token.meta.image, animation: token.meta.animation_url };
        renderDepends(el, { ...facts, sample: t || null });
    };
    // The first token read stays the sample: rows do not change as more of the grid loads.
    dependsView = { c, sample: (t) => { if (!token) { token = t; draw(); } } };
    readDepends(c).then((f) => { facts = f; draw(); }, () => { el.innerHTML = '<dt>Contract</dt><dd>Could not be read.</dd>'; });
    // With no token listed below, token 0 is tried once, so the image row has something to go on.
    if (!listed && !isEdition(c)) loadToken(c, 0).then((t) => { if (!token) { token = t; draw(); } }, () => {});
}

function detailLinks(c) {
    const ex = EXPLORER[c.chainId];
    const sample = mintCursor(c).first();
    const has = sample !== undefined;
    return [
        FIND3R_CHAINS.has(c.chainId) && ['find3r', `https://find3r.thebenmeadows.com/#address=${c.address}&chain=${c.chainId}`],
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
    const imgs = sources(c);
    dlg.innerHTML = `
        <button class="close" aria-label="Close">&times;</button>
        <div class="big">${imgs.length ? imgTag(imgs, c.name, { lazy: false }) : '<span class="ph">No preview</span>'}</div>
        <h3 id="dlg-title">${esc(c.name || 'Unnamed')} <span class="sym">${esc(c.symbol || '')}</span></h3>
        ${aboutBlock(c)}
        <dl>
            <dt>Kind</dt><dd>${esc(c.kind)}${hint(KIND_HELP[c.kind])}</dd>
            <dt>Chain</dt><dd>${esc(c.chain)}</dd>
            <dt>Contract</dt><dd class="mono">${esc(c.address)}</dd>
            <dt>Deployer</dt><dd>${who(c.chainId, c.owner, c.ownerName)}</dd>
            <dt>Deployed</dt><dd>${day(c.timestamp)} &middot; block ${esc(c.block)}</dd>
            <dt>Mint</dt><dd>${esc(mintLabel(c))}${supplyNote(c)}${hint(MINT_HELP[(c.sale || {}).state])}</dd>
            <dt>Minter</dt><dd>${minterLine(c)}</dd>
        </dl>
        <div class="links">${detailLinks(c).map(([l, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(l)}</a>`).join('')}</div>
        ${isSiteOrg(c) ? '' : `<h4 class="mints-h">Depends on</h4>
        <p class="about-src">What this collection needs in order to keep showing its art, and what its owner can still change. On chain: settled. Pinned: a file named by its own hash. Server: a server someone runs. Changeable: the owner can still change it. Unknown: not read.</p>
        <dl class="depends" id="depends" aria-live="polite"><dt>Contract</dt><dd>Reading…</dd></dl>
        <p class="disclose" id="depends-note">${esc(DEP_NOTE)}</p>`}
        <h4 class="mints-h">Mints</h4>
        <div class="mints" id="mints" aria-live="polite"></div>
        <p class="disclose" id="mints-note" role="status"></p>
        <button class="more" id="mints-more" type="button" hidden>More</button>`;
    dlg.setAttribute('aria-labelledby', 'dlg-title');
    dlg.querySelector('.close').onclick = () => dlg.close();
    dlg.onclose = () => { if (opener && opener.focus) opener.focus(); };
    dlg.showModal();
    if (isSiteOrg(c)) {
        dlg.querySelector('.mints-h').textContent = 'Sites';
        dlg.querySelector('#mints').outerHTML = '<ul class="sites" id="sites" aria-live="polite"></ul>';
        const note = dlg.querySelector('#mints-note');
        note.textContent = 'Reading projects…';
        loadSites(c, dlg.querySelector('#sites'), note);
        return;
    }
    const grid = dlg.querySelector('#mints'), more = dlg.querySelector('#mints-more'), note = dlg.querySelector('#mints-note');
    note.textContent = 'Reading…';
    readMinted(c).then((live) => {
        if (!grid.isConnected) return;   // the view was closed or replaced while the contract was read
        const cursor = mintCursor(c, live);
        startDepends(c, dlg.querySelector('#depends'), cursor.left());
        if (!cursor.left()) {
            note.textContent = cursor.known ? 'Nothing minted yet.' : 'How many were minted could not be read.';
            return;
        }
        more.onclick = () => loadMints(c, cursor, grid, more, note);
        loadMints(c, cursor, grid, more, note);
    });
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
    document.addEventListener('error', onImageError, true); // image errors do not bubble: listen in the capture phase
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
    for (const c of state.all) {
        if (isSiteOrg(c)) {
            c.kind = SITE_KIND;
            c.ownerName = 'ABX FS';
        }
    }
    const chains = new Set(state.all.map((c) => c.chain)).size;
    const failed = data.value.failedChains || [];
    const when = new Date(data.value.generated * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    const stale = Date.now() / 1000 - data.value.generated > 3600 ? ' · this data is over an hour old, so recent changes may be missing' : '';
    $('#meta').textContent = `${state.all.length} collections on ${chains} chains · read ${when}${failed.length ? ` · not yet read: ${failed.join(', ')}` : ''}${stale}`;
    renderLog(news.status === 'fulfilled' ? news.value.entries || [] : [], state.all);
    renderFilters();
    renderData();
    document.body.removeAttribute('data-loading');
    getJson('ours.json').then(renderOurs)
        .catch(() => { $('#ours-grid').innerHTML = '<p class="disclose">Could not read the wallet.</p>'; });
}

main().catch((e) => {
    $('#meta').textContent = `Could not read the data: ${e.message}`;
    document.body.removeAttribute('data-loading');
});
