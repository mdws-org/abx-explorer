#!/opt/homebrew/bin/python3
"""List every ABX v3 collection on mainnet chains from factory Deployed events.

Writes contracts.json next to this script. Stdlib only; public RPCs, plus the
Blockscout logs API for Ethereum (public Ethereum RPCs refuse historical logs).
"""
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEPLOYED_TOPIC = "0xc95935a66d15e0da5e412aca0ad27ae891d20b2fb91cf3994b6a3bf2b8178082"
FACTORIES = {
    "0x2ff8828a9150401225bb217caa8b9b5e666a1c97": "1/1 image",
    "0x83222f791ca243feb0c1fef93a8732ece3001b4b": "Series image",
    "0xeab8a19feada0ddba2fde324715ebbb6234b5616": "Series code",
    "0x4e9dfcc70dcc02fa5bad113bc2cf0a2218358b1e": "1/1 edition",
    "0xcc29ed68f26693dc9aa5f090b21f37985206cc19": "Edition image",
    "0x86f9cfe597ab145452f4a66ac102291d54e8eb46": "Edition code",
}
# chain id: (name, rpc for reads/logs, max getLogs block span or None to use Blockscout)
CHAINS = {
    1: ("Ethereum", "https://ethereum-rpc.publicnode.com", None),
    8453: ("Base", "abx:8453", 2_500_000),  # free public Base RPCs refuse history; ABX creator RPC does not
    42161: ("Arbitrum", "https://arb1.arbitrum.io/rpc", 100_000),
    4663: ("Robinhood Chain", "https://rpc.mainnet.chain.robinhood.com", 100_000),
}
BLOCKSCOUT_ETH = "https://eth.blockscout.com/api"
GENERATION_START = int(time.mktime(time.strptime("2026-09-10", "%Y-%m-%d")))  # abx-core-v3 deploy date
UA = {"user-agent": "abx-directory/0.1"}


def http_json(url, body=None):
    headers = dict(UA, **({"content-type": "application/json"} if body else {}))
    for attempt in range(8):
        req = urllib.request.Request(url, body, headers)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429:
                return json.load(e)
        except (OSError, json.JSONDecodeError):
            pass
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"no answer from {url}")


def rpc(url, method, params):
    if url.startswith("abx:"):
        sys.path.insert(0, str(Path(__file__).parent))
        import abx_rpc
        return abx_rpc.rpc(int(url[4:]), method, params)
    out = http_json(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode())
    if "error" in out:
        raise RuntimeError(out["error"])
    return out["result"]


def block_time(url, n):
    return int(rpc(url, "eth_getBlockByNumber", [hex(n), False])["timestamp"], 16)


def first_block_after(url, ts, head):
    """Binary search inside a window estimated from the recent block rate."""
    sample = head - 100_000
    rate = (block_time(url, head) - block_time(url, sample)) / 100_000
    lo = max(head - int((time.time() - ts) / rate * 1.2), 1)
    hi = head
    while lo < hi:
        mid = (lo + hi) // 2
        if block_time(url, mid) < ts:
            lo = mid + 1
        else:
            hi = mid
    return lo


def rpc_logs(url, span):
    head = int(rpc(url, "eth_blockNumber", []), 16)
    start, logs = first_block_after(url, GENERATION_START, head), []
    for cur in range(start, head + 1, span):
        logs += rpc(url, "eth_getLogs", [{
            "address": list(FACTORIES), "topics": [DEPLOYED_TOPIC],
            "fromBlock": hex(cur), "toBlock": hex(min(cur + span - 1, head))}])
        time.sleep(0.8)
    for log in logs:
        log["timeStamp"] = hex(block_time(url, int(log["blockNumber"], 16)))
    return logs


def blockscout_logs():
    logs = []
    for factory in FACTORIES:
        out = http_json(f"{BLOCKSCOUT_ETH}?module=logs&action=getLogs&fromBlock=0&toBlock=latest"
                        f"&address={factory}&topic0={DEPLOYED_TOPIC}")
        logs += out.get("result") or []
        time.sleep(1)
    return logs


def decode_string(hexdata):
    raw = bytes.fromhex(hexdata[2:])
    if len(raw) < 64:
        return None
    n = int.from_bytes(raw[32:64], "big")
    return raw[64:64 + n].decode("utf-8", "replace")


def call_str(url, to, selector):
    try:
        return decode_string(rpc(url, "eth_call", [{"to": to, "data": selector}, "latest"]))
    except RuntimeError:
        return None


def chain_rows(chain_id, name, url, span):
    logs = rpc_logs(url, span) if span else blockscout_logs()
    rows = []
    for log in logs:
        clone = "0x" + log["topics"][1][-40:]
        rows.append({
            "chainId": chain_id, "chain": name, "address": clone,
            "kind": FACTORIES[log["address"].lower()],
            "owner": "0x" + log["topics"][3][-40:],
            "name": call_str(url, clone, "0x06fdde03"),
            "symbol": call_str(url, clone, "0x95d89b41"),
            "block": int(log["blockNumber"], 16),
            "timestamp": int(log["timeStamp"], 16),
            "tx": log["transactionHash"],
        })
    print(f"{name}: {len(rows)} collections", file=sys.stderr)
    return rows


def main():
    """Pull each chain into its own cache file; a failed chain keeps its last good cache."""
    here = Path(__file__).parent
    rows, failed = [], []
    for chain_id, (name, url, span) in CHAINS.items():
        cache = here / f"chain-{chain_id}.json"
        if "--refresh" in sys.argv or not cache.exists():
            try:
                cache.write_text(json.dumps(chain_rows(chain_id, name, url, span), indent=1))
            except RuntimeError as e:
                print(f"{name}: FAILED {e}", file=sys.stderr)
        if cache.exists():
            rows += json.loads(cache.read_text())
        else:
            failed.append(name)
    rows.sort(key=lambda r: r["timestamp"], reverse=True)
    out = here / "contracts.json"
    out.write_text(json.dumps({"generated": int(time.time()), "failedChains": failed, "contracts": rows}, indent=1))
    print(f"wrote {len(rows)} rows to {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
