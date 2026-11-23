/* Runs the cases in tools/mints-cases.json against web/mints.js, the same file the page loads. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const cases = JSON.parse(readFileSync(new URL('./mints-cases.json', import.meta.url), 'utf8'));
const root = {};
vm.runInNewContext(readFileSync(new URL('../web/mints.js', import.meta.url), 'utf8'), { globalThis: root });
const { count, editionIds } = root.abxMints;

for (const c of cases.count) {
  test(`count: ${c.name}`, () => assert.equal(count({ minted: c.minted, next: c.next, supply: c.supply }), c.count));
}
for (const c of cases.edition) {
  test(`edition: ${c.name}`, () => assert.deepEqual([...editionIds({ saleIds: c.saleIds, supplies: c.supplies })], c.ids));
}
