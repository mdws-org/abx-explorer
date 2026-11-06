#!/opt/homebrew/bin/python3
"""Serve web/ on 127.0.0.1:8821 with caching off, so a reload always shows the current files."""
import functools
import http.server
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "web"


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    handler = functools.partial(NoCache, directory=str(ROOT))
    http.server.ThreadingHTTPServer(("127.0.0.1", 8821), handler).serve_forever()
