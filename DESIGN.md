# DMDS® Design System

| | |
|---|---|
| **Version** | 2.1 (design system) |
| **Date** | 2026-07-17 |
| **Owner** | Dennis Mink (@0xMink) |
| **Scope** | The DMDS studio site (`src/` → `build.sh` → one self-contained `dist/index.html`) |
| **Describes** | Site implementation v6 — "version" elsewhere in this doc means the site version |
| **Enforcement** | `scripts/check.py`, run by every build — claims, glyphs, CSP, provenance, size budgets |

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
- **Clock**: `Intl` supplies the zone label, so it reads `EST` or `EDT`
  correctly across daylight-saving transitions. **MUST** never hardcode a
  zone abbreviation.
- **Footer status**: reads the renderer's actual state —
  `ALL SYSTEMS NOMINAL` (full budget) / `RENDER DEGRADED · CORE NOMINAL`
  (governor has cut the particle budget) / `STATIC RENDER · CONTENT
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

| Token         | Value                   | Usage                                  |
| ------------- | ----------------------- | -------------------------------------- |
| `--ink`       | `#0b0b0c`               | Page ground                            |
| `--ink-2`     | `#131315`               | Loader panels, inputs, raised surfaces |
| `--bone`      | `#edeae3`               | Primary text (≈16.4:1 on ink)          |
| `--bone-dim`  | `rgba(237,234,227,.52)` | Secondary text (≈4.9:1 — AA at 11px+)  |
| `--bone-faint`| `rgba(237,234,227,.28)` | **Decorative/`aria-hidden` only** (≈2.2:1) |
| `--signal`    | `#ff4a00`               | THE accent — test-equipment orange     |
| `--signal-hot`| `#ff6b2b`               | Reserved hot variant                   |
| `--line`      | `rgba(237,234,227,.13)` | Hairlines (decorative)                 |

- **MUST**: meaningful text uses `--bone` or `--bone-dim`, never
  `--bone-faint` (it fails WCAG contrast; it exists for annotations that
  are also `aria-hidden` — coordinates, loader log, placeholders).
- **MUST**: `--line` never serves as the *sole* boundary of an
  interactive control — controls get text, fills, or focus rings too.
- One accent, spent deliberately: cursor, indices, hover floods, terminal
  punctuation (`.sig` — the period as a shipped deliverable), ~12% of
  particles (`step(0.88, mix)` in the fragment shader). Single-theme by
  design. Selection inverts: signal ground, ink text.

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
  intra-component 0.4–2.4rem).
- **Easing**: `--ease-out: cubic-bezier(.19,1,.22,1)` (reveals, cursor),
  `--ease-inout: cubic-bezier(.77,0,.175,1)` (panel wipes, floods).
  Durations: micro 0.25–0.35s · reveals 1–1.1s · floods 0.4–0.5s ·
  morphs 0.9–1.5s (2.2s first assembly).
- **Breakpoints** (max-width): **900** nav meta hides · **860** stat/dossier
  grids 4→2, proof grid collapses · **720** HUD/coords/engine-hint hide,
  cap layout unmirrors, work grid 3-col · **560** nav compacts (see
  Responsive), transmit grid 1-col.
- **Z-index layers**: 0 canvas · 10 content · 90 grain · 100 HUD ·
  200 nav · 250 cursor · 300 skip-link · 400 loader. **MUST**: new layers
  slot into this scale, no arbitrary values.
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
| 004 | Proof of Work | `ambient` | 0.38 |
| 005 | Operator | `text:0xMINK` | 0.8 |
| 006 | Work / dossiers | `ambient` | 0.32 |
| 007 | Contact / transmit | `logo` | 0.55 |

`data-formation` / `data-dim` drive the engine; per-section dim keeps
text legible over the field. **NOTE**: `0xMINK` is a handle, not a hex
literal. On desktop, non-text formations shift ±0.42 × half-width so
they sit beside the copy.

## The engine as instrument

42,000 particles (16,000 mobile / Save-Data), one `GL_POINTS` draw call,
GPU vertex-shader morphing between position buffers with per-particle
stagger. Three ways visitors operate it: **typing** on the hero (live
typesetting through the same canvas-sampling pipeline as the wordmark,
12-char buffer), **scrolling** (morphs scrubbed by scroll position via
`setMorphPair`, forward and backward), **hovering work rows** (the field
spells the project). Vertex shader: three-sine idle drift, curl advection
peaking mid-morph (`mix·(1−mix)·4`) so transitions swirl, world-space
mouse repulsion.

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
(frame-rate-independent decay `exp(−9·dt)`) → quarter-res two-pass bloom
→ composite with radial chromatic aberration, vignette, hash dither.
**NOTE**: "one draw call" refers to the particle field; the post pipeline
adds four fullscreen-quad passes, which are the dominant fill-rate cost —
the claim registry says so explicitly.

Degradation ladder — **MUST** preserve content at every rung:

1. Full: particles + post pipeline (desktop).
2. Direct: particles, no post (mobile, Save-Data, or any FBO/shader failure).
3. Static: no WebGL → CSS gradient atmosphere; all content readable.
4. No JS: dossiers render expanded, stats show real values, reveals
   don't hide anything (`html.js`-gated).

**Quality governor**: halves the particle budget when FPS < 40, restores
(doubling) only after two consecutive fast windows — drop fast, recover
slow, no oscillation. Floor: COUNT/4. Hidden tabs pause the loop, so no
polluted samples. `setBudget()` pins and locks the budget.
**WebGL context loss**: `webglcontextlost` pauses; `webglcontextrestored`
rebuilds every GPU resource from CPU-side state and resumes; a failed
restore falls to the static rung. **MUST**: context loss never blanks
content.

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
- **Scramble**: glyph decode on nav hover/focus. **Hover floods**:
  proof/work rows flood signal, content inverts to ink. **Magnetic CTA**:
  0.32× pointer follow. **Cursor**: dot + lagging ring with labels
  (VIEW / TRANSMIT), `pointer: fine` only. **Tab title**: blur swaps to
  `[ SIGNAL LOST ] — DMDS®`.
- Reduced motion collapses all of the above to near-static.

## Component states

| Component | Rest | Hover | Focus | Active/Open | Disabled/Fallback |
|---|---|---|---|---|---|
| Nav link | `--bone-dim` | `--bone` + scramble | ring + scramble | — | — |
| Work row (button-in-h3) | hairline row | flood, ink text, name slides, detail unfolds | `:focus-within` = hover + ring | `.open`: flood suppressed, arrow 45°, dossier region shown | no-JS: dossier expanded |
| Proof row | hairline row | flood, ink text | `:focus-within` flood | — | — |
| Chip (native radio) | hairline border | — | ring on span | signal border/text/tint | — |
| Input | `--ink-2`, hairline | — | signal border | `:user-invalid` red border | — |
| CTA | outlined pill | flood fills, arrow nudges | ring | TRANSMITTING… label | fallback → recovery row |
| SND toggle | `--bone-dim` OFF | `--bone` | ring | signal ON | hidden ≤560px |

## Conversion layer

- **Transmit form**: name / email / project chips / brief. Success
  (`[ SIGNAL RECEIVED ]`) shows **only** after the endpoint confirms
  HTTP 2xx. **MUST**: the visitor's message is never lost — on any
  failure the filled form stays, the draft persists in `localStorage`
  (restored on return, cleared on success), and the mailto fallback also
  reveals a copy-to-clipboard recovery row. **NOTE**: mailto is a
  *recovery path*, not guaranteed delivery — the site never claims
  otherwise.
- **Draft privacy**: drafts are timestamped and expire after 7 days
  (expired drafts are deleted on load, not restored); storage failures
  are swallowed (no draft on browsers that throw); nothing beyond the
  four field values is stored. **MUST**: the form's microcopy discloses
  that unsent text is kept on the device.
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
  translations** in the Proof table; nav becomes a solid blurred bar past
  the hero.

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

Enforced by `check.py` on every build; measured values as of v6:

| Metric | Budget | Measured |
|---|---|---|
| dist raw | ≤ 512 KB | ~321 KB (v6 + tier-1 GPGPU engine + governor) |
| dist gzip | ≤ 280 KB | ~130 KB |
| Requests on load | 0 | 0 — verified by artifact inspection + browser network test; with no endpoint configured, `connect-src 'none'` also makes requests *impossible* (CSP constrains destinations, it can't count requests) |
| Loader cap | ≤ 2.6 s | hard timeout |

**SHOULD** (test matrix, measured in DevTools/PageSpeed until automated):
LCP < 2.5s on mid-tier mobile · CLS < 0.02 · main-thread JS parse+exec
< 150ms desktop · steady-state ≥ 55fps desktop / ≥ 40fps mobile (below
which the governor is *expected* to act — that's it working, and the
footer says so).

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
  content drift; it is *consistency*, not proof of origin. **MUST**:
  release only artifacts emitted by `build.sh` — process discipline (and
  CI attestation, if the site ever gets CI), not something the artifact
  can prove about itself.
- **External links**: `rel="noopener"` on every `target="_blank"`.
- **Reproducibility**: the artifact is deterministic given the source
  tree, the resolved commit, the build timestamp (`SOURCE_DATE_EPOCH`
  overrides wall-clock time for pinned builds), and the build-tool
  versions — not "given the tree" alone, because the timestamp is an
  input by design.
- **NOTE — trademark**: the site uses ®. Confirm the DMDS registration
  is current before launch; if not registered, switch to ™ (launch
  checklist, README).

## Responsive & zoom

- Relative units (rem/clamp/vw) throughout; content reflows to 390px
  wide with zero horizontal overflow (tested).
- **MUST**: ≤560px keeps every nav jump link with ≥40px tap targets
  (padding, not font size, makes the target; measured 44px). The SND
  toggle and nav meta hide first; links never shrink below 0.625rem.
- **SHOULD**: page remains operable at 200% and 400% browser zoom
  (test matrix); absolute-positioned hero furniture may overlap before
  content does — content wins.

## Accessibility

- Semantic sections, skip link, visible focus rings, `aria-hidden` on all
  decorative layers, visually-hidden h1.
- **Disclosures**: native buttons wrapped in headings, `aria-expanded` +
  `aria-controls`, labelled regions. Focus stays on the button on
  toggle (APG accordion behavior).
- **Form**: native inputs and radios (visually-hidden `<input>` +
  styled span, `fieldset`/`legend`), native validation +
  `:user-invalid`, `role="status"` success/recovery messages.
- **Type mode**: announced via `role="status"` live region on entry and
  exit; never captures from interactive elements (contract above).
- **Reduced motion**: honored end-to-end (scroll, reveals, particles,
  loader, counters, grain).
- **Forced colors**: atmosphere layers removed, native cursor restored,
  flood pseudo-elements hidden so no state becomes invisible, manifesto
  fully lit, system colors respected.
- **No JS**: full content — dossiers expanded, real stat values, no
  hidden reveals, footer states `STATIC RENDER`.
- **Sound**: opt-in only, `aria-pressed`.

## Browser & feature matrix

Baseline: evergreen Chromium/Firefox/Safari (last 2 major). Every
capability is feature-detected, never UA-sniffed: WebGL1 (→ static
rung), `document.fonts` (→ resolve immediately), AudioContext (→ SND
hidden no-op), clipboard API (→ execCommand → manual copy), localStorage
(try/caught), `navigator.connection.saveData`, `pointer: fine`,
`prefers-reduced-motion`, `forced-colors`. IE/legacy: not supported; the
no-JS reading path is the floor.

## Test matrix

Before release (manual until automated): boot log lines correspond to
real events (throttle CPU to see reordering) · claims PASS in console ·
loader skips via click/Escape and never exceeds 2.6s+wipe · type mode:
activate, announce, Escape, idle-exit, blocked while a control has
focus · dossiers via mouse, Enter, and screen reader (button + region
semantics) · scroll acceptance list (Motion & scroll) · form: endpoint
success, endpoint failure → mailto + copy recovery + draft restore ·
reduced motion · forced colors · 200%/400% zoom · 390px viewport ·
no-JS render · WebGL blocked → static rung · `check.py` negative tests
(mutate a claim, a date, the dist — each must fail).

## Voice / copy rules

- Declarative, load-bearing sentences. "Engineered, not decorated."
- **MUST**: no unverifiable superlatives; quantitative claims come from
  the registry; qualitative claims ("every claim is load-bearing") are
  backed by the verification machinery that makes them checkable.
- HUD/system language stays in character everywhere — and stays *true*
  everywhere (see Truthful instrumentation).
- Plain-English translation lines accompany engineering claims for
  non-technical buyers.
