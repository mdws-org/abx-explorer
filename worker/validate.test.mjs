// Written before the summarizer: these cases encode the agreed rules for published news.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEntry, factsOnlyEntry } from './validate.js';

const facts = {
  date: '2026-11-05',
  versions: ['0.8.0', '0.7.4'],
  sources: [['Release notes', 'https://github.com/ArtBlocks/abx/releases/tag/%40artblocks%2Fabx-cli%400.8.0']],
  title: 'ABX CLI 0.8.0',
  summary: 'ABX CLI 0.8.0 was released. See the release notes for the changes.',
};
const good = {
  date: '2026-11-05',
  title: 'ABX CLI 0.8.0: creator wallets can pay their own gas',
  body: 'A creator wallet with enough native funds now pays transaction value and fees itself. When it cannot, zero-value calls fall back to ABX gas sponsorship.',
  sources: facts.sources,
};
const bad = (patch) => validateEntry({ ...good, ...patch }, facts);

test('a well-formed entry passes', () => assert.deepEqual(validateEntry(good, facts), { ok: true, errors: [] }));
test('a link in the body is rejected', () => assert.equal(bad({ body: good.body + ' Read more at https://evil.example now.' }).ok, false));
test('a bare domain in the body is rejected', () => assert.equal(bad({ body: good.body + ' Mint at free-abx.xyz today.' }).ok, false));
test('markup is rejected', () => assert.equal(bad({ title: 'ABX CLI <b>0.8.0</b> is out today' }).ok, false));
test('a version not in the facts is rejected', () => assert.equal(bad({ body: good.body.replace('fees itself', 'fees itself since 0.9.1') }).ok, false));
test('an em dash is rejected', () => assert.equal(bad({ title: 'ABX CLI 0.8.0 — wallets pay gas' }).ok, false));
test('a body over 480 characters is rejected', () => assert.equal(bad({ body: 'word '.repeat(120) }).ok, false));
test('a line break is rejected', () => assert.equal(bad({ body: good.body + '\nSecond paragraph that is long enough.' }).ok, false));
test('a model talking about itself is rejected', () => assert.equal(bad({ body: 'As an AI, I cannot verify this release, but it seems to add wallet payments.' }).ok, false));
test('a date that differs from the facts is rejected', () => assert.equal(bad({ date: '2026-11-06' }).ok, false));
test('a source off the allowed hosts is rejected', () => assert.equal(bad({ sources: [['x', 'https://evil.example/a']] }).ok, false));
test('an http source is rejected', () => assert.equal(bad({ sources: [['x', 'http://github.com/ArtBlocks/abx']] }).ok, false));
test('no sources is rejected', () => assert.equal(bad({ sources: [] }).ok, false));
test('the facts-only fallback itself passes', () => assert.equal(validateEntry(factsOnlyEntry(facts), facts).ok, true));
