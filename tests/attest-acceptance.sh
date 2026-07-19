#!/usr/bin/env bash
# Adversarial acceptance of tests/attest.sh — prove the refusal
# machinery fires, rather than relying on inspection of it. Every
# refusal branch is FAULT-INJECTED against a scratch replica of the
# repo's attestable state (ledger tail + dist + runner + evidence
# objects + the attest script itself, byte-identical), so the real
# tree, ledger and standing attestation are never touched. A local
# throwaway HTTP server exercises the serving-boundary branches.
#
# Constraint: this suite is meaningful only when run from a state that
# attests cleanly (immediately after a run of record + attest.sh) —
# every fault is a mutation of a known-good baseline, and the positive
# control asserts the replica reproduces the committed attestation
# byte-for-byte.
set -u
cd "$(dirname "$0")/.."
fail() { echo "ATTEST ACCEPTANCE: FAIL — $1"; exit 1; }

SCRATCH="$(mktemp -d)"
srv_pid=""
trap 'kill "$srv_pid" 2>/dev/null; rm -rf "$SCRATCH"' EXIT

R="$SCRATCH/repo"
LEDGER_TAIL=4

fresh() {
  rm -rf "$R"
  mkdir -p "$R/tests/evidence" "$R/dist"
  cp tests/attest.sh tests/run.sh tests/run-manifest.jsonl "$R/tests/"
  cp dist/index.html "$R/dist/"
  tail -$LEDGER_TAIL tests/run-manifest.jsonl | python3 -c 'import json,sys
for l in sys.stdin: print(json.loads(l)["evidence_path"])' | while IFS= read -r p; do
    [ -f "$p" ] || { echo "baseline evidence object missing: $p" >&2; exit 1; }
    cp "$p" "$R/$p"
  done || fail "could not stage baseline evidence objects"
}

run_attest() {  # $1 = URL, or the literal --no-http
  set +e
  if [ "$1" = "--no-http" ]; then
    out="$("$R/tests/attest.sh" --no-http 2>&1)"
  else
    out="$(DMDS_HTTP_URL="$1" "$R/tests/attest.sh" 2>&1)"
  fi
  rc=$?
  set -e 2>/dev/null || true
}

refused() {  # $1 = required refusal substring, $2 = case label
  [ "$rc" -eq 1 ] || fail "$2: expected exit 1, got $rc — $out"
  printf '%s' "$out" | grep -q "ATTESTATION REFUSED" || fail "$2: refusal banner missing — $out"
  printf '%s' "$out" | grep -qF "$1" || fail "$2: expected '$1' in — $out"
  [ ! -f "$R/tests/attestation.json" ] || fail "$2: refusal still wrote attestation.json"
}

mutate_ledger() {  # $1 = python statements over the entry list `ls`
  MUT="$1" python3 - "$R/tests/run-manifest.jsonl" <<'PY'
import json, os, sys
p = sys.argv[1]
ls = [json.loads(l) for l in open(p, encoding="utf-8")]
exec(os.environ["MUT"])
with open(p, "w", encoding="utf-8") as f:
    f.write("".join(json.dumps(e, separators=(",", ":"), sort_keys=True) + "\n" for e in ls))
PY
}

last_evidence() {
  tail -1 "$R/tests/run-manifest.jsonl" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["evidence_path"])'
}

# throwaway server: right.html = the attested bytes, wrong.html = not
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
cp dist/index.html "$SCRATCH/right.html"
printf 'not the attested bytes\n' > "$SCRATCH/wrong.html"
python3 -m http.server --bind 127.0.0.1 --directory "$SCRATCH" "$port" >/dev/null 2>&1 &
srv_pid=$!
up=0
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "http://127.0.0.1:$port/right.html" 2>/dev/null && { up=1; break; }
  sleep 0.1
done
[ "$up" -eq 1 ] || fail "throwaway HTTP server never came up on port $port"
dead_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"

# 1. positive control: pristine replica + matching serving boundary
#    attests, and reproduces the committed attestation byte-for-byte
fresh
run_attest "http://127.0.0.1:$port/right.html"
[ "$rc" -eq 0 ] || fail "positive control: expected exit 0, got $rc — $out"
printf '%s' "$out" | grep -q '^ATTESTED: ' || fail "positive control: no ATTESTED line — $out"
diff -q "$R/tests/attestation.json" tests/attestation.json >/dev/null \
  || fail "positive control: replica attestation differs from the committed one"

# 2. --no-http succeeds as an EXPLICIT disk-only attestation with
#    http_sha256 recorded as null, and announces itself
fresh
run_attest --no-http
[ "$rc" -eq 0 ] || fail "--no-http: expected exit 0, got $rc — $out"
printf '%s' "$out" | grep -q 'DISK-ONLY' || fail "--no-http: disk-only notice missing — $out"
python3 -c 'import json,sys; a=json.load(open(sys.argv[1])); sys.exit(0 if a["http_sha256"] is None else 1)' \
  "$R/tests/attestation.json" || fail "--no-http: http_sha256 not recorded as null"

# 3. unreachable serving boundary → refusal (not a warning)
fresh
run_attest "http://127.0.0.1:$dead_port/"
[ "$rc" -eq 1 ] || fail "unreachable: expected exit 1, got $rc — $out"
printf '%s' "$out" | grep -q 'unreachable' || fail "unreachable: wrong message — $out"
[ ! -f "$R/tests/attestation.json" ] || fail "unreachable: refusal still wrote attestation.json"

# 4. serving boundary returns different bytes → refusal
fresh
run_attest "http://127.0.0.1:$port/wrong.html"
refused "HTTP boundary returned DIFFERENT bytes" "http-mismatch"

# 5. silently weakened suite: one check count altered
fresh; mutate_ledger 'ls[-1]["checks"] = 141'
run_attest --no-http
refused "suite/check inventory changed" "check-count"

# 6. extra product run hiding under the candidate batch id (inserted
#    BEFORE the attested four, so only whole-batch membership can see it)
fresh; mutate_ledger 'ls.insert(len(ls) - 4, dict(ls[-4]))'
run_attest --no-http
refused "additional product runs" "extra-batch-entry"

# 7. cherry-picked runs: entries not sharing one invocation batch
fresh; mutate_ledger 'ls[-1]["batch"] = "some-other-invocation"'
run_attest --no-http
refused "do not share one runner-invocation batch id" "batch-mismatch"

# 8. non-contiguous run_ids
fresh; mutate_ledger 'ls[-1]["run_id"] += 1'
run_attest --no-http
refused "run_ids not contiguous" "run-id-gap"

# 9. a dirty run cannot be attested
fresh; mutate_ledger 'ls[-1]["dirty"] = True'
run_attest --no-http
refused "dirty" "dirty-run"

# 10. missing evidence object
fresh; rm "$R/$(last_evidence)"
run_attest --no-http
refused "evidence object missing" "evidence-missing"

# 11. corrupt evidence object (byte appended → object hash mismatch;
#     note the sha gate precedes decompression, so gzip.open only ever
#     runs on byte-identical objects and cannot raise)
fresh; printf 'x' >> "$R/$(last_evidence)"
run_attest --no-http
refused "evidence object hash mismatch" "evidence-corrupt"

# 12. a lying ledger: evidence object intact but log_sha256 forged —
#     the decompress-back-to-log branch is the only defense
fresh; mutate_ledger 'ls[-1]["log_sha256"] = "0" * 64'
run_attest --no-http
refused "decompresses to a different log" "log-sha-forged"

# 13. rebuilt-after-test dist
fresh; printf ' ' >> "$R/dist/index.html"
run_attest --no-http
refused "tested DIFFERENT dist bytes" "dist-rebuilt"

# 14. runner changed since the runs it vouches for
fresh; printf '# tampered\n' >> "$R/tests/run.sh"
run_attest --no-http
refused "used a different runner" "runner-changed"

echo "ATTEST ACCEPTANCE: PASS (14 cases — positive control byte-identical to committed attestation, --no-http explicit+null, refusals: unreachable/mismatched HTTP, check inventory, extra batch entry, cherry-picked batch, run_id gap, dirty run, missing/corrupt evidence, forged log hash, rebuilt dist, changed runner; no refusal wrote an attestation)"
