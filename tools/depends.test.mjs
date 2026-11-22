/* Runs the cases in tools/depends-cases.json against web/depends.js, the same file the page loads. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const cases = JSON.parse(readFileSync(new URL('./depends-cases.json', import.meta.url), 'utf8'));
const root = { URL };
vm.runInNewContext(readFileSync(new URL('../web/depends.js', import.meta.url), 'utf8'), { globalThis: root, URL });
const { where, rows } = root.abxDepends;
const STATES = new Set(['chain', 'pinned', 'host', 'open', 'unknown']);

for (const c of cases.where) {
  test(`where: ${c.name}`, () => {
    assert.deepEqual({ ...where(c.uri) }, { where: c.where, host: c.host });
  });
}

for (const c of cases.rows) {
  test(`rows: ${c.name}`, () => {
    const got = rows(c.from);
    for (const r of got) {
      assert.ok(STATES.has(r.state), `${r.label} has state ${r.state}`);
      assert.equal(typeof r.text, 'string');
    }
    for (const want of c.rows) {
      const r = got.find((x) => x.label === want.label);
      assert.ok(r, `no ${want.label} row`);
      assert.equal(r.state, want.state, `${want.label}: ${r.text}`);
      for (const s of want.says) assert.ok(r.text.includes(s), `${want.label} does not say "${s}": ${r.text}`);
      for (const s of want.never || []) assert.ok(!r.text.includes(s), `${want.label} says "${s}": ${r.text}`);
    }
    for (const label of c.absent || []) assert.ok(!got.some((x) => x.label === label), `${label} row is present`);
  });
}
