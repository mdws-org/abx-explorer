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
    const CID = '(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})';           // CIDv0, or CIDv1 in base32
    const CID_START = new RegExp(`^${CID}(?:[/?#]|$)`);
    const CID_HOST = new RegExp(`^${CID}\\.ipfs\\.[a-z0-9.-]+$`);
    const TXID_START = /^[A-Za-z0-9_-]{43}(?:[/?#]|$)/;                     // an Arweave transaction id

    /* Where one address lives: { where: 'chain' | 'ipfs' | 'arweave' | 'host' | 'unknown', host }.
       IPFS and Arweave are claimed only when the address holds a hash or transaction id in the place a
       gateway reads it from; any other address at such a host is just that host. */
    function where(uri) {
        const none = { where: 'unknown', host: null };
        if (typeof uri !== 'string' || !uri) return none;
        if (uri.startsWith('data:')) return { where: 'chain', host: null };
        if (uri.startsWith('ipfs://')) return CID_START.test(uri.slice(7)) ? { where: 'ipfs', host: null } : none;
        if (uri.startsWith('ar://')) return TXID_START.test(uri.slice(5)) ? { where: 'arweave', host: null } : none;
        if (!/^https?:\/\//i.test(uri)) return none;
        let u;
        try { u = new URL(uri); } catch { return none; }
        const host = u.hostname.toLowerCase();
        if (!host) return none;
        if (ARWEAVE_HOST.test(host) && TXID_START.test(u.pathname.slice(1))) return { where: 'arweave', host };
        if (CID_HOST.test(host) || (u.pathname.startsWith('/ipfs/') && CID_START.test(u.pathname.slice(6)))) return { where: 'ipfs', host };
        return { where: 'host', host };
    }

    /* Contract text shown in a row: no control or direction characters, which could reorder the row. */
    const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/g, '').trim().slice(0, 120);

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

    /* Where a field's value lives, from its representation. Null when the field is unset or says nothing usable. */
    function fieldPlace(f) {
        if (!f || !f.rep) return null;
        switch (f.rep) {
            case 'inline': case 'inline-gzip':
                return { state: 'chain', text: 'On chain, in the contract.' };
            case 'renderer':
                return f.value ? { state: 'chain', text: built(f.value) } : null;
            case 'reader': case 'reader-gzip':
                return { state: 'chain', text: 'Read on chain through another contract. What that contract reads was not checked.' };
            case 'ipfs':
                return CID_START.test(String(f.value || '')) ? PLACE.ipfs({ host: null }) : null;
            case 'arweave':
                return TXID_START.test(String(f.value || '')) ? PLACE.arweave({ host: null }) : null;
            case 'url': case 'url-template': {
                const v = String(f.value || '');
                // A token id in the server's name: each token has its own server, so no one host is named.
                if (/^https?:\/\/[^/?#]*\{id\}/i.test(v)) return { state: 'host', text: 'Served by a server named per token. Whoever runs those servers can change it or stop.' };
                const at = placed(v.replace(/\{id\}/g, '0'));
                return at.state === 'unknown' ? null : at;
            }
            case 'keccak256': case 'sha256':
                return { state: 'unknown', hashOnly: true, text: 'The contract holds only a hash of this file; where the file is kept is not said.' };
            default:
                return null;
        }
    }

    /* A field's row, falling back to what the sample token's own metadata names. */
    function fieldRow(f, sampleUri) {
        const at = fieldPlace(f);
        if (at && !at.hashOnly) return withLock(at, f.locked, FIELD_LOCK);
        const sample = placed(sampleUri);
        if (sample.state !== 'unknown') return sample;
        return at ? { state: at.state, text: at.text } : NOT_READ;
    }

    function metadata(f) {
        if (f.renderer) return withLock({ state: 'chain', text: built(f.renderer) }, f.uriLocked, URI_LOCK);
        // The address a token actually returned says more than the base alone: it includes any per-token override.
        const sample = f.sample ? placed(f.sample.uri) : NOT_READ;
        const at = sample.state !== 'unknown' ? sample : f.base ? placed(f.base) : NOT_READ;
        return withLock(at, f.uriLocked, URI_LOCK);
    }

    function program(f) {
        const s = f.script;
        if (!s || !Number.isInteger(s.chunks)) return NOT_READ;
        if (s.chunks === 0) {
            const at = fieldPlace(f.fields && f.fields.code);
            if (!at) return { state: 'unknown', text: 'The contract names no program.' };
            return at.hashOnly ? { state: at.state, text: at.text } : withLock(at, f.fields.code.locked, FIELD_LOCK);
        }
        const deps = f.deps || {};
        const n = Number.isInteger(deps.count) ? deps.count : 0;
        const libs = n ? ` It names ${n} shared librar${n === 1 ? 'y' : 'ies'}.` : '';
        const also = f.fields && f.fields.code && f.fields.code.rep ? ' The code field is also set; which of the two is run was not checked.' : '';
        const where = `On chain, in ${parts(s.chunks)}`;
        if (s.locked === false) return { state: 'open', text: `${where}.${libs}${also} The owner can still change it.` };
        if (s.locked !== true) return { state: 'unknown', text: `${where}.${libs}${also} Whether it is locked was not read.` };
        // A locked script still runs whatever its libraries are pointed at.
        if (n && deps.locked === false) return { state: 'open', text: `${where}, and locked.${libs}${also} The owner can still change which libraries those are.` };
        if (n && deps.locked !== true) return { state: 'unknown', text: `${where}, and locked.${libs}${also} Whether the libraries are locked was not read.` };
        return { state: 'chain', text: `${where}, and locked.${libs}${also}` };
    }

    function hooks(f) {
        const h = f.hooks;
        if (!h) return NOT_READ;
        const set = ['configure', 'augment', 'transfer'].filter((k) => h[k]).map((k) => `${k}: ${clean(h[k])}`);
        const what = set.length
            ? `${set.length} set (${set.join(', ')}). A hook is another contract that runs when a token is configured, read or moved.`
            : 'None.';
        if (h.locked === true) return set.length ? { state: 'open', text: `${what} The set is locked; what those contracts do was not checked.` } : { state: 'chain', text: 'None, and none can be added.' };
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
        if (creator) out.push({ label: 'Creator', state: 'chain', text: `${creator}, as the contract states. Anyone deploying a contract can write any name there.` });
        return out;
    }

    root.abxDepends = { where, rows };
})(typeof globalThis !== 'undefined' ? globalThis : this);
