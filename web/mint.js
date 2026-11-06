'use strict';

/* One-tap free mint: /mint.html?chain=<id>&token=<address>[&id=<editionId>]
   Sends purchaseTo(token, [id, 1,] ABX wallet, ETH, maxPrice 0) from the visitor's wallet. */

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
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');
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

function decodeString(words) {
    const hex = words.map((w) => w.toString(16).padStart(64, '0')).join('');
    const len = Number(words[1] || 0n);
    const bytes = (hex.slice(128, 128 + len * 2).match(/../g) || []).map((x) => parseInt(x, 16));
    return new TextDecoder().decode(new Uint8Array(bytes));
}

function params() {
    const q = new URLSearchParams(location.search);
    const chain = Number(q.get('chain'));
    const token = (q.get('token') || '').toLowerCase();
    const id = q.has('id') ? q.get('id') : null;
    if (!CHAINS[chain] || !isAddr(token) || (id !== null && !/^\d{1,30}$/.test(id))) throw new Error('This link is malformed.');
    return { chain, token, id: id === null ? null : BigInt(id) };
}

/* Free, open and unpaused, read live. Returns a reason string when not mintable. */
async function checkSale({ chain, token, id }) {
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

function txData({ token, id }, recipient) {
    if (id === null) return SEL.purchaseTo721 + addrWord(token) + addrWord(recipient) + word(0) + word(0);
    return SEL.purchaseTo1155 + addrWord(token) + word(id) + word(1) + addrWord(recipient) + word(0) + word(0);
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
    const minter = p.id === null ? MINTER_721 : MINTER_1155;
    const hash = await eth.request({ method: 'eth_sendTransaction', params: [{ from, to: minter, value: '0x0', data: txData(p, recipient) }] });
    status.innerHTML = `Sent. <a href="${CHAINS[p.chain].explorer}/tx/${esc(hash)}">View the transaction</a>. The page records it on its next check.`;
}

async function main() {
    const p = params();
    const ours = await (await fetch('ours.json', { signal: AbortSignal.timeout(8000) })).json();
    if (!isAddr(ours.wallet)) throw new Error('ABX wallet address missing.');
    const name = decodeString(await call(p.chain, p.token, SEL.name).catch(() => [0n, 0n])) || 'Unnamed collection';
    $('#title').textContent = name;
    $('#facts').innerHTML = `
        <dt>Chain</dt><dd>${esc(CHAINS[p.chain].name)}</dd>
        <dt>Contract</dt><dd class="mono">${esc(p.token)}</dd>
        ${p.id === null ? '' : `<dt>Edition</dt><dd>${esc(p.id)}</dd>`}
        <dt>Sent to</dt><dd class="mono">${esc(ours.wallet)} (ABX wallet)</dd>`;
    const reason = await checkSale(p);
    if (reason) { $('#what').textContent = reason; return; }
    $('#what').textContent = 'Free and open. One tap mints one token to the ABX wallet.';
    if (!window.ethereum) { walletLinks(); return; }
    const go = $('#go');
    go.hidden = false;
    go.onclick = () => {
        go.disabled = true;
        mint(p, ours.wallet).catch((e) => { $('#status').textContent = e.message || 'Cancelled.'; go.disabled = false; });
    };
}

main().catch((e) => { $('#what').textContent = e.message || 'Could not read the sale.'; });
