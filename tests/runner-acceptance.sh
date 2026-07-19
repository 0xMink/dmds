#!/usr/bin/env bash
# Self-verifying acceptance of the runner's failure semantics. Expected
# exits are ASSERTED, ledger separation is ASSERTED, stop-on-first-
# failure is demonstrated with a real second suite that must never
# start, and — the branch most capable of producing false success —
# evidence-layer failures are FAULT-INJECTED (fake gzip/python3 on
# PATH) to prove the runner goes nonzero even when the suite passed.
set -u
cd "$(dirname "$0")/.."
fail() { echo "RUNNER ACCEPTANCE: FAIL — $1"; exit 1; }
lines() { if [ -f "$1" ]; then wc -l < "$1"; else echo 0; fi; }

prod_before="$(lines tests/run-manifest.jsonl)"
acc_before="$(lines tests/runner-acceptance-manifest.jsonl)"
m2_logs_before="$(ls tests/logs/ 2>/dev/null | grep -c '^m2-grab-' || true)"

# 1. failure-class propagation
tests/run.sh fail-fixture >/dev/null 2>&1
[ $? -eq 1 ] || fail "assertion mode: expected exit 1"
FIXTURE_MODE=harness tests/run.sh fail-fixture >/dev/null 2>&1
[ $? -eq 2 ] || fail "harness mode: expected exit 2"

# 2. multi-suite stop-on-first-failure: m2-grab must never start
SUITES="fail-fixture m2-grab" tests/run.sh all >/dev/null 2>&1
[ $? -eq 1 ] || fail "multi-suite: expected first suite's exit 1"
m2_logs_after="$(ls tests/logs/ 2>/dev/null | grep -c '^m2-grab-' || true)"
[ "$m2_logs_after" -eq "$m2_logs_before" ] || fail "multi-suite did not stop before m2-grab"

# 3. allowlist: an unknown suite is rejected, not recorded
tests/run.sh no-such-suite >/dev/null 2>&1
[ $? -eq 64 ] || fail "unknown suite: expected exit 64"

# 4. passing path produces a verified evidence object
tests/run.sh pass-fixture >/dev/null 2>&1
[ $? -eq 0 ] || fail "pass-fixture: expected exit 0"
last_entry="$(tail -1 tests/runner-acceptance-manifest.jsonl)"
ev_path="$(printf '%s' "$last_entry" | python3 -c 'import json,sys; print(json.load(sys.stdin)["evidence_path"] or "")')"
[ -n "$ev_path" ] && [ -f "$ev_path" ] || fail "pass-fixture evidence object missing: '$ev_path'"
gzip -t "$ev_path" || fail "pass-fixture evidence object corrupt"

# 5. FAULT: evidence archive failure must be fatal despite a passing suite
fake="$(mktemp -d)"
printf '#!/bin/sh\nexit 1\n' > "$fake/gzip" && chmod +x "$fake/gzip"
PATH="$fake:$PATH" tests/run.sh pass-fixture >/dev/null 2>&1
[ $? -eq 75 ] || fail "gzip fault: expected exit 75 (evidence archive failure)"
rm -f "$fake/gzip"

# 6. FAULT: ledger append failure must be fatal despite a passing suite
printf '#!/bin/sh\nexit 1\n' > "$fake/python3" && chmod +x "$fake/python3"
PATH="$fake:$PATH" tests/run.sh pass-fixture >/dev/null 2>&1
[ $? -eq 76 ] || fail "python3 fault: expected exit 76 (ledger append failure)"
rm -rf "$fake"

# 7. ENFORCEMENT: a tree-tainting suite is fatal (77), recorded, banner-
#    free, and stops the multi-suite chain — detection without policy is
#    just a diary
out="$(SUITES="taint-fixture m2-grab" tests/run.sh all 2>&1)"
rc=$?
[ "$rc" -eq 77 ] || fail "taint: expected exit 77, got $rc"
printf '%s' "$out" | grep -q "ALL SUITES PASSED" && fail "taint: success banner printed for an unstable tree"
m2_logs_after3="$(ls tests/logs/ 2>/dev/null | grep -c '^m2-grab-' || true)"
[ "$m2_logs_after3" -eq "$m2_logs_before" ] || fail "taint: m2-grab started after an unstable first suite"
git checkout -- tests/taint-canary.txt

# 8. ledger separation and integrity
[ "$(lines tests/run-manifest.jsonl)" -eq "$prod_before" ] || fail "fixtures polluted the production ledger"
acc_after="$(lines tests/runner-acceptance-manifest.jsonl)"
# fail(1) + harness(1) + multi(1) + pass(1) + taint(1) = 5; faulted runs append nothing
[ $((acc_after - acc_before)) -eq 5 ] || fail "expected exactly 5 acceptance entries, got $((acc_after - acc_before))"
tail -5 tests/runner-acceptance-manifest.jsonl | python3 -c '
import json, sys
es = [json.loads(l) for l in sys.stdin]
assert [e["exit"] for e in es] == [1, 2, 1, 0, 0], [e["exit"] for e in es]
assert all(e["kind"] == "fixture" for e in es), "kind must be fixture"
assert all(e["schema"] == 3 for e in es), "schema must be 3"
assert all("tree_stable" in e and "untracked" in e for e in es), "schema-3 fields missing"
assert es[-1]["tree_stable"] is False, "taint run must record tree_stable:false"
assert all(e["tree_stable"] for e in es[:-1]), "non-taint fixtures must be tree-stable"
' || fail "acceptance ledger entries malformed"

# 9. fixture failures land in runner-artifacts, never the committed fire history
ls tests/runner-artifacts/ | grep -q '^fail-fixture-' || fail "fixture failure log not in runner-artifacts"
ls tests/failures/ 2>/dev/null | grep -q '^fail-fixture-' && fail "fixture failure log leaked into tests/failures"

echo "RUNNER ACCEPTANCE: PASS (exit 1/2/64 propagation, stop-on-first-failure, evidence+ledger faults fatal at 75/76, tree-taint fatal at 77 with no banner, ledger separation, artifact segregation)"
