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

## Gap-closure pass (after external review)

Review verdict accepted; its two "close before M4" items both drew
blood:

- **Bug #12 — stale scrub-pair cache across context restore** (the
  review's concurrency scenario, which I had wrongly waved off as
  "test race only"): restore rebuilt both target textures as the
  current formation but left `pairA/pairB` cached, so a post-restore
  `setMorphPair` with the pre-loss pair hit the same-pair guard,
  skipped its re-upload, and scroll-scrubbing went silently inert.
  Restore now invalidates the pair cache (spec amended with the
  commands-during-loss semantics: newest request wins, uploads while
  lost are CPU-state-only, pair cache invalidated).
- **Bug #13 — interrupted-morph freeze reconstructed the "from" state
  by name**: a tween's from-state is the *previous blend*, which no
  formation name can name. `blendedTargets` blended destination-vs-
  destination (dust factor snapped binary; frozen positions could be
  wrong after interrupt chains). Slot A now keeps a CPU mirror
  (`state.fromArr`, maintained at every upload site), and frozen
  blends — positions AND dust factor — derive from what the texture
  actually holds. Verified: interrupt at mix 0.36 leaves overflow dust
  factors at exactly 0.30 (= smooth01(0.36)), not binary.

Also added, per review: `debugCamera()`; exact fixed-step amplitude
checks (parX = mouse.x·0.4 to ±0.02 both directions); **depth
differential** on the scroll axis (near points shift 1.76× far points
— proving true 3D trucking, uncontaminated by the sway rotation that
the pointer axis also drives); device-formation z distribution
(range −2.0…+0.9, σ 0.67). Total: 9 → 21 checks; M1 59/59 and
M2 55/55 regression green.

Deferred to M4 with the review's agreement: render-level dust
image-energy measurements and per-scale parallax repeats (they belong
in the governor scale matrix, which re-runs at every promoted N).

## Second gap-closure pass (per-particle freeze + GPU-backed restoration)

- **Bug #14 — the freeze blended with a GLOBAL factor while every
  particle chases its own STAGGERED blend.** The previous test's
  "all dust factors exactly 0.30" was the bug's fingerprint, not a
  pass. Fixed the way the review's aside suggested: the freeze now
  runs ON the GPU (a freeze pass using the sim shader's exact
  per-particle hash/stagger math, copied into targA) — no CPU/GLSL
  float32 hash drift possible, and the 20 MiB of CPU mirror arrays
  added by the previous fix were deleted again (its memory concern
  resolved by construction). Verified: frozen dust factors span
  0.001–0.581 at mix 0.36 (the exact stagger range; uniform values
  now FAIL), and every frozen point lies on its own A→B segment at
  its own recovered blend factor (dominant-axis conditioning).
- **Bug #15 — found by the new loss test**: the freeze pass compiles
  its program lazily, and shader compilation THROWS on a lost context
  (uploads only no-op) — a formation change during a lost context
  crashed the caller. Freeze is now skipped on lost contexts
  (commands-during-loss stay CPU-state-only per spec) and degrades to
  the plain upload on any freeze failure.
- **Restoration proven GPU-backed, not status-backed**: a neural
  target reference is materialized and sampled pre-loss; after
  lose → request device → request neural → restore, the REBUILT
  textures match the reference texel-for-texel (maxDiff 0). Status no
  longer testifies anywhere in the loss path.

Deferred to M4 (per review): sway-frozen parallax isolation (fold
into the per-scale matrix) and the promotion gate's full CPU+GPU
memory/copy/latency accounting. Suite: 21 → 23 checks; M1 59/59,
M2 55/55.
