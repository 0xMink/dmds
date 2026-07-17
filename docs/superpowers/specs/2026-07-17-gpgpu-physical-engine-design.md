# Phase 1: The Engine Becomes Matter — GPGPU Physical Particle Engine

| | |
|---|---|
| **Date** | 2026-07-17 |
| **Status** | Approved design (rev 2 — engine-review corrections folded in) |
| **Owner** | Dennis Mink (@0xMink) |
| **Scope** | Phase 1 of the staged plan (physical engine → DMDS/OS terminal → playable layer). This spec covers Phase 1 only. |
| **Parent docs** | `DESIGN.md` v2.1 (this work bumps it to v2.2), `README.md` |

## Goal

Replace the WebGL1 vertex-morphing particle engine as tier 1 with a
WebGL2 GPGPU physical simulation, keeping the current engine intact as
tier 2. The visitor must *feel* the engine within two seconds (the
cursor displaces particles like matter), discover the signature move
(grab and tear the wordmark; it always reassembles), and see the site
"crisp-lock" to sharp legibility at rest. Sim sizes: 512² = 262,144
particles default desktop, up to 1024² = 1,048,576 on strong GPUs,
256² = 65,536 mobile floor.

The metaphor is load-bearing: **tearing the formation apart and
watching it recover is the site's resilience thesis made tactile.**
"Reassembly always wins" is specified below as a numerical invariant,
not a slogan.

## Non-goals (Phase 1)

- Terminal / DMDS-OS layer (Phase 2). Game layer (Phase 3).
- Photogrammetry operator portrait (separate; needs a scan from Dennis).
- Sound redesign beyond driving existing sfx intensity from excitement.
- External assets. Phase 1 stays fully self-contained.
- Removing or rewriting the WebGL1 engine (`src/gl.js`) — kept verbatim
  as tier 2.
- Half-float tier-1 mode: if RGBA32F is not renderable, use tier 2.
  (Half-float positions jitter visibly at ≥1440px; tier 2 is a better
  experience than a shimmering tier 1.)

## Tier ladder

| Tier | Requirements | Experience |
|---|---|---|
| 1 · `gl2` | WebGL2, `EXT_color_buffer_float`, probe passes (below) | GPGPU physical sim (this spec) |
| 2 · `gl1` | WebGL1 | Current shipped engine, unchanged |
| 3 · `css` | No usable GL | CSS gradient atmosphere (unchanged) |
| 4 · `static` | No JS | Full content, dossiers expanded (unchanged) |

**Capability ≠ performance**: tier 1 also has a runtime performance
demotion rule (see Governor) — a device that *can* run RGBA32F but
can't run it acceptably ends up on tier 2, not trapped at tier 1's
floor.

## Boot, fallback, and lifecycle

A canvas that has ever returned a WebGL2 context cannot later return a
WebGL1 context. The boot sequence is therefore:

1. **Probe on a throwaway canvas** (never the visible one). The probe
   must exercise the production shape, not just extension presence:
   WebGL2 context → `EXT_color_buffer_float` → create the production
   RGBA32F textures at 4×4 → attach as MRT (2 attachments, the real
   layout) → `checkFramebufferStatus` complete → run ≥3 sim steps
   through **both** ping-pong directions with known inputs →
   `readPixels` each attachment and assert expected values → a
   vertex-stage `texelFetch` render lands expected pixels → destroy
   everything. Any failure → tier 2, visible canvas untouched.
2. Probe passed → init `DMDS_GL2` on the visible canvas.
3. **Late-failure safety net**: if visible-canvas init still fails
   (drivers differ, allocation fails at real sizes), `destroy()` the
   tier-1 attempt, **replace the canvas element** with a fresh clone
   (same id/attributes), and init tier 2 on the replacement. The same
   path serves runtime performance demotion.
4. Tier-2 failure → tier 3 (existing behavior).

`main.js` is engine-agnostic; the boot log names the real tier
(truthful instrumentation): `COMPILE sim + render … OK` (tier 1) vs
the existing `COMPILE vertex + fragment … OK` (tier 2).

### Engine interface (both engines)

```
init(canvas, onMilestone) → Promise     // milestones: compile, post, seed(count), loop
setFormation(name | "text:S", duration)
setScroll(progress, velocity)
setPointer(x, y, down)                  // CSS px; engine handles DPR
isReady() / pause() / resume()
destroy()                               // full teardown: RAF, listeners, observers,
                                        // GL resources, context loss handlers
status() → { tier, post, count, max, running }   // cheap, production-safe
debugReadState() → { positions, velocities }     // TEST ONLY: gl2, sizes ≤ 64²,
                                                 // readback; available only when the page
                                                 // was loaded with ?debug=1, else throws
```

`setQualityBias` (vestigial, no caller) is deleted from both engines.

## GPGPU core (`src/gl2.js`)

**State**: two ping-pong FBO pairs of RGBA32F textures, size N×N,
N ∈ {256, 384, 512, 768, 1024}, NEAREST, no mips:

- `position`: xyz world + w = free channel (reserved; particle seed is
  `hash(gl_VertexID)` computed in-shader, not stored)
- `velocity`: xyz + w = grab state (0 = free, 1 = grabbed; while
  grabbed, xyz is **repurposed as the captured offset** — see Grab)

**Sim pass**: one MRT fragment draw per frame (GLSL ES 3.00), writing
next position + velocity. **Render pass**: one `GL_POINTS` draw,
vertex shader fetches `texelFetch(position, ivec2(id % N, id / N))`
via `gl_VertexID` (GLSL ES 3.00). Post pipeline (persistence, bloom,
aberration, vignette) ported from gl.js (GLSL ES 1.00 remains valid on
a WebGL2 context). No per-frame CPU uploads.

### Numerical invariants (the "reassembly always wins" contract)

- **Integration**: semi-implicit Euler — `v ← v + F·dt` then
  `p ← p + v·dt`.
- **Damping is time-based**: `v *= exp(-k_drag · dt)` — identical
  behavior at 60/120/144 Hz. No per-frame multipliers anywhere.
- **dt clamp**: `dt = min(frameDelta, 1/30)`; after tab-resume /
  suspension, accumulated excess time is discarded (no catch-up
  substeps). Max 1 sim step per frame.
- **Caps**: `|F| ≤ F_max`, `|v| ≤ v_max` (clamped in-shader).
- **Finite-value recovery**: any non-finite or out-of-bounds
  (‖p‖ > 4 world units) particle resets to its current formation
  target with v = 0, same frame.
- **Grab release is unconditional** on: `pointerup`, `pointercancel`,
  `lostpointercapture`, `blur`, `visibilitychange→hidden`, context
  loss, tier teardown. A grab can never outlive its pointer.
- **Forces**, in order: formation spring `k_f(seed) · (target − p)`
  (per-particle stagger via k_f), curl-noise turbulence scaled by
  excitement, cursor force (radial falloff, scaled by pointer speed),
  grab spring (replaces formation spring while grabbed), then damping.

**Acceptance invariant (tested via debug readback at small sizes, and
by silhouette screenshot at full size)**: after grab release with no
further input, ≥ 99% of particles are within ε = 0.01 world units of
their targets within T = 3 s, at every supported N and at simulated
frame intervals of 1/144, 1/60, and 1/30 s.

## Grab & tear

- **Capture on the pointerdown edge only**: a `grabEdge` uniform is 1
  for exactly one sim step. During that step, particles whose
  *projected* position lies within radius R of the pointer set
  `velocity.w = 1` and store `velocity.xyz = p − grabAnchor` (their
  world-space offset from the grab point). The clump membership never
  grows while dragging.
- **Capture math (projected screen-space)**: project p by the current
  view-projection matrix, divide by w, compare NDC-space distance to
  the pointer's NDC position (aspect-corrected); R defined in CSS px,
  converted once per frame. Depth is preserved: the grab target for a
  particle is `unproject(pointerNDC, capturedDepth) + offset`, so a
  torn clump keeps its shape and its depth.
- **While grabbed**: formation spring off; strong spring toward
  (grab target); turbulence reduced inside the clump.
- **Release**: flags cleared by uniform broadcast; release velocity =
  filtered pointer velocity (EMA over ~80 ms) + small seed-hash jitter
  — the fling matches the hand's motion. Formation spring resumes;
  the invariant above takes over.
- **Touch**: displacement force only, no grab (the finger occludes the
  effect; stirring reads better). **Reduced-motion**: no grab, no
  turbulence, no parallax; see Reduced motion.
- Keyboard/type-mode contract from DESIGN.md is unchanged.

## Depth & camera

World box ≈ [-1,1]³. Perspective camera; parallax offset lerped from
scroll + pointer, amplitude ≤ 0.08 world units (a lean, not a
fly-through). Wordmark and type-mode text stay near-planar with
shallow z jitter; terrain/sphere/phone/curve become volumetric.
Point size attenuates with depth. Reduced-motion: fixed camera.

## Crisp-lock

CPU-side `excitement ∈ [0,1]`, no readback: driven up by morph starts,
grabs, pointer speed, scroll velocity; exponential decay τ ≈ 1.2 s.
Drives: turbulence amplitude, trail persistence, bloom mix, aberration,
point sharpness.

**Settle mechanism (per-particle, in-shader)**: below
`excitement < 0.05`, turbulence is exactly zero, spring gain rises
slightly, damping rises, and a deadband applies — if
`‖target − p‖ < ε_snap` and `‖v‖ < v_snap`, then `p ← target, v ← 0`.
ε_snap small enough to be invisible (≤ ~0.5 device px at default
camera). **MUST**: a settled formation is legible as type — post-fx
near zero, points crisp, positions *actually converged*, not merely
rendered sharply.

## Formations & targets

- **Correspondence is deterministic**: particle identity = texel index;
  formation targets are arrays indexed by the same particle index;
  sampling uses a fixed seed. Texel i in formation A corresponds to
  texel i in formation B, so `mix(targetA, targetB, staggeredProgress)`
  produces stable, untangled morphs. Stagger comes from
  `hash(gl_VertexID)`, not from either target's data.
- **Residency policy**: targets are kept as CPU Float32Arrays,
  regenerated at the governor's **current** N only. At most two target
  textures (A = current, B = next) are GPU-resident. Formation switch:
  generate/upload B (idle-time, before the transition starts), morph,
  then B becomes A and the old A's texture object is reused for the
  next B. No six-formation residency, no 16 MiB uploads mid-
  interaction.
- **Type mode**: text sampled from 2D canvas as today, capped at 120k
  text points; above the cap, remaining particles get **ambient dust**
  targets with rendering rules: lower max alpha, smaller points,
  reduced bloom contribution, depth range behind the text plane —
  the dust may never overwhelm the glyph silhouette.

## Governor (two-axis) and performance demotion

The frame budget has two dominant costs: simulation (∝ N²) and
fill-rate (post passes × resolution × DPR). The ladder degrades the
cheap-to-recover axis first:

1. Reduce aberration, then bloom quality (fewer taps).
2. Post pipeline at half resolution.
3. Cap render DPR at 1.5, then 1.0.
4. Step N down one size.
5. Post off entirely (direct render — existing tier-2 look).
6. **Demote to tier 2**: below 35 fps for 2 valid windows with N at
   floor and post off → `destroy()` tier 1, replace canvas, boot
   tier 2. Footer/status stay truthful throughout.

**States** (5 s measurement windows): *initial promotion* above the
baseline (desktop 512², mobile/Save-Data 256²) needs 2 consecutive
valid windows > 56 fps, one step at a time, max 1024²; *degradation*
on 1 bad window (< 40 fps) or immediately on a < 20 fps second;
*recovery* of a lost step needs 2 consecutive good windows; ≥ 5 s
cooldown after any transition or allocation. **Valid windows exclude**:
hidden tab, paused, first window after resume/restore, active resize
or allocation, < 60 presented frames. Metric: 10th-percentile frame
time, not average.

**Resize is deferred until idle**: only when pointer up ∧ no active
morph ∧ excitement < 0.1 ∧ ≥ 2 s idle. Resize re-seeds from current
formation targets at the new N and morphs in over 0.9 s. A resize can
therefore never destroy a tear or fling.

**GPU memory budget**: resident *sim* memory is bounded by the
residency policy — 4 state textures + 2 target textures × 16 B/texel =
96 MiB at 1024², 24 MiB at 512², 6 MiB at 256². Post framebuffers are
bounded separately by the DPR-cap and half-res rungs, not by N. During
resize, new allocations complete before old ones are freed only if the
estimated sim peak stays under 1.5× the current-N figure, otherwise
free-then-allocate with a fade. Upgrades are refused when the next N's
figure can't be established (allocation failure → step back down,
cooldown, no retry for the session).

## Context loss

`webglcontextlost`: preventDefault, pause, release any grab.
`webglcontextrestored`: rebuild all resources directly into the
*current* formation at the *current* governor size; failure → the
tier-2 replacement path. Footer status must reflect the stall
(existing `STATIC RENDER` / `RENDER DEGRADED` vocabulary) — never a
frozen `ALL SYSTEMS NOMINAL`.

## Reduced motion

Formations render and converge, then the engine **stops integrating**:
no RAF sim work while settled; re-render only on formation change,
resize, or scroll-driven camera need (which is disabled — fixed
camera — so in practice: on formation change). No turbulence, no grab,
no parallax, post minimal. Reduced-motion visitors get a crisp, calm,
near-static field that costs near-zero GPU.

## Truth machinery updates

- `claims.js`: `particle-budget` redefined — adaptive 65,536 →
  1,048,576, device-dependent, governor may sit anywhere in range
  (`dom: false`). `draw-calls` redefined: 1 render draw + 1 MRT sim
  pass per frame; post adds up to 4 fullscreen passes. HUD + console
  banner print the live current count.
- Boot log: `SEED particles` reports the actually seeded count of the
  booted tier; tier-1 compile line names the sim honestly.
- `DESIGN.md` → v2.2: engine section rewritten (tier table,
  interaction contract incl. grab/tear + capture math summary,
  crisp-lock MUST, camera bounds, two-axis governor, numerical
  invariants, memory budget). Size budgets → raw ≤ 512 KB,
  gzip ≤ 280 KB (tripwires; expected ≈ 240/110 KB). `check.py`
  constants updated.

## Design fixes shipped with Phase 1

1. **Hero affordance**: the keyboard invitation becomes a visible chip
   (hairline border, mono, orange bracket accents) under the headline
   block, present from reveal, subtle pulse (none under
   reduced-motion); still absent on touch.
2. **Orange in the scroll path**: the Proof header band (`ENGINEERED,
   NOT DECORATED.`) becomes a full-bleed signal-orange flood with ink
   type (computed contrast ≈ 5.9:1 — AA normal / AAA large; verify at
   implementation). The page's color peak stops being click-gated.
3. **Form grammar**: rectangular CTA (no pill), hairline-underline
   inputs, microcopy consolidated to one visible line + a native
   `<details>` disclosure carrying the full privacy text (all
   promises remain in the DOM for no-JS readers; privacy copy claims
   unchanged).

## Testing & verification

- **M0 spike gate (before any porting)**: the throwaway-canvas probe
  *is* the spike — run under headless SwiftShader it must prove the
  production shape listed in Boot §1 (MRT layout, both ping-pong
  directions, multi-step determinism, texelFetch render, destroy/
  recreate ×2 without leaks). If SwiftShader cannot run tier 1, the
  harness pivots: tier-1 correctness via the probe at tiny sizes
  wherever it *does* run, tier-2 regression headless, Dennis as the
  real-GPU reviewer. The spike decides which harness gets built.
- **Committed test suite** (`tests/`, graduating the scratchpad
  Playwright scripts; `build.sh --test` runs them):
  - Site smoke: boot log/tier line, claims↔DOM, dossiers, type mode,
    scroll, form incl. fast-submit confirm (existing coverage,
    committed at last).
  - Deterministic sim tests at N ≤ 64 via `debugReadState()`
    (`?debug=1`): zero-force particles hold position · spring
    convergence · damping invariance across dt ∈ {1/144, 1/60, 1/30}
    · capture only on pointerdown edge · clump membership constant
    while dragging · offsets stable · release clears every flag ·
    fling direction matches pointer velocity · ≥ 99%-within-ε-by-T
    invariant · injected NaN resets · dt = 5 s (fake resume) does not
    explode · no resize while grabbed · hidden-tab resume does not
    trigger emergency downgrade.
  - Failure-mode tests, each must reach the cleanup + tier-2 path:
    context creation returns null (stubbed) · extension missing
    (stubbed) · FBO incomplete (forced small internal format stub) ·
    shader compile failure (injected bad source via test hook) ·
    runtime context loss (`WEBGL_lose_context`).
- **Visual acceptance**: settle-time and convergence are numeric (via
  readback); silhouette legibility at rest is screenshot-diff
  best-effort against the target mask; Playwright video review for
  morph/tear/reassemble/crisp-lock remains mandatory but carries feel,
  not correctness.
- **Real hardware (Dennis, mandatory)**: trackpad feel, tear/fling,
  fps HUD across governor sizes, one mid-tier phone. Acceptance:
  ≥ 55 fps at the settled governor state; interaction feels immediate
  (subjective, Dennis judges).
- **Regression**: full `build.sh` green; reduced-motion,
  forced-colors, no-JS unchanged; tier 2 boots when tier 1 is denied
  at every failure point above.

## Risks

| Risk | Mitigation |
|---|---|
| SwiftShader lacks WebGL2 float/MRT | M0 probe gates; harness pivots per above |
| Late tier-1 failure strands the canvas | Throwaway-canvas probe + canvas replacement + `destroy()` |
| Fill-rate dominates at high DPR | Two-axis governor degrades post/DPR before particles |
| Fast-but-capable device trapped in bad tier 1 | Runtime demotion rule (35 fps floor) |
| Physics blow-up / NaN / stuck grabs | Numerical invariants section; tested with injected faults |
| GPU memory spikes on resize | Residency policy + budget + idle-only resize |
| Mobile thermals | 256² floor, Save-Data path, post-off rung, demotion |
| Scope creep toward Phase 2 | Non-goals list; terminal work rejected in review |

## Milestones (each independently verifiable)

- **M0** — probe/spike under SwiftShader; decides harness. No porting
  before this passes or pivots.
- **M1** — `gl2.js` core: formations render + morph at 512² behind a
  debug flag; boot/fallback/lifecycle chain (probe, replace, destroy)
  wired and failure-mode tested.
- **M2** — cursor force + grab/tear/fling + numerical invariants +
  deterministic sim tests green.
- **M3** — depth, perspective camera, parallax; ambient dust rules.
- **M4** — crisp-lock + settle deadband; two-axis governor + demotion;
  HUD/claims/boot-log truth updates.
- **M5** — design fixes (hero affordance, orange proof band, form
  grammar).
- **M6** — `tests/` committed + `build.sh --test`; DESIGN.md v2.2 +
  README; budgets updated; full verification pass; screenshots +
  videos packaged for Dennis's real-hardware review.

## Open decisions deferred to implementation

- Exact constants (k_f, k_drag, F_max, v_max, R, ε_snap, curl scale) —
  the spec fixes the models and invariants, not the numbers; tuned
  against video, then Dennis's hardware.
- Whether 1024² promotion ships enabled or flag-gated until real
  hardware data exists (governor + demotion make either safe; default
  conservative).
