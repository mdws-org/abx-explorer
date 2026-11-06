/* ABX Explorer refresher: a Cloudflare Worker on two schedules.

   Every 15 minutes: read new factory Deployed events on each chain, add up to a
   few new collections (name, image, mint terms, deployer name), refresh the
   mint terms of a few existing collections in rotation, and write
   contracts.json to the R2 bucket the site is served from.

   Every hour: turn new ABX releases into news entries (Claude, then Workers AI,
   then facts only; every entry passes validate.js before it is published), and
   alert on Telegram when the btm minter's heartbeat is more than an hour old.

   Secrets: ABX_KEY (ABX Services key, creator RPC), ANTHROPIC_KEY, TG_BOT, TG_CHAT.
   Bindings: BUCKET (R2), AI (Workers AI).
   The free plan allows 50 subrequests per run; every outbound call goes through
   `budget`, which stops the run's optional work before that limit. */

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
  totalSupplyId: '0xbd85b039', maxSupplyId: '0x869f7594', sales721: '0xc6b9f06a', sales1155: '0x3a1c83ac', reverse: '0x5d78a217',
};
const MAX_SUBREQUESTS = 46, NEW_PER_RUN = 2, REFRESH_PER_RUN = 3, LOG_SPAN = 2_500_000;
const HEARTBEAT_MAX_S = 3600;
const RELEASES = 'https://api.github.com/repos/ArtBlocks/abx/releases?per_page=20';

class OutOfBudget extends Error {}

function budgetFor() {
  let used = 0;
  return {
    async fetch(url, init) {
      if (++used > MAX_SUBREQUESTS) throw new OutOfBudget(`subrequest budget spent (${MAX_SUBREQUESTS})`);
      return fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
    },
    left: () => MAX_SUBREQUESTS - used,
  };
}

/* ── chain reads ─────────────────────────────────────────────────────────── */

async function rpc(env, b, chain, method, params) {
  const r = await b.fetch(`https://services.abx.io/v1/rpc/${chain}`, {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ABX_KEY}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`${method} on ${chain}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${method} on ${chain}: ${JSON.stringify(j.error).slice(0, 160)}`);
  return j.result;
}

const pad = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const words = (hex) => (hex && hex.length > 2 ? hex.slice(2).match(/.{64}/g) || [] : []).map((w) => BigInt(`0x${w}`));

/** eth_call; null when it reverts or returns nothing. */
async function call(env, b, chain, to, data) {
  try {
    const res = await rpc(env, b, chain, 'eth_call', [{ to, data }, 'latest']);
    return res && res !== '0x' ? res : null;
  } catch (e) {
    if (e instanceof OutOfBudget) throw e;
    return null;
  }
}

function abiString(hex) {
  if (!hex || hex.length < 130) return null;
  const h = hex.slice(2), off = parseInt(h.slice(0, 64), 16) * 2;
  if (!Number.isSafeInteger(off) || off + 64 > h.length) return null;
  const len = parseInt(h.slice(off, off + 64), 16) * 2;
  if (!Number.isSafeInteger(len) || off + 64 + len > h.length || len > 4_000_000) return null;
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) bytes[i / 2] = parseInt(h.slice(off + 64 + i, off + 66 + i), 16);
  return new TextDecoder().decode(bytes);
}

/* ── metadata and images ─────────────────────────────────────────────────── */

function dataPayload(uri) {
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const head = uri.slice(0, comma), body = uri.slice(comma + 1);
  if (head.includes(';base64')) return Uint8Array.from(atob(body.replace(/\s/g, '')), (c) => c.charCodeAt(0));
  try { return new TextEncoder().encode(decodeURIComponent(body)); } catch { return new TextEncoder().encode(body); }
}

async function metadata(b, uri) {
  if (!uri) return null;
  try {
    if (uri.startsWith('data:application/json')) return JSON.parse(new TextDecoder().decode(dataPayload(uri)));
    if (uri.startsWith('https://')) return await (await b.fetch(uri, { redirect: 'follow' })).json();
  } catch (e) {
    if (e instanceof OutOfBudget) throw e;
  }
  return null;
}

const EXT = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** A preview the page can show: data: images are stored in the bucket, URLs pass through. */
async function keepImage(env, src, stem) {
  if (typeof src !== 'string') return null;
  if (src.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${src.slice(7)}`;
  if (src.startsWith('https://')) return src;
  const m = /^data:([^;,]+)/.exec(src);
  if (!m || !EXT[m[1]]) return null;
  const bytes = dataPayload(src);
  if (!bytes || bytes.length > 2_000_000) return null;
  const key = `img/${stem}.${EXT[m[1]]}`;
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: m[1], cacheControl: 'public, max-age=86400' } });
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
  const known = ((c.sale && c.sale.sales) || []).map((x) => x.id).filter(Number.isInteger);
  return [...new Set([...known, ...logs.map((l) => Number(BigInt(l.topics[2])))])].sort((a, b2) => a - b2);
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

async function saleStatus(env, b, c) {
  const { chainId: ch, address: tok } = c;
  const mw = words(await call(env, b, ch, tok, SEL.minter));
  const minter = mw.length ? `0x${mw[0].toString(16).padStart(40, '0')}` : null;
  const paused = Boolean((words(await call(env, b, ch, tok, SEL.paused))[0]) || 0n);
  const s = { minter, paused, minted: null, cap: null, sales: [] };
  if (minter === MINTER_721) {
    s.minted = Number(words(await call(env, b, ch, tok, SEL.totalSupply))[0] ?? 0n);
    const cap = words(await call(env, b, ch, tok, SEL.maxInvocations))[0];
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

async function ensName(env, b, addr) {
  const data = SEL.reverse + word(64) + word(60) + word(20) + addr.slice(2).toLowerCase().padEnd(64, '0');
  const raw = await call(env, b, 1, UNIVERSAL_RESOLVER, data);
  if (!raw) return null;
  const h = raw.slice(2), off = parseInt(h.slice(0, 64), 16) * 2, len = parseInt(h.slice(off, off + 64), 16) * 2;
  if (!len) return null;
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) bytes[i / 2] = parseInt(h.slice(off + 64 + i, off + 66 + i), 16);
  return new TextDecoder().decode(bytes) || null;
}

/* ── collections ─────────────────────────────────────────────────────────── */

async function scanChain(env, b, state, chain) {
  const head = parseInt(await rpc(env, b, chain.id, 'eth_blockNumber', []), 16) - chain.confirm;
  const from = (state.lastBlock[chain.id] ?? head) + 1;
  if (from > head) return [];
  const to = Math.min(head, from + LOG_SPAN - 1);
  const logs = await rpc(env, b, chain.id, 'eth_getLogs', [{ address: Object.keys(FACTORIES), topics: [DEPLOYED], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
  state.lastBlock[chain.id] = to;
  return logs.map((l) => ({
    chainId: chain.id, chain: chain.name, address: `0x${l.topics[1].slice(-40)}`, kind: FACTORIES[l.address.toLowerCase()],
    owner: `0x${l.topics[3].slice(-40)}`, block: parseInt(l.blockNumber, 16), tx: l.transactionHash,
  }));
}

async function enrich(env, b, c) {
  const { chainId: ch, address: tok } = c;
  c.name = abiString(await call(env, b, ch, tok, SEL.name));
  c.symbol = abiString(await call(env, b, ch, tok, SEL.symbol));
  const block = await rpc(env, b, ch, 'eth_getBlockByNumber', [`0x${c.block.toString(16)}`, false]);
  c.timestamp = parseInt(block.timestamp, 16);
  const meta = (await metadata(b, abiString(await call(env, b, ch, tok, SEL.contractURI)))) || {};
  c.description = typeof meta.description === 'string' ? meta.description.slice(0, 2000) : null;
  let image = meta.image;
  if (!image) {
    const sel = isEdition(c.kind) ? SEL.uri : SEL.tokenURI;
    const tmeta = await metadata(b, abiString(await call(env, b, ch, tok, sel + word(0))));
    image = tmeta && tmeta.image;
  }
  c.image = await keepImage(env, image, `${ch}-${tok.slice(2, 10)}`);
  c.sale = await saleStatus(env, b, c);
  c.ownerName = await ensName(env, b, c.owner);
  return c;
}

async function refreshCollections(env, b, state) {
  const obj = await env.BUCKET.get('contracts.json');
  const data = obj ? await obj.json() : { contracts: [] };
  const known = new Set(data.contracts.map((c) => `${c.chainId}:${c.address}`));
  for (const chain of CHAINS) {
    // First run: continue from the newest collection already listed, so nothing between the last pull and now is missed.
    if (state.lastBlock[chain.id] == null) {
      const blocks = data.contracts.filter((c) => c.chainId === chain.id).map((c) => c.block);
      if (blocks.length) state.lastBlock[chain.id] = Math.max(...blocks);
    }
  }
  for (const chain of CHAINS) {
    for (const c of await scanChain(env, b, state, chain)) {
      if (!known.has(`${c.chainId}:${c.address}`) && !state.queue.some((q) => q.address === c.address && q.chainId === c.chainId)) state.queue.push(c);
    }
  }
  let added = 0;
  while (state.queue.length && added < NEW_PER_RUN && b.left() > 16) {
    data.contracts.unshift(await enrich(env, b, state.queue[0]));
    state.queue.shift();
    added++;
  }
  const n = data.contracts.length;
  for (let k = 0; k < REFRESH_PER_RUN && n && b.left() > 8; k++) {
    const c = data.contracts[state.cursor % n];
    state.cursor = (state.cursor + 1) % n;
    c.sale = { ...(c.sale || {}), ...(await saleStatus(env, b, c)), minterInfo: c.sale && c.sale.minterInfo };
  }
  data.contracts.sort((a, c2) => c2.timestamp - a.timestamp);
  data.generated = Math.floor(Date.now() / 1000);
  data.failedChains = [];
  await env.BUCKET.put('contracts.json', JSON.stringify(data), { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' } });
  return added;
}

/* ── news ────────────────────────────────────────────────────────────────── */

const PROMPT = `You write one short news entry for a page that tracks ABX, an open protocol from Art Blocks.
Use only the release notes below. Return JSON only: {"title": "...", "body": "..."}.
title: 8 to 90 characters, plain words, may start with the package and version.
body: two or three plain sentences, 40 to 480 characters, saying what changed for someone using ABX.
No links, no domains, no markdown, no dashes, no opinions, no version numbers other than ones in the notes.`;

async function claude(env, b, notes) {
  const r = await b.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 400, messages: [{ role: 'user', content: `${PROMPT}\n\nRelease notes:\n${notes}` }] }),
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

function parseModel(text) {
  const m = /\{[\s\S]*\}/.exec(text || '');
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** One entry per release day: the model writes title and body, the code supplies date and sources. */
async function writeEntry(env, b, facts, notes) {
  for (const writer of [() => claude(env, b, notes), () => workersAI(env, notes)]) {
    try {
      const out = parseModel(await writer());
      if (!out) continue;
      const entry = { date: facts.date, tag: facts.tag, title: out.title, body: out.body, sources: facts.sources, automated: 'ai' };
      if (validateEntry(entry, facts).ok) return entry;
    } catch (e) {
      if (e instanceof OutOfBudget) throw e;
    }
  }
  return factsOnlyEntry(facts);
}

async function refreshNews(env, b, state) {
  const r = await b.fetch(RELEASES, { headers: { 'user-agent': 'abx-explorer', accept: 'application/vnd.github+json' } });
  if (!r.ok) return 0;
  const fresh = (await r.json()).filter((rel) => !rel.draft && !state.seenReleases.includes(rel.tag_name));
  if (!fresh.length) return 0;
  const byDay = new Map();
  for (const rel of fresh) {
    const date = rel.published_at.slice(0, 10);
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push(rel);
  }
  const obj = await env.BUCKET.get('news.json');
  const news = obj ? await obj.json() : { entries: [] };
  let written = 0;
  for (const [date, rels] of [...byDay].sort()) {
    if (b.left() < 4 || written >= 2) break;
    const versions = rels.map((x) => /@(\d+\.\d+\.\d+)$/.exec(x.tag_name)).filter(Boolean).map((m) => m[1]);
    const headline = rels.find((x) => x.tag_name.includes('abx-cli@')) || rels[0];
    const facts = {
      date, tag: 'Release', versions,
      title: `${headline.tag_name.replace('@artblocks/', '').replace('@', ' ')} released`,
      summary: `New releases: ${rels.map((x) => x.tag_name.replace('@artblocks/', '')).join(', ')}. The release notes list the changes.`,
      sources: rels.slice(0, 4).map((x) => [x.tag_name.replace('@artblocks/', '').slice(0, 40), x.html_url]),
    };
    const notes = rels.map((x) => `${x.tag_name}\n${(x.body || '').slice(0, 1500)}`).join('\n\n').slice(0, 4000);
    news.entries.unshift(await writeEntry(env, b, facts, notes));
    state.seenReleases.push(...rels.map((x) => x.tag_name));
    written++;
  }
  news.entries = news.entries.slice(0, 200);
  await env.BUCKET.put('news.json', JSON.stringify(news), { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' } });
  return written;
}

/* ── minter heartbeat ────────────────────────────────────────────────────── */

async function checkHeartbeat(env, b, state) {
  const obj = await env.BUCKET.get('heartbeat.json');
  const beat = obj ? (await obj.json()).ts : 0;
  const age = Math.floor(Date.now() / 1000) - beat;
  if (age > HEARTBEAT_MAX_S && state.alertedBeat !== beat) {
    const text = `ABX auto-minter on btm has been silent for ${Math.round(age / 60)} minutes (last heartbeat ${beat ? new Date(beat * 1000).toISOString() : 'never'}).`;
    const r = await b.fetch(`https://api.telegram.org/bot${env.TG_BOT}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TG_CHAT, text }),
    });
    if (r.ok) state.alertedBeat = beat;
  }
}

/* ── entry points ────────────────────────────────────────────────────────── */

async function loadState(env) {
  const obj = await env.BUCKET.get('worker-state.json');
  return { lastBlock: {}, queue: [], cursor: 0, seenReleases: [], alertedBeat: null, ...(obj ? await obj.json() : {}) };
}

export default {
  async scheduled(event, env) {
    const b = budgetFor(), state = await loadState(env);
    try {
      if (event.cron === '7 * * * *') {
        await checkHeartbeat(env, b, state);
        await refreshNews(env, b, state);
      } else {
        await refreshCollections(env, b, state);
      }
    } finally {
      await env.BUCKET.put('worker-state.json', JSON.stringify(state), { httpMetadata: { contentType: 'application/json' } });
    }
  },
};
