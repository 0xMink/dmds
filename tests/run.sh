#!/usr/bin/env bash
# DMDS test runner — durable evidence, not verdict-only pipelines.
#
# Every run keeps its complete log in tests/logs/ (gitignored), archives
# passing logs content-addressed into tests/evidence/ (gitignored;
# survives log cleanup — NOT machine loss: this repo has no remote),
# archives product failure logs to committed tests/failures/ and fixture
# failure logs to gitignored tests/runner-artifacts/ (a fire drill does
# not belong in the building's fire history), and appends one JSON line
# to a ledger:
#   tests/run-manifest.jsonl                product suites
#   tests/runner-acceptance-manifest.jsonl  fixture/acceptance runs
#
# Ledger entries (schema 3) record: full commit hash, dirty flag that
# INCLUDES untracked files, a working-diff sha256 covering tracked diffs
# AND untracked file contents, the untracked path list, pre/post tree
# signatures with a tree_stable verdict (a 15-minute background run can
# race the editor), dist/runner/log/evidence hashes, and a per-ledger
# flock-serialized monotonic run_id. Ledgers are excluded from the dirty
# computation (they grow during multi-suite runs).
#
# Evidence discipline: set -euo pipefail — a failure to PRESERVE
# evidence is itself fatal (the runner must never print success after
# losing its testimony). The archive object is created and verified
# BEFORE the ledger entry that names it. Distinguished exits:
#   0    all checks passed        (suite: process.exit(pass ? 0 : 1))
#   1    assertion failure
#   2    harness/run failure (suite catch-all: launch, nav, exception)
#   64   suite not in allowlist
#   74   log write failure (tee)
#   75   evidence archive failure
#   76   ledger append failure
#   >128 killed by signal
#
#   tests/run.sh              run all product suites, stop on first failure
#   tests/run.sh m1-core      run one suite
#   tests/run.sh m1-core 3    run one suite N times (flake hunting)
#   SUITES="a b" tests/run.sh all   override the list (validated)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p tests/logs tests/failures tests/evidence tests/runner-artifacts

PRODUCT_SUITES=(m1-core m2-grab m3-depth m4-governor)
FIXTURE_SUITES=(fail-fixture pass-fixture)
PROD_LEDGER=tests/run-manifest.jsonl
ACCEPT_LEDGER=tests/runner-acceptance-manifest.jsonl
LEDGER_EXCLUDES=(":(exclude)${PROD_LEDGER}" ":(exclude)${ACCEPT_LEDGER}")

untracked_list() { git ls-files --others --exclude-standard 2>/dev/null || true; }

# working-state fingerprint: tracked diffs + untracked names AND contents
# + the artifact, runner and suite actually being exercised
tree_sig() {
  local suite="$1"
  {
    git status --porcelain=v1 -- . "${LEDGER_EXCLUDES[@]}" 2>/dev/null || true
    git diff --binary -- . "${LEDGER_EXCLUDES[@]}" 2>/dev/null || true
    git diff --cached --binary -- . "${LEDGER_EXCLUDES[@]}" 2>/dev/null || true
    while IFS= read -r f; do [ -f "$f" ] && sha256sum "$f" || true; done < <(untracked_list)
    sha256sum dist/index.html tests/run.sh "tests/${suite}.js" 2>/dev/null || true
  } | sha256sum | cut -d' ' -f1
}

run_suite() {
  local suite="$1"
  local is_product=false is_fixture=false s
  for s in "${PRODUCT_SUITES[@]}"; do if [ "$s" = "$suite" ]; then is_product=true; fi; done
  for s in "${FIXTURE_SUITES[@]}"; do if [ "$s" = "$suite" ]; then is_fixture=true; fi; done
  if ! $is_product && ! $is_fixture; then
    echo "unknown suite: ${suite} (not in PRODUCT_SUITES or FIXTURE_SUITES)" >&2
    exit 64
  fi
  local ledger kind faildir
  if $is_fixture; then ledger="$ACCEPT_LEDGER"; kind="fixture"; faildir="tests/runner-artifacts"
  else ledger="$PROD_LEDGER"; kind="product"; faildir="tests/failures"; fi

  local stamp log t0 t1 status tee_status checks commit dirty diff_sha untracked tree_before tree_after
  stamp="$(date -u +%Y%m%dT%H%M%S.%N)-$$"
  log="tests/logs/${suite}-${stamp}.log"

  # provenance BEFORE the run mutates anything
  commit="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  untracked="$(untracked_list)"
  dirty=true
  if git diff --quiet -- . "${LEDGER_EXCLUDES[@]}" \
     && git diff --cached --quiet -- . "${LEDGER_EXCLUDES[@]}" \
     && [ -z "$untracked" ]; then dirty=false; fi
  diff_sha="$({
    git diff --binary -- . "${LEDGER_EXCLUDES[@]}" 2>/dev/null || true
    git diff --cached --binary -- . "${LEDGER_EXCLUDES[@]}" 2>/dev/null || true
    while IFS= read -r f; do [ -n "$f" ] && [ -f "$f" ] && { printf 'UNTRACKED %s\n' "$f"; sha256sum "$f"; } || true; done <<< "$untracked"
  } | sha256sum | cut -d' ' -f1)"
  tree_before="$(tree_sig "$suite")"
  t0="$(date -u +%s)"

  {
    echo "== env preamble =="
    date -u
    uptime
    echo "cores: $(nproc)  ($(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ //' || true))"
    { cat /sys/fs/cgroup/cpu.max 2>/dev/null | sed 's/^/cpu.max: /'; } || true
    { cat /sys/fs/cgroup/memory.max 2>/dev/null | sed 's/^/memory.max: /'; } || true
    free -h
    vmstat 1 3 || true
    ps -eo pid,stat,%cpu,%mem,cmd | grep -E '[c]hrom(e|ium)|node tests/' || true
    echo "commit: ${commit} dirty: ${dirty}"
    [ -n "$untracked" ] && printf 'untracked: %s\n' $untracked || true
    echo "== suite: ${suite} =="
  } | tee "$log"

  set +e
  node "tests/${suite}.js" 2>&1 | tee -a "$log"
  local pipe_status=("${PIPESTATUS[@]}")
  set -e
  status="${pipe_status[0]}"
  tee_status="${pipe_status[1]}"
  [ "$tee_status" -eq 0 ] || { echo "log write failed for ${log}" >&2; exit 74; }
  t1="$(date -u +%s)"
  printf 'exit=%s\n' "$status" | tee -a "$log"
  tree_after="$(tree_sig "$suite")"
  checks="$(grep -oE 'PASS \([0-9]+ checks\)' "$log" | grep -oE '[0-9]+' | tail -1 || true)"

  # evidence FIRST, ledger entry SECOND — the ledger must never name an
  # object that failed to materialize
  local log_sha evidence_path="" evidence_sha=""
  log_sha="$(sha256sum "$log" | cut -d' ' -f1)"
  if [ "$status" -ne 0 ]; then
    cp "$log" "${faildir}/${suite}-${stamp}.log" \
      || { echo "failure-log archive failed" >&2; exit 75; }
    echo "FAILURE LOG ARCHIVED: ${faildir}/${suite}-${stamp}.log"
  else
    evidence_path="tests/evidence/${log_sha}.log.gz"
    local tmp="${evidence_path}.tmp.$$"
    gzip -n -c "$log" > "$tmp" || { echo "evidence archive failed" >&2; rm -f "$tmp"; exit 75; }
    gzip -t "$tmp" || { echo "evidence archive corrupt" >&2; rm -f "$tmp"; exit 75; }
    mv "$tmp" "$evidence_path" || { echo "evidence archive rename failed" >&2; exit 75; }
    evidence_sha="$(sha256sum "$evidence_path" | cut -d' ' -f1)"
  fi

  LEDGER="$ledger" KIND="$kind" SUITE="$suite" STAMP="$stamp" EXIT_STATUS="$status" \
  CHECKS="${checks:-}" COMMIT="$commit" DIRTY="$dirty" DIFF_SHA="$diff_sha" \
  UNTRACKED="$untracked" TREE_BEFORE="$tree_before" TREE_AFTER="$tree_after" \
  LOG_SHA="$log_sha" EVIDENCE_PATH="$evidence_path" EVIDENCE_SHA="$evidence_sha" \
  T0="$t0" T1="$t1" python3 - <<'PY' || { echo "ledger append failed" >&2; exit 76; }
import fcntl, hashlib, json, os
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(65536), b""):
            h.update(b)
    return h.hexdigest()
e = os.environ
entry = {
    "schema": 3,
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
    "untracked": [u for u in e["UNTRACKED"].splitlines() if u],
    "tree_before": e["TREE_BEFORE"],
    "tree_after": e["TREE_AFTER"],
    "tree_stable": e["TREE_BEFORE"] == e["TREE_AFTER"],
    "log_sha256": e["LOG_SHA"],
    "evidence_path": e["EVIDENCE_PATH"] or None,
    "evidence_sha256": e["EVIDENCE_SHA"] or None,
    "dist_sha256": sha("dist/index.html") if os.path.exists("dist/index.html") else None,
    "runner_sha256": sha("tests/run.sh"),
}
with open(e["LEDGER"], "a", encoding="utf-8") as f:
    fcntl.flock(f, fcntl.LOCK_EX)
    with open(e["LEDGER"], encoding="utf-8") as g:
        entry["run_id"] = sum(1 for _ in g) + 1
    f.write(json.dumps(entry, separators=(",", ":"), sort_keys=True) + "\n")
PY

  [ "$status" -eq 0 ] || exit "$status"
}

case "${1:-all}" in
  all)
    for suite in ${SUITES:-"${PRODUCT_SUITES[@]}"}; do run_suite "$suite"; done
    ;;
  *)
    reps="${2:-1}"
    for i in $(seq 1 "$reps"); do
      echo "── run $i/$reps ──"
      run_suite "$1"
    done
    ;;
esac
echo "ALL SUITES PASSED — logs tests/logs/, evidence tests/evidence/, ledger ${PROD_LEDGER}"
