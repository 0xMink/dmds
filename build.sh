#!/usr/bin/env bash
# DMDS® build — inlines fonts, styles and scripts into self-contained
# HTML artifacts (zero external requests on load), stamps provenance,
# generates a hash-based CSP per page, emits robots.txt + sitemap.xml,
# then verifies the artifacts (claims registry, glyph coverage, CSP,
# size budgets).
#
# Pages: src/index.html → dist/index.html (the studio page), plus
# src/pages/<slug>.html → dist/<slug>/index.html (subpages — same
# pipeline, same discipline, no engine).
set -euo pipefail
cd "$(dirname "$0")"

SRC=src
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

python3 - "$SRC" << 'EOF'
import sys, os, re, glob, hashlib, base64

src = sys.argv[1]
stamp = os.environ["DMDS_GIT_SHA"] + " " + os.environ["DMDS_BUILD_TS"]

def sha(s):
    return "'sha256-" + base64.b64encode(hashlib.sha256(s.encode()).digest()).decode() + "'"

def build_page(page_path, out_path):
    html = open(page_path).read()
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

    # asset hrefs resolve against src/ regardless of the page's folder —
    # subpages reference the same shared fonts.css/styles.css by name
    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">', inline_css, html)
    html = re.sub(r'<script src="([^"]+)"></script>', inline_js, html)

    # ── Content-Security-Policy: hash-allowlisted inline blocks only ──
    # Hashes are computed from the FINAL html by scanning every bare
    # <style>/<script> block — the same scan check.py verifies with — so
    # literal blocks authored in the page (e.g. the no-JS loader style)
    # are first-class, not just the blocks this script inlined. Typed
    # scripts (application/ld+json) are data blocks outside CSP scope.
    # connect-src is derived from the form's data-endpoint: 'none' while no
    # endpoint is configured (the page then *cannot* make a network request),
    # or exactly that endpoint's origin once one is set.
    styles = re.findall(r"<style>(.*?)</style>", html, re.S)
    scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
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
    assert n == 1, f"build:csp placeholder missing from {page_path}"

    # ── provenance: the artifact says which commit built it, and when ──
    html = html.replace("</head>", '<meta name="dmds-build" content="' + stamp + '">\n</head>')
    # visible freshness stamp (footer): same provenance, human-readable —
    # the stamp is build-generated, so the readout is true by construction
    html = html.replace("%%DMDS_BUILD%%",
                        os.environ["DMDS_GIT_SHA"] + " · " + os.environ["DMDS_BUILD_TS"][:10])
    html += "<!-- dmds build " + stamp + " -->\n"

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    open(out_path, "w").write(html)
    gates = sorted(set(re.findall(r'data-owner-gate="([^"]+)"', html)))
    print(f"built {out_path}: {os.path.getsize(out_path)/1024:.0f} KB  (commit {os.environ['DMDS_GIT_SHA']})")
    return gates

urls = []
all_gates = {}

gates = build_page(os.path.join(src, "index.html"), os.path.join("dist", "index.html"))
urls.append("https://dmds.studio/")
if gates: all_gates["dist/index.html"] = gates

for page in sorted(glob.glob(os.path.join(src, "pages", "*.html"))):
    slug = os.path.splitext(os.path.basename(page))[0]
    gates = build_page(page, os.path.join("dist", slug, "index.html"))
    urls.append(f"https://dmds.studio/{slug}/")
    if gates: all_gates[f"dist/{slug}/index.html"] = gates

# ── robots.txt + sitemap.xml + llms.txt — the crawl surface ships with the site ──
open("dist/robots.txt", "w").write(
    "User-agent: *\nAllow: /\n\nSitemap: https://dmds.studio/sitemap.xml\n"
    "LLMs-Txt: https://dmds.studio/llms.txt\n")
import shutil
shutil.copy(os.path.join(src, "llms.txt"), "dist/llms.txt")
lastmod = os.environ["DMDS_BUILD_TS"][:10]
sm = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
for u in urls:
    sm.append(f"  <url><loc>{u}</loc><lastmod>{lastmod}</lastmod></url>")
sm.append("</urlset>")
open("dist/sitemap.xml", "w").write("\n".join(sm) + "\n")
print(f"built dist/robots.txt + dist/sitemap.xml ({len(urls)} URLs)")

# ── owner-gate tripwire: a page with unresolved gates must not ship ──
for path, gates in all_gates.items():
    print(f"WARNING: {path} carries UNRESOLVED OWNER GATES: {', '.join(gates)} — DO NOT DEPLOY until the owner fills them")
EOF

python3 scripts/check.py
