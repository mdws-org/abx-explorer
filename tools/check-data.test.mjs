/* Runs the cases in tools/data-cases.json against schema/*.schema.json through check-data.mjs.
   Each case edits one field of a known-good file and says whether the result must pass. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkData, validate, SchemaError } from './check-data.mjs';
import { buildOwnersIndex } from '../worker/owners.js';

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const W1 = '0x' + '1'.repeat(40), W2 = '0x' + '2'.repeat(40), A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);

const GOOD = {
  contracts: () => read('./fixtures/contracts.json'),
  owners: () => buildOwnersIndex(
    [{ chainId: 8453, address: A, name: 'One' }, { chainId: 1, address: B, name: 'Two' }],
    { [`8453:${A}`]: { [W1]: 2 }, [`1:${B}`]: { [W1]: 1, [W2]: 3 } },
    Date.parse('2026-11-17T01:30:15Z'), [1, 8453, 42161, 84532]),
};

function apply(doc, { op, path, value }) {
  let o = doc;
  for (const k of path.slice(0, -1)) o = o[k];
  const last = path[path.length - 1];
  if (op === 'set') o[last] = structuredClone(value);
  else if (op === 'delete') delete o[last];
  else throw new Error(`unknown op ${op}`);
  return doc;
}

for (const kind of Object.keys(GOOD)) {
  test(`${kind}: the known-good file passes`, () => {
    assert.deepEqual(checkData(kind, GOOD[kind]()), []);
  });
}

for (const c of read('./data-cases.json').cases) {
  test(`${c.target}: ${c.expect} ${c.name}`, () => {
    const errs = checkData(c.target, apply(GOOD[c.target](), c));
    if (c.expect === 'accept') assert.deepEqual(errs, []);
    else assert.ok(errs.length > 0, 'the schema accepted a file it must reject');
  });
}

test('a keyword the checker does not implement is a schema error, not a pass', () => {
  assert.throws(() => validate({ type: 'string', format: 'email' }, 'x'), SchemaError);
});
