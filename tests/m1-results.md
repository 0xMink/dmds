# M1 results — tier-1 GPGPU core

Run: `node tests/m1-core.js` · Environment: headless SwiftShader ·
Date: 2026-07-17 · **PASS — 46/46 checks** (two correction passes
after external review; runs were 13 → 31 → 46 checks).

## Milestone state

**M1 implementation complete; M1 verification complete** for
everything SwiftShader can testify to. Real-GPU performance and
interaction feel remain pending Dennis's hardware (as spec'd — that
gate belongs to M2+ review, not M1).

## Second correction pass (verification-debt closure)

- **Unit audit added to spec (rev 3.1)** — the "unreachable at
  V_max·dt" justification was mathematically wrong (a per-frame cap
  bounds speed, not position); the spatial bound actually comes from
  force balance (max non-spring force ÷ min spring gain ≈ 31 wu past
  the ≤ r20 envelope → ~51 < 60). Every world-space constant is now
  tabulated; M2 fling constants are chosen against that table.
- **Exact reset contract proven at single-step granularity** via new
  `pause()/debugStep()/debugReadTargets()`: poked particle, ONE sim
  step → position equals the active GPU target texel (dp = 0),
  velocity exactly zero, next step stable (drift 2e-4).
- **512² morph measured** on a deterministic 32×32 texel sample
  (`debugReadSample`, any N): 1024/1024 sampled particles moved,
  finite — "formations render + morph at 512²" is now demonstrated
  at 512², not inferred from 64².
- **Lifecycle reusability**: init→destroy→init ×3 with an
  add/removeEventListener tally — balanced across cycles, engine
  ready and integrating after re-init; tier-2 destroy→reinit passes.
  This caught a real bug: `init()` never reset `state.destroyed`, so
  a destroyed engine could never re-initialize (both tiers fixed).
  `destroy()` also now clears the pending restore timer.
- **Restoration integrity beyond status**: post-restore GL health
  (zero errors, FBOs complete), sim integrates finite, formation
  preserved, demotion timer proven cancelled (outlived its window).
  This caught bug #3 of the pass: the rebuild deleted *pre-loss* GL
  objects on the restored context → sticky `INVALID_OPERATION`.
  Stale references are now forgotten, not freed (both tiers).
- **Failure matrix completed**: shader-compile failure (corrupted
  source on the visible canvas only) and partial-build failure
  (injected after textures/FBOs/programs exist) both reach cleanup +
  tier 2.

## Known debt (accepted, tracked)

- Provenance is two-commit-honest but not tamper-evident (a hand-edit
  to dist can survive if it dodges the CSP hashes) — M6 adds
  rebuild-and-compare or an artifact hash.
- Tier-2's `setBudget` remains; `setQualityBias` was never present
  under that name (spec's deletion target was resolved as: no such
  API shipped).

## What the correction pass changed

1. **World-scale reconciliation (spec rev 3.1)**: the spec's
   "[−1,1]³ / ‖p‖ > 4" wording described a normalization the
   implementation correctly did not adopt (tier 1 shares tier 2's
   generator space, half-extents ≈ 14.6 × 8.2, formations ≲ r20;
   OOB bound 60, unreachable legitimately at V_max·dt ≤ 3 wu/frame).
   The earlier `maxR < 60` test looked like a loosened bound against
   the stale spec — the spec was amended, and the bound is now tested
   as the *documented reset bound* plus a tighter legit-motion check
   (`maxR < 25`).
2. **Recovery is proven, not argued**: `debugPoke` injects a particle
   at r = 200 (and another as NaN); both return inside the formation
   envelope within 1 s — impossible without the reset branch, since
   capped motion covers ≤ ~3 wu/frame.
3. **Production shape verified at 512²**: allocation, ≥3 frames,
   `SEED … 262,144`, zero GL errors, both MRT FBOs complete.
4. **Morph verified numerically** at readable N: 4095/4096 particles
   moved > 0.5 wu, stayed finite and in-bounds; engine-level formation
   name changes synchronously (the page choreography re-asserting the
   hero formation afterward is page behavior, by design).
5. **`DMDS_GL.destroy()` exists** (tier 2 lifecycle: tracked
   listeners, RAF cancel, GL teardown — behaviorally unchanged
   otherwise). Destroy/teardown verified for tier 1 (stops, releases
   state, no errors after).
6. **Canvas replacement proven by identity**, with the break injected
   *after* the visible canvas holds WebGL2 (old canvas held webgl2,
   new element ≠ old, new runs webgl1).
7. **Full fallback matrix**: no-WebGL2 · no-EXT_color_buffer_float ·
   FBO-incomplete · post-context late failure · runtime loss →
   pause · restore → resume · no-restore-in-4s → demotion to tier 2
   on a fresh canvas · no GL at all → CSS tier with honest log.
8. **Timeout swallowing removed** — a failed precondition now fails
   the test at the precondition.

## Bugs the expanded matrix caught (would have shipped)

- **Context restore was broken on every device**: a restored WebGL2
  context forgets its extensions; without re-acquiring
  `EXT_color_buffer_float`, the rebuilt RGBA32F FBOs come back
  incomplete → restore always failed. Fixed (re-acquire on restore);
  `fb:restore-resumes-gl2` now passes.
- The failure was invisible because the restore handler's catch was
  **silent** — it now logs before demoting (truthful instrumentation
  applies to error paths too).

## Visual evidence

`m1-settled.png` (captured by the committed suite, portable runner):
at excitement 0.04 the wordmark **appears visually sharp under
SwiftShader** — post-fx faded, points crisp. This is a visual
observation; *physical* crisp-lock (convergence to targets, settled
velocities, snap counts) is verified numerically only at the
recovery-test level so far — the full convergence reduction and
settling invariants are M2/M4 scope.

## Provenance flow (corrected)

`dist` committed alongside its own source can never carry a matching
hash. Flow now: dist is excluded from the dirty computation, the stamp
names the source commit the artifact was built *from*, and dist is
committed separately after its source commit (documented in README).

## Carried forward

- Grab/tear + full deterministic sim battery incl. damping-invariance
  across dt and the convergence invariant (M2) · depth/camera/dust
  (M3) · two-axis governor + demotion-by-performance + physical
  crisp-lock verification + reduced-motion stop (M4) · design fixes
  (M5) · docs + `build.sh --test` consolidation (M6).
- SwiftShader runs the sim in slow motion at low fps (dt clamp, no
  catch-up — by design); assembly pacing on real GPUs pends Dennis.
