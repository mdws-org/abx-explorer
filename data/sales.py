#!/opt/homebrew/bin/python3
"""Add mint terms and deployer ENS names to web/contracts.json.

Per collection: minter(), paused(), totalSupply(), maxInvocations(); the shared
fixed-price minter's sales(token) for ERC-721, or sales(token, id) for each
edition id found in the 1155 minter's SaleConfigured events. Deployer names come
from the ENS Universal Resolver's reverse(bytes,uint256) on Ethereum.
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from keccak import selector, topic  # noqa: E402

RPC = {
    1: "https://ethereum-rpc.publicnode.com",
    8453: "https://mainnet.base.org",
    42161: "https://arb1.arbitrum.io/rpc",
    4663: "https://rpc.mainnet.chain.robinhood.com",
}
MINTER_721 = "0xfb5c61274a3a7da83ccdd88ddec914438244e2c9"
MINTER_1155 = "0x2af9f0c477c34a23cbec646a3b6bc0ca4df5d37f"
UNIVERSAL_RESOLVER = "0xeeeeeeee14d718c2b47d9923deab1335e144eeee"
SALE_CONFIGURED_1155 = topic("SaleConfigured(address,uint256,address,uint256,uint256)")
BLOCKSCOUT_ETH = "https://eth.blockscout.com/api"
ZERO = "0x" + "0" * 40
MOCK = Path(__file__).parent.parent / "web" / "contracts.json"


def post(url, payload):
    req = urllib.request.Request(url, json.dumps(payload).encode(),
                                 {"content-type": "application/json", "user-agent": "abx-directory/0.1"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except (OSError, json.JSONDecodeError):
            time.sleep(2 * (attempt + 1))
    return {}


def get_json(url):
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={"user-agent": "abx-directory/0.1"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except (OSError, json.JSONDecodeError):
            time.sleep(3 * (attempt + 1))
    return None


def call(chain_id, to, data):
    """eth_call returning the raw result bytes, or None on revert/error."""
    out = post(RPC[chain_id], {"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                               "params": [{"to": to, "data": data}, "latest"]})
    res = out.get("result")
    return bytes.fromhex(res[2:]) if res and res != "0x" else None


def words(raw):
    return [raw[i:i + 32] for i in range(0, len(raw), 32)] if raw else []


def as_int(w):
    return int.from_bytes(w, "big")


def as_addr(w):
    return "0x" + w[-20:].hex()


def pad_addr(a):
    return a[2:].lower().rjust(64, "0")


def read_sale(chain_id, minter, data):
    w = words(call(chain_id, minter, data))
    if len(w) < 5 or not as_int(w[0]):
        return None
    return {"paymentToken": as_addr(w[1]), "price": str(as_int(w[2])),
            "allocation": as_int(w[3]), "sold": as_int(w[4])}


def edition_ids(chain_id, token):
    """Edition ids that ever had a sale configured on the shared 1155 minter."""
    tok_topic = "0x" + pad_addr(token)
    if chain_id == 1:
        url = (f"{BLOCKSCOUT_ETH}?module=logs&action=getLogs&fromBlock=0&toBlock=latest"
               f"&address={MINTER_1155}&topic0={SALE_CONFIGURED_1155}&topic1={tok_topic}&topic0_1_opr=and")
        logs = (get_json(url) or {}).get("result") or []
    else:
        out = post(RPC[chain_id], {"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs", "params": [{
            "address": MINTER_1155, "topics": [SALE_CONFIGURED_1155, tok_topic],
            "fromBlock": hex(max(0, int(post(RPC[chain_id], {"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []})["result"], 16) - 99_000)),
            "toBlock": "latest"}]})
        logs = out.get("result") or []
    return sorted({int(l["topics"][2], 16) for l in logs})


def sale_status(c):
    cid, tok = c["chainId"], c["address"]
    minter_w = words(call(cid, tok, selector("minter()")))
    minter = as_addr(minter_w[0]) if minter_w else None
    paused_w = words(call(cid, tok, selector("paused()")))
    supply_w = words(call(cid, tok, selector("totalSupply()")))
    cap_w = words(call(cid, tok, selector("maxInvocations()")))
    s = {"minter": minter, "paused": bool(paused_w and as_int(paused_w[0])),
         "minted": as_int(supply_w[0]) if supply_w else None,
         "cap": as_int(cap_w[0]) if cap_w else None, "sales": []}
    if minter == MINTER_721:
        sale = read_sale(cid, MINTER_721, selector("sales(address)") + pad_addr(tok))
        if sale:
            s["sales"].append(sale)
    elif minter == MINTER_1155:
        for i in edition_ids(cid, tok):
            sale = read_sale(cid, MINTER_1155, selector("sales(address,uint256)") + pad_addr(tok) + f"{i:064x}")
            if sale:
                s["sales"].append(dict(sale, id=i))
    s["state"] = classify(s)
    return s


def classify(s):
    if not s["minter"] or s["minter"] == ZERO:
        return "owner only"
    if s["minter"] not in (MINTER_721, MINTER_1155):
        return "custom minter"
    if not s["sales"]:
        return "no sale set"
    if s["paused"]:
        return "paused"
    capped = s["cap"] is not None and s["minted"] is not None and s["minted"] >= s["cap"]
    open_sale = any(x["sold"] < x["allocation"] for x in s["sales"])
    return "open" if open_sale and not capped else "sold out"


def ens_name(addr):
    data = (selector("reverse(bytes,uint256)") + f"{64:064x}" + f"{60:064x}"
            + f"{20:064x}" + addr[2:].lower().ljust(64, "0"))
    raw = call(1, UNIVERSAL_RESOLVER, data)
    if not raw:
        return None
    off = as_int(raw[0:32])
    n = as_int(raw[off:off + 32])
    return raw[off + 32:off + 32 + n].decode("utf-8", "replace") or None


def decode_str(raw):
    if not raw or len(raw) < 64:
        return None
    n = as_int(raw[32:64])
    return raw[64:64 + n].decode("utf-8", "replace") or None


def verified_name(chain_id, addr):
    """Verified source name from Blockscout (Ethereum only; other explorers need keys or challenge)."""
    if chain_id != 1:
        return None
    out = get_json(f"https://eth.blockscout.com/api/v2/addresses/{addr}") or {}
    time.sleep(0.5)
    return out.get("name")


def minter_info(chain_id, addr, names, uri_image):
    """Who or what the minter is: wallet vs contract, names, owner, any image it exposes."""
    if not addr or addr == ZERO or addr in (MINTER_721, MINTER_1155):
        return None
    code = post(RPC[chain_id], {"jsonrpc": "2.0", "id": 1, "method": "eth_getCode", "params": [addr, "latest"]}).get("result")
    info = {"address": addr, "isContract": bool(code and code != "0x")}
    if addr not in names:
        names[addr] = ens_name(addr)
    info["ens"] = names[addr]
    if info["isContract"]:
        info["contractName"] = verified_name(chain_id, addr) or decode_str(call(chain_id, addr, selector("name()")))
        owner_w = words(call(chain_id, addr, selector("owner()")))
        if owner_w:
            owner = as_addr(owner_w[0])
            if owner not in names:
                names[owner] = ens_name(owner)
            info["owner"], info["ownerEns"] = owner, names[owner]
        info["image"] = uri_image(decode_str(call(chain_id, addr, selector("contractURI()"))),
                                  f"minter-{chain_id}-{addr[2:10]}")
    return info


def main():
    from enrich import load_json_uri, keep_image  # noqa: E402

    def uri_image(uri, stem):
        meta = load_json_uri(uri) if uri else None
        return keep_image((meta or {}).get("image"), stem)

    data = json.loads(MOCK.read_text())
    names = {}
    for c in data["contracts"]:
        c["sale"] = sale_status(c)
        c["sale"]["minterInfo"] = minter_info(c["chainId"], c["sale"]["minter"], names, uri_image)
        if c["owner"] not in names:
            names[c["owner"]] = ens_name(c["owner"])
        c["ownerName"] = names[c["owner"]]
        print(f"{c['chain']:16} {str(c['name'])[:34]:34} {c['sale']['state']:13} "
              f"{len(c['sale']['sales'])} sale(s)  {c['ownerName'] or ''}", file=sys.stderr)
    MOCK.write_text(json.dumps(data, indent=1))


if __name__ == "__main__":
    main()
