# M3 results — depth, camera parallax, ambient dust

Run: `node tests/m3-depth.js` · Environment: headless SwiftShader ·
Date: 2026-07-18 · **PASS — 9/9 checks** (M1 59/59 ×3, M2 55/55
regression green).

## What M3 built

- **Camera parallax** (spec unit-audit values, fixed at M3): pointer
  lean ±0.4/±0.2 wu, scroll drift ±0.3 wu, lerped at 4/s in
  `advanceSimulationState` (deterministic tests step it too). The
  camera truck lives in the view matrix; sim and render consume the
  SAME per-frame matrices (`state.proj/view/vp/invVP`, computed once
  in simStep), so grab capture math can never diverge from the drawn
  image. Zero under reduced motion (verified: drift exactly 0 with
  pointer + scroll input).
- **Scroll feed**: `GL.setScroll(progress)` called from the page raf;
  tier 2 has no camera truck and the call is guarded.
- **Type-mode ambient dust** (spec rules): text formations cap at
  120,000 glyph particles; the remainder scatter behind the text plane
  (z ≤ −3), flagged in `target.w`. The renderer blends the dust factor
  with the same stagger as position (a particle fades to dust as it
  travels), rendering dust smaller (−45%) and dimmer (−65% alpha,
  which also starves bloom). Verified at 512²: glyph-region texels
  unflagged, overflow-region flagged and behind-plane; at 64²
  (below cap) zero dust.
- **Deeper device formation**: z shells ±0.9 (was ±0.35), UI bars
  ±0.6, sparkle depth to −2 — volumetric under the new parallax.
- `debugProject` added (parallax observed through matrices, not
  screenshots); `debugReadTargets` gained region offsets.

## Flake killed (third sighting, root-caused)

The intermittent M1 failure was `fb:restore-target-texture-preserved`:
the page's scroll choreography can fire `setMorphPair` at a hero-zone
boundary between the test's before/after texture samples, re-uploading
different targets — a test race, not an engine defect. The restore
test now stubs the public formation API for its duration (the restore
handler uses internal paths and is unaffected). M1 passed 3×
consecutively after the fix.

## Notes

- Parallax NDC shift measured ≈0.023 (pointer sweep) / ≈0.04 (full
  scroll) at 16:9 — subtle by design ("a lean, not a fly-through");
  feel judgment on real hardware pends Dennis.
- Carried forward: M4 (two-axis governor, performance demotion,
  reduced-motion stop, full crisp-lock physical verification at
  governor scale), M5 (orange proof band, form grammar), M6 (docs,
  `build.sh --test`, provenance tamper-evidence).
