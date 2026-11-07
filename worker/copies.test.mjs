import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniff, dueCopies, pickCopies, publicHttps, fetchImage, copyBatch } from './copies.js';

const enc = (s) => new TextEncoder().encode(s);

test('sniff: an HTML page that contains an <svg> is not an SVG image', () => {
  assert.equal(sniff(enc('<!-- upstream error -->\n<html><body><svg xmlns="http://www.w3.org/2000/svg"></svg></body></html>')), null);
  assert.equal(sniff(enc('<html><svg></svg></html>')), null);
});

test('sniff: SVG documents with a declaration, comments, a doctype or a bare root are accepted', () => {
  for (const s of ['<svg xmlns="http://www.w3.org/2000/svg"/>', '<svg/>', '﻿  <?xml version="1.0"?>\n<!-- c --><!DOCTYPE  svg PUBLIC "x" "y">\n<svg>', '<!doctype\nsvg><svg>'])
    assert.equal(sniff(enc(s)), 'svg', s);
  assert.equal(sniff(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
});

test('dueCopies: images that keep failing go behind a copy due for its daily check', () => {
  const now = 1_000_000;
  const rows = [
    { image: 'https://ok.example/a', copy: { key: 'img/x.png', checkedAt: now - 90_000 }, copyAttemptAt: now - 90_000 },
    ...[1, 2, 3, 4].map((i) => ({ image: `https://dead.example/${i}`, copyAttemptAt: now - 4_000 })),
    { image: 'https://new.example/n' },
  ];
  const order = dueCopies(rows, now).map((c) => c.image);
  assert.equal(order[0], 'https://new.example/n');
  assert.equal(order[1], 'https://ok.example/a');
});

test('pickCopies: stamps the attempt, so a run killed while copying does not pick the same images next time', () => {
  const now = 2_000_000;
  const rows = [1, 2, 3, 4].map((i) => ({ image: `https://h.example/${i}` }));
  const first = pickCopies(rows, now).map((c) => c.image);
  const second = pickCopies(rows, now + 3_600).map((c) => c.image);
  assert.deepEqual(second[0], 'https://h.example/4');
  assert.ok(!first.includes(second[0]));
});

test('publicHttps: refuses IP literals, local names, ports, credentials and other schemes', () => {
  for (const u of ['https://169.254.169.254/', 'https://10.0.0.1/x', 'https://[::1]/', 'https://localhost/', 'https://printer.local/',
    'https://intranet/', 'https://a.example:8443/', 'https://u:p@a.example/', 'http://a.example/', 'ftp://a.example/'])
    assert.throws(() => publicHttps(u), u);
  assert.equal(publicHttps('https://resolver.abx.io/t/1/0xab/0/image').host, 'resolver.abx.io');
});

function budget(responses) {
  const seen = [];
  return {
    seen,
    left: () => 40,
    async fetch(url, init) { seen.push({ url, headers: init.headers }); return responses.shift()(url); },
  };
}

test('fetchImage: a redirect to an IP address is refused', async () => {
  const b = budget([() => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret' } })]);
  await assert.rejects(fetchImage(b, 'https://a.example/i'), /IP address/);
  assert.equal(b.seen.length, 1);
});

test('fetchImage: a re-check sends the validators and a 304 skips the body', async () => {
  const b = budget([() => new Response(null, { status: 304 })]);
  const got = await fetchImage(b, 'https://a.example/i', { etag: '"v1"', lastModified: 'Tue, 01 Oct 2026 00:00:00 GMT' });
  assert.equal(got.status, 304);
  assert.equal(b.seen[0].headers['if-none-match'], '"v1"');
});

test('copyBatch: an unchanged image whose stored object went missing is written again', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', png))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const puts = [];
  const env = { BUCKET: { head: async () => null, put: async (k) => { puts.push(k); } } };
  const c = { chainId: 1, address: '0x' + 'a'.repeat(40), image: 'https://a.example/i', copy: { key: `img/1-${'a'.repeat(40)}.png`, sha256: sha, checkedAt: 0 } };
  const b = budget([() => new Response(png, { status: 200 })]);
  await copyBatch(env, b, [c], 5_000_000, () => false);
  assert.deepEqual(puts, [`img/1-${'a'.repeat(40)}.png`]);
  assert.equal(b.seen[0].headers['if-none-match'], undefined); // object missing: unconditional GET
});
