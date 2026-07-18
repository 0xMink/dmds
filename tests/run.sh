#!/usr/bin/env bash
# DMDS test runner — durable evidence, not verdict-only pipelines.
# Every run keeps its complete log + exit classification in tests/logs/
# (a launch failure, an assertion failure, a timeout and a kill must
# stay distinguishable). An environmental preamble is recorded so a
# failure can be classified against host conditions instead of vibes.
#
#   tests/run.sh              run all four suites, stop on first failure
#   tests/run.sh m1-core      run one suite
#   tests/run.sh m1-core 3    run one suite N times (flake hunting),
#                             stopping immediately on any failure
set -u -o pipefail
cd "$(dirname "$0")/.."
mkdir -p tests/logs

run_suite() {
  local suite="$1"
  local stamp log status
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  log="tests/logs/${suite}-${stamp}.log"
  {
    echo "== env preamble =="
    date -u
    uptime
    free -h
    ps -eo pid,stat,%cpu,%mem,cmd | grep -E '[c]hrom(e|ium)|node tests/' || true
    echo "== suite: ${suite} =="
  } | tee "$log"
  node "tests/${suite}.js" 2>&1 | tee -a "$log"
  status=${PIPESTATUS[0]}
  printf 'exit=%s\n' "$status" | tee -a "$log"
  # exit 0 = pass; 1 = assertion failure; 2 = harness/run failure
  # (launch, timeout); >128 = killed by signal — all retained in the log
  if [ "$status" -ne 0 ]; then
    echo "RETAINED: $log"
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
echo "ALL RETAINED IN tests/logs/"
