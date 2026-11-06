/* ABX Explorer refresher: a Cloudflare Worker on two schedules.

   Every 15 minutes: read new factory Deployed events on each chain, add up to a
   few new collections (name, image, mint terms, deployer name), refresh the
   mint terms of a few existing collections in rotation, and write
   contracts.json to the R2 bucket the site is served from.

   Every hour: turn new ABX releases into news entries (Claude, then Workers AI,
   then facts only; every entry passes validate.js before it is published), and
   alert on Telegram when the btm minter's heartbeat or the 15-minute job goes
   quiet for more than an hour.

   Secrets: ABX_KEY (ABX Services key, creator RPC), ANTHROPIC_KEY, TG_BOT, TG_CHAT.
   Bindings: BUCKET (R2), AI (Workers AI).

   Rules this file keeps:
   - Everything read from a chain or a metadata URL was written by a stranger: sizes are capped
     before decoding, strings are trimmed, SVGs are stored as attachments.
   - Saved progress (queue, seen releases) changes only after the data it describes is written.
   - The free plan allows 50 subrequests per run; every outbound call goes through `budget`. */

import { validateEntry, factsOnlyEntry } from './validate.js';

const CHAINS = [
  { id: 1, name: 'Ethereum', confirm: 12 },
  { id: 8453, name: 'Base', confirm: 30 },
  { id: 42161, name: 'Arbitrum', confirm: 120 },
  { id: 4663, name: 'Robinhood Chain', confirm: 30 },
];
const FACTORIES = {
  '0x2ff8828a9150401225bb217caa8b9b5e666a1c97': '1/1 image', '0x83222f791ca243feb0c1fef93a8732ece3001b4b': 'Series image',
  '0xeab8a19feada0ddba2fde324715ebbb6234b5616': 'Series code', '0x4e9dfcc70dcc02fa5bad113bc2cf0a2218358b1e': '1/1 edition',
  '0xcc29ed68f26693dc9aa5f090b21f37985206cc19': 'Edition image', '0x86f9cfe597ab145452f4a66ac102291d54e8eb46': 'Edition code',
};
const DEPLOYED = '0xc95935a66d15e0da5e412aca0ad27ae891d20b2fb91cf3994b6a3bf2b8178082';
const SALE_1155 = '0xe5a7e9d14be75ee6a3536e3dd982da3f8886e25a773c14f0ae21564547943400';
const MINTER_721 = '0xfb5c61274a3a7da83ccdd88ddec914438244e2c9';
const MINTER_1155 = '0x2af9f0c477c34a23cbec646a3b6bc0ca4df5d37f';
const UNIVERSAL_RESOLVER = '0xeeeeeeee14d718c2b47d9923deab1335e144eeee';
const SEL = {
  name: '0x06fdde03', symbol: '0x95d89b41', contractURI: '0xe8a3d485', tokenURI: '0xc87b56dd', uri: '0x0e89341c',
  minter: '0x07546172', paused: '0x5c975abb', totalSupply: '0x18160ddd', maxInvocations: '0x6cbdef61',
  sales721: '0xc6b9f06a', sales1155: '0x3a1c83ac', reverse: '0x5d78a217',
};
const MAX_SUBREQUESTS = 46, ENRICH_RESERVE = 20, NEW_PER_RUN = 2, REFRESH_PER_RUN = 3, LOG_SPAN = 2_500_000;
const MAX_ATTEMPTS = 3, LEASE_S = 600, QUIET_S = 3600, REALERT_S = 86_400;
const MAX_ABI_BYTES = 65_536, MAX_DATA_URI = 400_000, MAX_META_BYTES = 200_000;
// Release notes come from the changelogs on GitHub's raw CDN: no API key, no API rate limit.
const CHANGELOG_BASE = 'https://raw.githubusercontent.com/ArtBlocks/abx/main/packages';
const NEWS_PACKAGES = [['abx-cli', 'cli'], ['abx-sdk', 'sdk']];

class OutOfBudget extends Error {}
class RpcDown extends Error {}

function budgetFor() {
  let used = 0;
  return {
    async fetch(url, init) {
      if (++used > MAX_SUBREQUESTS) throw new OutOfBudget(`subrequest budget spent (${MAX_SUBREQUESTS})`);
      // manual: a redirect hop would cost an uncounted subrequest, and the ABX key must never follow one
      return fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    },
    left: () => MAX_SUBREQUESTS - used,
  };
}

const now = () => Math.floor(Date.now() / 1000);
const clean = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').slice(0, max) : null);

/* ── chain reads ─────────────────────────────────────────────────────────── */

/** A JSON-RPC call. Transport failures throw RpcDown; a JSON-RPC error throws a plain Error. */
async function rpc(env, b, chain, method, params) {
  let r;
  try {
    r = await b.fetch(`https://services.abx.io/v1/rpc/${chain}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ABX_KEY}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch (e) {
    if (e instanceof OutOfBudget) throw e;
    throw new RpcDown(`${method} on ${chain}: ${e.message}`);
  }
  if (!r.ok) throw new RpcDown(`${method} on ${chain}: HTTP ${r.status}${r.status >= 300 && r.status < 400 ? ' (redirect refused)' : ''}`);
  const j = await r.json();
  if (j.error) throw new Error(`${method} on ${chain}: ${JSON.stringify(j.error).slice(0, 160)}`);
  return j.result;
}

const pad = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const words = (hex) => (hex && hex.length > 2 ? hex.slice(2, 2 + 64 * 16).match(/.{64}/g) || [] : []).map((w) => BigInt(`0x${w}`));

/** eth_call: null when the call reverts or returns nothing; RpcDown when the RPC itself failed. */
async function call(env, b, chain, to, data) {
  try {
    const res = await rpc(env, b, chain, 'eth_call', [{ to, data }, 'latest']);
    return res && res !== '0x' ? res : null;
  } catch (e) {
    if (e instanceof OutOfBudget || e instanceof RpcDown) throw e;
    return null; // a revert: the contract has no such value
  }
}

/** Decode an ABI `string` return value, refusing anything over MAX_ABI_BYTES before decoding. */
function abiString(hex) {
  if (!hex || hex.length < 130) return null;
  const h = hex.slice(2), off = parseInt(h.slice(0, 64), 16) * 2;
  if (!Number.isSafeInteger(off) || off + 64 > h.length) return null;
  const len = parseInt(h.slice(off, off + 64), 16) * 2;
  if (!Number.isSafeInteger(len) || len > MAX_ABI_BYTES * 2 || off + 64 + len > h.length) return null;
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) bytes[i / 2] = parseInt(h.slice(off + 64 + i, off + 66 + i), 16);
  return new TextDecoder().decode(bytes);
}

/* ── metadata and images ─────────────────────────────────────────────────── */

function dataPayload(uri) {
  if (uri.length > MAX_DATA_URI) return null;
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const head = uri.slice(0, comma), body = uri.slice(comma + 1);
  try {
    if (head.includes(';base64')) return Uint8Array.from(atob(body.replace(/\s/g, '')), (c) => c.charCodeAt(0));
    return new TextEncoder().encode(decodeURIComponent(body));
  } catch {
    return null;
  }
}

async function metadata(b, uri) {
  if (typeof uri !== 'string') return null;
  try {
    if (uri.startsWith('data:application/json')) {
      const bytes = dataPayload(uri);
      return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    }
    if (uri.startsWith('https://')) {
      const r = await b.fetch(uri);
      if (!r.ok || Number(r.headers.get('content-length') || 0) > MAX_META_BYTES) return null;
      const text = await r.text();
      return text.length > MAX_META_BYTES ? null : JSON.parse(text);
    }
  } catch (e) {
    if (e instanceof OutOfBudget) throw e;
  }
  return null;
}

const EXT = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** A preview the page can show: data: images are stored in the bucket, URLs pass through.
    SVGs are stored as attachments: an <img> renders them, opening one directly downloads it. */
async function keepImage(env, src, stem) {
  if (typeof src !== 'string' || src.length > MAX_DATA_URI) return null;
  if (src.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${src.slice(7, 200)}`;
  if (src.startsWith('https://')) return src.slice(0, 2000);
  const m = /^data:([^;,]+)/.exec(src);
  if (!m || !EXT[m[1]]) return null;
  const bytes = dataPayload(src);
  if (!bytes) return null;
  const key = `img/${stem}.${EXT[m[1]]}`;
  await env.BUCKET.put(key, bytes, {
    httpMetadata: { contentType: m[1], cacheControl: 'public, max-age=86400', ...(m[1] === 'image/svg+xml' ? { contentDisposition: 'attachment' } : {}) },
  });
  return key;
}

/* ── mint terms and names ────────────────────────────────────────────────── */

const isEdition = (kind) => kind.startsWith('Edition') || kind === '1/1 edition';

/** Edition ids with a sale on the shared 1155 minter: the ones already known plus any configured recently. */
async function editionIds(env, b, c) {
  const head = parseInt(await rpc(env, b, c.chainId, 'eth_blockNumber', []), 16);
  const from = Math.max(c.block || 0, head - LOG_SPAN + 1);
  const logs = await rpc(env, b, c.chainId, 'eth_getLogs', [{
    address: MINTER_1155, topics: [SALE_1155, `0x${pad(c.address)}`], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${head.toString(16)}`,
  }]);
  const known = ((c.sale && c.sale.sales) || []).map((x) => x.id).filter((x) => x != null).map(String);
  const found = logs.filter((l) => !l.removed && l.topics && l.topics.length >= 3).map((l) => BigInt(l.topics[2]).toString());
  return [...new Set([...known, ...found])];
}

async function readSale(env, b, chain, minter, data) {
  const w = words(await call(env, b, chain, minter, data));
  if (w.length < 5 || !w[0]) return null;
  return { paymentToken: `0x${w[1].toString(16).padStart(40, '0')}`, price: w[2].toString(), allocation: Number(w[3]), sold: Number(w[4]) };
}

function classify(s) {
  if (!s.minter || /^0x0+$/.test(s.minter)) return 'owner only';
  if (s.minter !== MINTER_721 && s.minter !== MINTER_1155) return 'custom minter';
  if (!s.sales.length) return 'no sale set';
  if (s.paused) return 'paused';
  const capped = s.cap != null && s.minted != null && s.cap > 0 && s.minted >= s.cap;
  return s.sales.some((x) => x.sold < x.allocation) && !capped ? 'open' : 'sold out';
}

/** Mint terms. Throws RpcDown when the RPC failed, so a flaky minute never overwrites good data. */
async function saleStatus(env, b, c) {
  const { chainId: ch, address: tok } = c;
  const mw = words(await call(env, b, ch, tok, SEL.minter));
  const minter = mw.length ? `0x${mw[0].toString(16).padStart(40, '0')}` : null;
  const paused = Boolean((words(await call(env, b, ch, tok, SEL.paused))[0]) || 0n);
  const s = { minter, paused, minted: null, cap: null, sales: [] };
  if (minter === MINTER_721) {
    const minted = words(await call(env, b, ch, tok, SEL.totalSupply))[0];
    const cap = words(await call(env, b, ch, tok, SEL.maxInvocations))[0];
    s.minted = minted == null ? null : Number(minted);
    s.cap = cap == null ? null : Number(cap);
    const sale = await readSale(env, b, ch, MINTER_721, SEL.sales721 + pad(tok));
    if (sale) s.sales.push(sale);
  } else if (minter === MINTER_1155) {
    for (const id of (await editionIds(env, b, c)).slice(0, 3)) {
      const sale = await readSale(env, b, ch, MINTER_1155, SEL.sales1155 + pad(tok) + word(id));
      if (sale) s.sales.push({ ...sale, id });
    }
  }
  s.state = classify(s);
  return s;
}

/** Primary ENS name through the Universal Resolver (it checks the forward record too). */
async function ensName(env, b, addr) {
  const data = SEL.reverse + word(64) + word(60) + word(20) + addr.slice(2).toLowerCase().padEnd(64, '0');
  return clean(abiString(await call(env, b, 1, UNIVERSAL_RESOLVER, data)), 100) || null;
}

/* ── collections ─────────────────────────────────────────────────────────── */

async function scanChain(env, b, state, chain) {
  const head = parseInt(await rpc(env, b, chain.id, 'eth_blockNumber', []), 16) - chain.confirm;
  if (state.lastBlock[chain.id] == null) state.lastBlock[chain.id] = head; // a chain with nothing listed starts now
  const from = state.lastBlock[chain.id] + 1;
  if (from > head) return [];
  const to = Math.min(head, from + LOG_SPAN - 1);
  const logs = await rpc(env, b, chain.id, 'eth_getLogs', [{ address: Object.keys(FACTORIES), topics: [DEPLOYED], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
  if (!Array.isArray(logs)) throw new RpcDown(`eth_getLogs on ${chain.id}: not a list`);
  const found = logs
    .filter((l) => !l.removed && Array.isArray(l.topics) && l.topics.length >= 4 && FACTORIES[String(l.address).toLowerCase()])
    .map((l) => ({
      chainId: chain.id, chain: chain.name, address: `0x${l.topics[1].slice(-40)}`, kind: FACTORIES[l.address.toLowerCase()],
      owner: `0x${l.topics[3].slice(-40)}`, block: parseInt(l.blockNumber, 16), tx: l.transactionHash, attempts: 0,
    }));
  state.lastBlock[chain.id] = to; // only after the whole range was read and parsed
  return found;
}

async function enrich(env, b, q) {
  const c = { chainId: q.chainId, chain: q.chain, address: q.address, kind: q.kind, owner: q.owner, block: q.block, tx: q.tx };
  const { chainId: ch, address: tok } = c;
  c.name = clean(abiString(await call(env, b, ch, tok, SEL.name)), 200);
  c.symbol = clean(abiString(await call(env, b, ch, tok, SEL.symbol)), 40);
  const block = await rpc(env, b, ch, 'eth_getBlockByNumber', [`0x${c.block.toString(16)}`, false]);
  if (!block || !block.timestamp) throw new RpcDown(`block ${c.block} on ${ch} not available`);
  c.timestamp = parseInt(block.timestamp, 16);
  const meta = (await metadata(b, abiString(await call(env, b, ch, tok, SEL.contractURI)))) || {};
  c.description = clean(meta.description, 2000);
  let image = meta.image;
  if (!image) {
    const tmeta = await metadata(b, abiString(await call(env, b, ch, tok, (isEdition(c.kind) ? SEL.uri : SEL.tokenURI) + word(0))));
    image = tmeta && tmeta.image;
  }
  c.image = await keepImage(env, image, `${ch}-${tok.slice(2).toLowerCase()}`);
  c.sale = await saleStatus(env, b, c);
  c.ownerName = await ensName(env, b, c.owner);
  return c;
}

async function refreshCollections(env, b, state) {
  const obj = await env.BUCKET.get('contracts.json');
  const data = obj ? await obj.json() : { contracts: [] };
  if (!Array.isArray(data.contracts)) data.contracts = [];
  const known = new Set(data.contracts.map((c) => `${c.chainId}:${c.address}`));
  for (const chain of CHAINS) {
    // First run: continue from the newest collection already listed, so nothing since the last pull is missed.
    if (state.lastBlock[chain.id] == null) {
      const blocks = data.contracts.filter((c) => c.chainId === chain.id).map((c) => c.block);
      if (blocks.length) state.lastBlock[chain.id] = Math.max(...blocks);
    }
  }
  const failed = [];
  for (const chain of CHAINS) {
    try {
      for (const c of await scanChain(env, b, state, chain)) {
        const k = `${c.chainId}:${c.address}`;
        if (!known.has(k) && !state.queue.some((q) => `${q.chainId}:${q.address}` === k)) state.queue.push(c);
      }
    } catch (e) {
      if (e instanceof OutOfBudget) throw e;
      failed.push(chain.name);
      console.warn('scan failed', chain.name, e.message);
    }
  }
  const done = new Set();
  for (const q of state.queue.slice(0, NEW_PER_RUN)) {
    if (b.left() < ENRICH_RESERVE) break;
    try {
      data.contracts.unshift(await enrich(env, b, q));
      done.add(q);
    } catch (e) {
      if (e instanceof OutOfBudget) throw e;
      q.attempts = (q.attempts || 0) + 1;
      console.warn('enrich failed', q.chainId, q.address, `attempt ${q.attempts}`, e.message);
    }
  }
  const n = data.contracts.length;
  for (let k = 0; k < REFRESH_PER_RUN && n && b.left() > 10; k++) {
    const c = data.contracts[state.cursor % n];
    state.cursor = (state.cursor + 1) % n;
    try {
      c.sale = { ...(await saleStatus(env, b, c)), minterInfo: c.sale && c.sale.minterInfo };
    } catch (e) {
      if (e instanceof OutOfBudget) throw e;
      console.warn('refresh skipped', c.chainId, c.address, e.message); // keep the last good terms
    }
  }
  data.contracts.sort((a, c2) => c2.timestamp - a.timestamp);
  // When no chain could be read, the data is not fresh: leave the timestamp, so the page's stale
  // notice and the hourly dead-man alert both see the outage.
  const anyRead = failed.length < CHAINS.length;
  if (anyRead) data.generated = now();
  data.failedChains = failed;
  await env.BUCKET.put('contracts.json', JSON.stringify(data), { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' } });
  // Saved progress moves only now that contracts.json holds the new collections.
  state.queue = state.queue.filter((q) => !done.has(q) && (q.attempts || 0) < MAX_ATTEMPTS);
  if (anyRead) state.lastSuccess = now();
}

/* ── news ────────────────────────────────────────────────────────────────── */

const PROMPT = `You write one short news entry for a page that tracks ABX, an open protocol from Art Blocks.
Use only the release notes below. Reply with exactly two lines and nothing else:
Title: 8 to 90 characters, plain words, may start with the package and version.
Body: two or three plain sentences on one line, 40 to 480 characters, saying what changed for someone using ABX.
No links, no domains, no markdown, no dashes, no opinions, no version numbers other than ones in the notes.`;

async function claude(env, b, notes) {
  const r = await b.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    // Thinking off: a two-line summary needs none, and with it on the token cap is spent before any text.
    body: JSON.stringify({
      model: 'claude-haiku-5-5', max_tokens: 600, thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: `${PROMPT}\n\nRelease notes:\n${notes}` }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}`);
  return (await r.json()).content.map((p) => p.text || '').join('');
}

async function workersAI(env, notes) {
  const r = await env.AI.run('@cf/mistralai/mistral-small-3.1-24b-instruct', {
    messages: [{ role: 'user', content: `${PROMPT}\n\nRelease notes:\n${notes}` }], max_tokens: 400,
  });
  return r.response || '';
}

/** The model's two lines, "Title: ..." and "Body: ..."; null when either is missing. */
function parseModel(text) {
  const title = /^\s*Title:\s*(.+?)\s*$/m.exec(text || '');
  const body = /^\s*Body:\s*(.+?)\s*$/m.exec(text || '');
  return title && body ? { title: title[1], body: body[1] } : null;
}

/** One entry: the model writes title and body, the code supplies date and sources. */
async function writeEntry(env, b, facts, notes) {
  for (const writer of [() => claude(env, b, notes), () => workersAI(env, notes)]) {
    try {
      const out = parseModel(await writer());
      if (!out) { console.warn('news: model reply had no Title and Body lines'); continue; }
      const entry = { date: facts.date, tag: facts.tag, title: out.title, body: out.body, sources: facts.sources, automated: 'ai' };
      const v = validateEntry(entry, facts);
      if (v.ok) return entry;
      console.warn('news: entry failed validation', v.errors.join('; '));
    } catch (e) {
      if (e instanceof OutOfBudget) throw e;
      console.warn('news: writer failed', e.message);
    }
  }
  return factsOnlyEntry(facts);
}

/** Version sections of a changesets CHANGELOG.md, newest first: [{version, notes}]. */
function changelogSections(md) {
  return md.split(/^## /m).slice(1).map((p) => {
    const nl = p.indexOf('\n');
    return { version: p.slice(0, nl).trim(), notes: p.slice(nl + 1).trim() };
  }).filter((s) => /^\d+\.\d+\.\d+$/.test(s.version));
}

const releaseUrl = (pkg, v) => `https://github.com/ArtBlocks/abx/releases/tag/${encodeURIComponent(`@artblocks/${pkg}@${v}`)}`;

async function refreshNews(env, b, state) {
  const fresh = [];
  for (const [pkg, dir] of NEWS_PACKAGES) {
    const r = await b.fetch(`${CHANGELOG_BASE}/${dir}/CHANGELOG.md`, { headers: { 'user-agent': 'abx-explorer' } });
    if (!r.ok) continue;
    for (const s of changelogSections((await r.text()).slice(0, 400_000))) {
      const key = `${pkg}@${s.version}`;
      if (!state.seenReleases.includes(key)) fresh.push({ pkg, key, ...s });
    }
  }
  // First run: the page's news already covers these, so mark them seen and write nothing.
  if (!state.seenReleases.length) {
    state.seenReleases = fresh.map((f) => f.key);
    return;
  }
  if (!fresh.length) return;
  const obj = await env.BUCKET.get('news.json');
  const news = obj ? await obj.json() : { entries: [] };
  if (!Array.isArray(news.entries)) news.entries = [];
  const date = new Date().toISOString().slice(0, 10);
  const published = [];
  // One entry per package per run, oldest unseen version first, so a burst of releases becomes a short series.
  for (const pkg of new Set(fresh.map((f) => f.pkg))) {
    if (b.left() < 4 || published.length >= 2) break;
    const rel = fresh.filter((f) => f.pkg === pkg).at(-1);
    const facts = {
      date, tag: 'Release', versions: [rel.version],
      title: `${pkg} ${rel.version} released`,
      summary: `${pkg} ${rel.version} is out. The release notes list what changed.`,
      sources: [[`${pkg} ${rel.version}`.slice(0, 40), releaseUrl(pkg, rel.version)]],
    };
    news.entries.unshift(await writeEntry(env, b, facts, `${pkg} ${rel.version}\n${rel.notes.slice(0, 3500)}`));
    published.push(rel.key);
  }
  if (!published.length) return;
  news.entries = news.entries.slice(0, 200);
  await env.BUCKET.put('news.json', JSON.stringify(news), { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' } });
  state.seenReleases.push(...published); // only after news.json holds them
}

/* ── alerts ──────────────────────────────────────────────────────────────── */

async function telegram(env, b, text) {
  const r = await b.fetch(`https://api.telegram.org/bot${env.TG_BOT}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TG_CHAT, text }),
  });
  const j = r.ok ? await r.json().catch(() => ({})) : {};
  return j.ok === true;
}

/** One alert per problem, repeated daily while it lasts. */
async function alertOnce(env, b, state, kind, active, text) {
  const last = state.alerts[kind] || 0;
  if (!active) { delete state.alerts[kind]; return; }
  if (now() - last < REALERT_S) return;
  if (await telegram(env, b, text)) state.alerts[kind] = now();
}

async function checkHealth(env, b, newsState, collState) {
  let beat = null, stopped = false;
  try {
    const obj = await env.BUCKET.get('heartbeat.json');
    const hb = obj ? await obj.json() : null;
    if (hb && Number.isFinite(hb.ts) && hb.ts <= now() + 300) { beat = hb.ts; stopped = hb.stopped === true; }
  } catch { /* an unreadable heartbeat counts as missing */ }
  const minterQuiet = !stopped && (beat == null || now() - beat > QUIET_S);
  await alertOnce(env, b, newsState, 'minter', minterQuiet,
    `ABX auto-minter on btm has been silent for over an hour (last heartbeat ${beat ? new Date(beat * 1000).toISOString() : 'missing or unreadable'}).`);
  const refreshQuiet = !collState.lastSuccess || now() - collState.lastSuccess > QUIET_S;
  await alertOnce(env, b, newsState, 'refresh', refreshQuiet,
    `abx-refresh: the 15-minute collection update has not finished for over an hour (last success ${collState.lastSuccess ? new Date(collState.lastSuccess * 1000).toISOString() : 'never'}).`);
}

/* ── state and entry points ──────────────────────────────────────────────── */

const DEFAULTS = {
  'state/collections.json': { lastBlock: {}, queue: [], cursor: 0, lastSuccess: null, lease: 0 },
  'state/news.json': { seenReleases: [], alerts: {}, lease: 0 },
};

async function loadState(env, key) {
  let s = {};
  try { const obj = await env.BUCKET.get(key); s = obj ? await obj.json() : {}; } catch { s = {}; }
  const d = DEFAULTS[key], out = { ...structuredClone(d), ...(s && typeof s === 'object' && !Array.isArray(s) ? s : {}) };
  // Lists and maps must keep their shape; numbers may also be null (never run yet).
  for (const [k, v] of Object.entries(d)) {
    if (Array.isArray(v)) { if (!Array.isArray(out[k])) out[k] = []; }
    else if (v && typeof v === 'object') { if (!out[k] || typeof out[k] !== 'object' || Array.isArray(out[k])) out[k] = {}; }
    else if (out[k] !== null && !Number.isFinite(out[k])) out[k] = v;
  }
  return out;
}

const saveState = (env, key, s) => env.BUCKET.put(key, JSON.stringify(s), { httpMetadata: { contentType: 'application/json' } });

/** Runs `job` under a lease, so an overlapping run of the same schedule skips instead of racing. */
async function leased(env, key, job) {
  const state = await loadState(env, key);
  if (state.lease && now() - state.lease < LEASE_S) { console.warn('skipped: a run of this schedule holds the lease', key); return; }
  state.lease = now();
  await saveState(env, key, state);
  try {
    await job(state);
  } finally {
    state.lease = 0;
    await saveState(env, key, state);
  }
}

export default {
  // No routes: the Worker only runs on its schedules.
  fetch: () => new Response('Not found', { status: 404 }),
  async scheduled(event, env) {
    const b = budgetFor();
    if (event.cron === '7 * * * *') {
      const coll = await loadState(env, 'state/collections.json');
      await leased(env, 'state/news.json', async (st) => {
        try { await checkHealth(env, b, st, coll); } catch (e) { console.warn('health check failed', e.message); }
        await refreshNews(env, b, st);
      });
    } else {
      await leased(env, 'state/collections.json', (st) => refreshCollections(env, b, st));
    }
  },
};
