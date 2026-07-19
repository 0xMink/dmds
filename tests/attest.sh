#!/usr/bin/env bash
# Bind the last complete product regression to the exact dist bytes it
# tested. Run AFTER a clean run of record. The attestation commit must
# NOT rebuild dist — a proof must not change the object it proves; the
# refusals below make the known mistakes structurally unattestable:
#   - rebuilt-after-test dist (hash mismatch)
#   - cherry-picked single-suite runs posing as a regression (batch id,
#     exact suite composition and order)
#   - missing/corrupt retained evidence (each object re-hashed and
#     decompressed back to its log hash)
# The HTTP boundary is verified when the dev server is up: the bytes the
# server RETURNS must equal the bytes attested (serving the wrong
# directory or a stale process fails here, not in production).
set -euo pipefail
cd "$(dirname "$0")/.."
url="${DMDS_HTTP_URL:-http://127.0.0.1:8080/}"
http_sha=""
if curl -fsS --max-time 5 "$url" > /tmp/dmds-attest-http.$$ 2>/dev/null; then
  http_sha="$(sha256sum "/tmp/dmds-attest-http.$$" | cut -d' ' -f1)"
  rm -f "/tmp/dmds-attest-http.$$"
else
  rm -f "/tmp/dmds-attest-http.$$"
  echo "WARN: dev server not reachable at ${url} — serving boundary not verified" >&2
fi
HTTP_SHA="$http_sha" python3 - <<'PY'
import gzip, hashlib, json, os, sys
def sha_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(65536), b""):
            h.update(b)
    return h.hexdigest()
EXPECTED_SUITES = ["m1-core", "m2-grab", "m3-depth", "m4-governor"]
entries = [json.loads(l) for l in open("tests/run-manifest.jsonl", encoding="utf-8")][-len(EXPECTED_SUITES):]
dist = sha_file("dist/index.html")
runner = sha_file("tests/run.sh")
problems = []
if len(entries) != len(EXPECTED_SUITES):
    problems.append("incomplete ledger: %d entries" % len(entries))
if [e["suite"] for e in entries] != EXPECTED_SUITES:
    problems.append("wrong suite composition/order: %s" % [e["suite"] for e in entries])
if len({e.get("batch") for e in entries}) != 1 or entries[0].get("batch") is None:
    problems.append("entries do not share one runner-invocation batch id")
ids = [e["run_id"] for e in entries]
if ids != list(range(ids[0], ids[0] + len(ids))):
    problems.append("run_ids not contiguous: %s" % ids)
for e in entries:
    rid = e["run_id"]
    if e["exit"] != 0: problems.append("run %d exit %d" % (rid, e["exit"]))
    if e["dirty"]: problems.append("run %d dirty" % rid)
    if not e.get("tree_stable"): problems.append("run %d tree unstable" % rid)
    if not e.get("checks"): problems.append("run %d has no check count" % rid)
    if e["dist_sha256"] != dist: problems.append("run %d tested DIFFERENT dist bytes" % rid)
    if e["runner_sha256"] != runner: problems.append("run %d used a different runner" % rid)
    ep = e.get("evidence_path")
    if not ep or not os.path.isfile(ep):
        problems.append("run %d evidence object missing: %s" % (rid, ep))
    else:
        if sha_file(ep) != e["evidence_sha256"]:
            problems.append("run %d evidence object hash mismatch" % rid)
        else:
            raw = gzip.open(ep, "rb").read()
            if hashlib.sha256(raw).hexdigest() != e["log_sha256"]:
                problems.append("run %d evidence decompresses to a different log" % rid)
if len({e["commit"] for e in entries}) != 1:
    problems.append("runs span multiple commits")
http_sha = os.environ.get("HTTP_SHA") or None
if http_sha and http_sha != dist:
    problems.append("HTTP boundary returned DIFFERENT bytes than attested dist")
if problems:
    print("ATTESTATION REFUSED: " + "; ".join(problems))
    sys.exit(1)
att = {
    "schema": 2,
    "source_commit": entries[0]["commit"],
    "batch": entries[0]["batch"],
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
