import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanList, ownerCounts, buildOwnersIndex, indexFromStates } from './owners.js';

const MAIN = [1, 8453, 42161, 84532];
const A = '0xAAaa000000000000000000000000000000000001';
const B = '0xbbbb000000000000000000000000000000000002';
const C = '0xCCCC000000000000000000000000000000000003';
const COLL721 = '0x1111111111111111111111111111111111111111';
const COLL1155 = '0x2222222222222222222222222222222222222222';
const TESTNET = '0x3333333333333333333333333333333333333333';

const projects = [
  { chainId: 8453, address: COLL721.toUpperCase().replace('0X', '0x'), name: 'Series', contractType: 'code' },
  { chainId: 1, address: COLL1155, name: 'Edition', contractType: 'edition-code' },
  { chainId: 11155111, address: TESTNET, name: 'Sepolia', contractType: 'code' },
];
const states = {
  [COLL721]: {
    chainId: 8453, address: COLL721.toUpperCase().replace('0X', '0x'),
    tokens: [
      { tokenId: '0', lifecycle: 'live', owner: A },
      { tokenId: '1', lifecycle: 'live', owner: A.toLowerCase() },
      { tokenId: '2', lifecycle: 'live', owner: B },
      { tokenId: '3', lifecycle: 'unminted', owner: C },
      { tokenId: '4', lifecycle: 'burned', owner: C },
    ],
  },
  [COLL1155]: {
    chainId: 1, address: COLL1155,
    tokens: [
      { tokenId: '0', lifecycle: 'live', owner: null, holders: { [A]: '5', [C]: '0' } },
      { tokenId: '1', lifecycle: 'live', owner: null, holders: { [C.toLowerCase()]: '2' } },
      { tokenId: '2', lifecycle: 'unminted', owner: null, holders: { [B]: '1' } },
    ],
  },
};
const T = Date.UTC(2026, 10, 6, 12);

test('ERC-721 owners and ERC-1155 holders are counted per live token, case-folded', () => {
  const ix = indexFromStates(projects, states, T, MAIN);
  assert.deepEqual(ix.collections, [
    { chainId: 8453, address: COLL721, name: 'Series' },
    { chainId: 1, address: COLL1155, name: 'Edition' },
  ]);
  assert.deepEqual(ix.owners, {
    [A.toLowerCase()]: [[0, 2], [1, 1]],
    [B]: [[0, 1]],
    [C.toLowerCase()]: [[1, 1]],
  });
  assert.equal(ix.version, 1);
  assert.equal(ix.source, 'resolver.abx.io');
  assert.equal(ix.generatedAt, '2026-11-06T12:00:00.000Z');
  assert.deepEqual(ix.chains, [1, 8453]);
});

test('every key in the output is lowercase', () => {
  const ix = indexFromStates(projects, states, T, MAIN);
  for (const w of Object.keys(ix.owners)) assert.equal(w, w.toLowerCase());
  for (const c of ix.collections) assert.equal(c.address, c.address.toLowerCase());
});

test('non-live tokens are excluded', () => {
  const counts = ownerCounts(states[COLL721], { chainId: 8453, address: COLL721 });
  assert.equal(counts[C.toLowerCase()], undefined);
  const ed = ownerCounts(states[COLL1155], { chainId: 1, address: COLL1155 });
  assert.equal(ed[B], undefined);
});

test('a zero or unparseable 1155 balance does not count', () => {
  const s = { chainId: 1, address: COLL1155, tokens: [{ lifecycle: 'live', holders: { [A]: '0', [B]: 'abc', [C]: '-1' } }] };
  assert.deepEqual(ownerCounts(s, { chainId: 1, address: COLL1155 }), {});
});

test('collections on chains outside the list are left out', () => {
  const ix = indexFromStates(projects, states, T, MAIN);
  assert.ok(!ix.collections.some((c) => c.address === TESTNET));
});

test('fail closed: a missing or empty projects list throws', () => {
  assert.throws(() => indexFromStates(null, states, T, MAIN));
  assert.throws(() => indexFromStates({ error: 'down' }, states, T, MAIN));
  assert.throws(() => indexFromStates([], states, T, MAIN));
  assert.throws(() => scanList([{ chainId: 11155111, address: TESTNET }], MAIN));
});

test('fail closed: a collection without owner data blocks the whole index', () => {
  assert.throws(() => indexFromStates(projects, { [COLL721]: states[COLL721] }, T, MAIN), /missing/);
  const list = scanList(projects, MAIN);
  assert.throws(() => buildOwnersIndex(list, { [`8453:${COLL721}`]: { [B]: 1 } }, T, MAIN), /missing/);
});

test('a project state for a different contract is refused', () => {
  assert.throws(() => ownerCounts(states[COLL1155], { chainId: 8453, address: COLL721 }));
  assert.throws(() => ownerCounts({ chainId: 1, address: COLL1155 }, { chainId: 1, address: COLL1155 }));
});

test('a collection listed twice appears once', () => {
  const ix = indexFromStates([...projects, projects[0]], states, T, MAIN);
  assert.equal(ix.collections.length, 2);
});
