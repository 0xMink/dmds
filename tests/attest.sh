#!/usr/bin/env bash
# Bind the last complete product regression to the exact dist bytes it
# tested. Run AFTER a clean run of record. The attestation commit must
# NOT rebuild dist — a proof must not change the object it proves; the
# refusals below make the known mistakes structurally unattestable:
#   - rebuilt-after-test dist (hash mismatch)
#   - cherry-picked runs posing as a regression (one batch id, exact
#     suite composition/order, and the batch must contain EXACTLY these
#     four product entries — no extra prefix runs hiding in it)
#   - a silently weakened suite (check counts enforced against the
#     EXPECTED inventory below — intentional test growth must update it
#     deliberately, which is the point)
#   - missing/corrupt retained evidence (each object re-hashed and
#     decompressed back to its log hash)
#   - unverified serving boundary: HTTP verification is REQUIRED — the
#     bytes the server returns must equal the attested bytes. Pass
#     --no-http to explicitly produce a disk-only attestation
#     (http_sha256: null, recorded as such).
set -euo pipefail
cd "$(dirname "$0")/.."
require_http=1
[ "${1:-}" = "--no-http" ] && require_http=0
url="${DMDS_HTTP_URL:-http://127.0.0.1:8080/}"
http_sha=""
if [ "$require_http" -eq 1 ]; then
  curl -fsS --max-time 5 "$url" > "/tmp/dmds-attest-http.$$" \
    || { echo "ATTESTATION REFUSED: HTTP boundary unreachable at ${url} (use --no-http for an explicit disk-only attestation)"; rm -f "/tmp/dmds-attest-http.$$"; exit 1; }
  http_sha="$(sha256sum "/tmp/dmds-attest-http.$$" | cut -d' ' -f1)"
  rm -f "/tmp/dmds-attest-http.$$"
else
  echo "NOTE: --no-http — producing a DISK-ONLY attestation (serving boundary not verified)"
fi
HTTP_SHA="$http_sha" REQUIRE_HTTP="$require_http" python3 - <<'PY'
import gzip, hashlib, json, os, sys, zlib
def sha_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(65536), b""):
            h.update(b)
    return h.hexdigest()
EXPECTED = [("m1-core", 59), ("m2-grab", 55), ("m3-depth", 35), ("m4-governor", 142)]
ledger = [json.loads(l) for l in open("tests/run-manifest.jsonl", encoding="utf-8")]
entries = ledger[-len(EXPECTED):]
dist = sha_file("dist/index.html")
runner = sha_file("tests/run.sh")
problems = []
if len(entries) != len(EXPECTED):
    problems.append("incomplete ledger: %d entries" % len(entries))
actual = [(e["suite"], e.get("checks")) for e in entries]
if actual != EXPECTED:
    problems.append("suite/check inventory changed: %s (expected %s)" % (actual, EXPECTED))
batch = entries[0].get("batch")
if batch is None or len({e.get("batch") for e in entries}) != 1:
    problems.append("entries do not share one runner-invocation batch id")
else:
    batch_entries = [e for e in ledger if e.get("batch") == batch]
    if batch_entries != entries:
        problems.append("batch %s contains additional product runs beyond the attested four" % batch)
ids = [e["run_id"] for e in entries]
if ids != list(range(ids[0], ids[0] + len(ids))):
    problems.append("run_ids not contiguous: %s" % ids)
for e in entries:
    rid = e["run_id"]
    if e.get("kind") != "product": problems.append("run %d is not a product run" % rid)
    if e.get("schema") != 3: problems.append("run %d has unexpected ledger schema" % rid)
    if e["exit"] != 0: problems.append("run %d exit %d" % (rid, e["exit"]))
    if e["dirty"]: problems.append("run %d dirty" % rid)
    if not e.get("tree_stable"): problems.append("run %d tree unstable" % rid)
    if e["dist_sha256"] != dist: problems.append("run %d tested DIFFERENT dist bytes" % rid)
    if e["runner_sha256"] != runner: problems.append("run %d used a different runner" % rid)
    ep = e.get("evidence_path")
    if not ep or not os.path.isfile(ep):
        problems.append("run %d evidence object missing: %s" % (rid, ep))
    else:
        if sha_file(ep) != e["evidence_sha256"]:
            problems.append("run %d evidence object hash mismatch" % rid)
        else:
            # the sha gate above proves the object matches the LEDGER's
            # claim — a forged ledger can bless malformed bytes, so the
            # decompressor must refuse in-band, never traceback
            try:
                raw = gzip.open(ep, "rb").read()
            except (OSError, EOFError, zlib.error) as exc:
                problems.append("run %d evidence archive is not readable gzip: %s" % (rid, type(exc).__name__))
            else:
                if hashlib.sha256(raw).hexdigest() != e["log_sha256"]:
                    problems.append("run %d evidence decompresses to a different log" % rid)
if len({e["commit"] for e in entries}) != 1:
    problems.append("runs span multiple commits")
http_sha = os.environ.get("HTTP_SHA") or None
if os.environ.get("REQUIRE_HTTP") == "1" and http_sha != dist:
    problems.append("HTTP boundary returned DIFFERENT bytes than attested dist")
if problems:
    print("ATTESTATION REFUSED: " + "; ".join(problems))
    sys.exit(1)
att = {
    "schema": 3,
    "source_commit": entries[0]["commit"],
    "batch": batch,
    "dist_sha256": dist,
    "http_sha256": http_sha,
    "runner_sha256": runner,
    "run_ids": ids,
    "suites": {e["suite"]: e["checks"] for e in entries},
    "total_checks": sum(e["checks"] for e in entries),
}
with open("tests/attestation.json", "w", encoding="utf-8") as f:
    json.dump(att, f, indent=1, sort_keys=True)
    f.write("\n")
print("ATTESTED: " + json.dumps(att, sort_keys=True))
PY
