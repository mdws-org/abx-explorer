import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

// An R2 bucket in memory: put stamps `uploaded` from a clock that only moves forward.
function bucket(seed = {}) {
  const store = new Map();
  let clock = Date.parse('2026-11-06T00:00:00Z');
  const B = {
    store,
    seed(k, v) { store.set(k, { body: typeof v === 'string' ? v : JSON.stringify(v), uploaded: new Date(clock += 1000) }); },
    async get(k) { const e = store.get(k); return e ? { uploaded: e.uploaded, json: async () => JSON.parse(e.body) } : null; },
    async head(k) { const e = store.get(k); return e ? { uploaded: e.uploaded } : null; },
    async put(k, v) { B.seed(k, v); },
    json(k) { const e = store.get(k); return e && JSON.parse(e.body); },
  };
  for (const [k, v] of Object.entries(seed)) B.seed(k, v);
  return B;
}

const reply = (v, status = 200) => new Response(typeof v === 'string' ? v : JSON.stringify(v), { status });

// Chains report nothing new; the resolver answers from `projects` and `project(address)`.
function stubFetch({ projects = [], project = () => reply('', 404) } = {}) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://services.abx.io/')) {
      const { method } = JSON.parse(init.body);
      return reply({ result: method === 'eth_blockNumber' ? '0x1000' : method === 'eth_getLogs' ? [] : '0x' });
    }
    if (u === 'https://resolver.abx.io/api/projects') return reply(projects);
    const m = /\/api\/project\/(0x[0-9a-f]{40})$/.exec(u);
    if (m) return project(m[1]);
    if (u.startsWith('https://api.telegram.org/')) return reply({ ok: true });
    return reply('', 404);
  };
}

async function run(BUCKET, cron) {
  const warn = console.warn;
  console.warn = () => {};
  try { await worker.scheduled({ cron }, { BUCKET, AI: { run: async () => ({ response: '' }) } }); } finally { console.warn = warn; }
}

const QUARTER = '*/15 * * * *', HOURLY = '7 * * * *';
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), W1 = '0x' + '1'.repeat(40), W2 = '0x' + '2'.repeat(40);
const nowS = () => Math.floor(Date.now() / 1000);
const live = (chainId, address, owner) => reply({ chainId, address, tokens: [{ tokenId: '0', lifecycle: 'live', owner }] });

test('owner index: generatedAt is the oldest read, so a collection that keeps failing ages the file', async () => {
  const old = nowS() - 3 * 86400;
  const R2 = bucket({
    'state/abx-owners.json': { collections: { [`8453:${A}`]: { fetchedAt: old, owners: { [W1]: 1 } }, [`8453:${B}`]: { fetchedAt: old, owners: {} } } },
  });
  stubFetch({
    projects: [{ chainId: 8453, address: A }, { chainId: 8453, address: B }],
    project: (a) => (a === A ? reply('down', 500) : live(8453, B, W2)),
  });
  await run(R2, QUARTER);
  const ix = R2.json('abx-owners.json');
  assert.equal(ix.generatedAt, new Date(old * 1000).toISOString());
  assert.deepEqual(ix.owners, { [W1]: [[0, 1]], [W2]: [[1, 1]] });
});

test('owner index: one short projects list neither drops a collection nor publishes; two in a row remove it', async () => {
  const t = nowS() - 600;
  const R2 = bucket({
    'state/abx-owners.json': { collections: { [`8453:${A}`]: { fetchedAt: t, owners: { [W1]: 1 } }, [`84532:${B}`]: { fetchedAt: t, owners: { [W2]: 1 } } } },
  });
  stubFetch({ projects: [{ chainId: 8453, address: A }], project: () => live(8453, A, W1) });
  await run(R2, QUARTER);
  assert.equal(R2.json('abx-owners.json'), undefined);
  assert.ok(R2.json('state/abx-owners.json').collections[`84532:${B}`]);
  await run(R2, QUARTER);
  const ix = R2.json('abx-owners.json');
  assert.deepEqual(ix.collections.map((c) => c.address), [A]);
  assert.equal(R2.json('state/abx-owners.json').collections[`84532:${B}`], undefined);
});

const quietNews = (extra = {}) => ({ seenReleases: ['abx-cli@1.0.0'], alerts: { minter: nowS(), refresh: nowS() }, lease: 0, ...extra });
const entry = (title, body) => ({ date: '2026-11-06', tag: 'Release', title, body, sources: [['abx-cli 1.1.0', 'https://github.com/ArtBlocks/abx']] });

test('feed: the hourly run rewrites a feed.xml older than news.json', async () => {
  const R2 = bucket({ 'state/news.json': quietNews() });
  R2.seed('feed.xml', '<feed/>');
  R2.seed('news.json', { entries: [entry('abx-cli 1.1.0 released', 'The command line tool can now upload a folder.')] });
  stubFetch();
  await run(R2, HOURLY);
  assert.match(R2.store.get('feed.xml').body, /abx-cli 1\.1\.0 released/);
});

test('feed: characters XML 1.0 forbids are dropped', async () => {
  const R2 = bucket({ 'state/news.json': quietNews(), 'news.json': { entries: [entry('abx-cli\u000b 1.1.0', 'Uploads\u0001 are checked first.')] } });
  stubFetch();
  await run(R2, HOURLY);
  const feed = R2.store.get('feed.xml').body;
  assert.match(feed, /<title>abx-cli 1\.1\.0<\/title>/);
  assert.doesNotMatch(feed, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
});
