/* ABX owner index: which wallets hold live tokens in which registered ABX collections.

   Source: resolver.abx.io. `/api/projects` lists every registered collection;
   `/api/project/<address>` returns one collection's state with its tokens. A wallet
   owns a collection when a live token has `owner == wallet` (ERC-721) or
   `holders[wallet] > 0` (ERC-1155). The count is the number of such live tokens.

   Published shape (version 1), addresses lowercase, collections referenced by index:
   { version, generatedAt, source, chains, collections: [{chainId, address, name}],
     owners: { "0xwallet": [[collectionIndex, count], ...] } }

   Everything here is pure: no fetches, no storage. */

export const OWNERS_VERSION = 1;
export const OWNERS_SOURCE = 'resolver.abx.io';

const ADDR = /^0x[0-9a-f]{40}$/;
const clean = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').slice(0, max) : '');

export const collectionKey = (c) => `${c.chainId}:${c.address}`;

/** The collections to scan: entries of `/api/projects` on the given chains, lowercase, one per chain+address.
    Throws when the list is not a usable array, so a broken source never yields a partial index. */
export function scanList(projects, chainIds) {
  if (!Array.isArray(projects) || !projects.length) throw new Error('projects list missing or empty');
  const chains = new Set(chainIds);
  const seen = new Set(), out = [];
  for (const p of projects) {
    if (!p || typeof p !== 'object' || !chains.has(p.chainId)) continue;
    const address = String(p.address || '').toLowerCase();
    if (!ADDR.test(address)) continue;
    const c = { chainId: p.chainId, address, name: clean(p.name, 200) };
    if (seen.has(collectionKey(c))) continue;
    seen.add(collectionKey(c));
    out.push(c);
  }
  if (!out.length) throw new Error('projects list has no collections on the scanned chains');
  return out;
}

const positive = (v) => {
  try { return BigInt(String(v).trim()) > 0n; } catch { return false; }
};

/** {wallet: liveTokenCount} for one `/api/project/<address>` response.
    Throws when the response is not a project state for `expect` (chainId and address). */
export function ownerCounts(project, expect) {
  if (!project || typeof project !== 'object' || !Array.isArray(project.tokens)) throw new Error('project state has no token list');
  if (expect) {
    if (Number(project.chainId) !== expect.chainId || String(project.address || '').toLowerCase() !== expect.address) {
      throw new Error(`project state is for ${project.chainId}:${project.address}, expected ${collectionKey(expect)}`);
    }
  }
  const counts = {};
  const add = (w) => {
    const a = String(w || '').toLowerCase();
    if (ADDR.test(a) && !/^0x0{40}$/.test(a)) counts[a] = (counts[a] || 0) + 1;
  };
  for (const t of project.tokens) {
    if (!t || t.lifecycle !== 'live') continue;
    const holders = t.holders && typeof t.holders === 'object' ? t.holders : null;
    if (holders) {
      const held = new Set();
      for (const [w, bal] of Object.entries(holders)) if (positive(bal)) held.add(w.toLowerCase());
      if (t.owner) held.add(String(t.owner).toLowerCase());
      for (const w of held) add(w);
    } else if (t.owner) {
      add(t.owner);
    }
  }
  return counts;
}

/** The published index. `collections` comes from scanList; `owned` maps collectionKey to ownerCounts.
    Throws unless every collection has owner data, so a published file always covers the full set. */
export function buildOwnersIndex(collections, owned, generatedAt, chainIds) {
  if (!Array.isArray(collections) || !collections.length) throw new Error('no collections');
  const missing = collections.filter((c) => !owned || !owned[collectionKey(c)]);
  if (missing.length) throw new Error(`owner data missing for ${missing.length} collection(s): ${missing.map(collectionKey).slice(0, 5).join(', ')}`);
  const owners = {};
  collections.forEach((c, i) => {
    for (const [w, n] of Object.entries(owned[collectionKey(c)])) {
      if (n > 0) (owners[w] ||= []).push([i, n]);
    }
  });
  const sorted = {};
  for (const w of Object.keys(owners).sort()) sorted[w] = owners[w];
  const present = new Set(collections.map((c) => c.chainId));
  return {
    version: OWNERS_VERSION,
    generatedAt: new Date(generatedAt).toISOString(),
    source: OWNERS_SOURCE,
    chains: (chainIds || [...present]).filter((id) => present.has(id)),
    collections: collections.map((c) => ({ chainId: c.chainId, address: c.address, name: c.name })),
    owners: sorted,
  };
}

/** The index straight from raw responses: the `/api/projects` list and {address: `/api/project/<address>` response}. */
export function indexFromStates(projects, states, generatedAt, chainIds) {
  const collections = scanList(projects, chainIds);
  const owned = {};
  for (const c of collections) {
    const s = states && (states[c.address] || states[collectionKey(c)]);
    if (s) owned[collectionKey(c)] = ownerCounts(s, c);
  }
  return buildOwnersIndex(collections, owned, generatedAt, chainIds);
}
