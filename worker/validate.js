/* Deterministic checks for a news entry before it is published.

   The model writes only `title` and `body`. Dates and sources come from the
   facts the Worker gathered, never from the model. An entry that fails any
   check is replaced by a facts-only entry; it is never published as written.

   facts = { date: "YYYY-MM-DD", versions: ["0.8.0", ...], sources: [[label, url], ...] } */

export const SOURCE_HOSTS = new Set([
  'github.com', 'docs.abx.io', 'www.npmjs.com', 'fs.abx.io', 'www.abx.io', 'abx.thebenmeadows.com',
]);

// Any word.word where the second part is letters only: catches every domain ending, new or old.
// Version numbers (0.8.1) and abbreviations (e.g.) do not match.
const URLISH = /https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\b/i;
const MARKUP = /[<>`*_#[\]]|&[a-z#0-9]+;|[​-‏‪-‮⁦-⁩]/i;
const DASHES = /[–—]/;
const SELF = /\b(as an ai|language model|i cannot|i can't|i'm sorry)\b/i;
const VERSION = /\bv?(\d+\.\d+\.\d+)\b/g;

function textErrors(field, s, min, max) {
  const errs = [];
  if (typeof s !== 'string') return [`${field} is not a string`];
  if (s.length < min || s.length > max) errs.push(`${field} length ${s.length} outside ${min}..${max}`);
  if (/[\r\n]/.test(s)) errs.push(`${field} has a line break`);
  if (URLISH.test(s)) errs.push(`${field} contains a link or domain`);
  if (MARKUP.test(s)) errs.push(`${field} contains markup characters`);
  if (DASHES.test(s)) errs.push(`${field} contains an em or en dash`);
  if (SELF.test(s)) errs.push(`${field} talks about itself`);
  return errs;
}

export function validateEntry(entry, facts) {
  const errors = [];
  if (!entry || typeof entry !== 'object') return { ok: false, errors: ['entry is not an object'] };
  if (entry.date !== facts.date) errors.push(`date ${entry.date} is not the facts date ${facts.date}`);
  errors.push(...textErrors('title', entry.title, 8, 90));
  errors.push(...textErrors('body', entry.body, 40, 480));
  const known = new Set(facts.versions || []);
  for (const field of ['title', 'body']) {
    for (const m of String(entry[field] || '').matchAll(VERSION)) {
      if (!known.has(m[1])) errors.push(`${field} names version ${m[1]}, which is not in the facts`);
    }
  }
  const sources = entry.sources;
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 4) {
    errors.push('sources must be 1 to 4 items');
  } else {
    for (const s of sources) {
      let host = '';
      try { const u = new URL(s[1]); host = u.protocol === 'https:' ? u.host : ''; } catch { /* host stays empty */ }
      if (!SOURCE_HOSTS.has(host)) errors.push(`source ${s[1]} is not on an allowed https host`);
      if (typeof s[0] !== 'string' || s[0].length < 1 || s[0].length > 40) errors.push('source label must be 1 to 40 characters');
    }
  }
  return { ok: errors.length === 0, errors };
}

/* The entry published when the model is unavailable or its text fails a check. */
export function factsOnlyEntry(facts) {
  return { date: facts.date, tag: facts.tag || 'Release', title: facts.title, body: facts.summary, sources: facts.sources, automated: 'facts' };
}
