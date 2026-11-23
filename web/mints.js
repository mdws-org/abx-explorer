/* Which token ids a collection's detail view lists. The data file's mint count is a day old at best and is
   missing for a collection with no public sale, so the count read from the contract just now is used with
   it. Pure functions; web/app.js does the reading. Cases: tools/mints-cases.json. */
(function (root) {
    'use strict';

    const MAX_TOKENS = 10 ** 12;   // more than any collection holds; a larger value is a bad read
    const whole = (n) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_TOKENS ? n : null);

    /* How many ids, from 0, a series or 1/1 image has: the contract's next id when it has one (a burned
       token keeps its id), otherwise its supply; the data file's count when it is larger or nothing else
       was read. Null when nothing says. */
    function count({ minted, next, supply }) {
        const chain = whole(next) !== null ? whole(next) : whole(supply);
        const file = whole(minted);
        if (chain === null) return file;
        return file === null ? chain : Math.max(chain, file);
    }

    /* An edition's ids: the data file's sales list when it has one, otherwise the ids from 0 whose supply
       was read and is above zero, up to the first that is not. */
    function editionIds({ saleIds, supplies }) {
        const listed = (saleIds || []).map((x) => (typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x)).filter((x) => whole(x) !== null);
        if (listed.length) return listed;
        const ids = [];
        for (const s of supplies || []) {
            if (whole(s) === null || s === 0) break;
            ids.push(ids.length);
        }
        return ids;
    }

    root.abxMints = { count, editionIds };
})(typeof globalThis !== 'undefined' ? globalThis : this);
