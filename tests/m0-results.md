# M0 probe results

Gate defined in `docs/superpowers/specs/2026-07-17-gpgpu-physical-engine-design.md`
(Boot §1 / Testing §M0). Run with `node tests/m0-run.js` (needs
playwright-core + headless chromium shell).

## Environment: headless SwiftShader (CI/dev rig)

| | |
|---|---|
| Date | 2026-07-17 |
| Renderer | ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero))), SwiftShader driver |
| Version | WebGL 2.0 (OpenGL ES 3.0 Chromium) |
| Result | **PASS — 36/36 checks, 3 full destroy/recreate cycles** |

Verified: WebGL2 context · `EXT_color_buffer_float` · RGBA32F state
textures at production layout · 2-attachment MRT FBO complete in both
ping-pong directions · 3 sim steps bit-exact vs CPU mirror (maxErr 0) ·
`position.w` sentinel preserved through the sim · vertex-stage
`texelFetch` via `gl_VertexID` renders to the expected pixel · RGBA16F
target upload/sample round-trip (maxErr 0) · zero GL errors · explicit
teardown of every application-owned resource, recreate ×2.

**Harness decision**: SwiftShader runs the full tier-1 shape — the
headless harness tests tier 1 directly; no pivot needed. Real-GPU
review (Dennis) still mandatory for feel and performance per spec.

**Probe defect found & fixed during M0** (probe bug, not a spec
assumption): a test particle placed at NDC (0,0) lands a 1px point on
the exact pixel-corner boundary (window 4.0,4.0) and rasterizes into
pixel (3,3), not (4,4). Test particles must target pixel centers
(NDC 0.125 → window 4.5). Carry this into gl2 sim tests: never assert
point coverage at pixel corners.

## Environment: real hardware (Dennis)

Pending — to be recorded at M2+ alongside feel review.
