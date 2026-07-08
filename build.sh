#!/usr/bin/env bash
# DMDS® build — inlines fonts, styles and scripts into a single
# self-contained dist/index.html (zero external requests).
set -euo pipefail
cd "$(dirname "$0")"

SRC=src
OUT=dist/index.html
mkdir -p dist

python3 - "$SRC" "$OUT" << 'EOF'
import sys, os, re

src, out = sys.argv[1], sys.argv[2]
html = open(os.path.join(src, "index.html")).read()

def inline_css(m):
    css = open(os.path.join(src, m.group(1))).read()
    return "<style>\n" + css + "\n</style>"

def inline_js(m):
    js = open(os.path.join(src, m.group(1))).read()
    return "<script>\n" + js + "\n</script>"

html = re.sub(r'<link rel="stylesheet" href="([^"]+)">', inline_css, html)
html = re.sub(r'<script src="([^"]+)"></script>', inline_js, html)

open(out, "w").write(html)
print(f"built {out}: {os.path.getsize(out)/1024:.0f} KB")
EOF
