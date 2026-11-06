"""ABX creator RPC (https://services.abx.io/v1/rpc/{chainId}), authenticated with an ABX Services key.

The key comes from the ABX_SERVICES_API_KEY environment variable, or from the .env
file that `abx auth login` writes (ABX_ENV_FILE, default ./.env). It is never printed
or passed on a command line. The creator RPC is for private creator use: never put
this endpoint or key in a public page.
Every failure surfaces as RuntimeError; redirects are refused so the key never follows one.
"""
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ENV = Path(os.environ.get("ABX_ENV_FILE", ".env"))
BASE_URL = "https://services.abx.io/v1/rpc/{}"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


_OPENER = urllib.request.build_opener(_NoRedirect)


def _key():
    if os.environ.get("ABX_SERVICES_API_KEY"):
        return os.environ["ABX_SERVICES_API_KEY"]
    if not ENV.exists():
        raise RuntimeError("no ABX key: set ABX_SERVICES_API_KEY, or run `abx auth login` and point ABX_ENV_FILE at its .env")
    for line in ENV.read_text().splitlines():
        m = re.match(r"\s*(?:export\s+)?ABX_SERVICES_API_KEY\s*=\s*(.*)$", line)
        if m:
            return m.group(1).strip().strip('"').strip("'")
    raise RuntimeError(f"ABX_SERVICES_API_KEY is missing from {ENV}; run `abx auth login`")


def rpc(chain_id, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    headers = {"content-type": "application/json", "authorization": f"Bearer {_key()}",
               "user-agent": "abx-directory/0.1"}
    for attempt in range(4):
        req = urllib.request.Request(BASE_URL.format(chain_id), body, headers)
        try:
            with _OPENER.open(req, timeout=30) as r:
                out = json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                time.sleep(3 * (attempt + 1))
                continue
            raise RuntimeError(f"{method}: HTTP {e.code}") from None
        except (OSError, ValueError):
            time.sleep(3 * (attempt + 1))
            continue
        if "error" in out:
            raise RuntimeError(f"{method}: {str(out['error'])[:200]}")
        return out["result"]
    raise RuntimeError(f"{method} failed on the ABX creator RPC")
