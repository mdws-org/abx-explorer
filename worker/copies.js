/* Copies of collection images that live on other hosts.

   A collection whose image is an https URL (the ABX resolver, an IPFS gateway, an artist's own
   site) shows a broken box whenever that host is down or blocked for the visitor. Each run copies a
   few of those images into the bucket under img/, so the page can load them from its own origin.

   - The original URL stays in `c.image`; the copy is described in `c.copy`
     ({ key, sha256, bytes, type, savedAt, checkedAt }), and `c.copyError` holds the last failure.
   - A copy is re-checked once a day and rewritten only when its bytes changed. A failed check keeps
     the last good copy; an image never copied is retried after an hour.
   - The file type comes from the bytes, never from the host's content-type header; anything that is
     not PNG, JPEG, GIF, WebP or SVG is refused. SVGs are stored as attachments, like the data: images.
   - Redirects are followed by hand (https only, a few hops), each hop counted against the run's budget. */

export const MAX_COPY_BYTES = 10 * 1024 * 1024;
export const COPIES_PER_RUN = 3;
const MAX_HOPS = 3;
const RECHECK_S = 86_400, RETRY_S = 3_600;

const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

/** The image type of `bytes` by its signature: 'png' | 'jpg' | 'gif' | 'webp' | 'svg' | null. */
export function sniff(bytes) {
  const b = bytes, at = (i, s) => [...s].every((ch, k) => b[i + k] === ch.charCodeAt(0));
  if (b.length >= 8 && b[0] === 0x89 && at(1, 'PNG\r\n\x1a\n')) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && (at(0, 'GIF87a') || at(0, 'GIF89a'))) return 'gif';
  if (b.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  // SVG: text whose first tag is an XML declaration, a comment, a doctype or <svg>, and that has an <svg> element.
  const head = new TextDecoder().decode(b.subarray(0, 4096)).replace(/^﻿/, '').trimStart();
  if (/^<(\?xml|!--|!doctype svg|svg[\s>])/i.test(head) && /<svg[\s>]/i.test(new TextDecoder().decode(b.subarray(0, 65_536)))) return 'svg';
  return null;
}

/** Body bytes of `url`, following up to MAX_HOPS https redirects; refuses bodies over MAX_COPY_BYTES. */
export async function fetchImage(b, url) {
  let u = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const r = await b.fetch(u, { headers: { accept: 'image/*' } });
    if (r.status >= 300 && r.status < 400) {
      const next = r.headers.get('location');
      if (!next) throw new Error(`HTTP ${r.status} without a location`);
      u = new URL(next, u).href;
      if (!u.startsWith('https://')) throw new Error('redirect to a non-https address');
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (Number(r.headers.get('content-length') || 0) > MAX_COPY_BYTES) throw new Error('over 10 MB');
    const reader = r.body.getReader(), parts = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_COPY_BYTES) { await reader.cancel(); throw new Error('over 10 MB'); }
      parts.push(value);
    }
    const out = new Uint8Array(size);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  throw new Error('too many redirects');
}

const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Collections whose image is on another host, most overdue first: never copied, then oldest check. */
export function dueCopies(contracts, nowS) {
  const due = (c) => {
    if (typeof c.image !== 'string' || !c.image.startsWith('https://')) return false;
    const checked = (c.copy && c.copy.checkedAt) || c.copyCheckedAt || 0;
    return nowS - checked >= (c.copy ? RECHECK_S : RETRY_S);
  };
  const at = (c) => (c.copy ? c.copy.checkedAt : -1);
  return contracts.filter(due).sort((x, y) => at(x) - at(y));
}

/** Copy or re-check up to COPIES_PER_RUN outside images. Mutates the records in `contracts`. */
export async function refreshCopies(env, b, contracts, nowS, isBudgetError) {
  for (const c of dueCopies(contracts, nowS).slice(0, COPIES_PER_RUN)) {
    if (b.left() < MAX_HOPS + 1) break;
    try {
      const bytes = await fetchImage(b, c.image);
      const ext = sniff(bytes);
      if (!ext) throw new Error('not a PNG, JPEG, GIF, WebP or SVG image');
      const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
      const key = `img/${c.chainId}-${c.address.slice(2).toLowerCase()}.${ext}`;
      if (!c.copy || c.copy.sha256 !== sha256 || c.copy.key !== key) {
        await env.BUCKET.put(key, bytes, {
          httpMetadata: { contentType: TYPES[ext], cacheControl: 'public, max-age=86400', ...(ext === 'svg' ? { contentDisposition: 'attachment' } : {}) },
        });
        if (c.copy && c.copy.key !== key) await env.BUCKET.delete(c.copy.key);
        c.copy = { key, sha256, bytes: bytes.length, type: TYPES[ext], savedAt: nowS, checkedAt: nowS };
      } else {
        c.copy.checkedAt = nowS;
      }
      delete c.copyError;
      delete c.copyCheckedAt;
    } catch (e) {
      if (isBudgetError(e)) throw e;
      c.copyError = String(e.message).slice(0, 200);
      if (c.copy) c.copy.checkedAt = nowS; // the last good copy stays; try again tomorrow
      else c.copyCheckedAt = nowS;
      console.warn('image copy failed', c.chainId, c.address, e.message);
    }
  }
}
