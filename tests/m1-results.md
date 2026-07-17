# M1 results — tier-1 GPGPU core

Run: `node tests/m1-core.js` · Environment: headless SwiftShader ·
Date: 2026-07-17 · **PASS (13/13)**

## What M1 built

- `src/gl2.js`: WebGL2 GPGPU engine — RGBA32F position/velocity
  ping-pong behind 2 MRT FBOs, one sim pass + one render draw per
  frame; formation spring + turbulence + cursor force; semi-implicit
  Euler, `exp(-k·dt)` damping, dt clamp 1/30, force/velocity caps,
  non-finite/OOB reset-to-target, settle deadband; formations ported
  from gl.js at COUNT = N² (512² desktop / 256² mobile · Save-Data;
  `?debug=1&gl2n=` override); RGBA16F target pair; post pipeline
  reused (GLSL ES 1.00 compiles unchanged on the WebGL2 context);
  excitement scalar driving post intensity (first crisp-lock cut);
  `destroy()`, context-loss handlers with 4 s restore timeout hook.
- `src/main.js`: engine-agnostic boot chain — gl2 probe → init →
  on failure `destroy()` + **canvas replacement** → tier 2; boot log
  names the booted tier (`COMPILE sim + render` vs
  `COMPILE vertex + fragment`); all call sites use the selected
  engine handle.
- `src/gl.js`: behaviorally unchanged; `status()` gains
  `tier: "gl1"` (spec-permitted lifecycle/interface hook).
- `src/claims.js`: particle-budget and draw-calls rewritten
  tier-aware (registry may not drift behind the engine — MUST).
- Build: 260 KB raw / 112 KB gzip — inside even the pre-raise
  budgets. `check.py` covers gl2.js glyphs.

## Verified (SwiftShader)

- Tier-1 boots; log lines honest (`SEED particles … 16,384` at 128²;
  262,144 at production size); zero page errors under the strict CSP.
- Readback at N=64: all values finite, positions within bounds, depth
  sentinel intact, sim integrating (drift over 1.5 s ≈ 16 wu).
- Fallbacks: WebGL2 denied at creation → tier 2 boots (42,000 seeded,
  tier-2 log line); injected post-probe init failure → `destroy()` +
  canvas replacement → tier 2 boots. Both green.
- Visual: `m1-settled.png` — at excitement 0.04 the wordmark sits
  sharp and legible (crisp-lock behaving); `m1-tier1.png` shows
  mid-assembly. NOTE: at SwiftShader's ~6 fps the dt clamp runs the
  sim in slow motion by design (no catch-up substeps — spec), so
  assembly takes ~5× wall time there; real-GPU pacing needs Dennis's
  review.

## Carried forward (not yet done)

- Failure-mode stubs still missing: extension-missing, FBO-incomplete,
  runtime context loss, restore-timeout demotion (test exists for none
  of these yet — M2/M4 test work).
- Grab/tear (M2), depth+camera parallax (M3), two-axis governor +
  demotion + full crisp-lock contract + reduced-motion stop (M4),
  design fixes (M5), docs + suite consolidation (M6).
