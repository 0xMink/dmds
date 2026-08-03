# DMDS™ Design System

| | |
|---|---|
| **Version** | 2.2 (design system) |
| **Date** | 2026-08-02 |
| **Owner** | Dennis Mink (@0xMink) |
| **Scope** | The DMDS studio site (`src/` → `build.sh` → one self-contained `dist/index.html`) |
| **Describes** | Site implementation v7 — "version" elsewhere in this doc means the site version |
| **Enforcement** | `scripts/check.py` on every build (claims, glyphs, CSP, provenance, budgets) + the evidence suites in `tests/` (291 automated checks) + `tests/attest.sh` (release attestation) |

**v2.2 covers what v2.1 predated**: the tier-1 GPGPU engine and its
two-axis governor (M1–M4), the accessibility hardening round
(`--line-strong`, the legibility scrim, scramble labels, per-section
dim reductions), M5 (the signal band, the form grammar), boot-log
durability, and the promotion of the test matrix from a manual
checklist to an automated evidence-and-attestation system.

**Conformance labels.** **MUST** = invariant; the build or a review should
fail without it. **SHOULD** = expected unless a reason is recorded here.
**MAY** = optional enhancement. **NOTE** = rationale, not a rule.
Unlabeled prose describes the shipped implementation.

---

## Concept: _Proof of Work_

Every agency says "we build great things"; DMDS proves its claims with
inspectable work. The studio builds with formal specification, adversarial
review, and zero-trust patterns where the risk model warrants them (each
adjective is backed by a dossier, not asserted globally) — so the site is
framed as an **engineering document that happens to be beautiful**. Mono annotations
(`[ SEC.03 / PROOF OF WORK ]`, `FIG.01`, coordinates, live ET clock, FPS
readout), hairline rules, spec-sheet tables — the technical-poster language of
a place that measures things. The tone: sharp, declarative, zero beige.

The concept escalates in three moves:

1. **The engine is the demo** — a hand-rolled WebGL particle field
   (deliberately **not** three.js) that the visitor can operate.
2. **The claims are receipts** — every quantitative claim on the page lives
   in a versioned registry (`src/claims.js`) with a definition, source,
   verification method, and review date; work rows open *dossiers* of
   evidence; the boot sequence re-verifies the page against the registry
   in the visitor's own DOM.
3. **The studio is the engineer** — an Operator section names the one
   operator accountable for the work (not a claim of sole authorship —
   collaborators, upstreams, and dependencies exist), spelled by the same
   particle engine.

**MUST** — the technical language is never simulated. A status line that
says `OK` reports an event that actually completed; a gauge that shows a
number measured it. This is the design system's load-bearing rule; most
other MUSTs are instances of it.

## Truthful instrumentation

How the rule above is implemented:

- **Boot log**: the progress bar is a time-paced animation (it claims
  nothing); every *log line* is fired by the event it names —
  `MOUNT /typefaces (n/6)` by a per-face `document.fonts.load` check
  (`OK` only when all six faces resolved; otherwise `DEGRADED` —
  `fonts.ready` alone settles even on failure and doesn't earn an OK),
  `COMPILE` / `SEED` / `LINK render loop` by engine milestones with the
  actual particle count, `VERIFY claims↔DOM (n)` by the runtime
  consistency check (see below), `BOOT … READY` by load completion.
  Engine failure logs `FAIL` + `FALLBACK static field — ACTIVE`. A stall
  logs `TIMEOUT — CONTINUING`.
- **Boot log durability**: every log line is also mirrored into
  `window.DMDS_BOOTLOG` (append-only string array). The loader element
  removes itself ~1.1s after finishing, so the DOM copy of the log is
  ephemeral by design; the buffer is the durable record that tests and
  telemetry read. **NOTE** — this closed a first-commit-vintage race:
  whether a DOM read at engine-ready+2.5s beat `loader.remove()`
  depended on frame pacing, and a rendering-cost change flipped it.
  **MUST**: anything that needs boot-log contents after boot reads the
  buffer, not the loader's DOM.
- **Clock**: `Intl` supplies the zone label, so it reads `EST` or `EDT`
  correctly across daylight-saving transitions. **MUST** never hardcode a
  zone abbreviation.
- **Footer status**: reads the renderer's actual state —
  `ALL SYSTEMS NOMINAL` (full budget) / `RENDER DEGRADED · CORE NOMINAL`
  (governor has reduced quality or budget) / `STATIC RENDER · CONTENT
  NOMINAL` (no WebGL, and the no-JS default in markup).
- **FPS readout**: measured. **Console banner**: prints the actually
  seeded particle count after init.
- **Loader is skippable** (click or Escape) and hard-capped at 2.6 s —
  it MUST never hold usable content hostage.

## Claim registry

`src/claims.js` is the single source of truth for every quantitative
claim. Each entry: `page` (exact string shown), `text`, `definition`
(what would make it false), `source`, `verify` (how a third party checks
it), `verified` date, `review_by` date, `visibility`.

- **MUST**: every *static, claim-bearing* quantitative statement rendered
  as content carries `data-claim="<id>"` and matches its registry entry —
  checked at build (`check.py`) *and* at runtime (the loader's
  `VERIFY claims↔DOM` step; failures go to the console). Excluded:
  navigational identifiers (`W-01`, `FIG.02`, `SEC.03`), live
  measurements (FPS, particle count, scroll HUD), time/date displays,
  build metadata, and user input — those are instrumentation or chrome,
  governed by the truthful-instrumentation rule instead.
- **NOTE — what each verification tier proves**: *build verification*
  proves registry validity and freshness (`check.py`); the *runtime
  check* proves only that the rendered page is consistent with the
  embedded registry — it does not re-establish the underlying facts in
  the visitor's browser; the *evidence links* are how a visitor inspects
  the cited sources themselves. Copy and log lines **MUST NOT** imply a
  stronger tier than the one that ran.
- **MUST**: a claim past its `review_by` date fails the build. Re-verify
  the fact, then bump the date. Fast-drifting values (GitHub stars) get
  short windows.
- **MUST**: `visibility` is honest — `public` means visitor-verifiable
  (a link a stranger can click); `attestable` means privately verifiable,
  and the page says so (`PRIVATELY VERIFIABLE, REFERENCES ON REQUEST`).
- **SHOULD**: definitions pre-empt ambiguity ("templates" excludes
  scaffolding CLIs; "built in-house" excludes open-source dependencies;
  "0 external requests" is scoped to page load).
- Stat markup carries the real value as text (no-JS readers see the
  truth); JS resets to 0 and animates up to `data-count`. **MUST**: text
  and `data-count` agree (build-checked).

## Color

| Token          | Value                   | Usage                                  |
| -------------- | ----------------------- | -------------------------------------- |
| `--ink`        | `#0b0b0c`               | Page ground; text on signal (5.84:1)   |
| `--ink-2`      | `#131315`               | Loader panels, raised surfaces         |
| `--bone`       | `#edeae3`               | Primary text (≈16.4:1 on ink)          |
| `--bone-dim`   | `rgba(237,234,227,.52)` | Secondary text (≈4.9:1 — AA at 11px+)  |
| `--bone-faint` | `rgba(237,234,227,.28)` | **Decorative/`aria-hidden` only** (≈2.2:1) |
| `--signal`     | `#ff4a00`               | THE accent — test-equipment orange     |
| `--signal-hot` | `#ff6b2b`               | Reserved hot variant                   |
| `--line`       | `rgba(237,234,227,.13)` | Hairlines — **decorative only**        |
| `--line-strong`| `rgba(237,234,227,.4)`  | Interactive boundaries (≈3.33:1 — WCAG 1.4.11) |

- **MUST**: meaningful text uses `--bone` or `--bone-dim`, never
  `--bone-faint` (it fails WCAG contrast; it exists for annotations that
  are also `aria-hidden` — coordinates, loader log, placeholders).
- **MUST**: the boundary of an interactive control (input underlines,
  chip borders) uses `--line-strong` or stronger — ≥3:1 against the
  ground per WCAG 1.4.11. `--line` is for decorative hairlines only and
  never serves as the *sole* affordance of a control.
- One accent, spent deliberately: cursor, indices, hover floods, terminal
  punctuation (`.sig` — the period as a shipped deliverable), ~12% of
  particles. Single-theme by design. Selection inverts: signal ground,
  ink text.
- **The signal band** (v7): the proof-of-work stats strip is the page's
  **one** full-bleed solid-`--signal` surface — ink type on orange
  ground (5.84:1), hairline ink separators (`rgba(11,11,12,.3)`),
  selection inverted locally (ink ground, signal text). **MUST**: it
  stays singular. A second solid orange band would demote the accent to
  a theme; new emphasis spends the existing grammar (floods, indices)
  instead.

## Legibility over the field

Particles composite **additively** — dense regions of the field stack
toward white, so no per-section `data-dim` value can *guarantee* dark
ground behind text. Dimming shapes the field's average; it cannot bound
its maximum.

- Long-form text blocks that sit over the live canvas (manifesto,
  section heads, capability copy, operator body, proof rows, work
  details, contact copy, the transmit form) carry a **feathered ink
  scrim**: a `::before` layer behind the text (`inset: -1.4rem -2rem`,
  `rgba(11,11,12,.82)`, `blur(26px)`, `z-index: -1`) — a soft pool of
  ink, not a visible card.
- Rows with signal hover-floods set their scrim to `opacity: 0` while
  flooded — the flood is itself an opaque ground, and ink-under-orange
  would ring the edges.
- **MUST**: body text rendered over the live field sits on a scrim or an
  opaque surface. Per-section `data-dim` is an aesthetic control, not
  the contrast mechanism.
- **NOTE**: this rule was added after a human review caught dense
  particle formations washing out hero-adjacent text — automated
  contrast tooling samples static ground colors and cannot see an
  animated additive field. Contrast over the canvas is a design
  invariant, not an audit output.

## Type

- **Clash Display 500/600** — display voice, clamp()-fluid to 11rem.
- **General Sans 400/500** — body voice.
- **Space Mono 400/700** — instrument voice: annotations, nav, HUD, tags,
  dossier logs, footer. Uppercase, tracked +0.14em, 11px (`.mono`).
- **MUST**: mono UI text is ≥ 0.625rem (10px). The former 0.56rem sizes
  were retired for legibility.

All six faces are subsetted (~87 KB total) and embedded as data URIs.
**Glyph coverage is a build check, not a hope**: `check.py` parses the
actual woff2 cmaps and fails if the markup/styles/scripts use a glyph
that is neither embedded nor on the explicit system-fallback allowlist.
**NOTE**: the UI arrows (↗ ↘ → ↔) and scramble block glyphs (█▓▒░) are
*intentionally* left to the system fallback stack; their exact shape is
nonessential — the worst case is a differently-drawn arrow, never
meaning loss — and they sit in the visual-regression matrix.
The engine samples Clash Display itself (`document.fonts.load` gates
formation building), so particle typesetting and HTML headlines share a
face. **SHOULD**: layout shift is measured (CLS in the test matrix), not
assumed from inlining.

## Design tokens

- **Spacing**: `--pad: clamp(1.25rem, 4vw, 4rem)` is the horizontal
  module; vertical rhythm uses rem multiples (section padding 8–10rem,
  intra-component 0.4–2.4rem). Full-bleed elements (the signal band)
  escape the module with `margin: 0 calc(-1 * var(--pad))` and restore
  it as internal padding.
- **Easing**: `--ease-out: cubic-bezier(.19,1,.22,1)` (reveals, cursor),
  `--ease-inout: cubic-bezier(.77,0,.175,1)` (panel wipes, floods).
  Durations: micro 0.25–0.35s · reveals 1–1.1s · floods 0.4–0.5s ·
  morphs 0.9–1.5s (2.2s first assembly).
- **Breakpoints** (max-width): **900** nav meta hides · **860** stat/dossier
  grids 4→2 (the signal band goes 2×2 with corrected separators), proof
  grid collapses · **720** HUD/coords/engine-hint hide, cap layout
  unmirrors, work grid 3-col · **560** nav compacts (see Responsive),
  transmit grid 1-col.
- **Z-index layers**: 0 canvas · 10 content · 90 grain · 100 HUD ·
  200 nav · 250 cursor · 300 skip-link · 400 loader. **MUST**: new layers
  slot into this scale, no arbitrary values. (Scrims live at `z-index:
  -1` *within* their text block's stacking context — below the text,
  above the canvas.)
- **Content widths**: manifesto 20ch · descriptions 30–46rem ·
  form `min(40rem, 100%)`.

## Structural grammar

- **Section indices are navigation**: `001–007`, mirrored in the HUD,
  `data-index`, and `[ SEC.NN / NAME ]` heads. Dossier (`W-01`), proof
  (`P-01`) and figure (`FIG.01`) numbers are real references.
- **Hairline rules** separate sections; heads are mono label + stretched rule.
- **Ghost numerals**: stroked transparent 24rem indices behind capability
  sections; alternating sections mirror layout so the scroll zigzags.
- **Spec-sheet grids**: 1px-gap grids where the gap color is the border;
  tabular numerals throughout.
- **Grain**: SVG-noise overlay at 7% opacity (static under reduced
  motion, removed under forced colors).

## Page anatomy

| # | Section | Formation | Dim |
|---|---------------|-----------------|------|
| 001 | Hero / boot | `logo` | 1.0 |
| 002 | Manifesto | `ambient` | 0.7 |
| 003 | Capabilities ×4 | `grid` → `device` → `neural` → `curve` | 1.0 |
| 004 | Proof of Work (+ signal band) | `ambient` | 0.28 |
| 005 | Operator | `text:0xMINK` | 0.45 |
| 006 | Work / dossiers | `ambient` | 0.25 |
| 007 | Contact / transmit | `logo` | 0.3 |

`data-formation` / `data-dim` drive the engine; per-section dim keeps
the field's *average* legible over text (the scrim, above, bounds the
worst case). The reading-heavy sections (004–007) were dimmed further
in the accessibility round. **NOTE**: `0xMINK` is a handle, not a hex
literal. On desktop, non-text formations shift ±0.42 × half-width so
they sit beside the copy.

## The engine as instrument

Two tiers, feature-detected at boot (`gl2 → gl1 → static`):

**Tier 1 (`src/gl2.js`) — WebGL2 GPGPU physical simulation.** Particle
positions and velocities live in RGBA32F textures; a fragment pass
integrates real forces every frame — one MRT sim pass, one `GL_POINTS`
render draw. Sim sizes come from a ladder (`count = N²`): desktop
baseline **512² = 262,144** particles (floor 256², promotion ceiling
1024²); mobile / Save-Data pinned to [256², 384²]. The physics is
specified, not vibed (spec: `docs/superpowers/specs/2026-07-17-gpgpu-
physical-engine-design.md`): formation springs with per-particle
stagger, time-based exponential drag (`v·exp(−K_DRAG·dt)` — frame-rate
independent), force and velocity caps, dt clamp, and a settle deadband
that snaps converged particles. One GLSL stagger/hash definition is
injected into every shader that blends targets, so the per-particle
factor can never silently diverge between passes.

Visitors can **grab** the field (capture radius 160 CSS px — sized to
exceed the ~130px hover-repulsion crater, or a press would grab the
middle of its own evacuated hole), tear a clump off a formation, and
**fling** it (release velocity clamped to 0.8·V_max, per-axis seed
jitter). A depth channel (`position.w`) drives camera parallax
(amplitudes fixed by the spec's unit audit). **Typing** on the hero
typesets live through the same canvas-sampling pipeline as the wordmark
(glyph particles capped at 120,000; the remainder becomes dust).

**Tier 2 (`src/gl.js`) — WebGL1 buffer engine.** 42,000 particles
(16,000 mobile / Save-Data), GPU vertex-shader morphing between position
buffers with per-particle stagger, three-sine idle drift, curl advection
peaking mid-morph, world-space mouse repulsion. This was the site's
original engine; it remains the fallback when WebGL2 / float-texture
support is absent or tier 1 fails init or demotes.

Three ways visitors operate the field in either tier: **typing** on the
hero (12-char buffer), **scrolling** (morphs scrubbed by scroll position
via `setMorphPair`, forward and backward), **hovering work rows** (the
field spells the project).

### Engine state machine

| State | Entered by | Exited by |
|---|---|---|
| `intro-lock` | page boot | wordmark assembly complete (~2.3s after loader) |
| `scrub` | default | any manual grab |
| `manual-type` | accepted hero keystroke | Escape · 9s idle · scroll > 90px · leaving hero |
| `manual-hover` | work-row mouseenter | mouseleave · scroll > 90px |

**MUST**: every manual state has a non-interactive exit (timeout or
scroll reclaim) — the engine can never be wedged. Manual states record
`manualY0`; scrolling 90px from it returns control to `scrub`.

### Keyboard capture contract

Ambient capture is deliberately narrow. **MUST** hold all of:

- hero on stage (scroll < 0.6vh) and page loaded;
- no Ctrl/Alt/Meta, no IME composition (`isComposing`);
- focus not inside `input, textarea, select, button, a,
  [contenteditable]` — users operating controls are never intercepted;
- only the supported character set; space scrolls until typing is active;
- `preventDefault` only on keys actually consumed — never globally;
- visible capture indicator (the `>` readout + caret) **and** an
  `aria-live` announcement on activation and exit;
- Escape always exits.

## Rendering

Desktop post pipeline (hand-rolled, ping-pong FBOs): persistence trails
(frame-rate-independent decay) → reduced-res two-pass bloom → composite
with radial chromatic aberration, vignette, hash dither.
**NOTE**: "one draw call" refers to the particle field; the post
pipeline adds fullscreen-quad passes, which are the dominant fill-rate
cost — the claim registry says so explicitly.

Degradation ladder — **MUST** preserve content at every rung:

1. Tier 1: GPGPU simulation + post pipeline (desktop WebGL2).
2. Tier 2: buffer engine (WebGL1, or any tier-1 init failure/demotion);
   post pipeline where supported, direct rendering on mobile/Save-Data.
3. Static: no WebGL → CSS gradient atmosphere; all content readable.
4. No JS: dossiers render expanded, stats show real values, reveals
   don't hide anything (`html.js`-gated).

**Quality governor (tier 1) — two axes.** Axis 1: post/fill quality,
rungs 0–5 (bloom drops to eighth-res, then the backing store caps at
1.0 device px, then post turns off). Axis 2: sim size along the ladder,
where a resize is a **managed reinit deferred until idle** — never
mid-frame (a demotion inside the frame callback destroys the engine
under its own feet; found the hard way). Escalation order under
sustained low FPS: quality down → sim size down → post off → **tier-2
demotion** (one-way per page load). Improvement reverses the path;
promotion above baseline is desktop-only and gated on sustained
headroom, and a size that ever failed allocation is blocked from
promotion. Every decision is appended to a sequenced governor history
(`seq` disambiguates order where timestamps can't). Hidden tabs pause
the loop, so no polluted samples; reduced-motion runs a power stop.
**Tier 2 keeps its own simpler governor**: halve budget below 40 FPS,
restore only after two consecutive fast windows, floor COUNT/4.
**WebGL context loss** (both tiers): `webglcontextlost` pauses;
`webglcontextrestored` rebuilds every GPU resource from CPU-side state
and resumes; a failed restore falls down the ladder. **MUST**: context
loss never blanks content.

## Sound

Synthesized in-house, zero assets, **off by default** — the nav `SND`
toggle (`aria-pressed`) is the only way in; the context suspends on tab
hide. Drone (two detuned saws through a dark lowpass + bandpassed noise
bed, swelled by scroll velocity); SFX: morph whoosh, hover blip,
keystroke tick. **MUST**: sound never autoplays.

## Motion & scroll

**Scroll contract** — native scroll IS the scroll mechanism. Content
stays in normal document flow; desktop smoothing intercepts *wheel input
only* and eases the real scroll position via `window.scrollTo` each
frame. Anything else that moves the page — keyboard scrolling,
find-in-page, tab-focus auto-scroll, scrollbar drag, anchors, history
restoration — is detected as an external scroll and adopted, never
fought. Touch and reduced-motion get fully native scroll.

**MUST** (wheel interception limits): never intercept when Ctrl or Meta
is held (pinch-zoom, browser gestures) · never intercept
horizontal-dominant deltas (`|deltaX| > |deltaY|` stays native) · never
intercept over a scrollable sub-region that can consume the movement —
none exist on the page today; this rule guards any future one ·
normalize `deltaMode` (line/page → pixels) rather than assuming pixels.

**MUST** (acceptance tests for any scroll change): find-in-page reaches
matches · Tab brings focused elements into view · PgDn/space/arrows work
· scrollbar drag works · reload restores position · anchors land
correctly · opening a dossier re-measures geometry. **NOTE**: v2–v5
transformed a fixed-position wrapper, which silently broke tab-focus
scrolling and find-in-page; this section exists so that never returns.

- **Loader**: panel wipe exit; 2.6s hard cap; click/Escape skips;
  reduced-motion shortens the ramp; the bar closes with a minimum step so
  low frame rates can't stretch it.
- **Reveals**: clip-path line reveals + translate/fade, one-shot
  IntersectionObserver. **Manifesto**: per-word illumination by scroll.
- **Scramble**: glyph decode on nav hover/focus. **MUST**: scrambled
  elements carry an `aria-label` with their true text, set *before*
  listeners bind — screen readers announce at focus time, mid-animation,
  and must never read garbage glyphs.
- **Hover floods**: proof/work rows flood signal, content inverts to ink
  (plain-English lines darken to ≥5:1 on the flood). **Magnetic CTA**:
  0.32× pointer follow. **Cursor**: dot + lagging ring with labels
  (VIEW / TRANSMIT), `pointer: fine` only. **Tab title**: blur swaps to
  `[ SIGNAL LOST ] — DMDS™`.
- Reduced motion collapses all of the above to near-static.

## Component states

| Component | Rest | Hover | Focus | Active/Open | Disabled/Fallback |
|---|---|---|---|---|---|
| Nav link | `--bone-dim` | `--bone` + scramble | ring + scramble | — | — |
| Work row (button-in-h3) | hairline row | flood, ink text, name slides, detail unfolds | `:focus-within` = hover + ring | `.open`: flood suppressed, arrow 45°, dossier region shown | no-JS: dossier expanded |
| Proof row | hairline row | flood, ink text | `:focus-within` flood | — | — |
| Chip (native radio) | `--line-strong` hairline border | — | ring on span | checked: **solid signal fill, ink text** | — |
| Input / textarea | transparent ground, `--line-strong` bottom hairline | — | signal underline (border + 1px shadow = 2px rule) | `:user-invalid`: `#d4452c` underline | — |
| CTA | outlined **rectangle** (no radius — the page has no rounded corners) | flood fills, arrow nudges | ring | TRANSMITTING… label | fallback → recovery row |
| Fine-print disclosure (native `details`) | mono summary, `--bone-dim`, `+` affix | `--bone` | ring on summary | `[open]`: summary signal, content revealed | no-JS: browser-native disclosure still works |
| SND toggle | `--bone-dim` OFF | `--bone` | ring | signal ON | hidden ≤560px |

**Form grammar (v7).** Fields are hairline underlines on the scrim
ground — no boxes, no fills; the underline is the affordance
(`--line-strong`, so it meets 1.4.11), and focus answers in signal. The
checked chip is the one solid-signal control state on the page, echoing
the band. The CTA is rectangular: the pill radius was retired because
nothing else on the page curves.

## Conversion layer

- **Transmit form**: name / email / project chips / brief. Success
  (`[ SIGNAL RECEIVED ]`) shows **only** after the endpoint confirms
  HTTP 2xx. **MUST**: the visitor's message is never lost — on any
  failure the filled form stays, the draft persists in `localStorage`
  (restored on return, cleared on success), and the mailto fallback also
  reveals a copy-to-clipboard recovery row. **NOTE**: mailto is a
  *recovery path*, not guaranteed delivery — the site never claims
  otherwise.
- **Microcopy**: exactly **one visible line** under the CTA; everything
  else (privacy statement, draft-persistence disclosure, the direct
  email line) lives behind a native `<details>` disclosure
  (`[ PRIVACY & DIRECT LINE + ]`). **MUST**: the disclosure stays native
  `details/summary` — keyboard and no-JS behavior for free. **NOTE**:
  three stacked fine-print paragraphs read as a disclaimers pile and
  undercut the conversion moment; one line + a disclosure keeps the
  promises *available* without printing them all.
- **Draft privacy**: drafts are timestamped and expire after 7 days
  (expired drafts are deleted on load, not restored); storage failures
  are swallowed (no draft on browsers that throw); nothing beyond the
  four field values is stored. **MUST**: the form's microcopy (behind
  the disclosure) discloses that unsent text is kept on the device.
- **Abuse controls, client side**: honeypot + minimum-fill-time gate,
  where fill time is measured from first interaction. **MUST**: timing
  is a *risk signal, not proof* — a too-fast submit (autofill, paste,
  password managers are all legitimately fast) is never silently
  dropped; the button asks for one confirming press and the next press
  transmits. **MUST (endpoint contract)**: any configured `data-endpoint` API
  performs server-side validation (lengths, content), rate limiting, and
  origin checks — the client is not the abuse-control system.
- **Privacy**: stated on the form — one inbox, no third-party analytics,
  no tracking, no list. **MUST** stay true as long as it's printed.
- **Mid-page shortcut CTA** after Capabilities; **plain-English
  translations** in the Proof table; the **signal band** carries the
  four headline stats (registry-wired) as the section's exclamation
  point; nav becomes a solid blurred bar past the hero.

## Evidence dossiers

Work rows are `h3 > button` disclosures (`aria-expanded`,
`aria-controls`) opening labelled `role="region"` dossiers: case header,
4-up stat grid (registry-wired), summary, status-tagged ledger
(`MERGED` / `UPSTREAM` / `PROVEN` / `CHECKED` / `SHIPPED`), proof links.
An open row suppresses the hover flood so evidence stays readable.
**MUST**: dossier facts are registry entries — public ones link out;
private ones are labelled *privately verifiable*. **MUST**: disclosure
semantics stay native (real button, real region) — no `tabindex` +
`aria-expanded` on generic elements.

## Performance budgets

Enforced by `check.py` on every build; measured values as of v7:

| Metric | Budget | Measured |
|---|---|---|
| dist raw | ≤ 512 KB | ~334 KB (v7: both engine tiers + governor + instrumentation) |
| dist gzip | ≤ 280 KB | ~136 KB |
| Requests on load | 0 | 0 — verified by artifact inspection + browser network test; with no endpoint configured, `connect-src 'none'` also makes requests *impossible* (CSP constrains destinations, it can't count requests) |
| Loader cap | ≤ 2.6 s | hard timeout |

**SHOULD** (measured in DevTools/PageSpeed; not yet in the automated
suites): LCP < 2.5s on mid-tier mobile · CLS < 0.02 · main-thread JS
parse+exec < 150ms desktop · steady-state ≥ 55fps desktop / ≥ 40fps
mobile (below which the governor is *expected* to act — that's it
working, and the footer says so).

## Security & provenance

- **CSP**: build-generated `<meta http-equiv="Content-Security-Policy">`
  with `default-src 'none'` and SHA-256 hash allowlists for the exact
  inline style/script blocks — no `unsafe-inline` anywhere. `img-src
  data:; font-src data:; base-uri 'none'; form-action 'self'`.
  `connect-src` is derived by the build from the form's `data-endpoint`:
  `'none'` while no endpoint is configured, or exactly that endpoint's
  https origin once one is set — never a blanket `https:`. **MUST**:
  `check.py` re-derives the hashes from the artifact and fails on
  mismatch (also catches hand-edited dist).
- **No eval**, no string-built code, no inline event handlers.
  `innerHTML` appears at exactly three call sites, all with
  author-controlled strings (boot-log lines, scramble word-wrapping, the
  SND toggle label) — adding a fourth requires a security-review note
  here. `textContent` / DOM construction is the default everywhere else.
- **Provenance**: every artifact carries the git commit + UTC build time
  (`<meta name="dmds-build">` + trailing comment); a non-clean tree is
  stamped `-dirty` so a commit hash never misrepresents the source.
  **NOTE — what this proves**: CSP hash re-derivation detects post-build
  content drift; it is *consistency*, not proof of origin. Proof that
  the *served* artifact is the *tested* artifact is the attestation
  system's job (below).
- **External links**: `rel="noopener"` on every `target="_blank"`.
- **Reproducibility**: the artifact is deterministic given the source
  tree, the resolved commit, the build timestamp (`SOURCE_DATE_EPOCH`
  overrides wall-clock time for pinned builds), and the build-tool
  versions — not "given the tree" alone, because the timestamp is an
  input by design.
- **NOTE — trademark (resolved 2026-08-03)**: the site uses ™, not ® —
  no DMDS registration was found, and ® without registration is a
  misrepresentation this site's truth doctrine can't carry. ™ asserts
  common-law claim and is always lawful. If a registration issues,
  switch site-wide and re-subset or allowlist accordingly (™ currently
  renders via the system-fallback allowlist; the embedded subsets carry
  ® but not ™ and the font sources are not in the repo).

### Debug & telemetry surface

The shipped artifact contains the engine's test instrumentation, gated
behind query parameters: `?debug=1` enables the debug API (state
readbacks, fault injection, staged init failures, governor injection —
every debug function **throws** without the flag) and `?telemetry=1`
enables read-only observability getters with zero behavior change (used
for hardware retests, so the measured run IS the production experience).

**Decision (v2.2): no stripped production build.** Considered and
rejected, deliberately:

- The 291-check evidence suite and the attestation both bind to the
  exact dist bytes. A stripped variant forks "tested artifact" from
  "shipped artifact" — the attestation's core claim (*public bytes =
  attested bytes = tested bytes*) would silently weaken to "a sibling of
  the tested artifact".
- The gates are real: without the params, debug paths are unreachable
  (functions throw; injection branches never run) — there is no default
  behavior difference to remove.
- The debug surface exposes nothing sensitive: it reads and perturbs the
  visitor's own local simulation.
- Size is inside budget with margin (~334 of 512 KB).

**MUST**: debug/test hooks are honored only under an explicit query
flag, default-off, with zero behavior change when absent. **MUST**: the
attested artifact and the served artifact are the same bytes — any
future "production variant" proposal must answer for the fork above.

## Verification & evidence

What v2.1 listed as a manual pre-release checklist is now an automated
regime with three layers. (Manual checks that remain are listed at the
end.)

**1. Build verification** (`scripts/check.py`, run by every
`./build.sh`): claims↔page consistency, `review_by` freshness, stat
text↔`data-count` agreement, glyph coverage against the embedded woff2
cmaps, CSP hash re-derivation, provenance stamp, size budgets.

**2. Regression evidence** (`tests/run.sh` + four suites, headless
Chromium/SwiftShader against the built artifact):

| Suite | Checks | Covers |
|---|---|---|
| `m1-core` | 59 | boot, production shape, morph, numerical recovery, lifecycle, full fallback matrix |
| `m2-grab` | 55 | grab/tear/fling state machine + numerical invariants |
| `m3-depth` | 35 | camera parallax, reduced-motion camera, dust rules |
| `m4-governor` | 142 | two-axis governor, resize-as-reinit, demotion, reduced-motion power stop, status honesty |

`run.sh` is an *evidence runner*, not just a test runner: every run
appends a ledger entry (`tests/run-manifest.jsonl` — suite, check
counts, exit, git state) and archives the full gzipped log under
`tests/evidence/`, hash-linked from the ledger. `dirty` includes
untracked files; a tree that changes mid-run is refused (`tree_stable`).
Product failures are archived to `tests/failures/` — committed fire
history, because failures that led to fixes are evidence too.

**3. Release attestation** (`tests/attest.sh`): verifies that one
contiguous, same-batch, all-passing ledger group with the expected
suite/check inventory exists, that its evidence archives re-hash and
decompress correctly, and that `dist/index.html`'s bytes hash equal to
what an actual HTTP fetch of the served file returns — then issues
`tests/attestation.json` binding batch → runs → dist bytes → HTTP
boundary, atomically (lock, unique temp, fsync, rename) with all
attested inputs re-validated under the lock. The verifier is itself
verified: `tests/attest-acceptance.sh` fault-injects every declared
refusal predicate (35 cases) against a scratch replica, with a positive
control that reproduces the committed attestation byte-for-byte.

**MUST (release sequence)**: commit source → `./build.sh` → commit
`dist/` → full regression via `run.sh` (all four suites, one batch, on
the release-candidate commit, clean tree) → `attest.sh` → commit the
attestation *without rebuilding* → push. GitHub Pages deploys `dist/`
**verbatim** (no build step in the workflow — a CI build would break
the byte-equality claim), and the final step is fetching the public URL
past CDN cache and confirming its hash equals `dist_sha256` in the
attestation. **MUST**: if a suite's check count changes, the expected
inventory in `attest.sh` is updated *deliberately, in the same commit* —
that constant is the tripwire that catches silently vanishing checks.

**Manual checks that remain** (not yet automated): boot-log lines
correspond to real events under CPU throttle · type mode with a real
screen reader · form endpoint success/failure paths against a live
endpoint · reduced motion, forced colors, 200%/400% zoom by eye ·
real-hardware frame pacing (SwiftShader is a software rasterizer; it
proves logic, not feel) · axe-core + keyboard-walk + 320px-reflow audit
re-run after visual changes (tooling in scratch; 0 violations as of v7).

## Responsive & zoom

- Relative units (rem/clamp/vw) throughout; content reflows to 320px
  wide with zero horizontal overflow (tested — WCAG 1.4.10).
- **MUST**: ≤560px keeps every nav jump link with ≥40px tap targets
  (padding, not font size, makes the target; measured 44px). The SND
  toggle and nav meta hide first; links never shrink below 0.625rem.
- **SHOULD**: page remains operable at 200% and 400% browser zoom
  (test matrix); absolute-positioned hero furniture may overlap before
  content does — content wins.

## Accessibility

- Semantic sections, skip link, visible focus rings, `aria-hidden` on all
  decorative layers, visually-hidden h1.
- **Contrast**: audited against WCAG 2.1 AA — alpha-composited pairs
  computed, axe-core clean (0 violations), non-text contrast (1.4.11)
  met via `--line-strong`, and text-over-canvas bounded by the scrim
  (see *Legibility over the field* — the one class of contrast failure
  automated tools cannot see).
- **Disclosures**: native buttons wrapped in headings, `aria-expanded` +
  `aria-controls`, labelled regions. Focus stays on the button on
  toggle (APG accordion behavior). The form's fine print uses native
  `details/summary`.
- **Form**: native inputs and radios (visually-hidden `<input>` +
  styled span, `fieldset`/`legend`), native validation +
  `:user-invalid`, `role="status"` success/recovery messages.
- **Scramble targets** carry `aria-label` with the true text (set
  before listeners bind) so mid-animation announcement is never garbage.
- **Type mode**: announced via `role="status"` live region on entry and
  exit; never captures from interactive elements (contract above).
- **Reduced motion**: honored end-to-end (scroll, reveals, particles,
  loader, counters, grain; tier-1 engine runs a power stop).
- **Forced colors**: atmosphere layers removed, native cursor restored,
  flood pseudo-elements hidden so no state becomes invisible, manifesto
  fully lit, system colors respected.
- **No JS**: full content — dossiers expanded, real stat values, no
  hidden reveals, footer states `STATIC RENDER`.
- **Sound**: opt-in only, `aria-pressed`.

## Browser & feature matrix

Baseline: evergreen Chromium/Firefox/Safari (last 2 major). Every
capability is feature-detected, never UA-sniffed: WebGL2 + float
textures (→ tier 2), WebGL1 (→ static rung), `document.fonts` (→
resolve immediately), AudioContext (→ SND hidden no-op), clipboard API
(→ execCommand → manual copy), localStorage (try/caught),
`navigator.connection.saveData`, `pointer: fine`,
`prefers-reduced-motion`, `forced-colors`. IE/legacy: not supported; the
no-JS reading path is the floor.

## Voice / copy rules

- Declarative, load-bearing sentences. "Engineered, not decorated."
- **MUST**: no unverifiable superlatives; quantitative claims come from
  the registry; qualitative claims ("every claim is load-bearing") are
  backed by the verification machinery that makes them checkable.
- HUD/system language stays in character everywhere — and stays *true*
  everywhere (see Truthful instrumentation).
- Plain-English translation lines accompany engineering claims for
  non-technical buyers.
