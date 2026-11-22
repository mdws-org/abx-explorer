/* What a collection depends on, from what its contract says: where its metadata, program, live view and
   image come from, and what its owner can still change. Pure functions over values already read from
   chain; web/app.js does the reading. Cases: tools/depends-cases.json.

   States: chain   on chain, and nothing here can change it
           pinned  named by its own hash on IPFS or Arweave: it cannot change, but someone has to keep serving it
           host    a server someone runs: it can change or stop
           open    on chain now, and the owner can still change it
           unknown not read */
(function (root) {
    'use strict';

    const ARWEAVE_HOST = /(^|\.)arweave\.net$/;
    const IPFS_HOST = /\.ipfs\.[a-z0-9.-]+$/;

    /* Where one address lives: { where: 'chain' | 'ipfs' | 'arweave' | 'host' | 'unknown', host }. */
    function where(uri) {
        const none = { where: 'unknown', host: null };
        if (typeof uri !== 'string' || !uri) return none;
        if (uri.startsWith('data:')) return { where: 'chain', host: null };
        if (uri.startsWith('ipfs://')) return { where: 'ipfs', host: null };
        if (uri.startsWith('ar://')) return { where: 'arweave', host: null };
        if (!/^https?:\/\//i.test(uri)) return none;
        let u;
        try { u = new URL(uri); } catch { return none; }
        const host = u.hostname.toLowerCase();
        if (!host) return none;
        if (ARWEAVE_HOST.test(host)) return { where: 'arweave', host };
        if (IPFS_HOST.test(host) || u.pathname.startsWith('/ipfs/')) return { where: 'ipfs', host };
        return { where: 'host', host };
    }

    const NOT_READ = { state: 'unknown', text: 'Not read.' };
    const PLACE = {
        chain: () => ({ state: 'chain', text: 'On chain, in the token itself.' }),
        ipfs: (w) => ({ state: 'pinned', text: `On IPFS, named by its own hash${w.host ? ` (through ${w.host})` : ''}. The file cannot change; someone has to keep it pinned.` }),
        arweave: (w) => ({ state: 'pinned', text: `On Arweave, named by its own hash${w.host ? ` (through ${w.host})` : ''}. The file cannot change.` }),
        host: (w) => ({ state: 'host', text: `Served by ${w.host}. Whoever runs that server can change it or stop.` }),
        unknown: () => NOT_READ,
    };
    const placed = (uri) => { const w = where(uri); return PLACE[w.where](w); };
    const BUILT = 'Built by a contract on chain each time it is asked for.';
    const parts = (n) => `${n} part${n === 1 ? '' : 's'}`;

    /* A metadata field the contract holds: its representation says how the value is carried, and its lock
       says whether the owner can still point the field at something else. */
    function field(f) {
        if (!f || !f.rep) return null;
        let at = NOT_READ;
        if (f.rep === 'renderer' || f.rep === 'inline' || f.rep === 'reader') at = { state: 'chain', text: f.rep === 'renderer' ? BUILT : 'On chain, in the contract.' };
        else if (f.rep === 'ipfs') at = PLACE.ipfs({ host: null });
        else if (f.rep === 'arweave') at = PLACE.arweave({ host: null });
        else if (f.rep === 'url' || f.rep === 'url-template') at = placed(String(f.value || '').replace('{id}', '0'));
        if (at.state === 'unknown' || typeof f.locked !== 'boolean') return at;
        if (f.locked) return { state: at.state, text: `${at.text} This field is locked.` };
        // What it points at now may be fixed; the pointer is not.
        return { state: at.state === 'host' ? 'host' : 'open', text: `${at.text} The owner can still point this field somewhere else.` };
    }

    function metadata(f) {
        if (f.uriLocked === null || f.uriLocked === undefined) return NOT_READ;
        const tail = f.uriLocked ? ' That is locked.' : ' The owner can still point it somewhere else.';
        if (f.renderer) return { state: f.uriLocked ? 'chain' : 'open', text: BUILT + tail };
        const at = f.base ? placed(f.base) : f.sample ? placed(f.sample.uri) : NOT_READ;
        if (at.state === 'unknown') return NOT_READ;
        // Locked at a server still depends on that server; locked on chain depends on nothing.
        return { state: at.state === 'chain' && !f.uriLocked ? 'open' : at.state, text: at.text + tail };
    }

    function program(f) {
        const s = f.script;
        if (!s || s.chunks === null || s.chunks === undefined) return NOT_READ;
        if (s.chunks > 0) {
            const libs = f.deps && f.deps.count ? ` It names ${f.deps.count} shared librar${f.deps.count === 1 ? 'y' : 'ies'}.` : '';
            return s.locked
                ? { state: 'chain', text: `On chain, in ${parts(s.chunks)}, and locked.${libs}` }
                : { state: 'open', text: `On chain, in ${parts(s.chunks)}.${libs} The owner can still change it.` };
        }
        return field(f.fields && f.fields.code) || { state: 'unknown', text: 'The contract names no program.' };
    }

    function hooks(f) {
        const h = f.hooks;
        if (!h) return NOT_READ;
        const set = ['configure', 'augment', 'transfer'].filter((k) => h[k]).map((k) => `${k}: ${h[k]}`);
        if (set.length) {
            return { state: 'open', text: `${set.length} set (${set.join(', ')}). A hook is another contract that runs when a token is configured, read or moved.${h.locked ? ' The set is locked.' : ' The owner can change them.'}` };
        }
        return h.locked ? { state: 'chain', text: 'None, and none can be added.' } : { state: 'open', text: 'None. The owner can add one.' };
    }

    /* The rows of the list, in order: [{ label, state, text }]. */
    function rows(f) {
        const code = /code$/.test(f.kind || '');
        const fields = f.fields || {}, sample = f.sample || {};
        const out = [{ label: 'Metadata', ...metadata(f) }];
        if (code) {
            out.push({ label: 'Program', ...program(f) });
            out.push({ label: 'Live view', ...(field(fields.animation_url) || placed(sample.animation)) });
        }
        out.push({ label: 'Image', ...(field(fields.image) || placed(sample.image)) });
        if (code) out.push({ label: 'Hooks', ...hooks(f) });
        if (typeof f.creator === 'string' && f.creator.trim()) {
            out.push({ label: 'Creator', state: 'chain', text: `${f.creator.trim()}, as the contract states. Anyone deploying a contract can write any name there.` });
        }
        return out;
    }

    root.abxDepends = { where, rows };
})(typeof globalThis !== 'undefined' ? globalThis : this);
