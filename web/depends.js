/* What a collection depends on, from what its contract says: where its metadata, program, live view and
   image come from, and what its owner can still change. Pure functions over values already read from
   chain; web/app.js does the reading. Cases: tools/depends-cases.json.

   States: chain   on chain, and the collection's contract can no longer change it
           pinned  named by its own hash on IPFS or Arweave: the file cannot change, but someone has to keep serving it
           host    a server someone runs: it can change or stop
           open    not at a server, and the owner can still change it
           unknown not read, or a lock that decides the answer was not read

   A row never says more than was read. A contract that builds a value (a renderer or a reader) is named,
   and what that contract itself reads is said to be unchecked. */
(function (root) {
    'use strict';

    const ARWEAVE_HOST = /(^|\.)arweave\.net$/;
    const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
    const TX_LAST = 'AEIMQUYcgkosw048';   // the last character of 32 bytes in base64url leaves two bits unused

    /* A CID: version 0 by its shape, version 1 (base32) by decoding it and checking that it is a version, a
       codec and a hash whose stated length is the length it has. A name that only looks like one is refused. */
    function validCid(id) {
        if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(id)) return true;
        if (!/^b[a-z2-7]{20,120}$/.test(id)) return false;
        const bytes = [];
        let bits = 0, acc = 0;
        for (const ch of id.slice(1)) {
            acc = (acc << 5) | B32.indexOf(ch); bits += 5;
            if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); acc &= (1 << bits) - 1; }
        }
        let at = 0;
        const varint = () => { let v = 0, shift = 0; for (;;) { if (at >= bytes.length || shift > 21) return -1; const b = bytes[at++]; v |= (b & 0x7f) << shift; if (!(b & 0x80)) return v; shift += 7; } };
        if (varint() !== 1 || varint() < 0 || varint() < 0) return false;   // version 1, a codec, a hash function
        const length = varint();
        return length > 0 && bytes.length - at === length;
    }
    const validTx = (id) => /^[A-Za-z0-9_-]{43}$/.test(id) && TX_LAST.includes(id[42]);   // an Arweave transaction id
    const first = (s) => s.split(/[/?#]/)[0];

    /* Where one address lives: { where: 'chain' | 'ipfs' | 'arweave' | 'host' | 'unknown', host }.
       IPFS and Arweave are claimed only when the address holds a hash or transaction id in the place a
       gateway reads it from; any other address at such a host is just that host. An IPNS name is a host:
       whoever holds its key can repoint it. */
    function where(uri) {
        const none = { where: 'unknown', host: null };
        if (typeof uri !== 'string' || !uri) return none;
        if (uri.startsWith('data:')) return { where: 'chain', host: null };
        if (uri.startsWith('ipfs://')) return validCid(first(uri.slice(7))) ? { where: 'ipfs', host: null } : none;
        if (uri.startsWith('ar://')) return validTx(first(uri.slice(5))) ? { where: 'arweave', host: null } : none;
        if (!/^https?:\/\//i.test(uri)) return none;
        let u;
        try { u = new URL(uri); } catch { return none; }
        const host = u.hostname.toLowerCase();
        if (!host) return none;
        if (ARWEAVE_HOST.test(host) && validTx(first(u.pathname.slice(1)))) return { where: 'arweave', host };
        const labels = host.split('.');
        if (labels[1] === 'ipfs' && labels.length > 3 && validCid(labels[0])) return { where: 'ipfs', host };
        if (u.pathname.startsWith('/ipfs/') && validCid(first(u.pathname.slice(6)))) return { where: 'ipfs', host };
        return { where: 'host', host };
    }

    /* Contract text shown in a row: no control, direction, line-separator or invisible filler characters,
       which could reorder a row or start what looks like a new one. The joiners U+200C and U+200D stay:
       Persian and Indic names need them. */
    const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;
    const clean = (s) => Array.from(String(s).replace(UNSAFE, '')).slice(0, 120).join('').trim();

    const NOT_READ = { state: 'unknown', text: 'Not read.' };
    const PLACE = {
        chain: () => ({ state: 'chain', text: 'On chain, in the token itself.' }),
        ipfs: (w) => ({ state: 'pinned', text: `On IPFS, named by its own hash${w.host ? ` (through ${w.host})` : ''}. The file cannot change; someone has to keep it pinned.` }),
        arweave: (w) => ({ state: 'pinned', text: `On Arweave, named by its own hash${w.host ? ` (through ${w.host})` : ''}. The file cannot change.` }),
        host: (w) => ({ state: 'host', text: `Served by ${w.host}. Whoever runs that server can change it or stop.` }),
        unknown: () => NOT_READ,
    };
    const placed = (uri) => { const w = where(uri); return PLACE[w.where](w); };
    const built = (addr) => `Built by contract ${addr} each time it is asked for. What that contract reads was not checked.`;
    const parts = (n) => `${n} part${n === 1 ? '' : 's'}`;

    /* A lock on top of a place. `locked` is true, false, or anything else when it was not read. */
    function withLock(at, locked, words) {
        if (at.state === 'unknown') return at;
        if (locked === true) return { state: at.state, text: `${at.text} ${words.locked}` };
        // What it points at now may be fixed; the pointer is not.
        if (locked === false) return { state: at.state === 'host' ? 'host' : 'open', text: `${at.text} ${words.open}` };
        return { state: at.state === 'host' ? 'host' : 'unknown', text: `${at.text} ${words.unread}` };
    }
    const FIELD_LOCK = { locked: 'This field is locked.', open: 'The owner can still point this field somewhere else.', unread: 'Whether this field is locked was not read.' };
    const URI_LOCK = { locked: 'That is locked.', open: 'The owner can still point it somewhere else.', unread: 'Whether that is locked was not read.' };

    const CREATOR_LOCK = { locked: 'This field is locked.', open: 'The owner can still change it.', unread: 'Whether it is locked was not read.' };
    const WEAK = { host: 3, pinned: 2, chain: 1 };

    /* Where a field's value lives, from its representation. Null when the field is unset; `unplaced` when it
       is set but says nothing usable; `hashOnly` when the contract holds a hash and not the file. */
    function fieldPlace(f) {
        if (!f || !f.rep) return null;
        const unplaced = { state: 'unknown', unplaced: true, text: 'Not read.' };
        switch (f.rep) {
            case 'inline': case 'inline-gzip':
                return { state: 'chain', text: 'On chain, in the contract.' };
            case 'renderer':
                return f.value ? { state: 'chain', text: built(f.value) } : unplaced;
            case 'reader': case 'reader-gzip':
                return { state: 'chain', text: `Read on chain through ${f.value ? `contract ${f.value}` : 'another contract'}. What that contract reads was not checked.` };
            case 'ipfs':
                return validCid(first(String(f.value || ''))) ? PLACE.ipfs({ host: null }) : unplaced;
            case 'arweave':
                return validTx(first(String(f.value || ''))) ? PLACE.arweave({ host: null }) : unplaced;
            case 'url': case 'url-template': {
                const v = String(f.value || '');
                // A token id in the server's name: each token has its own server, so no one host is named.
                if (/^https?:\/\/[^/?#]*\{id\}/i.test(v)) return { state: 'host', text: 'Served by a server named per token. Whoever runs those servers can change it or stop.' };
                const at = placed(v.replace(/\{id\}/g, '0'));
                return at.state === 'unknown' ? unplaced : at;
            }
            case 'keccak256': case 'sha256':
                return { state: 'unknown', hashOnly: true, text: 'The contract holds only a hash of this file; where the file is kept is not said.' };
            default:
                return unplaced;
        }
    }

    /* A field's row. A field that places itself is shown with its lock. One that does not (unset, hash-only
       or unreadable) is shown by where the token read here gets it, which is one token's answer, with the
       field's lock when the field is set. */
    function fieldRow(f, sampleUri) {
        const at = fieldPlace(f);
        if (at && !at.hashOnly && !at.unplaced) return withLock(at, f.locked, FIELD_LOCK);
        const sample = placed(sampleUri);
        if (sample.state === 'unknown') return at ? { state: 'unknown', text: at.text } : NOT_READ;
        if (!at) return sample;
        const text = at.hashOnly ? `The contract holds only a hash of this file. The token read here gets it from: ${sample.text}` : `The token read here gets it from: ${sample.text}`;
        return withLock({ state: sample.state, text }, f.locked, FIELD_LOCK);
    }

    function metadata(f) {
        if (f.rendererUnread) return { state: 'unknown', text: 'The renderer address could not be read, so where metadata comes from was not read.' };
        if (f.renderer) return withLock({ state: 'chain', text: built(f.renderer) }, f.uriLocked, URI_LOCK);
        // The base is the collection's answer; the address a token returned is that one token's, and includes
        // any per-token override. When they differ both are said, and the row is as weak as the weaker.
        const base = f.base ? placed(f.base) : NOT_READ;
        const token = f.sample ? placed(f.sample.uri) : NOT_READ;
        let at = base.state !== 'unknown' ? base : token;
        if (base.state !== 'unknown' && token.state !== 'unknown' && base.text !== token.text) {
            at = { state: WEAK[base.state] >= WEAK[token.state] ? base.state : token.state, text: `The contract's base address: ${base.text} The token read here: ${token.text}` };
        }
        return withLock(at, f.uriLocked, URI_LOCK);
    }

    function program(f) {
        const s = f.script;
        if (!s || !Number.isInteger(s.chunks)) return NOT_READ;
        const code = f.fields && f.fields.code;
        if (s.chunks === 0) {
            const at = fieldPlace(code);
            if (!at) return { state: 'unknown', text: 'The contract names no program.' };
            if (at.unplaced) return { state: 'unknown', text: 'The code field is set, but where it points could not be read.' };
            if (at.hashOnly) return { state: 'unknown', text: at.text };
            const row = withLock(at, code.locked, FIELD_LOCK);
            // With no script stored, an unlocked script can still be added beside the field.
            if (s.locked === true) return row;
            const keep = row.state === 'host' ? 'host' : null;
            if (s.locked === false) return { state: keep || 'open', text: `${row.text} No script is stored on chain, and the owner can still add a script.` };
            return { state: keep || 'unknown', text: `${row.text} Whether a script can still be added was not read.` };
        }
        const deps = f.deps || {};
        const counted = Number.isInteger(deps.count);
        const n = counted ? deps.count : 0;
        const libs = n ? ` It names ${n} shared librar${n === 1 ? 'y' : 'ies'}.` : '';
        const where = `On chain, in ${parts(s.chunks)}`;
        if (s.locked === false) return { state: 'open', text: `${where}.${libs} The owner can still change it.` };
        if (s.locked !== true) return { state: 'unknown', text: `${where}.${libs} Whether it is locked was not read.` };
        if (code && code.rep) return { state: 'unknown', text: `${where}, and locked.${libs} The code field is also set; which of the two is run was not checked.` };
        if (!counted) return { state: 'unknown', text: `${where}, and locked. Whether it names shared libraries was not read.` };
        // A locked script still runs whatever its libraries are pointed at.
        if (n && deps.locked === false) return { state: 'open', text: `${where}, and locked.${libs} The owner can still change which libraries those are.` };
        if (n && deps.locked !== true) return { state: 'unknown', text: `${where}, and locked.${libs} Whether the libraries are locked was not read.` };
        return { state: 'chain', text: `${where}, and locked.${libs}` };
    }

    function hooks(f) {
        const h = f.hooks;
        if (!h) return NOT_READ;
        const set = ['configure', 'augment', 'transfer'].filter((k) => h[k]).map((k) => `${k}: ${clean(h[k])}`);
        const what = set.length
            ? `${set.length} set (${set.join(', ')}). A hook is another contract that runs when a token is configured, read or moved.`
            : 'None.';
        if (h.locked === true) {
            // Locked hooks cannot be swapped, and what they do was never read: neither changeable nor settled.
            return set.length ? { state: 'unknown', text: `${what} The set is locked; what those contracts do was not checked.` } : { state: 'chain', text: 'None, and none can be added.' };
        }
        if (h.locked === false) return { state: 'open', text: `${what} ${set.length ? 'The owner can change them.' : 'The owner can add one.'}` };
        return { state: 'unknown', text: `${what} Whether the set is locked was not read.` };
    }

    /* The rows of the list, in order: [{ label, state, text }]. */
    function rows(f) {
        const code = /code$/.test(f.kind || '');
        const fields = f.fields || {}, sample = f.sample || {};
        const out = [{ label: 'Metadata', ...metadata(f) }];
        if (code) {
            out.push({ label: 'Program', ...program(f) });
            out.push({ label: 'Live view', ...fieldRow(fields.animation_url, sample.animation) });
        }
        out.push({ label: 'Image', ...fieldRow(fields.image, sample.image) });
        if (code) out.push({ label: 'Hooks', ...hooks(f) });
        const creator = typeof f.creator === 'string' ? clean(f.creator) : '';
        if (creator) {
            const named = { state: 'chain', text: `${creator}, as the contract states. Anyone deploying a contract can write any name there.` };
            out.push({ label: 'Creator', ...withLock(named, f.creatorLocked, CREATOR_LOCK) });
        }
        return out;
    }

    root.abxDepends = { where, rows };
})(typeof globalThis !== 'undefined' ? globalThis : this);
