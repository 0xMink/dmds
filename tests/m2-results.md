# M2 results — grab / tear / fling

Run: `node tests/m2-grab.js` · Environment: headless SwiftShader ·
Date: 2026-07-17 · **PASS — 52/52 checks** (35 initial + 17 from the
gap-closure pass; M1 regression green, 59/59).

## Gap-closure pass (after external review)

1. **`debugStep` now steps the real engine**: the CPU half of the
   dynamical system (morph progress, mouse/turbulence/dim lerps,
   excitement decay and grab re-raise) lives in one shared
   `advanceSimulationState(dt, now)` used by BOTH the frame loop and
   the deterministic stepper — tests exercise the system visitors
   receive, not a calmer laboratory twin.
2. **Production-N convergence, via the spec'd hierarchical 2×2 GPU
   reduction** (`debugConvergence`): at 256² and 512², grab (5,330 /
   18,956 particles captured — counted by the reduction itself), drag,
   fling, then **0 of 65,536 / 0 of 262,144 outside 0.01 wu at 3 s**;
   0 outside 0.03, 0 flags, 0 non-finite, maxDist 0 at 4 s.
3. **Pointer-release ownership completed**: `setPointerCapture` on the
   canvas at grab start; release proven for lostpointercapture,
   hidden-tab, context-loss, and destroy (plus the earlier pointerup/
   pointercancel/blur). `destroy()`/`init()` fully reset CPU grab
   state — a stale `active` flag would have pinned excitement at 0.85
   and killed crisp-lock after any re-init.
4. **Camera-correct pointer geometry**: pointer NDC from
   `canvas.getBoundingClientRect()` (clamped, so an off-screen drag
   can't haul a clump toward the recovery bound — the held branch also
   applies OOB recovery now); release velocity from successive
   *unprojected* pointer anchors on the world-origin reference plane
   (camera-rotation-aware); `mat4Invert` throws on singular input;
   project→unproject round trip ≤ 2e-12 at 16:9 / ultrawide /
   portrait across depths with the live rotating camera.
5. Tear screenshot capture is a committed portable script
   (`tests/m2-tear-shot.js`), not a scratchpad artifact.

Wording correction per review: the fling assertions measure the
**post-integration release-step velocity** (spring and drag apply in
the same step, by design), not the raw transition value.

## What M2 built

- **Grab state machine in the sim shader**, exactly per the spec's
  transition table: capture on the pointerdown edge only (projected
  screen-space selection, aspect-corrected NDC radius from 90 CSS px);
  captured NDC depth stored in `position.w`; world offset from the
  unprojected anchor stored in `velocity.xyz` with `velocity.w` as the
  grab flag; held motion is first-order convergence toward
  `unproject(pointer, depth) + offset` (no spring — the velocity
  channels hold the offset); release fires in the same sim step that
  observes `active = 0` with the flag set, writing the EMA-filtered
  pointer velocity (clamped 0.8·V_max) + seed jitter — a stored offset
  is never integrated as physical velocity, not even one frame.
- **Pointer input** (desktop mouse only; touch/pen never grab;
  reduced-motion never grabs; interactive controls are guarded).
  Unconditional release on pointerup, pointercancel, blur,
  visibilitychange→hidden, and context loss.
- **Camera matrices in the sim pass** (VP + inverse), same inputs as
  the render pass per frame, so capture math matches drawn positions.
- Spec's **M2 acceptance condition discharged**: the 31 wu excursion
  margin re-derived under the grab model (held motion is monotonic and
  viewport-bounded; ballistic release ≤ 72/5.2 ≈ 13.9 wu + jitter,
  < 31) and verified empirically (max fling excursion ~11 wu against a
  60.9 bound).

## Verified (35 checks)

- Capture: ~270 particles at the wordmark, edge-only, depth stored,
  free particles keep the sentinel; **membership constant** through
  still and dragging holds.
- Held: clump follows the pointer (Δx 4.3 wu) and **keeps its shape**
  (max internal drift 0.29 wu over a full drag).
- Release: one step clears every flag and restores every sentinel;
  fling velocities finite, ≤ bound, matching the drag direction.
- Unconditional release proven for pointercancel and blur; NaN
  injected into a *held* particle recovers and clears its grab.
- **Damping law**: back-computed drag coefficient from single steps at
  1/144 and 1/30 s agrees to < 0.1% (time-based, not per-frame); the
  coefficient sits ~1.5% off nominal on SwiftShader's approximate
  `exp()` (`--enable-unsafe-swiftshader` reduced precision) — the
  portable gates are cross-dt consistency (2%) and coefficient within
  3% of nominal.
- **The two-tier convergence invariant, in full**, at dt ∈ {1/144,
  1/60, 1/30}: grab → drag → fling → 3 sim-seconds → **4096/4096
  within 0.01 wu** of the active GPU target (spec asks ≥99%); by 4 s,
  4096/4096 within 0.03, zero grab flags, zero non-finite. Excursion
  tracked every 0.25 s stays far inside the derived bound.

## Bug found by the battery (would have shipped)

- **Crisp-lock spec violation**: the shader scaled idle turbulence
  linearly with excitement but never zeroed it, so ~490 particles
  sustained 0.02–0.03 wu orbits below the snap gate forever —
  convergence stalled at ~93%. The spec already said "below excitement
  0.05, turbulence is exactly zero"; the shader now gates turbulence
  through `smoothstep(0.05, 0.12, excite)`. Convergence went to
  4096/4096 at every dt, and the settled field is now *actually*
  still, which is the crisp-lock MUST.

## Visual evidence

`m2-tear.png`: a clump torn out of the D (visible void in the
letterform), holding its shape mid-drag near the headline, field
excited. SwiftShader still (feel review pends real hardware).

## Notes / carried forward

- EXCITE_TAU tuned 1.2 → 0.8 s so the convergence window closes by
  3 s (constants are implementation-tunable per spec; recorded here).
- Depth/camera parallax + ambient dust (M3) · two-axis governor +
  performance demotion + reduced-motion stop (M4) · design fixes (M5)
  · docs/DESIGN.md v2.2 + `build.sh --test` + tamper-evidence (M6).
- Real-hardware review (Dennis): tear feel, fling weight, and the
  crisp-lock rhythm are now the top items to judge by hand.
