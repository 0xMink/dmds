# Phase 1: The Engine Becomes Matter — GPGPU Physical Particle Engine

| | |
|---|---|
| **Date** | 2026-07-17 |
| **Status** | **Approved for implementation** (rev 3) — M0 capability gate passed under headless SwiftShader 2026-07-17 (36/36; `tests/m0-results.md`, artifact `tests/results/m0-swiftshader-2026-07-17.json`, gate commit `d0654c8`); real-GPU performance and interaction validation remain pending |
| **Owner** | Dennis Mink (@0xMink) |
| **Scope** | Phase 1 of the staged plan (physical engine → DMDS/OS terminal → playable layer). This spec covers Phase 1 only. |
| **Parent docs** | `DESIGN.md` v2.1 (this work bumps it to v2.2), `README.md` |
| **Freeze rule** | After rev 3, the spec changes only on findings produced by implementation evidence (M0+), not further prose review. |

## Goal

Replace the WebGL1 vertex-morphing particle engine as tier 1 with a
WebGL2 GPGPU physical simulation, keeping the current engine as tier 2.
The visitor must *feel* the engine within two seconds (the cursor
displaces particles like matter), discover the signature move (grab and
tear the wordmark; it always reassembles), and see the site
"crisp-lock" to sharp legibility at rest. Sim sizes: 512² = 262,144
default desktop, up to 1024² = 1,048,576 on strong GPUs, 256² = 65,536
mobile floor.

The metaphor is load-bearing: **tearing the formation apart and
watching it recover is the site's resilience thesis made tactile.**
"Reassembly always wins" is a numerical invariant (below), not a slogan.

## Non-goals (Phase 1)

- Terminal / DMDS-OS layer (Phase 2). Game layer (Phase 3).
- Photogrammetry operator portrait (separate; needs a scan from Dennis).
- Sound redesign beyond driving existing sfx intensity from excitement.
- External assets. Phase 1 stays fully self-contained.
- Rewriting the WebGL1 engine. `src/gl.js` remains **behaviorally
  unchanged**; minimal lifecycle additions are permitted (a `destroy()`
  that cancels its RAF loop, listeners, and observers; removal of the
  caller-less `setQualityBias`) so it can satisfy the common interface
  and the canvas-replacement path. No rendering or interaction changes.
- Half-float tier-1 *state*: if RGBA32F is not renderable, use tier 2.
  (Half-float positions jitter visibly at ≥1440px; tier 2 is a better
  experience than a shimmering tier 1. Targets are 16F — see formats —
  because they are read-only and their precision only needs to beat
  ε_snap.)
- Optimal-transport / assignment-solver formation correspondence —
  explicitly rejected as over-engineering; see Formations for the
  Morton compromise and its escape hatch.

## Tier ladder

| Tier | Requirements | Experience |
|---|---|---|
| 1 · `gl2` | WebGL2, `EXT_color_buffer_float`, probe passes (below) | GPGPU physical sim (this spec) |
| 2 · `gl1` | WebGL1 | Current shipped engine, behaviorally unchanged |
| 3 · `css` | No usable GL | CSS gradient atmosphere (unchanged) |
| 4 · `static` | No JS | Full content, dossiers expanded (unchanged) |

**Capability ≠ performance**: tier 1 has a runtime performance demotion
rule (see Governor) — a device that *can* run RGBA32F but can't run it
acceptably ends on tier 2, not trapped at tier 1's floor.

## Boot, fallback, and lifecycle

A canvas that has ever returned a WebGL2 context cannot later return a
WebGL1 context. Therefore:

1. **Probe on a throwaway canvas** (never the visible one), exercising
   the production shape, not extension presence: WebGL2 context →
   `EXT_color_buffer_float` → production-format textures at 4×4 →
   MRT FBO with the real 2-attachment layout → framebuffer complete →
   ≥3 sim steps through **both** ping-pong directions with known
   inputs → `readPixels` per attachment asserting expected values →
   vertex-stage `texelFetch` render lands expected pixels → RGBA16F
   target upload + sample round-trip → destroy and recreate twice,
   with every application-owned resource explicitly deleted and no
   duplicate RAF, listener, observer, or live engine instance (this
   does not claim to prove the absence of driver-level leaks). Any
   failure → tier 2, visible canvas untouched.
2. Probe passed → init `DMDS_GL2` on the visible canvas.
3. **Late-failure safety net**: if visible-canvas init fails anyway,
   `destroy()` the tier-1 attempt, **replace the canvas element** with
   a fresh clone (same id/attributes), init tier 2 on the replacement.
   The same path serves runtime performance demotion and
   context-restoration timeout.
4. Tier-2 failure → tier 3 (existing behavior).

Boot log names the real tier (truthful instrumentation):
`COMPILE sim + render … OK` (tier 1) vs `COMPILE vertex + fragment …
OK` (tier 2).

### Engine interface (both engines)

```
init(canvas, onMilestone) → Promise     // milestones: compile, post, seed(count), loop
setFormation(name | "text:S", duration)
setScroll(progress, velocity)
setPointer(x, y, down)                  // CSS px; engine handles DPR
isReady() / pause() / resume()
destroy()                               // full teardown: RAF, listeners, observers,
                                        // GL resources, context-loss handlers
status() → { tier, post, count, max, running }   // cheap, production-safe
debugReadState() → { positions, velocities }     // TEST ONLY: gl2, N ≤ 64, readback;
                                                 // available only under ?debug=1, else throws
debugConvergence() → { nearOut, finalOut, bad, maxDist }
                                        // TEST ONLY: gl2, any N; hierarchical GPU
                                        // reduction (below); ?debug=1 only
```

## GPGPU core (`src/gl2.js`)

### Texture formats (complete inventory)

| Texture | Count | Format | Size | Contents |
|---|---|---|---|---|
| position | 2 (ping-pong) | RGBA32F | N×N | xyz world; w = `DEPTH_FREE` sentinel (−2.0) or captured NDC depth |
| velocity | 2 (ping-pong) | RGBA32F | N×N | xyz velocity (or captured offset while grabbed); w = grab flag |
| target | 4 (prev/current/next/scratch) | RGBA16F | N×N | xyz target; w = 0 (stagger comes from the id hash, not stored) |
| scene color | 1 | RGBA8 | drawingbuffer × post rung | |
| persistence | 2 (ping-pong) | RGBA8 | same as scene | trails |
| bloom | 2 (ping-pong) | RGBA8 | ¼ scene | |
| reduction chain | log₂N levels | RGBA32F | N×N → 1×1 | `?debug=1` builds only |

RGBA16F targets are safe: binary16 spacing near |x| = 1 is ~0.001
(max rounding error ~0.0005), an order of magnitude below ε_snap = 0.01.

**Particle identity** — cross-stage invariant: the sim (fragment) pass
derives `id = uint(gl_FragCoord.y) * N + uint(gl_FragCoord.x)`; the
render (vertex) pass uses `gl_VertexID`; texel `(id % N, id / N)` in
every state/target texture belongs to particle `id`; both stages use
the same integer hash for the per-particle seed. `gl_VertexID` does
not exist in fragment shaders — the sim must never reference it.

**Passes per frame**: one MRT sim draw (GLSL ES 3.00, writes position +
velocity), one `GL_POINTS` render draw (GLSL ES 3.00 vertex fetch),
post passes. The existing GLSL ES 1.00 post shaders are reused only if
they compile and link under WebGL2 unchanged; otherwise they get
minimal ES 3.00 ports. No per-frame CPU uploads.

### Numerical invariants (the "reassembly always wins" contract)

- **Integration**: semi-implicit Euler — `v ← v + F·dt`, then
  `p ← p + v·dt`.
- **Damping is time-based**: `v *= exp(−k_drag·dt)`. No per-frame
  multipliers anywhere; identical behavior at 60/120/144 Hz.
- **dt clamp**: `dt = min(frameDelta, 1/30)`; accumulated excess after
  suspension is discarded; max 1 sim step per frame.
- **Caps**: `|F| ≤ F_max`, `|v| ≤ v_max`, clamped in-shader.
- **Finite-value recovery**: non-finite or out-of-bounds (‖p‖ > 60;
  see Depth & camera for the world scale this bound belongs to)
  particles reset to their current target with v = 0, same frame.
  The bound is unreachable by legitimate motion: V_max·dt_max caps
  travel at ~3 world units per frame and no formation exceeds
  radius ~20.
- **Grab release is unconditional** on `pointerup`, `pointercancel`,
  `lostpointercapture`, `blur`, `visibilitychange→hidden`, context
  loss, tier teardown. A grab can never outlive its pointer.
- **Forces** (free particles): formation spring `k_f(seedHash) ·
  (target − p)` (stagger via k_f), curl-noise turbulence × excitement,
  cursor force (radial falloff × pointer speed), damping.

**Acceptance invariant** — measured with the active target frozen and
no morph in progress: after grab release with no further input,
(a) ≥ 99% of particles within ε = 0.01 world units of target within
3 s, and (b) by 4 s, **100%** within 0.03 or individually snapped,
zero grab flags set, zero non-finite values — at simulated frame
intervals of 1/144, 1/60, 1/30 s; verified numerically at N ≤ 64 via
`debugReadState()` and at production N via `debugConvergence()`.

### Grab & tear — exact state transitions

| State | `position.w` | `velocity.xyz` | `velocity.w` |
|---|---|---|---|
| free | `DEPTH_FREE` (−2.0) | physical velocity | 0 |
| capture edge | captured NDC depth | `p − captureAnchor` (world offset) | 1 |
| held | unchanged | captured offset (unchanged) | 1 |
| release edge | `DEPTH_FREE` | filtered pointer velocity + seed jitter | 0 |

- **Capture on the pointerdown edge only**: a `grabEdge` uniform is 1
  for exactly one sim step; during it, particles whose projected
  position lies within radius R (CSS px, converted per frame) of the
  pointer in aspect-corrected NDC space transition to *capture edge*.
  Membership never grows while dragging.
- **Capture math**: `captureDepth = projectedPosition.z/w`;
  `captureAnchor = unproject(pointerNDC.xy, captureDepth)`;
  `offset = p − captureAnchor`. Each held frame reconstructs
  `grabTarget = unproject(currentPointerNDC.xy, position.w) + offset`
  — the clump keeps its shape and its depth through perspective.
- **Held motion is first-order, not a spring** (the velocity channels
  hold the offset, so there is no velocity state to integrate):
  `p += (grabTarget − p) · (1 − exp(−k_grab·dt))` — frame-rate
  independent, and a firmer read than a lagging spring.
- **Release happens in-shader on the same sim step that observes
  `grabActive = 0` with `velocity.w = 1`**: write the fling velocity
  (pointer velocity EMA over ~80 ms + seed-hash jitter), clear the
  flag, restore the depth sentinel. A stored offset is never
  interpreted as a physical velocity, not even for one frame.
- **Touch**: displacement force only, no grab. **Reduced-motion**: no
  grab, no turbulence, no parallax (see Reduced motion).
- Keyboard/type-mode contract from DESIGN.md is unchanged.

## Depth & camera

**World scale (rev 3.1 amendment, from M1 implementation evidence —
the freeze rule's intended path)**: tier 1 reuses tier 2's formation
generators at their native scale, not a unit cube. At CAM_Z = 26,
FOV = 35°, the visible half-extents are ≈ 14.6 × 8.2 world units at
16:9 (viewport-dependent); formations span radius ≲ 20. Derived
constants scale accordingly — **unit audit** (everything in world
units, wu; formation half-height ≈ 8 wu is the reference scale):

| Quantity | Value | Why |
|---|---|---|
| Formation envelope | viewport-dependent | largest generator is the ambient field at 1.15× the visible extents — half-width scales with aspect ratio (≈ 15 wu at 16:9, ≈ 34 wu at 32:9 ultrawide) |
| Interaction excursion margin | ≈ 31 wu beyond the envelope | force balance: max non-spring force (turb ≈ 110 + cursor ≈ 340) ÷ min spring gain (≈ 14/s²·wu) — an approximate static equilibrium, so a safety margin rides on top; the spring, not the velocity cap, is what bounds position |
| OOB recovery bound | **derived at runtime**: max(60, ambient corner radius + 31 excursion + 10 safety) | a fixed bound is not viewport-safe — at 32:9 the ambient corner alone reaches ≈ 36 wu and legitimate interaction would cross a fixed 60; recomputed on resize, uniform to the sim shader; verified at portrait / 16:9 / ultrawide |
| V_max / F_max | 90 wu/s / 900 wu/s² | caps ≈ 4.5×/2× the strongest legitimate demand |
| ε_snap | 0.012 | ≈ 0.5 device px at default camera |
| Parallax amplitude | **fixed at M3**: pointer ±0.4 (x) / ±0.2 (y) wu, scroll ±0.3 wu — combined ≲ 0.65, lerped at 4/s; zero under reduced motion | camera truck in view space; sim and render share the same per-frame matrices so capture math never diverges from the drawn image |

NOTE: a per-frame displacement cap (V_max·dt ≤ 3 wu) bounds *speed*,
not position — recovery-time arguments must integrate over the window
(V_max × t), and spatial-bound arguments must use the force balance
above. M2's fling constants are chosen against this table, not the
retired unit-cube numbers.

**M2 acceptance condition — excursion margin recomputed with the grab
model** (the 31 wu margin predates grab dynamics and must not silently
become permanent): (a) *held* motion is first-order convergence toward
`unproject(pointer, capturedDepth) + offset` — monotonic, no
overshoot; the pointer is viewport-bounded, so a held clump stays
within the ambient corner + capture offset (≤ ~5 wu) — inside the
existing envelope. (b) *release* is ballistic under exponential drag:
excursion = v₀/k_drag with v₀ clamped to 0.8·V_max = 72 wu/s →
72/5.2 ≈ 13.9 wu, plus seed jitter ≤ ~1 wu, while the spring pulls
inward concurrently — worst case ≈ 15 wu beyond the release point,
< 31. **The 31 wu margin therefore remains sufficient under the M2
model**; verified empirically by the fling-excursion test (max radius
during fling stays under the derived bound). The earlier "[−1,1]³ / ‖p‖>4" wording
described a normalization the implementation, correctly, did not
adopt — sharing generator space with tier 2 keeps the two tiers'
formations identical.

Perspective camera; parallax lerped from scroll +
pointer, amplitude per the unit-audit table (fixed at M3 — the retired
unit-cube 0.08 does not apply). Wordmark/type text near-planar
with shallow deterministic z jitter; terrain/sphere/phone/curve
volumetric. Point size attenuates with depth. Reduced-motion: fixed
camera.

## Crisp-lock

CPU-side `excitement ∈ [0,1]`: driven up by morph starts, grabs,
pointer speed, scroll velocity; exponential decay τ ≈ 1.2 s. Drives
turbulence, trail persistence, bloom mix, aberration, point sharpness.

**Settle mechanism (per-particle, in-shader)**: below excitement 0.05,
turbulence is exactly zero, spring gain and damping rise, and a
deadband applies: if `‖target − p‖ < ε_snap` and `‖v‖ < v_snap`, then
`p ← target, v ← 0` (ε_snap ≤ ~0.5 device px at default camera).
**MUST**: a settled formation is legible as type — positions actually
converged, not merely rendered sharply.

## Formations & targets

- **Correspondence**: particle identity = texel index; all formations
  indexed by the same id; morph = `mix(targetA, targetB,
  staggeredProgress)` with stagger from the id hash. Deterministic and
  stable; *spatial coherence* comes from Morton ordering (below), and
  the curl advection that peaks mid-transition masks residual
  crossings (five site versions of evidence with naive ordering).
- **Morton ordering, precisely**: every formation's samples are
  normalized into the shared unit cube, quantized at 10 bits/axis,
  sorted by Morton code, ties broken by original sample index; planar
  formations apply their deterministic z jitter *before* quantization;
  the ordering is recomputed independently at each governor N.
  **Escape hatch**: a specific formation pair may override the
  strategy if video review shows tangling; assignment solvers remain
  out of scope.
- **GPU residency — four slots**: `prev`, `current`, `next` are pinned
  to the scroll order; `scratch` serves hover and type-mode targets.
  `current` is never evicted. A morph cannot start until its target's
  upload completes. Rapid requests collapse to the newest. Scroll
  reversal is always resident by construction; jumps > 1 formation
  upload into `next` (or `scratch` if a temporary is active) before
  morphing.
- **CPU cache & budget**: CPU Float32Arrays (xyz, 12 B/particle) are
  retained only for the GPU-resident neighborhood + 1 LRU spare +
  the current sampled-text cache — ≤ 5 arrays ≈ 60 MiB at 1024²,
  15 MiB at 512². Procedural formations (terrain, sphere, phone,
  curve) regenerate from their generators on demand; sampled ones
  (wordmark, type text) are re-sampled only on N change. Targets are
  generated at the governor's current N only.
- **Type mode**: text sampled from 2D canvas as today, capped at 120k
  text points; the remainder become **ambient dust**: lower max alpha,
  smaller points, reduced bloom contribution, depth range behind the
  text plane — dust may never overwhelm the glyph silhouette.

## Governor (two-axis) and performance demotion

Frame cost has two axes: simulation (∝ N²) and fill rate (post ×
resolution × DPR). Degradation order:

1. Reduce aberration, then bloom quality (fewer taps).
2. Post pipeline at half resolution.
3. Cap render DPR at 1.5, then 1.0.
4. Step N down one size (idle-deferred, below).
5. Post off entirely (direct render).
6. **Demote to tier 2**: p90 still failing for 2 valid windows with N
   at floor and post off → `destroy()`, replace canvas, boot tier 2.

**Metric**: p90 frame time per 5 s window (slow tail; lower is
better). Good: p90 < 17.9 ms. Bad: p90 > 25 ms. Emergency: rolling
1 s mean > 50 ms → skip rungs immediately.

**States**: initial promotion above baseline (desktop 512²,
mobile/Save-Data 256²) needs 2 consecutive valid good windows, one
step at a time, max 1024²; degradation on 1 bad window; recovery of a
lost step needs 2 consecutive good windows; ≥ 5 s cooldown after any
transition or allocation. **Valid windows exclude**: hidden tab,
paused, first window after resume/restore, active resize or
allocation, < 60 presented frames.

**Warm-up**: measurement begins after 30 presented steady-state frames
or 1 s after the render loop starts, whichever comes first — shader
compilation, first uploads, and first post-buffer allocation never
count against the page. **Startup fast path**: for the first 3 s after
warm-up, evaluate in 1 s windows and skip multiple rungs on severe
misses, then switch to normal 5 s hysteresis.

**Resize deferred until idle**: pointer up ∧ no morph ∧ excitement
< 0.1 ∧ ≥ 2 s idle. Resize re-seeds from current targets at the new N,
morphs in over 0.9 s. A resize can never destroy a tear or fling.

**Promotion gating**: stepping up to a larger N requires a successful
trial allocation of the new state + target set; failure → step back,
cooldown, no retry this session. Sim-texture memory by N (4×RGBA32F
state + 4×RGBA16F targets): **96 MiB @ 1024², 24 MiB @ 512²,
6 MiB @ 256²**; post buffers are bounded separately by the DPR/half-res
rungs. During resize, allocate-before-free only when the transient
peak (old + new sim set) is acceptable — otherwise free-then-allocate
with a fade.

## Context loss

`webglcontextlost`: preventDefault, pause, release any grab.
`webglcontextrestored`: rebuild into the current formation at the
current governor size. **No restoration within 4 s → canvas
replacement → tier 2.** Footer status reflects the stall throughout —
never a frozen `ALL SYSTEMS NOMINAL`.

**Commands during loss (rev 3.1 amendment, from M3 review)**: formation
requests issued while the context is lost update CPU state only (GL
uploads are no-ops on a lost context); restoration materializes the
**newest** requested formation — earlier requests are never
resurrected — and **invalidates the scrub-pair cache**, so a
post-restore `setMorphPair` with the pre-loss pair re-uploads instead
of hitting the same-pair guard and scrubbing between two copies of one
formation.

## Reduced motion

Formations render and converge; after the last formation change the
engine simulates T = 3 s, issues one final settle/snap pass, and
**stops its RAF loop** (CPU-visible criterion — no readback needed).
Re-render on formation change only. No turbulence, grab, or parallax;
post minimal; near-zero GPU at rest.

## Verification instrumentation

**Hierarchical GPU reduction** (`debugConvergence()`, `?debug=1`
builds): pass 1 maps state → an N×N RGBA32F record per particle:
R = outside-ε_near (0/1), G = outside-ε_final (0/1), B = grabbed-or-
non-finite (0/1), A = distance to target. Then repeatedly reduce 2×2
blocks (sum RGB, max A) into half-size textures until 1×1; read back
one texel. Float32 represents integers exactly to 2²⁴, far above
1,048,576. WebGL2 fragment shaders have no global atomics; this is the
mechanism, not an intention.

## Truth machinery updates

- `claims.js`: `particle-budget` → adaptive 65,536–1,048,576,
  device-dependent, governor may sit anywhere in range (`dom: false`).
  `draw-calls` → 1 render draw + 1 MRT sim pass per frame; post adds
  up to 4 fullscreen passes. HUD + console banner print the live
  count.
- Boot log: `SEED particles` reports the actually seeded count of the
  booted tier; tier-1 compile line names the sim honestly.
- `DESIGN.md` → v2.2: engine section rewritten from this spec
  (tier table, interaction contract, crisp-lock MUST, camera bounds,
  two-axis governor, numerical invariants, memory policy). Size
  budgets → raw ≤ 512 KB, gzip ≤ 280 KB (tripwires; expected
  ≈ 240/110 KB). `check.py` constants updated.

## Design fixes shipped with Phase 1

1. **Hero affordance**: keyboard invitation becomes a visible chip
   (hairline border, mono, orange bracket accents) under the headline
   block, present from reveal, subtle pulse (none under
   reduced-motion); still absent on touch.
2. **Orange in the scroll path**: the Proof header band (`ENGINEERED,
   NOT DECORATED.`) becomes a full-bleed signal-orange flood with ink
   type (computed contrast ≈ 5.9:1 — AA normal / AAA large; verify at
   implementation). The page's color peak stops being click-gated.
3. **Form grammar**: rectangular CTA (no pill), hairline-underline
   inputs, microcopy consolidated to one visible line + a native
   `<details>` disclosure with the full privacy text (all promises
   remain in the DOM for no-JS readers; privacy claims unchanged).

## Testing & verification plan

- **M0 spike gate (before any porting)**: the throwaway-canvas probe
  of Boot §1, run standalone under headless SwiftShader, plus the
  RGBA16F round-trip and destroy/recreate discipline. Results recorded
  per environment (SwiftShader now; Dennis's hardware at M2+). If
  SwiftShader cannot run tier 1, the harness pivots: probe-level
  correctness wherever a conformant context exists, tier-2 regression
  headless, Dennis as the real-GPU reviewer. The spike decides which
  harness gets built. **Architecture changes only if M0 falsifies a
  declared assumption.**
- **Committed test suite** (`tests/`, graduating the scratchpad
  Playwright scripts; `build.sh --test`):
  - Site smoke (existing coverage, committed at last): boot log/tier,
    claims↔DOM, dossiers, type mode, scroll, form incl. fast-submit.
  - Deterministic sim tests at N ≤ 64 via `debugReadState()`:
    zero-force hold · spring convergence · damping invariance across
    dt ∈ {1/144, 1/60, 1/30} · capture only on pointerdown edge ·
    membership constant while dragging · offsets stable · release
    clears every flag in the release pass · fling matches pointer
    velocity · the two-tier convergence invariant · injected NaN
    resets · dt = 5 s fake resume does not explode · no resize while
    grabbed · hidden-tab resume triggers no emergency downgrade.
  - Production-N convergence via `debugConvergence()` at the largest N
    the environment supports.
  - Failure-mode tests, each must reach cleanup + tier 2: context
    creation null (stub) · extension missing (stub) · FBO incomplete
    (stub) · shader compile failure (injected source) · runtime loss
    (`WEBGL_lose_context`) · restoration timeout (loss without
    restore).
- **Visual acceptance**: settle-time/convergence numeric (above);
  silhouette legibility at rest via screenshot-diff best effort;
  Playwright video review of morph/tear/reassemble/crisp-lock remains
  mandatory but carries feel, not correctness.
- **Real hardware (Dennis, mandatory)**: trackpad feel, tear/fling,
  fps HUD across governor states, one mid-tier phone. Acceptance:
  ≥ 55 fps at the settled governor state; interaction feels immediate
  (subjective).
- **Regression**: full `build.sh` green; reduced-motion,
  forced-colors, no-JS unchanged; tier 2 boots at every failure point.

## Risks

| Risk | Mitigation |
|---|---|
| SwiftShader lacks WebGL2 float/MRT | M0 gates; documented harness pivot |
| Late tier-1 failure strands the canvas | Throwaway probe + canvas replacement + `destroy()` |
| Fill rate dominates at high DPR | Two-axis governor degrades post/DPR before particles |
| Capable-but-slow device stuck in tier 1 | Runtime demotion rule |
| Physics blow-up / NaN / stuck grabs | Numerical invariants + injected-fault tests |
| Offset-as-velocity release bug | Same-pass release transition (specified) |
| GPU/CPU memory spikes | Format table, 4-slot residency, CPU cache budget, trial-allocation gating, idle-only resize |
| Mobile thermals | 256² floor, Save-Data, post-off rung, demotion |
| Startup stall punished by governor | Warm-up exclusion + fast path after warm-up only |
| Scope creep toward Phase 2 | Non-goals; terminal work rejected in review |

## Milestones

- **M0** — probe/spike under SwiftShader; record results; decides
  harness. No porting before this passes or pivots.
- **M1** — `gl2.js` core: formations render + morph at 512² behind a
  debug flag; boot/fallback/lifecycle chain wired and
  failure-mode tested.
- **M2** — cursor force + grab/tear/fling; numerical invariants;
  deterministic sim tests green.
- **M3** — depth, camera, parallax; ambient dust rules.
- **M4** — crisp-lock + settle; two-axis governor + demotion;
  HUD/claims/boot-log truth updates.
- **M5** — design fixes (hero affordance, orange proof band, form).
- **M6** — `tests/` + `build.sh --test`; DESIGN.md v2.2 + README;
  budgets; full verification pass; screenshots + videos packaged for
  Dennis's real-hardware review.

## Open decisions deferred to implementation

- Exact constants (k_f, k_drag, k_grab, F_max, v_max, R, ε_snap, curl
  scale) — models and invariants are fixed; numbers tuned against
  video, then Dennis's hardware.
- Whether 1024² promotion ships enabled or flag-gated until real
  hardware data exists (governor + demotion + trial allocation make
  either safe; default conservative).
