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
#   - a malformed ledger (unparseable JSON, wrong shapes/types): the
#     verifier distrusts its inputs, so crayon refuses in-band —
#     never a traceback
# The attestation (schema 4) records attest_sha256 — the hash of THIS
# script, i.e. the exact verifier that performed the proof (the output
# file is not hashed into itself, so no self-reference loop). Issuance
# is atomic (tmp + fsync + rename): a refusal or crash NEVER creates,
# replaces, or truncates an existing standing attestation.
#   - unverified serving boundary: HTTP verification is REQUIRED — the
#     bytes the server returns must equal the attested bytes. Pass
#     --no-http to explicitly produce a disk-only attestation
#     (http_sha256: null, recorded as such).
set -euo pipefail
cd "$(dirname "$0")/.."
require_http=1
[ "${1:-}" = "--no-http" ] && require_http=0
url="${DMDS_HTTP_URL:-http://127.0.0.1:8080/}"
# verifier stability: hash THIS script's bytes before doing anything
# else; issuance later refuses if they changed mid-verification, so
# attest_sha256 names the bytes that RAN, not whatever was on disk at
# the end. The override is a refusal-only test seam — a forged value
# can only cause a refusal, never a false attestation.
attest_before="${DMDS_ATTEST_BEFORE_OVERRIDE:-$(sha256sum tests/attest.sh | cut -d' ' -f1)}"
http_sha=""
if [ "$require_http" -eq 1 ]; then
  curl -fsS --max-time 5 "$url" > "/tmp/dmds-attest-http.$$" \
    || { echo "ATTESTATION REFUSED: HTTP boundary unreachable at ${url} (use --no-http for an explicit disk-only attestation)"; rm -f "/tmp/dmds-attest-http.$$"; exit 1; }
  http_sha="$(sha256sum "/tmp/dmds-attest-http.$$" | cut -d' ' -f1)"
  rm -f "/tmp/dmds-attest-http.$$"
else
  echo "NOTE: --no-http — producing a DISK-ONLY attestation (serving boundary not verified)"
fi
HTTP_SHA="$http_sha" REQUIRE_HTTP="$require_http" ATTEST_BEFORE="$attest_before" python3 - <<'PY'
import fcntl, gzip, hashlib, json, os, sys, tempfile, zlib
def sha_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(65536), b""):
            h.update(b)
    return h.hexdigest()
def refuse(msg):
    print("ATTESTATION REFUSED: " + msg)
    sys.exit(1)
EXPECTED = [("m1-core", 59), ("m2-grab", 55), ("m3-depth", 35), ("m4-governor", 142)]
# parse + shape validation BEFORE the semantic predicates: everything
# below indexes into these entries, so malformed input must be refused
# here, in-band, rather than surfacing as JSONDecodeError/KeyError
try:
    with open("tests/run-manifest.jsonl", encoding="utf-8") as f:
        ledger = [json.loads(l) for l in f]
except (OSError, ValueError) as exc:
    refuse("ledger malformed: %s" % type(exc).__name__)
if not ledger:
    refuse("ledger malformed: empty")
if not all(isinstance(e, dict) for e in ledger):
    refuse("ledger malformed: non-object entry")
entries = ledger[-len(EXPECTED):]
SHAPE = {
    "schema": int, "kind": str, "suite": str, "run_id": int, "exit": int,
    "checks": (int, type(None)), "commit": str, "dirty": bool,
    "tree_stable": bool, "batch": str, "dist_sha256": str,
    "runner_sha256": str, "log_sha256": str,
    "evidence_path": (str, type(None)), "evidence_sha256": (str, type(None)),
}
# exact typing for integer fields: isinstance(False, int) is True in
# Python, and False == 0 satisfies the exit predicate — so bool must
# be rejected explicitly or a crayon gets classified as a number
def well_typed(v, t):
    if t is int:
        return type(v) is int
    if t == (int, type(None)):
        return v is None or type(v) is int
    return isinstance(v, t)
for e in entries:
    for k, t in SHAPE.items():
        if k not in e:
            refuse("ledger malformed: entry missing %s" % k)
        if not well_typed(e[k], t):
            refuse("ledger malformed: %s has wrong type" % k)
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
# the verifier's tree_stable: refuse if this script's bytes changed
# between the pre-hash and issuance
if sha_file("tests/attest.sh") != os.environ["ATTEST_BEFORE"]:
    refuse("verifier changed during attestation")
att = {
    "schema": 4,
    "attest_sha256": os.environ["ATTEST_BEFORE"],
    "source_commit": entries[0]["commit"],
    "batch": batch,
    "dist_sha256": dist,
    "http_sha256": http_sha,
    "runner_sha256": runner,
    "run_ids": ids,
    "suites": {e["suite"]: e["checks"] for e in entries},
    "total_checks": sum(e["checks"] for e in entries),
}
# atomic, serialized issuance: an exclusive lock plus a UNIQUE tmp
# file (a fixed tmp name lets two concurrent verifiers write through
# each other's inode), fsync of file AND directory — a crash or a
# racing verifier must never leave a truncated or post-replacement-
# mutated certificate where a valid standing one used to be
with open("tests/attestation.lock", "w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    fd, tmp = tempfile.mkstemp(prefix=".attestation.", suffix=".tmp", dir="tests")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(att, f, indent=1, sort_keys=True)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, "tests/attestation.json")
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    dfd = os.open("tests", os.O_DIRECTORY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)
print("ATTESTED: " + json.dumps(att, sort_keys=True))
PY
