# ABX Explorer

ABX Explorer lists every collection that anyone has deployed with [ABX](https://www.abx.io/), the open protocol from Art Blocks. It runs at https://abx.thebenmeadows.com/.

The page reads the six ABX factory contracts on Ethereum, Base, Arbitrum and Robinhood Chain, so a collection appears whether or not it is registered with ABX's hosted services. It is independent and is not affiliated with Art Blocks.

## Sections

- **News**: ABX releases and new collections, side by side. News entries are written automatically from public sources and link those sources.
- **Directory**: every collection with its kind, chain, contract, deployer (ENS or Basename where one is set), mint status and deploy date. Search covers names, addresses and deployer names.
- **Gallery**: the collections that carry an image in their onchain metadata. Images hosted elsewhere are copied to the site daily (`worker/copies.js`); the page loads the copy first, then the original, then shows the collection's initials, so a blocked or offline host never leaves a broken image.
- **Detail view**: a collection's terms and minter, links to find3r, OnChainChecker, Fully On Chain, the explorer and OpenSea, and its individual mints, read from the chain in the browser.
- **Minted here**: free mints collected by the page's wallet.
- **Mint page** (`mint.html?chain=<id>&token=<address>[&id=<edition>]`): mints one token from a free sale on the shared ABX minter to the page's wallet, with a maximum price of 0. If the sale is repriced before the transaction is mined, the contract rejects it.

## Layout

| Path | Contents |
| --- | --- |
| `web/` | The page: `index.html`, `app.js`, `mint.html`, `mint.js`, `style.css`, and the JSON files the page reads |
| `data/pull_contracts.py` | Reads `Deployed` events from the six factories and writes `data/contracts.json` |
| `data/enrich.py` | Adds each collection's onchain metadata and a preview image, and writes `web/contracts.json` and `web/img/` |
| `data/sales.py` | Adds mint terms from the shared minters, minter details, and deployer ENS names |
| `data/base_names.py` | Adds Basenames for deployers that have no ENS name, checked forward and in reverse |
| `data/abx_rpc.py` | Authenticated calls to the ABX creator RPC |
| `data/keccak.py` | Keccak-256 for function selectors and event topics |
| `build_site.py` | Copies `web/` into `site/` for publishing |
| `serve.py` | Serves `web/` on 127.0.0.1:8821 with caching off |

The scripts use the Python standard library only.

## Run it locally

1. Run `abx auth login` from the [ABX CLI](https://github.com/ArtBlocks/abx) to get an ABX Services key. Base history needs the ABX creator RPC. The free public Base endpoints refuse log ranges this long.
2. Set `ABX_SERVICES_API_KEY`, or set `ABX_ENV_FILE` to the `.env` file that `abx auth login` wrote.
3. Build the data, in this order:

   ```sh
   python3 data/pull_contracts.py
   python3 data/enrich.py
   python3 data/sales.py
   python3 data/base_names.py
   ```

4. Run `python3 serve.py` and open http://127.0.0.1:8821/.

`pull_contracts.py` caches each chain in `data/chain-<id>.json`. To read new collections, run it with `--refresh`.

## Security

- Every name, description, image and URL the page shows was written onchain by someone else. The page escapes all text, links only `http` and `https` URLs, validates records before it renders them, and loads live views only after a click, inside an `allow-scripts` sandbox without same-origin access.
- The site serves a Content-Security-Policy header that allows scripts and styles from its own origin only.
- The ABX key must never be committed or put in a page. `.env` is ignored by git.

## License

MIT. See [LICENSE](LICENSE).

`web/publicsans.woff2` is [Public Sans](https://github.com/uswds/public-sans), under the SIL Open Font License 1.1.
