#!/usr/bin/env bash
# Bind the last N product-suite runs to the exact dist bytes they tested.
# Run AFTER a clean run of record. The attestation commit must NOT
# rebuild dist — a proof must not change the object it proves; the
# refusal below makes that mistake structurally impossible to attest.
set -euo pipefail
cd "$(dirname "$0")/.."
n="${1:-4}"
python3 - "$n" <<'PY'
import hashlib, json, sys
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(65536), b""):
            h.update(b)
    return h.hexdigest()
n = int(sys.argv[1])
entries = [json.loads(l) for l in open("tests/run-manifest.jsonl", encoding="utf-8")][-n:]
dist = sha("dist/index.html")
runner = sha("tests/run.sh")
problems = []
for e in entries:
    if e["exit"] != 0: problems.append("run %d exit %d" % (e["run_id"], e["exit"]))
    if e["dirty"]: problems.append("run %d dirty" % e["run_id"])
    if not e.get("tree_stable"): problems.append("run %d tree unstable" % e["run_id"])
    if e["dist_sha256"] != dist: problems.append("run %d tested DIFFERENT dist bytes" % e["run_id"])
    if e["runner_sha256"] != runner: problems.append("run %d used a different runner" % e["run_id"])
if len({e["commit"] for e in entries}) != 1: problems.append("runs span multiple commits")
if problems:
    print("ATTESTATION REFUSED: " + "; ".join(problems))
    sys.exit(1)
att = {
    "schema": 1,
    "source_commit": entries[0]["commit"],
    "dist_sha256": dist,
    "runner_sha256": runner,
    "run_ids": [e["run_id"] for e in entries],
    "suites": {e["suite"]: e["checks"] for e in entries},
    "total_checks": sum(e["checks"] or 0 for e in entries),
}
with open("tests/attestation.json", "w", encoding="utf-8") as f:
    json.dump(att, f, indent=1, sort_keys=True)
    f.write("\n")
print("ATTESTED: " + json.dumps(att, sort_keys=True))
PY
