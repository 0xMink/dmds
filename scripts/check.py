#!/usr/bin/env python3
"""DMDS™ build verification — the enforcement half of DESIGN.md.

Fails the build when:
  1. a data-claim value on the page disagrees with the claim registry
  2. a registry claim marked dom:true is missing from the page
  3. a claim is past its review_by date (stale evidence never ships)
  4. markup/styles/scripts use a glyph that is neither in the embedded
     font subsets nor on the explicit system-fallback allowlist
  5. the CSP hashes in dist/ don't match the inline blocks they guard
  6. the provenance stamp is missing from dist/
  7. dist/ exceeds its size budgets (raw / gzip)
"""
import base64
import datetime
import glob
import gzip
import hashlib
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
DIST = os.path.join(ROOT, "dist", "index.html")

# Budgets (bytes). Raw is what a cheap host serves uncompressed;
# gzip is what any sane host actually sends.
# raised per the approved GPGPU-engine spec (docs/superpowers/specs/
# 2026-07-17-gpgpu-physical-engine-design.md): the tier-1 engine +
# governor + debug instrumentation earn the growth; tripwires stay loud
BUDGET_RAW = 512 * 1024   # hard ceiling (spec)
BUDGET_GZIP = 280 * 1024
WARN_RAW = 352 * 1024     # loud warning near current size — growth must be
WARN_GZIP = 160 * 1024    # explained, not silently absorbed by the ceiling

# Glyphs intentionally rendered by system fallback fonts (not in the
# embedded subsets): UI arrows, the scramble-effect block glyphs, and
# ™ (the subsets contain ® but not ™, the font sources are not in the
# repo to re-subset, and a fallback-rendered small superscript legal
# mark beats shipping an ® the mark doesn't legally carry).
# Present in every mainstream OS font stack; worst case they degrade
# to a different arrow/block shape, never to meaning loss.
SYSTEM_FALLBACK_OK = set("↗↘→←↔█▓▒░™")

errors = []
warnings = []


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


# ── 1–3: claim registry ─────────────────────────────────────────
claims_src = read(os.path.join(SRC, "claims.js"))
m = re.search(r"/\* claims-json-start \*/(.*)/\* claims-json-end \*/", claims_src, re.S)
if not m:
    errors.append("claims.js: json markers missing")
    registry = {}
else:
    registry = json.loads(m.group(1))["claims"]

html = read(os.path.join(SRC, "index.html"))
page_claims = {}
for tag in re.finditer(r'<(\w+)([^>]*\bdata-claim="([^"]+)"[^>]*)>([^<]*)<', html):
    attrs, cid, text = tag.group(2), tag.group(3), tag.group(4).strip()
    dc = re.search(r'data-count="([^"]*)"', attrs)
    page_claims[cid] = dc.group(1) if dc else text

for cid, value in page_claims.items():
    if cid not in registry:
        errors.append(f"claim {cid}: on page, not in registry")
    elif value != str(registry[cid]["page"]):
        errors.append(f"claim {cid}: page says {value!r}, registry says {registry[cid]['page']!r}")

today = datetime.date.today()
for cid, c in registry.items():
    if c.get("dom") and cid not in page_claims:
        errors.append(f"claim {cid}: dom:true but missing from page")
    due = datetime.date.fromisoformat(c["review_by"])
    if due < today:
        errors.append(f"claim {cid}: past review_by {c['review_by']} — re-verify and bump the date")
    elif (due - today).days <= 14:
        warnings.append(f"claim {cid}: review due {c['review_by']}")

# stat animation integrity: text content must equal data-count
for m2 in re.finditer(r'data-count="(\d+)"[^>]*>(\d+)<', html):
    if m2.group(1) != m2.group(2):
        errors.append(f"stat markup: data-count={m2.group(1)} but text={m2.group(2)} (no-JS readers see the text)")

# ── 4: glyph coverage against the real embedded cmaps ───────────
try:
    from fontTools.ttLib import TTFont

    covered = set()
    fonts_css = read(os.path.join(SRC, "fonts.css"))
    for fm in re.finditer(r"base64,([A-Za-z0-9+/=]+)", fonts_css):
        font = TTFont(io.BytesIO(base64.b64decode(fm.group(1))))
        for table in font["cmap"].tables:
            covered.update(chr(cp) for cp in table.cmap)

    def strip_comments(text, kind):
        if kind == "html":
            return re.sub(r"<!--.*?-->", "", text, flags=re.S)
        text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
        if kind == "js":  # line comments never reach a visitor's screen
            text = re.sub(r"(?:^|(?<=\s))//.*$", "", text, flags=re.M)
        return text

    glyph_files = [("index.html", "html"), ("main.js", "js"), ("styles.css", "css"), ("gl.js", "js"), ("gl2.js", "js"), ("claims.js", "js"), ("term.js", "js"), ("page.css", "css"), ("page.js", "js")]
    glyph_files += [(os.path.join("pages", os.path.basename(p)), "html")
                    for p in sorted(glob.glob(os.path.join(SRC, "pages", "*.html")))]
    for fname, kind in glyph_files:
        path = os.path.join(SRC, fname)
        if not os.path.exists(path):
            continue
        body = strip_comments(read(path), kind)
        for ch in sorted({c for c in body if ord(c) > 127}):
            if ch not in covered and ch not in SYSTEM_FALLBACK_OK:
                errors.append(f"{fname}: glyph {ch!r} (U+{ord(ch):04X}) not in font subsets or fallback allowlist")
except ImportError:
    warnings.append("fontTools unavailable — glyph coverage not checked")

# ── subpage discipline: no data-claim outside the studio page — the
# runtime claims↔DOM verify only runs there; a subpage claim would be
# build-checked at best and the page must not imply the stronger tier ──
for p in sorted(glob.glob(os.path.join(SRC, "pages", "*.html"))):
    if "data-claim" in read(p):
        errors.append(f"{os.path.relpath(p, ROOT)}: data-claim on a subpage — quantitative claims live on the studio page (or wire subpage runtime verification first)")

# ── 5–7: the built artifacts (studio page + every subpage) ──────
artifacts = ([DIST] if os.path.exists(DIST) else []) + \
    sorted(glob.glob(os.path.join(ROOT, "dist", "*", "index.html")))
if artifacts:
    def sha(s):
        return "sha256-" + base64.b64encode(hashlib.sha256(s.encode()).digest()).decode()

    for apath in artifacts:
        rel = os.path.relpath(apath, ROOT)
        dist = read(apath)

        cm = re.search(r'Content-Security-Policy" content="([^"]+)"', dist)
        if not cm:
            errors.append(f"{rel}: CSP meta missing")
        else:
            declared = set(re.findall(r"sha256-[A-Za-z0-9+/=]+", cm.group(1)))
            actual = {sha(b.group(1)) for b in re.finditer(r"<style>(.*?)</style>", dist, re.S)}
            actual |= {sha(b.group(1)) for b in re.finditer(r"<script>(.*?)</script>", dist, re.S)}
            if declared != actual:
                errors.append(f"{rel}: CSP hash mismatch (declared {len(declared)}, actual {len(actual)})")

        if "dmds-build" not in dist:
            errors.append(f"{rel}: provenance stamp missing")

        for gate in sorted(set(re.findall(r'data-owner-gate="([^"]+)"', dist))):
            warnings.append(f"{rel}: unresolved owner gate {gate!r} — must be filled before deploy")

        raw = os.path.getsize(apath)
        gz = len(gzip.compress(dist.encode()))
        print(f"check: {rel} {raw/1024:.0f} KB raw / {gz/1024:.0f} KB gzip "
              f"(budget {BUDGET_RAW//1024}/{BUDGET_GZIP//1024})")
        if raw > BUDGET_RAW:
            errors.append(f"{rel}: {raw/1024:.0f} KB raw exceeds {BUDGET_RAW//1024} KB budget")
        elif raw > WARN_RAW:
            warnings.append(f"{rel}: {raw/1024:.0f} KB raw past the {WARN_RAW//1024} KB warning line")
        if gz > BUDGET_GZIP:
            errors.append(f"{rel}: {gz/1024:.0f} KB gzip exceeds {BUDGET_GZIP//1024} KB budget")
        elif gz > WARN_GZIP:
            warnings.append(f"{rel}: {gz/1024:.0f} KB gzip past the {WARN_GZIP//1024} KB warning line")
else:
    warnings.append("dist/index.html not built yet — artifact checks skipped")

for w in warnings:
    print(f"check: WARN  {w}")
for e in errors:
    print(f"check: FAIL  {e}")
if errors:
    sys.exit(1)
print(f"check: PASS  {len(registry)} claims verified, glyphs covered, CSP + provenance + budgets OK")
