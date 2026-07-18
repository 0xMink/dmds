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
