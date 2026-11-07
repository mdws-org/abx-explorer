/* Copies of collection images that live on other hosts.

   A collection whose image is an https URL (the ABX resolver, an IPFS gateway, an artist's own
   site) shows a broken box whenever that host is down or blocked for the visitor. Each run copies a
   few of those images into the bucket under img/, so the page can load them from its own origin.

   - The original URL stays in `c.image`; the copy is described in `c.copy`
     ({ key, sha256, bytes, type, etag, lastModified, savedAt, checkedAt }); `c.copyAttemptAt` is the
     last attempt, successful or not, and `c.copyError` the last failure.
   - Run in two steps so a run killed mid-copy (CPU or wall-clock limit) cannot cost the collection
     data or retry the same image forever: `pickCopies` stamps `copyAttemptAt` on the batch before the
     caller writes contracts.json; `copyBatch` then fetches, and the caller writes again if it changed.
   - Due: never copied and not attempted for an hour, or copied and not attempted for a day. Oldest
     attempt first, so a host that keeps failing goes to the back of the queue.
   - Re-checks are conditional GETs (If-None-Match / If-Modified-Since): a 304 skips the body and the
     hash. A copy is rewritten only when its bytes changed or the stored object has gone missing; a
     failed check keeps the last good copy. Old keys are never deleted here.
   - The file type comes from the bytes, never from the host's content-type header; anything that is
     not PNG, JPEG, GIF, WebP or an SVG document is refused. SVGs are stored as attachments.
   - Only public https hosts on the default port: no IP literals, no local names, no userinfo, checked
     on the first URL and on every redirect hop (followed by hand, each hop counted in the budget). */

export const MAX_COPY_BYTES = 10 * 1024 * 1024;
export const COPIES_PER_RUN = 3;
export const MAX_HOPS = 3;
export const COPY_RESERVE = COPIES_PER_RUN * (MAX_HOPS + 1);
const RECHECK_S = 86_400, RETRY_S = 3_600, HOP_TIMEOUT_MS = 8_000, BATCH_MS = 25_000;
const UA = 'abx-explorer (+https://abx.thebenmeadows.com/)';

const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

/** The image type of `bytes` by its signature: 'png' | 'jpg' | 'gif' | 'webp' | 'svg' | null. */
export function sniff(bytes) {
  const b = bytes, at = (i, s) => [...s].every((ch, k) => b[i + k] === ch.charCodeAt(0));
  if (b.length >= 8 && b[0] === 0x89 && at(1, 'PNG\r\n\x1a\n')) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && (at(0, 'GIF87a') || at(0, 'GIF89a'))) return 'gif';
  if (b.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  // SVG: after an optional XML declaration, comments, a doctype and whitespace, the first element is <svg>.
  let head = new TextDecoder().decode(b.subarray(0, 65_536)).replace(/^﻿/, '');
  const prolog = /^\s*(<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!doctype\s+svg[^>]*>)/i;
  for (let m; (m = prolog.exec(head));) head = head.slice(m[0].length);
  return /^\s*<svg[\s/>]/i.test(head) ? 'svg' : null;
}

/** Refuse anything but a public https host on the default port. Returns the parsed URL. */
export function publicHttps(href) {
  let u;
  try { u = new URL(href); } catch { throw new Error('not a URL'); }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== 'https:') throw new Error('not https');
  if (u.username || u.password) throw new Error('credentials in the URL');
  if (u.port && u.port !== '443') throw new Error('non-default port');
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) throw new Error('IP address host');
  if (!h.includes('.') || /(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(h)) throw new Error('local host name');
  return u;
}

const discard = (r) => { try { r.body?.cancel(); } catch { /* already closed */ } };

/** Read a body into one buffer, refusing more than MAX_COPY_BYTES. */
async function readCapped(r) {
  const declared = Number(r.headers.get('content-length') || 0);
  if (declared > MAX_COPY_BYTES) { discard(r); throw new Error('over 10 MB'); }
  let buf = new Uint8Array(declared || 65_536), size = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > MAX_COPY_BYTES) { await reader.cancel(); throw new Error('over 10 MB'); }
    if (size + value.length > buf.length) {
      const grown = new Uint8Array(Math.min(MAX_COPY_BYTES, Math.max(buf.length * 2, size + value.length)));
      grown.set(buf.subarray(0, size));
      buf = grown;
    }
    buf.set(value, size);
    size += value.length;
  }
  return buf.subarray(0, size);
}

/** GET `url`, following up to MAX_HOPS redirects by hand. Returns { status: 304 } or
    { status: 200, bytes, etag, lastModified }. `prev` (a stored copy) makes the request conditional. */
export async function fetchImage(b, url, prev) {
  let u = publicHttps(url).href;
  const headers = { accept: 'image/*', 'user-agent': UA };
  if (prev && prev.etag) headers['if-none-match'] = prev.etag;
  if (prev && prev.lastModified) headers['if-modified-since'] = prev.lastModified;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const r = await b.fetch(u, { headers, signal: AbortSignal.timeout(HOP_TIMEOUT_MS) });
    if (r.status === 304) { discard(r); return { status: 304 }; }
    if (r.status >= 300 && r.status < 400) {
      const next = r.headers.get('location');
      discard(r);
      if (!next) throw new Error(`HTTP ${r.status} without a location`);
      u = publicHttps(new URL(next, u).href).href;
      continue;
    }
    if (!r.ok) { discard(r); throw new Error(`HTTP ${r.status}`); }
    const bytes = await readCapped(r);
    return { status: 200, bytes, etag: r.headers.get('etag'), lastModified: r.headers.get('last-modified') };
  }
  throw new Error('too many redirects');
}

const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
const lastAttempt = (c) => c.copyAttemptAt || (c.copy && c.copy.checkedAt) || 0;

/** Collections whose image is on another host and is due, oldest attempt first. */
export function dueCopies(contracts, nowS) {
  return contracts
    .filter((c) => typeof c.image === 'string' && c.image.startsWith('https://')
      && nowS - lastAttempt(c) >= (c.copy ? RECHECK_S : RETRY_S))
    .sort((x, y) => lastAttempt(x) - lastAttempt(y));
}

/** Choose this run's batch and stamp the attempt on each, before the caller writes contracts.json. */
export function pickCopies(contracts, nowS) {
  const batch = dueCopies(contracts, nowS).slice(0, COPIES_PER_RUN);
  for (const c of batch) c.copyAttemptAt = nowS;
  return batch;
}

/** Copy or re-check each collection in `batch`. Mutates the records; returns how many changed. */
export async function copyBatch(env, b, batch, nowS, isBudgetError) {
  const started = Date.now();
  let changed = 0;
  for (const c of batch) {
    if (b.left() < MAX_HOPS + 1 || Date.now() - started > BATCH_MS) break;
    try {
      const key = (ext) => `img/${c.chainId}-${c.address.slice(2).toLowerCase()}.${ext}`;
      const stored = c.copy && /^img\/[\w.-]+$/.test(c.copy.key) && (await env.BUCKET.head(c.copy.key));
      const got = await fetchImage(b, c.image, stored ? c.copy : null);
      if (got.status === 304) {
        c.copy.checkedAt = nowS;
      } else {
        const ext = sniff(got.bytes);
        if (!ext) throw new Error('not a PNG, JPEG, GIF, WebP or SVG image');
        const sha256 = hex(await crypto.subtle.digest('SHA-256', got.bytes));
        const k = key(ext);
        if (!stored || c.copy.sha256 !== sha256 || c.copy.key !== k) {
          await env.BUCKET.put(k, got.bytes, {
            httpMetadata: { contentType: TYPES[ext], cacheControl: 'public, max-age=86400', ...(ext === 'svg' ? { contentDisposition: 'attachment' } : {}) },
          });
          c.copy = { key: k, sha256, bytes: got.bytes.length, type: TYPES[ext], savedAt: nowS, checkedAt: nowS };
        } else {
          c.copy.checkedAt = nowS;
        }
        if (got.etag) c.copy.etag = got.etag.slice(0, 200); else delete c.copy.etag;
        if (got.lastModified) c.copy.lastModified = got.lastModified.slice(0, 100); else delete c.copy.lastModified;
      }
      delete c.copyError;
      changed++;
    } catch (e) {
      if (isBudgetError(e)) break;
      c.copyError = String(e.message).slice(0, 200);
      changed++;
      console.warn('image copy failed', c.chainId, c.address, e.message);
    }
  }
  return changed;
}
