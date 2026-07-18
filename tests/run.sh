#!/usr/bin/env bash
# DMDS test runner — durable evidence, not verdict-only pipelines.
#
# Every run keeps its complete log in tests/logs/ (gitignored), gzips
# passing logs into tests/evidence/ keyed by content hash (gitignored;
# survives log cleanup — NOT machine loss: this repo has no remote, so
# no evidence here is off-box), archives failure logs to committed
# tests/failures/, and appends one JSON line to a ledger:
#   tests/run-manifest.jsonl             product suites
#   tests/runner-acceptance-manifest.jsonl  fixture/acceptance runs
# so synthetic failures never pollute the product failure record.
#
# Ledger entries (schema 2, python3-serialized, flock-serialized,
# per-ledger monotonic run_id) record FULL commit hash + dirty flag +
# working-diff sha256 — a run on a dirty tree must say so instead of
# attributing its results to HEAD. The ledgers themselves are excluded
# from the dirty computation (they grow during multi-suite runs).
# dist_sha256 ties the run to the exact artifact tested; runner_sha256
# ties it to the exact runner that ran it.
#
# Exit taxonomy (deliberate in every suite, not inferred):
#   0    all checks passed        (suite: process.exit(pass ? 0 : 1))
#   1    assertion failure
#   2    harness/run failure — launch timeout, navigation error, any
#        uncaught exception (suite catch-all: process.exit(2))
#   64   unknown suite name (runner allowlist)
#   >128 killed by signal (shell)
#
#   tests/run.sh              run all four suites, stop on first failure
#   tests/run.sh m1-core      run one suite
#   tests/run.sh m1-core 3    run one suite N times (flake hunting)
#   SUITES="a b" tests/run.sh all   override the suite list (acceptance)
set -u -o pipefail
cd "$(dirname "$0")/.."
mkdir -p tests/logs tests/failures tests/evidence

LEDGER_EXCLUDES=(':(exclude)tests/run-manifest.jsonl' ':(exclude)tests/runner-acceptance-manifest.jsonl')

run_suite() {
  local suite="$1"
  # allowlist: a sane name naming a real suite file — the ledger must
  # never record a suite that doesn't exist in the tree
  if ! [[ "$suite" =~ ^[a-z0-9-]+$ ]] || [ ! -f "tests/${suite}.js" ]; then
    echo "unknown suite: ${suite}" >&2
    exit 64
  fi
  local ledger="tests/run-manifest.jsonl" kind="product"
  case "$suite" in *fixture*) ledger="tests/runner-acceptance-manifest.jsonl"; kind="fixture" ;; esac
  local stamp log t0 t1 status checks commit dirty diff_sha
  # nanoseconds + pid: two runs in the same second must not collide
  stamp="$(date -u +%Y%m%dT%H%M%S.%N)-$$"
  log="tests/logs/${suite}-${stamp}.log"
  # provenance captured BEFORE the run mutates anything
  commit="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  if git diff --quiet -- . "${LEDGER_EXCLUDES[@]}" && git diff --cached --quiet -- . "${LEDGER_EXCLUDES[@]}"; then
    dirty=false
  else
    dirty=true
  fi
  diff_sha="$({ git diff --binary -- . "${LEDGER_EXCLUDES[@]}"; git diff --cached --binary -- . "${LEDGER_EXCLUDES[@]}"; } | sha256sum | cut -d' ' -f1)"
  t0="$(date -u +%s)"
  {
    echo "== env preamble =="
    date -u
    uptime
    echo "cores: $(nproc)  ($(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ //'))"
    cat /sys/fs/cgroup/cpu.max 2>/dev/null | sed 's/^/cpu.max: /' || true
    cat /sys/fs/cgroup/memory.max 2>/dev/null | sed 's/^/memory.max: /' || true
    free -h
    vmstat 1 3
    ps -eo pid,stat,%cpu,%mem,cmd | grep -E '[c]hrom(e|ium)|node tests/' || true
    echo "commit: ${commit} dirty: ${dirty}"
    echo "== suite: ${suite} =="
  } | tee "$log"
  node "tests/${suite}.js" 2>&1 | tee -a "$log"
  status=${PIPESTATUS[0]}
  t1="$(date -u +%s)"
  printf 'exit=%s\n' "$status" | tee -a "$log"
  checks="$(grep -oE 'PASS \([0-9]+ checks\)' "$log" | grep -oE '[0-9]+' | tail -1)"
  LEDGER="$ledger" KIND="$kind" SUITE="$suite" STAMP="$stamp" EXIT_STATUS="$status" \
  CHECKS="${checks:-}" COMMIT="$commit" DIRTY="$dirty" DIFF_SHA="$diff_sha" \
  LOG="$log" T0="$t0" T1="$t1" python3 - <<'PY'
import fcntl, hashlib, json, os
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(65536), b""):
            h.update(b)
    return h.hexdigest()
e = os.environ
entry = {
    "schema": 2,
    "kind": e["KIND"],
    "suite": e["SUITE"],
    "stamp": e["STAMP"],
    "start": int(e["T0"]),
    "end": int(e["T1"]),
    "elapsed_s": int(e["T1"]) - int(e["T0"]),
    "exit": int(e["EXIT_STATUS"]),
    "checks": int(e["CHECKS"]) if e["CHECKS"] else None,
    "commit": e["COMMIT"],
    "dirty": e["DIRTY"] == "true",
    "diff_sha256": e["DIFF_SHA"],
    "log_sha256": sha(e["LOG"]),
    "dist_sha256": sha("dist/index.html") if os.path.exists("dist/index.html") else None,
    "runner_sha256": sha("tests/run.sh"),
}
with open(e["LEDGER"], "a", encoding="utf-8") as f:
    fcntl.flock(f, fcntl.LOCK_EX)
    with open(e["LEDGER"], encoding="utf-8") as g:
        entry["run_id"] = sum(1 for _ in g) + 1
    f.write(json.dumps(entry, separators=(",", ":"), sort_keys=True) + "\n")
PY
  if [ "$status" -ne 0 ]; then
    cp "$log" "tests/failures/${suite}-${stamp}.log"
    echo "FAILURE LOG ARCHIVED: tests/failures/${suite}-${stamp}.log"
    exit "$status"
  fi
  # passing log → content-addressed compressed archive (survives log
  # cleanup; still on this disk only — see header)
  gzip -c "$log" > "tests/evidence/$(sha256sum "$log" | cut -d' ' -f1).log.gz"
}

case "${1:-all}" in
  all)
    for suite in ${SUITES:-m1-core m2-grab m3-depth m4-governor}; do run_suite "$suite"; done
    ;;
  *)
    reps="${2:-1}"
    for i in $(seq 1 "$reps"); do
      echo "── run $i/$reps ──"
      run_suite "$1"
    done
    ;;
esac
echo "ALL SUITES PASSED — logs tests/logs/, evidence tests/evidence/, ledger tests/run-manifest.jsonl"
