#!/usr/bin/env python3
"""The function selectors web/app.js reads a collection with (DEP_SEL) must be the first four bytes of the
Keccak-256 of the signatures named here. A selector typed wrong reads nothing, and the detail view would say
"Not read" for every collection with no other sign of it.

usage: python3 tools/check-selectors.py
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE / "data"))
from keccak import keccak256  # noqa: E402

SIGNATURES = {
    "uriLocked": "tokenURILocked()", "renderer": "tokenURIRenderer()", "base": "tokenURIBase()",
    "chunks": "scriptChunkCount()", "scriptLocked": "scriptLocked()",
    "depCount": "dependencyCount()", "depsLocked": "dependenciesLocked()",
    "hooks": "paramHooks()", "hooksLocked": "paramHooksLocked()",
    "field": "contractField(bytes32)", "fieldLocked": "contractFieldLocked(bytes32)",
}


def main():
    source = (HERE / "web" / "app.js").read_text()
    block = re.search(r"const DEP_SEL = \{(.*?)\};", source, re.S)
    if not block:
        sys.exit("web/app.js holds no DEP_SEL")
    found = dict(re.findall(r"(\w+): '(0x[0-9a-f]{8})'", block.group(1)))
    problems = []
    for name, signature in SIGNATURES.items():
        digest = keccak256(signature.encode())
        want = "0x" + (digest.hex() if isinstance(digest, (bytes, bytearray)) else str(digest).removeprefix("0x"))[:8]
        if found.get(name) != want:
            problems.append(f"{name}: {signature} is {want}, app.js has {found.get(name)}")
    problems += [f"{name}: in app.js but not named here" for name in found if name not in SIGNATURES]
    if problems:
        sys.exit("selectors do not match:\n  " + "\n  ".join(problems))
    print(f"ok: {len(SIGNATURES)} selectors match their signatures")


if __name__ == "__main__":
    main()
