'use strict';

/* One-tap free mint from the visitor's wallet. Two kinds of link:
   ABX:        /mint.html?chain=<id>&token=<address>[&id=<editionId>]
               sends purchaseTo(token, [id, 1,] ABX wallet, ETH, maxPrice 0) to the ABX shared minter.
   Art Blocks: /mint.html?ab=1&chain=<id>&minter=<address>&core=<address>&project=<n>&to=<address>[&gate=<address>&gateId=<n>]
               sends purchaseTo(to, project, core[, gate, gateId]) with value 0 to the project's shared-suite minter.
   Both re-read the sale on chain before sending; a sale that is no longer free is refused by the contract itself. */

const CHAINS = {
    1: { name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io' },
    8453: { name: 'Base', rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org' },
    42161: { name: 'Arbitrum', rpc: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io' },
};
const MINTER_721 = '0xfb5c61274a3a7da83ccdd88ddec914438244e2c9';
const MINTER_1155 = '0x2af9f0c477c34a23cbec646a3b6bc0ca4df5d37f';
const SEL = {
    purchaseTo721: '0xdbb83949',   // purchaseTo(address,address,address,uint256)
    purchaseTo1155: '0xa4eb2240',  // purchaseTo(address,uint256,uint256,address,address,uint256)
    sales721: '0xc6b9f06a',        // sales(address)
    sales1155: '0x3a1c83ac',       // sales(address,uint256)
    minter: '0x07546172',
    paused: '0x5c975abb',
    name: '0x06fdde03',
    // Art Blocks shared minter suite (V5) and V3 core
    abPriceInfo: '0xd9eb16db',     // getPriceInfo(uint256,address) -> (bool, uint256, string, address)
    abMaxInvoked: '0xcce7c909',    // projectMaxHasBeenInvoked(uint256,address) -> bool
    abState: '0x0ea5613f',         // projectStateData(uint256) -> (invocations, max, active, paused, completed, locked)
    abDetails: '0x8dd91a56',       // projectDetails(uint256) -> (name, artist, description, website, license)
    abAllowed: '0xfca23f4e',       // allowedProjectHolders(uint256,address,address,uint256) -> bool
    abPurchaseTo: '0x4e8d8787',    // purchaseTo(address,uint256,address)
    abPurchaseToHolder: '0x9d923dff', // purchaseTo(address,uint256,address,address,uint256)
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');
const isNum = (n) => /^\d{1,30}$/.test(n || '');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => a.slice(2).toLowerCase().padStart(64, '0');

async function call(chain, to, data) {
    const r = await fetch(CHAINS[chain].rpc, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    });
    const j = await r.json();
    if (j.error || !/^0x[0-9a-fA-F]+$/.test(j.result || '')) throw new Error('read failed');
    const h = j.result.slice(2);
    return Array.from({ length: h.length / 64 }, (_, i) => BigInt(`0x${h.slice(i * 64, i * 64 + 64)}`));
}

/* A string at the given head-word offset of an ABI-encoded tuple. */
function stringAt(words, slot) {
    const hex = words.map((w) => w.toString(16).padStart(64, '0')).join('');
    const off = Number(words[slot] || 0n) * 2;
    const len = parseInt(hex.slice(off, off + 64) || '0', 16);
    const bytes = (hex.slice(off + 64, off + 64 + len * 2).match(/../g) || []).map((x) => parseInt(x, 16));
    return new TextDecoder().decode(new Uint8Array(bytes));
}
const decodeString = (words) => stringAt(words, 0);

function params() {
    const q = new URLSearchParams(location.search);
    const chain = Number(q.get('chain'));
    if (!CHAINS[chain]) throw new Error('This link is malformed.');
    if (q.get('ab') === '1') {
        const p = {
            kind: 'ab', chain,
            minter: (q.get('minter') || '').toLowerCase(), core: (q.get('core') || '').toLowerCase(),
            project: q.get('project'), to: (q.get('to') || '').toLowerCase(),
            gate: q.has('gate') ? (q.get('gate') || '').toLowerCase() : null, gateId: q.has('gateId') ? q.get('gateId') : null,
        };
        if (!isAddr(p.minter) || !isAddr(p.core) || !isNum(p.project) || !isAddr(p.to)) throw new Error('This link is malformed.');
        if ((p.gate === null) !== (p.gateId === null) || (p.gate !== null && (!isAddr(p.gate) || !isNum(p.gateId)))) throw new Error('This link is malformed.');
        p.project = BigInt(p.project);
        if (p.gateId !== null) p.gateId = BigInt(p.gateId);
        return p;
    }
    const token = (q.get('token') || '').toLowerCase();
    const id = q.has('id') ? q.get('id') : null;
    if (!isAddr(token) || (id !== null && !isNum(id))) throw new Error('This link is malformed.');
    return { kind: 'abx', chain, token, id: id === null ? null : BigInt(id) };
}

/* Free, open and unpaused, read live. Returns a reason string when not mintable. */
async function checkAbx({ chain, token, id }) {
    const minter = id === null ? MINTER_721 : MINTER_1155;
    const assigned = await call(chain, token, SEL.minter);
    if (`0x${assigned[0].toString(16).padStart(40, '0')}` !== minter) return 'This collection does not sell through the ABX shared minter.';
    if ((await call(chain, token, SEL.paused))[0] !== 0n) return 'The sale is paused.';
    const sale = await call(chain, minter, id === null
        ? SEL.sales721 + addrWord(token) : SEL.sales1155 + addrWord(token) + word(id));
    const [configured, payToken, price, allocation, sold] = sale;
    if (!configured) return 'No sale is configured.';
    if (payToken !== 0n || price !== 0n) return 'This sale is not free anymore.';
    if (sold >= allocation) return 'This sale is sold out.';
    return null;
}

async function checkAb({ chain, minter, core, project, gate, gateId }) {
    const [configured, wei, , currency] = await call(chain, minter, SEL.abPriceInfo + word(project) + addrWord(core));
    if (!configured) return 'No price is configured for this project.';
    if (wei !== 0n || currency !== 0n) return 'This mint is not free anymore.';
    if ((await call(chain, minter, SEL.abMaxInvoked + word(project) + addrWord(core)))[0] !== 0n) return 'This project is fully minted.';
    const [invocations, max, active, paused] = await call(chain, core, SEL.abState + word(project));
    if (!active) return 'This project is not active.';
    if (paused) return 'This project is paused.';
    if (invocations >= max) return 'This project is fully minted.';
    if (gate !== null) {
        const ok = await call(chain, minter, SEL.abAllowed + word(project) + addrWord(core) + addrWord(gate) + word(gateId));
        if (ok[0] !== 1n) return 'The token this link names is not accepted for this holder mint.';
    }
    return null;
}

const checkSale = (p) => (p.kind === 'ab' ? checkAb(p) : checkAbx(p));
const minterOf = (p) => (p.kind === 'ab' ? p.minter : p.id === null ? MINTER_721 : MINTER_1155);

function txData(p, recipient) {
    if (p.kind === 'ab') {
        if (p.gate === null) return SEL.abPurchaseTo + addrWord(recipient) + word(p.project) + addrWord(p.core);
        return SEL.abPurchaseToHolder + addrWord(recipient) + word(p.project) + addrWord(p.core) + addrWord(p.gate) + word(p.gateId);
    }
    if (p.id === null) return SEL.purchaseTo721 + addrWord(p.token) + addrWord(recipient) + word(0) + word(0);
    return SEL.purchaseTo1155 + addrWord(p.token) + word(p.id) + word(1) + addrWord(recipient) + word(0) + word(0);
}

function walletLinks() {
    const here = location.href.replace(/^https?:\/\//, '');
    const apps = [
        ['MetaMask', `https://metamask.app.link/dapp/${here}`],
        ['Rainbow', `https://rnbwapp.com/dapp?url=${encodeURIComponent(location.href)}`],
        ['Coinbase Wallet', `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(location.href)}`],
    ];
    $('#wallet-apps').innerHTML = apps.map(([n, u]) => `<a href="${esc(u)}">${n}</a>`).join(' &middot; ');
    $('#open-in').hidden = false;
}

async function mint(p, recipient) {
    const eth = window.ethereum;
    const status = $('#status');
    const [from] = await eth.request({ method: 'eth_requestAccounts' });
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${p.chain.toString(16)}` }] });
    if (await checkSale(p)) throw new Error('The sale changed; nothing was sent.');
    status.textContent = 'Confirm in your wallet…';
    const hash = await eth.request({ method: 'eth_sendTransaction', params: [{ from, to: minterOf(p), value: '0x0', data: txData(p, recipient) }] });
    status.innerHTML = `Sent. <a href="${CHAINS[p.chain].explorer}/tx/${esc(hash)}">View the transaction</a>. The page records it on its next check.`;
}

async function describe(p) {
    if (p.kind === 'ab') {
        const d = await call(p.chain, p.core, SEL.abDetails + word(p.project)).catch(() => null);
        const name = d ? stringAt(d, 0) : '', artist = d ? stringAt(d, 1) : '';
        return {
            title: name || `Project ${p.project}`,
            recipient: p.to, recipientLabel: 'your collection wallet',
            facts: `<dt>Chain</dt><dd>${esc(CHAINS[p.chain].name)}</dd>
                ${artist ? `<dt>Artist</dt><dd>${esc(artist)}</dd>` : ''}
                <dt>Project</dt><dd>${esc(p.project)} on <span class="mono">${esc(p.core)}</span></dd>
                <dt>Minter</dt><dd class="mono">${esc(p.minter)}</dd>
                ${p.gate === null ? '' : `<dt>Holder of</dt><dd class="mono">${esc(p.gate)} #${esc(p.gateId)}</dd>`}
                <dt>Sent to</dt><dd class="mono">${esc(p.to)} (your collection wallet)</dd>`,
            how: `Art Blocks free mint. One tap mints one token to your collection wallet${p.gate === null ? '' : ', as the holder of the token above'}.`,
            send: 'The transaction mints one token at price 0 to the wallet named above. If the project is repriced before it lands, the minter rejects an unpaid purchase and nothing is minted.',
        };
    }
    const ours = await (await fetch('ours.json', { signal: AbortSignal.timeout(8000) })).json();
    if (!isAddr(ours.wallet)) throw new Error('ABX wallet address missing.');
    const name = decodeString(await call(p.chain, p.token, SEL.name).catch(() => [0n, 0n])) || 'Unnamed collection';
    return {
        title: name, recipient: ours.wallet, recipientLabel: 'the ABX wallet',
        facts: `<dt>Chain</dt><dd>${esc(CHAINS[p.chain].name)}</dd>
            <dt>Contract</dt><dd class="mono">${esc(p.token)}</dd>
            ${p.id === null ? '' : `<dt>Edition</dt><dd>${esc(p.id)}</dd>`}
            <dt>Sent to</dt><dd class="mono">${esc(ours.wallet)} (ABX wallet)</dd>`,
        how: 'Free and open. One tap mints one token to the ABX wallet.',
        send: 'The transaction mints one token to the ABX wallet with a maximum price of 0. If the sale is repriced before it lands, the contract rejects it and nothing is minted.',
    };
}

async function main() {
    const p = params();
    const d = await describe(p);
    $('#title').textContent = d.title;
    $('#facts').innerHTML = d.facts;
    $('#send-note').textContent = d.send;
    $('#go').textContent = `Mint free to ${d.recipientLabel}`;
    const reason = await checkSale(p);
    if (reason) { $('#what').textContent = reason; return; }
    $('#what').textContent = d.how;
    if (!window.ethereum) { walletLinks(); return; }
    const go = $('#go');
    go.hidden = false;
    go.onclick = () => {
        go.disabled = true;
        mint(p, d.recipient).catch((e) => { $('#status').textContent = e.message || 'Cancelled.'; go.disabled = false; });
    };
}

main().catch((e) => { $('#what').textContent = e.message || 'Could not read the sale.'; });
