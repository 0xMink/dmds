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
