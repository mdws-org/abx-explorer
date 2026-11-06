#!/opt/homebrew/bin/python3
"""Add onchain collection metadata and a preview image to contracts.json.

Reads contractURI() and tokenURI(0|1) from each collection. data: images are
written to web/img/; http(s) and ipfs images are kept as URLs. Writes
web/contracts.json for the page.
"""
import base64
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

RPC = {
    1: "https://ethereum-rpc.publicnode.com",
    8453: "https://mainnet.base.org",
    42161: "https://arb1.arbitrum.io/rpc",
    4663: "https://rpc.mainnet.chain.robinhood.com",
}
HERE = Path(__file__).parent
MOCK = HERE.parent / "web"
IMG = MOCK / "img"
IPFS_GATEWAY = "https://ipfs.io/ipfs/"


def eth_call_string(chain_id, to, data):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                       "params": [{"to": to, "data": data}, "latest"]}).encode()
    req = urllib.request.Request(RPC[chain_id], body,
                                 {"content-type": "application/json", "user-agent": "abx-directory/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            out = json.load(r)
    except (OSError, json.JSONDecodeError):
        return None
    res = out.get("result")
    if not res or len(res) < 130:
        return None
    raw = bytes.fromhex(res[2:])
    n = int.from_bytes(raw[32:64], "big")
    return raw[64:64 + n].decode("utf-8", "replace")


def parse_data_uri(uri):
    """Return (mime, bytes) for a data: URI, else None."""
    m = re.match(r"data:([^,;]*)((?:;[^,]*)*),(.*)", uri or "", re.S)
    if not m:
        return None
    mime, params, payload = m.group(1) or "text/plain", m.group(2), m.group(3)
    if ";base64" in params:
        return mime, base64.b64decode(payload)
    return mime, urllib.parse.unquote(payload).encode()


def load_json_uri(uri):
    if uri and uri.startswith("https://"):
        try:
            req = urllib.request.Request(uri, headers={"user-agent": "abx-directory/0.1"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except (OSError, json.JSONDecodeError):
            return None
    parsed = parse_data_uri(uri)
    if parsed:
        try:
            return json.loads(parsed[1])
        except json.JSONDecodeError:
            return None
    return None


def keep_image(src, stem):
    """Store a data: image as a file; pass URLs through."""
    if not src:
        return None
    if src.startswith("ipfs://"):
        return IPFS_GATEWAY + src[7:]
    if src.startswith("http"):
        return src
    parsed = parse_data_uri(src)
    if not parsed:
        return None
    mime, blob = parsed
    ext = {"image/svg+xml": "svg", "image/png": "png", "image/gif": "gif",
           "image/jpeg": "jpg", "image/webp": "webp"}.get(mime)
    if not ext:
        return None
    IMG.mkdir(exist_ok=True)
    path = IMG / f"{stem}.{ext}"
    path.write_bytes(blob)
    return f"img/{path.name}"


def enrich(c):
    stem = f"{c['chainId']}-{c['address'][2:10]}"
    meta = load_json_uri(eth_call_string(c["chainId"], c["address"], "0xe8a3d485")) or {}
    c["description"] = meta.get("description")
    c["creator"] = meta.get("creator") or meta.get("artist")
    c["link"] = meta.get("external_link") or meta.get("external_url")
    image = meta.get("image")
    for token in (0, 1):
        if image:
            break
        tok = load_json_uri(eth_call_string(c["chainId"], c["address"], "0xc87b56dd" + f"{token:064x}"))
        if tok:
            image = tok.get("image")
            c["live"] = bool(tok.get("animation_url"))
            c["previewToken"] = token
    c["image"] = keep_image(image, stem)


def main():
    data = json.loads((HERE / "contracts.json").read_text())
    for c in data["contracts"]:
        enrich(c)
        print(f"{c['chain']:16} {str(c['name'])[:40]:40} image={'yes' if c['image'] else 'no'}", file=sys.stderr)
    (MOCK / "contracts.json").write_text(json.dumps(data, indent=1))


if __name__ == "__main__":
    main()
