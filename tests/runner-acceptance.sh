#!/usr/bin/env bash
# Self-verifying acceptance of the runner's failure semantics: expected
# exits are ASSERTED, ledger separation is ASSERTED, and stop-on-first-
# failure in the multi-suite path is demonstrated with a real second
# suite that must never start.
set -u
cd "$(dirname "$0")/.."
fail() { echo "RUNNER ACCEPTANCE: FAIL — $1"; exit 1; }
lines() { [ -f "$1" ] && wc -l < "$1" || echo 0; }

prod_before="$(lines tests/run-manifest.jsonl)"
acc_before="$(lines tests/runner-acceptance-manifest.jsonl)"
m2_logs_before="$(ls tests/logs/ 2>/dev/null | grep -c '^m2-grab-' || true)"

tests/run.sh fail-fixture >/dev/null 2>&1
[ $? -eq 1 ] || fail "assertion mode: expected exit 1"
FIXTURE_MODE=harness tests/run.sh fail-fixture >/dev/null 2>&1
[ $? -eq 2 ] || fail "harness mode: expected exit 2"
SUITES="fail-fixture m2-grab" tests/run.sh all >/dev/null 2>&1
[ $? -eq 1 ] || fail "multi-suite: expected first suite's exit 1"

m2_logs_after="$(ls tests/logs/ 2>/dev/null | grep -c '^m2-grab-' || true)"
[ "$m2_logs_after" -eq "$m2_logs_before" ] || fail "multi-suite did not stop: m2-grab started after a first-suite failure"
[ "$(lines tests/run-manifest.jsonl)" -eq "$prod_before" ] || fail "fixture polluted the production ledger"
acc_after="$(lines tests/runner-acceptance-manifest.jsonl)"
[ $((acc_after - acc_before)) -eq 3 ] || fail "expected exactly 3 acceptance entries, got $((acc_after - acc_before))"
tail -3 tests/runner-acceptance-manifest.jsonl | python3 -c '
import json, sys
es = [json.loads(l) for l in sys.stdin]
assert [e["exit"] for e in es] == [1, 2, 1], [e["exit"] for e in es]
assert all(e["kind"] == "fixture" for e in es), "kind must be fixture"
assert all(e["schema"] == 2 for e in es), "schema must be 2"
' || fail "acceptance ledger entries malformed"
echo "RUNNER ACCEPTANCE: PASS (exit 1/2 propagation, stop-on-first-failure, ledger separation)"
