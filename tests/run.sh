#!/usr/bin/env bash
# DMDS test runner — durable evidence, not verdict-only pipelines.
# Every run keeps its complete log + exit status in tests/logs/, and
# appends one JSON line to tests/run-manifest.jsonl (committed) with
# the commit, suite, timestamp, exit, check count and log SHA-256 —
# so evidence survives even if the gitignored logs don't. Failure
# logs are additionally copied to tests/failures/ (committed).
#
# Exit taxonomy (deliberate in every suite, not inferred):
#   0    all checks passed        (suite: process.exit(pass ? 0 : 1))
#   1    assertion failure
#   2    harness/run failure — launch timeout, navigation error, any
#        uncaught exception (suite catch-all: process.exit(2))
#   >128 killed by signal (shell)
#
#   tests/run.sh              run all four suites, stop on first failure
#   tests/run.sh m1-core      run one suite
#   tests/run.sh m1-core 3    run one suite N times (flake hunting),
#                             stopping immediately on any failure
set -u -o pipefail
cd "$(dirname "$0")/.."
mkdir -p tests/logs tests/failures

run_suite() {
  local suite="$1"
  local stamp log status checks commit
  # nanoseconds + pid: two runs in the same second must not collide
  stamp="$(date -u +%Y%m%dT%H%M%S.%N)-$$"
  log="tests/logs/${suite}-${stamp}.log"
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
    echo "== suite: ${suite} =="
  } | tee "$log"
  node "tests/${suite}.js" 2>&1 | tee -a "$log"
  status=${PIPESTATUS[0]}
  printf 'exit=%s\n' "$status" | tee -a "$log"
  checks="$(grep -oE 'PASS \([0-9]+ checks\)' "$log" | grep -oE '[0-9]+' | tail -1)"
  commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  printf '{"commit":"%s","suite":"%s","stamp":"%s","exit":%s,"checks":%s,"log_sha256":"%s"}\n' \
    "$commit" "$suite" "$stamp" "$status" "${checks:-null}" \
    "$(sha256sum "$log" | cut -d' ' -f1)" >> tests/run-manifest.jsonl
  if [ "$status" -ne 0 ]; then
    cp "$log" "tests/failures/${suite}-${stamp}.log"
    echo "FAILURE LOG ARCHIVED: tests/failures/${suite}-${stamp}.log"
    exit "$status"
  fi
}

case "${1:-all}" in
  all)
    for suite in m1-core m2-grab m3-depth m4-governor; do run_suite "$suite"; done
    ;;
  *)
    reps="${2:-1}"
    for i in $(seq 1 "$reps"); do
      echo "── run $i/$reps ──"
      run_suite "$1"
    done
    ;;
esac
echo "ALL SUITES PASSED — logs in tests/logs/, manifest tests/run-manifest.jsonl"
