# M4 results — two-axis governor, scale, power

Run: `node tests/m4-governor.js` · Environment: headless SwiftShader ·
Date: 2026-07-18 · **PASS — 30/30 checks** (full regression green:
M1 59/59, M2 55/55, M3 35/35 — 179 total).

## What M4 built

- **Two-axis governor** (spec): quality rungs degrade fill-rate cost
  first — r1 aberration off + bloom at eighth-res, r2 whole post chain
  at half resolution, r3 DPR capped at 1.0 — then sim-size steps down
  the ladder (desktop 512² baseline, 256² floor; 384² between), then
  post off entirely (r5), then **tier demotion** through the same
  canvas-replacement path as the context-restore timeout. Improvement
  reverses symmetrically; promotion above baseline (768², 1024²) is
  desktop-only, needs two consecutive good windows at full quality,
  and is gated on a **trial allocation** (failure → no retry for the
  session).
- **Metric**: p90 frame time per 5s window (1s windows during the 3s
  startup fast path, where a severe miss skips a rung). Good < 17.9ms,
  bad > 25ms, emergency = rolling 1s mean > 50ms → two rungs at once.
  Warm-up: 30 presented frames or 1s before anything counts. Valid
  windows exclude hidden tabs, post-resume/restore/resize windows, and
  windows with too few presented frames. 5s cooldown after any
  transition.
- **Sim-size changes are managed reinits** through the destroy/init
  lifecycle (the most-tested path in the engine): idle-only (no grab,
  no morph, excitement < 0.1, 2s quiet), governor state and current
  formation survive, and the new field seeds AT the surviving
  formation's targets (small jitter) so it reassembles in under a
  second. A queued resize **deepens toward the floor** under continued
  bad windows instead of deadlocking the ladder (found by the ladder
  test: post-off and demotion were unreachable while a deferred
  resize waited for idle).
- **Reduced-motion power contract**: 3s after the last accepted
  formation command with the field settled, the frame after renders
  and the loop STOPS (`status().sleeping`); real commands wake it
  (wall-clock stamped — a stale sim-clock stamp put it straight back
  to sleep, caught by the wake test). Scrub movements count as
  commands; same-name re-asserts do not.
- **Status honesty**: `count` = current particles, `max` = the tier's
  baseline budget, plus an explicit `degraded` flag covering
  post-quality rungs (which don't change the count). The footer shows
  `RENDER DEGRADED · CORE NOMINAL` for a rung-1 cut and returns to
  `ALL SYSTEMS NOMINAL` on recovery — both verified through the real
  page footer.

## Verified (30 checks)

Ladder order (rungs → size → post-off → demotion callback) ·
cooldown blocks · invalid windows act-free · one good window is not
enough, a hold-band window resets the streak, two consecutive goods
recover · promotion requested with passing trial alloc · emergency
skips rungs and respects cooldown · resize deferred while a grab is
held and executed when idle (4,096 → 16,384 in-place, formation
preserved, engine running, promotion not flagged as degradation) ·
performance demotion reaches a running tier 2 end-to-end ·
reduced-motion stop/wake/re-stop · footer honesty both directions.

## Test-infrastructure decisions (recorded)

- `debugGovInject` drives the SAME production evaluation/emergency
  functions as the frame loop (no duplicated decision logic), and
  taking ownership disables live collection.
- On `?debug=1` pages the live collector is off entirely: under
  SwiftShader's frame times the real governor legitimately degrades
  test pages and can tear down engines mid-inspection (observed:
  pages arriving pre-degraded at rung 3, promotion fights). Decision
  logic is fully injection-tested; **live windowing/warm-up glue is
  validated on real hardware only** — accepted, recorded gap.
- SwiftShader's dt clamp runs excitement decay in slow motion; the
  resize test polls for completion instead of assuming wall-clock
  idle timing.

## Deferred to M4 part 2 (rendered evidence + ledger)

Image-energy dust measurements (glyph vs dust luminance) ·
complete-rendered-frame recovery after each freeze-failure stage ·
sway-frozen parallax isolation · golden-vector sweep at
low/mid/max ids × mix values × {256², 512², 1024²} · the written
CPU+GPU memory ledger per size (incl. persistent freeze scratch) ·
1024² promotion default (ships conservative until real-hardware data;
Dennis's 70–80fps at 512² is promotion datapoint #1).

## Correction pass (after external review) — 30 → 53 checks

All eight review items adopted; three more engine bugs found (total 21):

1. **Transactional resize (bug: healthy tier 1 destroyed by a failed
   speculative promotion)**: a failed build at the target size now marks
   it unavailable and ROLLS BACK to the previous known-good size; tier
   demotion only if the rollback also fails. Verified with
   size-conditional injected build failures: promotion to 128² fails →
   rollback to 64² succeeds, size marked, no demotion; 128²+64² both
   fail → demotes to tier 2.
2. **Directional pending requests with evidence cancellation**: a bad
   window cancels a queued promotion; recovery cancels a queued
   downsize; no-op targets never execute; promotions execute only from
   rung 0. Alternating-evidence tests prove no spurious resize.
3. **Frame stops at the lifecycle boundary**: `govMaybeResize` returns
   true on execution and the frame returns immediately — no GL work on
   the far side of a destroy/reinit.
4. **The REAL collector is now deterministic-testable**
   (`debugGovFrame` feeds synthetic time through the production
   `govFrame`): warm-up, fast-path 1s windows, under-populated-window
   invalidity, hold-streak counting, sustained-hold degradation, and
   the rolling-mean emergency all verified end-to-end (emergency
   correctly blocked during cooldown, then firing after).
5. **Physical sleep (bug #19 + bug #20)**: reduced-motion sleep now
   requires ≥4 SIM seconds + excitement < 0.05, and the boundary is
   verified with the convergence reduction (0 outside 0.05). Two bugs
   found: the morph-swirl force was not gated under reduced motion
   (tier-2 always zeroed uSwirl; the port dropped it — a parked
   mid-scrub REDUCED page could never settle), and `simSinceCmd`
   credited the 1/30-clamped dt while the REDUCED shader integrates
   min(dt, 1/60) — the CPU claimed settlement the GPU hadn't reached
   (the failing check's 1846/4096 stragglers matched the low-gain
   population exactly).
6. **Sustained-hold floor**: two consecutive windows in the 17.9–25ms
   band now degrade once — a machine can no longer sit below the
   ~55fps acceptance floor forever in the hysteresis gap.
7. **Rung effects observed, not commanded**: debugGov exposes real
   buffer dimensions, effective DPR, and the live aberration uniform
   (getUniform). Verified: baseline full-res + quarter-res bloom +
   aberr 1; rung 1 eighth-res bloom + aberr 0; rung 2 half-res trail;
   post-off frees the buffers entirely (bug #21: they previously
   stayed allocated — caught by this test); recovery restores
   everything. The decorative `r && true` check is gone.
8. **Status honesty**: `{count, baseline, ceiling, degraded}` — the
   semantically-false `max` is removed from tier-1 status (tier 2
   keeps its own convention; the console banner uses the live count).

Full regression: M1 59/59, M2 55/55, M3 35/35 — **202 checks**.

## Second correction pass — 53 → 69 checks

1. **Policy fix (the review's "immediately" item)**: a bad window now
   cancels a queued promotion AND applies its degradation in the same
   evaluation — a performance collapse is never consumed merely
   updating the calendar. (Emergency likewise: cancel + two rungs.)
2. **Transaction observability + state integrity**: `resizeTxn` phases
   (building-target / rolling-back / idle+last) exposed in debugGov;
   the rollback test now waits on the transaction rather than
   inferring from the blacklist, and verifies: formation survives and
   converges onto its GPU targets (reduction: 0 outside ε), pending
   cleared, poisoned size never retried after cooldown, the resize
   machinery still works for non-poisoned sizes (downsize to 32²
   lands), zero listener/RAF leak across the multi-reinit transaction
   (baseline sampled after the loader's RAF dies — the M1 lesson,
   re-learned).
3. **DPR rung observed under a real 2× device scale**
   (deviceScaleFactor 2): baseline caps at 1.75, rung 3 at exactly
   1.0 with the backing store shrunk to CSS size and post buffers
   reallocated against it, CSS dimensions untouched, recovery
   restores 1.75.
4. **Sleep boundary is CRISP, not merely near**: 0 outside 0.03,
   ≤2% outside ε_snap (0.012), maxDist < 0.03, max residual velocity
   < 0.1, zero flags. The production sleep decision remains a
   validated TIMING gate (sim-time + excitement), per review wording;
   runtime physical gating is not claimed.
5. **Collector invalidation sources**: browser-resize and
   hidden→resume contamination each leave their window inert while
   the following clean window acts normally. Context-restore/alloc/
   suspend-gap invalidation + staged async transaction races → part 2.

Full regression: M1 59/59, M2 55/55, M3 35/35 — **218 checks**.

## Real-hardware incident (Dennis, 2026-07-18) — 3 fixes

Console evidence from Dennis's machine: governor walked the full ladder
and demoted; a null-GL crash fired mid-frame; tier 2 then oscillated
42000↔21000↔10500 indefinitely.

- **Bug #22 — mid-frame demotion crash**: govDemote fires inside
  govFrame inside frame(); destroy() nulls the GL handle and the SAME
  frame continued into simStep. The lifecycle-boundary rule now covers
  every teardown path (frame returns if destroyed/stopped/GL-less
  after govFrame). Reproduced and fixed via a new LIVE-path test:
  `?govlive=1` lets SwiftShader's genuinely slow frames drive the real
  collector down the entire ladder to demotion — tier 2 boots with
  zero page errors (this also closes part of the "live windowing is
  hardware-only" gap).
- **Bug #23 — tier-2 governor oscillation** (shipped since v2, first
  machine to straddle the hysteresis gap): a drop within 12s of a
  restore now locks the budget at the stable lower value instead of
  pulsing forever.
- The demotion itself may have been CORRECT for the machine's state at
  the time (see open question): the same machine did 70–80fps at 512²
  the previous day. Prime suspect: Windows dual-GPU power policy
  (battery → iGPU). Tier-2 also failing 40fps at 42k supports
  "machine genuinely slow right now" over "governor misjudged".

Open question for Dennis: was the laptop on battery / power-saver?
Retest plugged in. If the discrete GPU returns, the governor should
hold full quality (and promote) — that comparison is the promotion-
default datapoint.

Suite: 69 → 72 checks; regression M1 59/59, M2 55/55, M3 35/35 — 221.

## Protocol-hardening pass (per review) — 72 → 80 checks

- **Pair-identity oscillation lock**: only the SAME high→low reversal,
  repeated within a bounded window after restores, locks the budget.
  Verified deterministically via a new `debugGovTick` injection on
  tier 2: transient drop → no lock; first reversal → suspect only;
  same-pair repeat → lock; suspicion decays after 40s (no false lock);
  tab-revisit unlocks WITHOUT immediate promotion (good streak reset —
  one good tick holds, two restore). Alt-tab is not a "please resume
  oscillating" button.
- **Governor history ring** (~120 entries, always recorded, exposed
  via `debugGovHistory` under debug): every window with its p90 and
  classification, every rung change, resize request/commit/rollback,
  emergency, demotion. The retest captures the trajectory, not the
  obituary.
- Incident wording adopted: prior slow runs remain environmentally
  unclassified; the plugged/battery/plugged comparison is a
  bidirectional real-device validation case, not full verification.
  Baseline / promotion-availability / promotion-ceiling are recorded
  as three separate decisions.

## Review-closure pass — 80 → 88 checks, full regression rerun

1. **Different-pair test added (the prescribed missing case)**: a
   42000↔21000 suspicion does NOT transfer to a 21000↔10500
   oscillation — the suspect is replaced, no cross-pair lock; the new
   pair locks only on its own repeat.
2. **History-ring semantics proven**: field fidelity (window p90 +
   classification, rung targets), chronological order, cap at 120
   with OLDEST evicted, copy-not-reference, survival across a managed
   promotion reinit, and — critically — **survival through live
   demotion** (the run that demotes is the run whose trajectory
   matters: 9 entries ending in `demote`, readable from tier 2).
3. **Full four-suite regression rerun after changing both engines**
   (the review's own founding-rule citation, accepted):
   M1 59/59 · M2 55/55 · M3 35/35 · M4 88/88 — **237 checks**.
4. **Budget tripwire re-tightened**: WARN at 352/160 KB — the current
   321/130 KB build sits 31 KB under the warning line, so ~30 KB of
   unexplained growth trips it — hard FAIL at the spec ceiling
   512/280.
5. **`?telemetry=1` read-only mode**: exposes debugGov/debugGovHistory
   with ZERO behavior change (live governor runs exactly as
   production; no fault hooks, no readbacks). Hardware retests use
   this instead of debug mode — the measured run IS the production
   experience, no equivalence argument needed.
6. Server durability: nohup + pidfile (`/tmp/dmds-http.pid`), survives
   session/SSH end; explicitly a temporary unauthenticated LAN
   process, not deployment.

One test flake fixed en route: the unlock test's visibility dance
re-armed the LIVE governor on a page whose real SwiftShader frames
could tick between deterministic ticks — the real loop is now stopped
before the post-unlock assertions (governor state persists; ticks are
pure).

## Review closure round 2 (2026-07-18) — pair-scoped restoration evidence

The previous round's "different-pair" test was itself the bug's
accomplice: its own inline comment narrated the forged credential
("restoredAt=104, within 12 → high=21000 ≠ suspect 42000 → suspect
replaced") without noticing that the restore at t=104 belonged to the
42000↔21000 pair. The tier-2 lock keyed *suspicion* by pair but the
*restoration credential* was global — so a monotonic double
degradation (42000 → 21000 → 10500) minted the first strike of a
21000↔10500 "oscillation" that had never cycled, and one real cycle
later the lock fired on half the required evidence.

**Fix (src/gl.js)**: restores now record `govRestoredTo` (the budget
restored TO); a drop counts as a strike only when it undoes a restore
to that exact budget (`govRestoredTo === high`), inside the existing
12s window. Evidence is now pair-local end to end.

**Corrected test asserts the true semantics** (3 checks, was 2):
- `lock:monotonic-degradation-mints-no-strike` — 21000→10500 inside
  the 42000-restore window leaves suspect=42000, locked=false
- `lock:new-pair-first-own-cycle-suspect-only` — the 10500↔21000
  pair's first OWN cycle produces suspicion only
- `lock:new-pair-locks-on-own-second-cycle` — lock on the second
  complete own cycle

All pre-existing lock tests (true repeat, decay, unlock, fresh
evidence) pass unchanged under the stricter rule — every legitimate
strike in them already followed a restore to the same budget.

Also closed this round:
1. **History entries carry a monotonic `seq`** (persisted with the gov
   object, so it survives managed reinit uninterrupted). Order is now
   proven by seq, not timestamps — injected entries share a `t`, and
   the test requires strict seq growth exactly where t repeats.
   Time answers "when"; seq answers "in what order".
2. **debugGovHistory returns cloned entries**, not shared references —
   `h[0].event = "everything-was-fine"` no longer rewrites the
   internal record; tested by mutation.
3. **Telemetry "zero behavior change" is now measured, not asserted**
   (differential test): plain vs ?telemetry=1 pages snapshot at the
   ready instant → identical {count, baseline, ceiling, degraded,
   sleeping, canvas dims}; plain page fully gated; telemetry read
   paths (debugGov/debugGovHistory) open; write/instrument paths
   (debugStep/debugPoke/debugGovInject/debugReadState) closed; live
   governor armed (liveOff=false, now exposed in the debugGov
   snapshot). Caveat kept honest: this measures the load-time surface
   + gating; fault hooks are statically `DEBUG &&`-gated in source.
4. **Server ownership verified**: pidfile 59691 is alive, is
   `python3 -m http.server 8080 --bind 0.0.0.0`, cwd
   `/root/dmds/dist`, and `ss -ltnp` shows the :8080 listener is
   owned by that pid (fd 3). HTTP 200 provenance no longer
   circumstantial.

Full regression after changing both engines:
M1 59/59 · M2 55/55 · M3 35/35 · M4 97/97 — **246 checks**.

## Review closure round 3 (2026-07-18) — two lifecycle proofs

1. **Visibility resume now clears ALL oscillation evidence** (src/gl.js).
   The re-arm previously reset only under `if (govLocked)` — the
   convenient branch. An unlocked resume kept `govRestoredAt`/
   `govRestoredTo`, so a pre-hide restoration credential still inside
   its 12s window could mint a post-resume strike from evidence that
   spans a lifecycle discontinuity, violating the stated fresh-evidence
   policy. Resume now unconditionally zeroes lock, suspect, suspectT,
   restoredAt, restoredTo and good. New test (17b) exercises the
   previously untested branch: resume at the HIGHER budget with a
   still-valid pre-hide credential → the immediate drop degrades
   normally with NO suspicion; suspicion is earned only after the pair
   restores again post-resume.
2. **The demotion history now proves "ends at demote, immutably" —
   the claim the prose made** (test 16 strengthened). Previously
   asserted only `some(event === 'demote')`, which a stale tier-1 loop
   scribbling after demotion would still satisfy. Now asserted:
   last entry IS `demote`; seq strictly monotonic end to end; and
   after a 2s wait with tier 2 rendering below, a second read shows
   identical length, identical last seq, last event still `demote` —
   tier-1 telemetry provably stops at its lifecycle boundary.

Full regression: M1 59/59 · M2 55/55 · M3 35/35 · M4 102/102 —
**251 checks**.

Honest flake record: one M1 run FAILED during this round while system
load was ~16 (immediately after the M4 suite; a follow-up attempt
couldn't even launch a browser within 180s under the same load). Two
subsequent runs at normal load: 59/59 both. The failing check's
identity was LOST because only the verdict line was captured — process
fixed (full suite output now tee'd to a file). Classification:
environmentally unclassified, machine-saturation suspected; if an M1
check fails again at normal load it must be treated as real, not
waved at this record.

## Review closure round 4 (2026-07-18) — evidence hygiene

Accounting correction, accepted from review: "full regression
251/251" was too clean a description. The defensible claim is: **M1,
M2, M3 and M4 each produced a successful post-change run, totaling
251 passing checks.** One earlier M1 run failed without retained
diagnostic output, and a separate rerun attempt failed during browser
launch under host load ~16. Those are two distinct events and neither
is part of an "uninterrupted 251/251" — that phrasing (including in
commit 1a9e575's message) overstated.

Closed this round:
1. **Resume test de-confounded**: the intervening `destroy()` between
   the visibility dance and the assertion is gone — it could have
   masked a resume-handler failure if destroy ever cleared governor
   fields, and it made the test exercise a destroyed engine rather
   than the live resumed state. Safe without it: dispatchEvent runs
   the handler synchronously and the rAF it requests cannot fire
   inside the same synchronous evaluate task. The test now isolates
   the resume handler as the thing that cleared the credential.
2. **Demotion history: exact snapshot equality**
   (JSON.stringify(h1) === JSON.stringify(h2)) — also catches
   in-place mutation of an existing entry, which length + final seq
   cannot see. (+1 check, M4 → 103.)
3. **tests/run.sh**: every suite run now records an environmental
   preamble (UTC time, uptime/load, memory, chromium/node processes),
   tees complete output to tests/logs/<suite>-<stamp>.log and appends
   the numeric exit status — launch failure (2), assertion failure
   (1), signal kill (>128) stay distinguishable. Logs are gitignored
   (evidence on disk, summaries in these records). Flake-hunt mode:
   `tests/run.sh m1-core 3` stops immediately on any failure and
   names the retained log.
4. **M1 controlled repetition**: three consecutive runs at ordinary
   recorded load via the runner (results below).
5. Hardware-retest cache note: the served dist updates on rebuild,
   but the BROWSER may cache — retest with a cache-busting param:
   http://192.168.4.40:8080/?telemetry=1&build=<dist-commit>
   (inert to the app; new URL to the cache).

**Round-4 run results** (all via tests/run.sh, complete logs in
tests/logs/, exit=0 each):
- M4 103/103 — de-confounded resume test passes with the resume
  handler as the only actor; byte-identical history snapshot holds.
- M1 controlled repetition: 3 consecutive 59/59 passes
  (11:28, 11:30, 11:32 UTC; 1-min load at preamble 9.25 / 7.89 / 7.94
  — largely self-inflicted by the back-to-back suites on this box,
  and well below the ~16 of the failure incident; no stale chromium).
- With the two earlier passes, that is 5 consecutive M1 passes since
  the single unclassified failure. Per the adopted protocol the
  incident is classified **harness/host infrastructure instability**
  (launch-timeout twin correlated with load ~16), with the standing
  rule: any future M1 assertion failure at normal load is a real
  defect until proven otherwise — its log will exist this time.

Defensible totals: M2 55 and M3 35 passed post-change earlier this
round (pre-runner, verdict lines only — the last such runs); M1 59
and M4 103 passed under the runner with retained logs. 252 checks.

## Review closure round 5 (2026-07-18) — evidence workflow acceptance

1. **M1 incident reclassified, wording accepted verbatim**:
   *unclassified historical M1 failure, not reproduced in five
   subsequent runs; a separate browser-launch timeout is classified
   as host/harness infrastructure failure.* The earlier "classified
   infrastructure" claim let the first event inherit the second's
   diagnosis; its evidence is gone, so its cause is not a knowable
   fact. The infra label now attaches only to the launch timeout.
2. **Load numbers are now interpretable**: this host has 8 cores
   (Xeon E5-4620). The incident's ~16 was 2× oversubscription; the
   passing runs' 8–9 were at capacity. The runner preamble now
   records nproc + CPU model, cgroup cpu.max/memory.max, and
   `vmstat 1 3` alongside uptime/free.
3. **Exit-taxonomy pushback (evidence, not assertion)**: all four
   suites deliberately exit 1 on a failed check
   (`process.exit(pass ? 0 : 1)`) and 2 from their catch-all
   (`process.exit(2)`) — the observed launch timeout itself took the
   exit-2 path (its "M1 RUN FAILED" prefix is that catch handler).
   The taxonomy is real per-suite behavior, documented in run.sh.
   Structured JSON result lines remain a possible future nicety.
4. **Runner failure path TESTED, not inspected**: committed
   tests/fail-fixture.js simulates both failure classes through the
   real runner — assertion mode propagated exit 1, harness mode
   exit 2; both runs archived to tests/failures/ and manifested with
   distinct nanosecond+pid stamps (same-second collision impossible
   in practice).
5. **All-suite path exercised end to end**: `tests/run.sh` (no args)
   ran M1→M2→M3→M4 in order — 59/55/35/103, four distinct logs,
   four manifest lines, exit 0 only after all four. **This is the
   first single uninterrupted 252-check runner execution**, at
   recorded loads 0.75→7.88 on 8 cores, superseding the earlier
   per-suite accounting.
6. **Evidence durability**: tests/run-manifest.jsonl is COMMITTED
   (commit, suite, stamp, exit, checks, log SHA-256 per run) so
   every run's identity+hash survives workspace loss; failure logs
   are copied to committed tests/failures/; passing logs stay
   gitignored on disk. The two fixture failure logs are retained in
   tests/failures/ as the acceptance evidence.

## Review closure round 6 (2026-07-18) — provenance made honest

1. **Dirty-tree provenance accepted and implemented** (runner schema
   2): full 40-char commit hash, `dirty` flag, working-diff sha256
   (ledgers excluded — they grow during multi-suite runs), plus
   dist_sha256 (the exact artifact tested), runner_sha256, per-ledger
   flock-serialized run_id, start/end/elapsed, python3-serialized
   JSON. The round-5 acceptance run IS annotated history now: its
   schema-1 entries claimed commit 9ac29cf while runner v2 + fixture
   were uncommitted (the tested dist artifact itself was the clean
   committed one; the runner was the dirty part — still wrong to
   leave unrecorded).
2. **The dirty flag caught a real leak on its first outing**: the M1
   suite overwrote tracked tests/m1-settled.png every run, so suites
   2–4 of any multi-suite run truthfully tested a dirty tree. Fixed:
   per-run captures go to gitignored tests/logs/; the committed png
   is frozen M1-milestone evidence. The run of record then produced
   four dirty:false entries at commit d78f894 — 59/55/35/103 = 252
   checks, one execution, no leftover chromium.
3. **Hash ≠ evidence, accepted**: the manifest is a durable index +
   integrity reference, not preserved evidence. Passing logs now also
   gzip into content-addressed tests/evidence/<sha256>.log.gz
   (survives log cleanup). HONEST CEILING: this repo has NO git
   remote — nothing, including committed failure logs, is off this
   machine. Flagged as an open item for the user (any push target
   fixes it).
4. **Fixture events separated from product evidence**: fixture runs
   ledger to tests/runner-acceptance-manifest.jsonl (kind:"fixture");
   the two historical fixture lines were moved out of the production
   manifest. tests/runner-acceptance.sh ASSERTS: exit 1 propagation
   (assertion mode), exit 2 (harness mode), multi-suite
   stop-on-first-failure via SUITES override with a real second suite
   proven never to start, exactly 3 acceptance entries, production
   ledger untouched. PASS.
5. **All-suite path completed** (the prior review saw it in flight):
   order M1→M2→M3→M4, four unique logs, four manifest entries,
   correct totals, exit 0 only after M4, zero chromium leftovers.
6. **Load-classification restraint accepted**: the environmental data
   makes FUTURE incidents diagnosable; it does not retroactively
   classify the lost M1 failure, which remains: unclassified
   historical failure, not reproduced (now seven consecutive M1
   passes since).

## Real-hardware telemetry round (2026-07-18) — first field data

User's machine identified via ?telemetry=1 + chrome://gpu: Intel HD
Graphics Family 0x0A16 (Haswell Gen 7.5, HD 4400 class), driver
20.19.15.4835, SINGLE GPU (no discrete, no Optimus — GPU1 is the
Microsoft Basic Render fallback), 4 threads, 3 GB RAM, 1366×768.
Both webgl and webgl2 hardware-accelerated on the identical ANGLE
D3D11 renderer. **Dual-GPU hypothesis: dead. Software-WebGL2
hypothesis: dead.** Remaining day-to-day variance question is
power/thermal only.

The 49-entry history ring (seq 1–49) convicted the governor of two
defects and the fix unmasked a third:

1. **Starved downsizes → demotion on never-collected evidence.**
   resize-requests to 384² (t=191.7) and 256² (t=201.7) never
   executed — every subsequent window shows n:512 through the demote
   at t=221.8. Idle-deferral starved under continuous interaction;
   the demote verdict cited floor evidence that was never collected.
   FIX: a second bad window forces the queued downsize at the next
   frame boundary (resize-forced event); demotion now requires bad
   evidence AT the applied floor. The forced-abandoned size gets a
   duress mark (trialFailed) — not retried that session, preventing
   minutes-scale baseline↔smaller bouncing.
2. **Rung 1↔2 ping-pong ×7 (~90s of post-effect flicker).** Rung-2
   p90 16.9–17.4ms (just under the 17.9 good line) promoted; rung-1
   p90 18–20ms (hold band) degraded back via sustained-hold. The
   rung axis had NO promotion memory (sizes: trial-no-retry; tier 2:
   pair lock; rungs: nothing). FIX: two-strike rung-promotion lock
   (rung-lock event, 120s bounce window, 180s strike decay), cleared
   on size change (new landscape), re-armed on tab revisit (tier-2
   policy). This machine now parks at rung 2 ≈ 58fps at full 512².
3. **Latent recovery deadlock (unmasked by fix 1).** Once a downsize
   actually applied, govImproveOnce requested a size promotion every
   improve window; govMaybeResize cancelled it every frame (promote
   requires rung 0) — rung restoration starved forever below
   baseline. Unreachable before only because downsizes never
   executed under load. FIX: rung-first recovery ordering.

Also from the dump: tier 2 held the FULL 42,000 budget at >56fps
(pair lock correctly saw recovery, not cycling — no lock); the X3557
HLSL warnings are harmless unroll notes; one EGL "version not
supported" is Chrome probing a higher ES version. Expected behavior
on this machine with the fixes: stable 512²/rung-2 under light use;
under heavy interaction a genuinely-applied 384², likely no
demotion at all.

Open (M4 part 2): size-promotion perf-bounce above the duress mark
is damped per-session but the mark's permanence (vs decay) deserves
review; the promote-request-from-degraded-rungs pattern still
consumes improve windows when below baseline at rung 0 with an
unmarked size above.

Tests: honest-ladder rewrite (test 1 now forces, applies the floor,
and demotes on floor evidence — demote entry n===32), rung-lock
battery (two-strike, good-cannot-repromote, bad-still-degrades),
starvation battery (scrub-parked mix=0.5 proves unforced pendings
starve and forced ones execute), duress-mark recovery (rungs restore
to 0, size stays). M4: 113 checks.

Full clean-provenance regression at b297351 (runner, all
dirty:false): M1 59 · M2 55 · M3 35 · M4 113 = **262 checks**.

## Field validation (2026-07-18, same Haswell machine, build 7a46b2c)

Second telemetry run on the machine that demoted yesterday. 59-entry
history, verbatim outcome — every mechanism fired per design:
- resize-forced → resize-commit 512→384 at t=60 (starvation fix, live)
- full rung recovery 3→2→1→0 at 384² by t=160 (rung-first recovery
  fix, live — the old code deadlocked on this exact path)
- queued 256² downsize cancelled on 4 consecutive goods (stale-pending
  cancellation, live)
- no 512² re-promotion occurred — CORRECTED (review): the trace is
  CONSISTENT with the duress mark but does not isolate it: the run
  never produced two consecutive good windows at rung 0, so promotion
  eligibility was never reached and the mark was never independently
  exercised in the field (the synthetic test covers it)
- rung-1 promotion failed twice (t=225 strike 1, t=250 strike 2) →
  rung-lock at 2 → three subsequent good windows produced NO churn.
  CORRECTED (review): strike 2 came from a p90 32.9ms BAD window —
  likely an interaction burst, not boundary oscillation. Under the
  workload-aware attribution shipped after this run, that window
  would void the trial rather than count a strike; the lock proved
  its MECHANISM live, not its attribution
- **no demotion**

Final state: tier 1 (gl2), 384² = 147,456 particles, rung 2, post on,
p90 ~17ms ≈ 58fps, held through the ~20s of post-lock evidence the
trace contains (observed stability, not long-term proof). Yesterday:
tier-2 fallback at 42,000 CPU particles. Today: 3.5× the particles
with full GPU physics on the same 2013 3GB-RAM laptop — an
uncontrolled comparison (code changed, interaction differed, power
state unknown), impressive but not an A/B experiment. Interaction
bads (31–49ms p90) were absorbed by rung moves + one applied size
step.

Remaining open on this machine: subjective experience report; the
plugged/battery variance question (optional A/B/A).

## Review closure round 7 (2026-07-19) — policy refinements + runner v4

Engine (all synthetic-tested, M4 127 checks):
1. Forced resize releases an active grab through the standard release
   path first — tested with a REAL held grab across the forced reinit
   (capture applied, resize commits mid-grab, zero stuck clumps, zero
   page errors, coherent pointer traffic after).
2. Degradation never re-requests an alloc-failed size; a fully
   poisoned size axis is exhausted → post-off → demotion at the
   CURRENT size (tested: no resize-request events, demote at n=64).
3. Workload-aware strikes: only sustained-hold degrades count toward
   the rung lock; a bad-window degrade VOIDS the promotion trial
   (interaction bursts and stalls are not boundary-oscillation
   evidence). Tested both ways.
4. allocFailed (hard, session) split from perfRejected (expires 300s
   sim-time; cleared on tab revisit). debugGov exposes both plus the
   merged legacy view.
5. Every resize cancellation logged with a reason
   (performance-dropped / recovery / stale / rung-not-zero) — no
   interpretive archaeology.
6. Rung locks reset on viewport change (fill-rate landscape moved).

Field-record corrections applied in place (duress mark: consistent-
with, not isolated; rung-lock strike 2 was an interaction burst that
current attribution would void; "stable" = ~20s observed post-lock).

Runner v4 (acceptance 8/8): untracked files in dirty + diff hash +
ledger list; set -euo pipefail with distinguished fatal exits
(74 log / 75 evidence / 76 ledger) FAULT-INJECTED via fake gzip and
python3 on PATH — a passing suite cannot mask evidence loss and a
failed archive appends no ledger entry; archive verified BEFORE the
ledger names it; pre/post tree signatures → tree_stable; explicit
PRODUCT/FIXTURE allowlists (unknown → 64); fixture failures to
gitignored tests/runner-artifacts/ (previous committed fixture logs
removed from tests/failures/ — git history retains them).

The first v4 regression (run_ids 17–20, all exit 0, 276 checks,
evidence objects verified) immediately demonstrated the new
instruments on their author: m4-results.md was edited mid-run
(these corrections), so M1 shows tree_stable:false and M2–M4 show
dirty:true. The taint is a docs file — but the manifest cannot know
that, which is the point. A clean run of record follows this commit.

**Round-7 run of record** (run_ids 21–24 at 124a02c, author hands off
the keyboard this time): M1 59 · M2 55 · M3 35 · M4 127 = **276
checks**, all exit 0, all dirty:false, all tree_stable:true, zero
untracked files, four verified evidence objects.

## Review closure round 8 (2026-07-19) — served bytes = proven bytes

1. **Release sequence corrected** (the review's core finding): dist is
   no longer rebuilt after testing. New order: commit source → build →
   commit dist → regression against THOSE bytes → tests/attest.sh
   binds {source_commit, dist_sha256, runner_sha256, run_ids} and
   REFUSES if any run was non-zero/dirty/unstable, spanned commits,
   used a different runner, or — the key one — tested different dist
   bytes than presently on disk. The attestation commit does not
   rebuild (a proof must not change the object it proves).
2. **Tree instability ENFORCED**: exit 77, result+evidence+ledger
   preserved, no success banner, chain stops. Acceptance-tested with
   a self-tainting fixture (tracked canary modified mid-run):
   exit 77, tree_stable:false recorded, m2-grab never started,
   banner absent.
3. **tree_sig/diff_sha fail CLOSED**: required git/sha256sum inputs
   lost their || true guards — a signature over partially-read state
   no longer possible; only environmental diagnostics tolerate absence.
4. **Strike attribution is contamination-aware, not severity-gated**
   (fixing the reverse failure: a rung failing cleanly at 27ms voided
   its own trial forever → eternal promote/degrade cycle). winDirty
   sampled per frame (grab active or excite ≥ 0.1); clean failures
   strike at ANY severity; contaminated windows degrade but void;
   contamination recorded in history (int:true). Tested in all four
   quadrants.
5. **Grab-release causality instrumented**: effective releases counted
   (only when a grab was active — a reinit clearing GPU flags cannot
   move the counter). Forced-resize-during-grab now proves: released
   via the standard path EXACTLY once, post-reinit pointerup counts
   nothing, a fresh grab works on the rebuilt engine.
6. **Poisoned-intermediate skip demonstrated at the default ladder**:
   384 alloc-failed → request targets 256 directly, 384 never
   requested or committed, 512→256 commit lands. (Two-consecutive-
   poisoned-then-viable is untestable on the shipped ladder — only
   two sizes exist below baseline; the skip loop + exhaustion case
   cover the code paths that exist.)
7. **Mid-morph duress policy explicit and tested**: forced resize at
   scrub-parked mix 0.5 reseeds at the current formation side
   ('device'), completes to mix 1, no limbo. Fling velocities are
   discarded with the old field (documented at the release site).
8. **perfRejected clears on viewport change** (same reasoning as the
   rung lock: a conditional verdict must not outlive its conditions).

Acceptance: 9 sections PASS (adds exit-77 enforcement drill).
**Run of record: run_ids 25–28 at fa66e14 — M1 59 · M2 55 · M3 35 ·
M4 135 = 284 checks, all dirty:false + tree_stable:true. Attested:
dist a8396aa0… (independently re-hashed = served bytes). M4 phase +
evidence workflow: CLOSED.**

## Review closure round 9 (2026-07-19) — attestation earns its narrative

1. **Pushback, evidence-backed**: the review's headline bug quoted
   `g.winDirty += true` (undefined+true=NaN chain). The shipped line
   (src/gl2.js:1452) was `g.winDirty = true` — plain boolean
   assignment; no arithmetic ever existed on that flag. The adjacent
   gap WAS real: winDirty was undeclared and worked by accident of
   undefined-falsiness — now declared `winDirty: false` in initGov.
2. **Collector-path contamination proven** (the injection tests
   bypassed govFrame): a REAL held grab + production govFrame driven
   with synthetic time → the closing valid window carries int:true;
   after release + excitement decay the next window doesn't.
   Accumulate → rollover → reset, end to end.
3. **Attestation v2 enforces its narrative**: exact suite composition
   AND order, one batch id per runner invocation (stamped into every
   ledger entry — four cherry-picked m1-core runs can no longer pose
   as a regression), contiguous run_ids, non-null check counts, and
   per-entry evidence verification (object exists, re-hashes to
   evidence_sha256, decompresses to log_sha256 — the attestation goes
   red if the archives rot).
4. **untracked enumeration fails closed** (|| true removed; tree_sig
   captures the list so the failure propagates). Newline-pathological
   filenames remain a documented limitation of the ledger's untracked
   list; the signature hashes contents regardless.
5. **HTTP boundary attested**: attest.sh curls the dev server and
   REFUSES if the returned bytes differ from the attested dist.
6. **Duress side-selection is a rule, not a point**: mix 0.25 →
   source ('logo'); 0.5 tie → destination ('device'). Fling discard
   is structural — velT recreated null-backed at reinit (WebGL2
   zero-initializes); a magnitude test would re-measure the spec.

Acceptance 9/9 (batch field asserted). **Run of record: run_ids
29–32, one batch, at 403bc86 — 59 · 55 · 35 · 138 = 287 checks, all
dirty:false + tree_stable:true. ATTESTED with
dist_sha256 = http_sha256 = 1bf57f10… — the bytes tested, the bytes
on disk, and the bytes the server returns are one object.**

## Review closure round 10 (2026-07-19) — attestation hardening final

Reviewer's correction acknowledged for the record: the round-9
"winDirty += true → NaN" production bug was quoted from code that
never existed (shipped line was boolean assignment); the reviewer
confirmed the fabrication. The correction cycle works both ways —
recorded because process honesty is the product here.

All five hardening items adopted:
1. **HTTP verification MANDATORY**: unreachable server → ATTESTATION
   REFUSED. `--no-http` is the only disk-only path, announces itself,
   and records http_sha256:null. Warnings are no longer load-bearing.
2. **Check inventory enforced**: exactly (59, 55, 35, 142) — a
   silently weakened suite refuses; intentional growth requires
   deliberately editing the expected inventory in attest.sh.
3. **Whole-batch membership**: all product entries carrying the
   candidate batch id must equal exactly the attested four — extra
   prefix runs in the batch refuse. kind:product + schema:3 asserted
   per entry.
4. **mix 0.75 → destination** tested: both sides plus tie now
   literally covered (0.25→source, 0.5→destination tie, 0.75→dest).
5. **Full decision consequence through the real collector** (adopted
   though declared non-blocking): promotion trial → contaminated bad
   window via production govFrame with a REAL held grab → degrades
   with NO strike, proven discriminatingly — the lock arrives exactly
   two CLEAN bounces later, impossible had the contaminated window
   counted.

**Run of record: run_ids 33–36, one batch, at fb69476 —
59 · 55 · 35 · 142 = 291 checks, all dirty:false + tree_stable:true.
ATTESTED (schema 3, all refusal gates green):
dist = http = 28507038… — tested, on-disk, and served bytes one
object, with the serving boundary now REQUIRED, not courteous.**
