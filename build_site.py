#!/opt/homebrew/bin/python3
"""Build the publishable abx.thebenmeadows.com site from web/ into site/.

Copies real files (symlinks resolved), drops the review banner and the meta CSP
(the live CSP is a Cloudflare response header), and refuses to finish if any
local-only reference survives.
"""
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC, OUT = HERE / "web", HERE / "site"
FILES = ["index.html", "mint.html", "app.js", "mint.js", "style.css", "theme.js", "publicsans.woff2",
         "contracts.json", "news.json", "ours.json"]
GENERATED = {"contracts.json", "ours.json"}


def build():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    for name in FILES:
        if not (SRC / name).exists() and name in GENERATED:
            print(f"skipped {name}: not generated yet (see README, 'Run it locally')")
            continue
        shutil.copyfile((SRC / name).resolve(), OUT / name)
    if (SRC / "img").exists():
        shutil.copytree(SRC / "img", OUT / "img")
    for page in ("index.html", "mint.html"):
        p = OUT / page
        html = p.read_text()
        html = re.sub(r'\s*<div class="mock-flag">.*?</div>', "", html, flags=re.S)
        html = re.sub(r'\s*<meta http-equiv="Content-Security-Policy"[^>]*>', "", html)
        p.write_text(html)
    css = OUT / "style.css"
    css.write_text(re.sub(r"\n\.mock-flag \{.*?\n\}\n", "\n", css.read_text(), flags=re.S))
    problems = [f"{f.name}: {m}" for f in OUT.rglob("*") if f.suffix in {".html", ".js", ".css"}
                for m in re.findall(r"127\.0\.0\.1|localhost|mock-flag|Mockup for review", f.read_text())]
    if problems:
        sys.exit("local-only references left: " + ", ".join(problems))
    count = sum(1 for f in OUT.rglob("*") if f.is_file())
    print(f"built {count} files in {OUT}")


if __name__ == "__main__":
    build()
