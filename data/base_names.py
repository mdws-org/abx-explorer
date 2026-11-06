#!/opt/homebrew/bin/python3
"""Primary Basenames (*.base.eth) for Base deployers, forward-verified.

Reverse: L2Resolver.name(namehash("<addr>.80002105.reverse")) on Base.
Forward check: L2Resolver.addr(namehash(name)) must equal the address, so a
reverse record cannot claim someone else's name. Fills `ownerName` where empty.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import abx_rpc  # noqa: E402
from keccak import keccak256, selector  # noqa: E402

L2_RESOLVER = "0xc6d566a56a1aff6508b41f6c90ff131615583bcd"
MOCK = Path(__file__).parent.parent / "web" / "contracts.json"


def namehash(name):
    node = b"\x00" * 32
    for label in reversed(name.split(".")) if name else []:
        node = keccak256(node + keccak256(label.encode()))
    return node.hex()


def call(data):
    try:
        res = abx_rpc.rpc(8453, "eth_call", [{"to": L2_RESOLVER, "data": data}, "latest"])
    except RuntimeError:
        return None
    return bytes.fromhex(res[2:]) if res and res != "0x" else None


def basename(addr):
    raw = call(selector("name(bytes32)") + namehash(f"{addr[2:].lower()}.80002105.reverse"))
    if not raw or len(raw) < 64:
        return None
    n = int.from_bytes(raw[32:64], "big")
    name = raw[64:64 + n].decode("utf-8", "replace")
    if not name:
        return None
    fwd = call(selector("addr(bytes32)") + namehash(name))
    return name if fwd and fwd[-20:].hex() == addr[2:].lower() else None


def main():
    data = json.loads(MOCK.read_text())
    cache = {}
    for c in data["contracts"]:
        if c.get("ownerName"):
            continue
        a = c["owner"].lower()
        if a not in cache:
            cache[a] = basename(a)
        if cache[a]:
            c["ownerName"] = cache[a]
    MOCK.write_text(json.dumps(data, indent=1))
    found = {a: n for a, n in cache.items() if n}
    print(f"checked {len(cache)} unnamed deployers, found {len(found)}: {sorted(found.values())}")


if __name__ == "__main__":
    main()
