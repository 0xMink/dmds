#!/usr/bin/env bash
# DMDS® build — inlines fonts, styles and scripts into a single
# self-contained dist/index.html (zero external requests on load),
# stamps provenance, generates a hash-based CSP, then verifies the
# artifact (claims registry, glyph coverage, CSP, size budgets).
set -euo pipefail
cd "$(dirname "$0")"

SRC=src
OUT=dist/index.html
mkdir -p dist

# provenance inputs: commit (marked -dirty if the SOURCE tree isn't clean)
# and a timestamp that SOURCE_DATE_EPOCH can pin for reproducible builds.
# dist/ is excluded from the dirty computation: the artifact's stamp names
# the source commit it was built FROM, and dist is committed in a separate
# follow-up commit — otherwise the stamp could never match (the commit
# containing dist cannot be known before dist is built).
DMDS_GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo untracked)"
if [ -n "$(git status --porcelain -- . ':!dist' 2>/dev/null)" ]; then
  DMDS_GIT_SHA="${DMDS_GIT_SHA}-dirty"
fi
export DMDS_GIT_SHA
export DMDS_BUILD_TS="$(date -u -d "@${SOURCE_DATE_EPOCH:-$(date +%s)}" +%Y-%m-%dT%H:%M:%SZ)"

python3 - "$SRC" "$OUT" << 'EOF'
import sys, os, re, hashlib, base64

src, out = sys.argv[1], sys.argv[2]
html = open(os.path.join(src, "index.html")).read()

styles, scripts = [], []

def inline_css(m):
    css = open(os.path.join(src, m.group(1))).read()
    body = "\n" + css + "\n"
    styles.append(body)
    return "<style>" + body + "</style>"

def inline_js(m):
    js = open(os.path.join(src, m.group(1))).read()
    body = "\n" + js + "\n"
    scripts.append(body)
    return "<script>" + body + "</script>"

html = re.sub(r'<link rel="stylesheet" href="([^"]+)">', inline_css, html)
html = re.sub(r'<script src="([^"]+)"></script>', inline_js, html)

# ── Content-Security-Policy: hash-allowlisted inline blocks only ──
# connect-src is derived from the form's data-endpoint: 'none' while no
# endpoint is configured (the page then *cannot* make a network request),
# or exactly that endpoint's origin once one is set.
def sha(s):
    return "'sha256-" + base64.b64encode(hashlib.sha256(s.encode()).digest()).decode() + "'"

ep = re.search(r'data-endpoint="([^"]*)"', html)
endpoint = ep.group(1).strip() if ep else ""
if endpoint:
    om = re.match(r"https://[^/]+", endpoint)
    assert om, f"data-endpoint must be an absolute https:// URL, got {endpoint!r}"
    connect = om.group(0)
else:
    connect = "'none'"

csp = (
    "default-src 'none'; "
    "style-src " + " ".join(sha(s) for s in styles) + "; "
    "script-src " + " ".join(sha(s) for s in scripts) + "; "
    "img-src data:; font-src data:; connect-src " + connect + "; "
    "base-uri 'none'; form-action 'self'"
)
csp_tag = '<meta http-equiv="Content-Security-Policy" content="' + csp + '">'
html, n = re.subn(r'<!-- build:csp[^>]*-->', csp_tag, html)
assert n == 1, "build:csp placeholder missing from src/index.html"

# ── provenance: the artifact says which commit built it, and when ──
stamp = os.environ["DMDS_GIT_SHA"] + " " + os.environ["DMDS_BUILD_TS"]
html = html.replace("</head>", '<meta name="dmds-build" content="' + stamp + '">\n</head>')
html += "<!-- dmds build " + stamp + " -->\n"

open(out, "w").write(html)
print(f"built {out}: {os.path.getsize(out)/1024:.0f} KB  (commit {os.environ['DMDS_GIT_SHA']})")
EOF

python3 scripts/check.py
