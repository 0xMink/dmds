# DMDS® — studio site

Single-page studio site for DMDS (websites · apps · AI · marketing).
Fully self-contained: **zero external requests** — fonts, styles, and the
WebGL engine are all embedded. The entire site is one ~150 KB HTML file.

## Structure

```
src/
  index.html   markup — semantic, accessible, OG/meta complete
  styles.css   design system (ink / bone / signal-orange, Clash Display + General Sans + Space Mono)
  fonts.css    six subsetted typefaces as base64 woff2 data URIs (~87 KB)
  claims.js    claim registry — every number on the page, with definition,
               source, verification method, and review date
  gl.js        hand-rolled WebGL1 particle engine (no three.js)
  main.js      loader, smooth scroll, cursor, scramble, reveals, HUD
scripts/
  check.py     build verification: claims vs page, review dates, glyph
               coverage (parses the embedded woff2 cmaps), CSP hashes,
               provenance, size budgets — the build fails if any drift
build.sh       inlines everything, generates a hash-based CSP, stamps the
               commit + build time → dist/index.html, then runs check.py
DESIGN.md      the design system — concept, tokens, contracts (MUST/SHOULD),
               state machines, budgets, test matrix
dist/
  index.html   the deployable site — a single file, host it anywhere
```

## Build & deploy

```bash
./build.sh              # writes + verifies dist/index.html
python3 scripts/check.py  # verification alone (also run by build.sh)
```

Deploy `dist/index.html` to any static host (Vercel, Netlify, Cloudflare
Pages, S3, or a plain nginx root). No build pipeline, no dependencies,
no CDN, works from `file://`. Requires python3 (+ fontTools for the
glyph check; it degrades to a warning without it).

The artifact ships with a build-generated Content-Security-Policy
(`default-src 'none'`, SHA-256 hashes for the inline blocks — no
`unsafe-inline`; `connect-src` is derived from the form's
`data-endpoint`: `'none'` while unset, the exact API origin once set)
and a provenance stamp (`<meta name="dmds-build">` = commit + UTC time,
`-dirty` if the source tree wasn't clean; set `SOURCE_DATE_EPOCH` to pin
the timestamp for reproducible builds). The stamp names the source
commit the artifact was built **from** — so the honest flow is: commit
source → `./build.sh` → commit `dist/` separately (dist is excluded
from the dirty computation; a dist committed alongside its own source
could never carry a matching hash). If you hand-edit `dist/index.html`,
the CSP hashes stop matching and `check.py` fails — rebuild from `src/`
instead.

## Truth machinery (v6)

- **Claim registry**: `src/claims.js` holds every quantitative claim.
  The build fails if the page disagrees with the registry or a claim is
  past its `review_by` date; the loader's `VERIFY claims↔DOM` step
  re-checks page-vs-registry consistency in the visitor's DOM and
  reports PASS/FAIL honestly (the underlying facts are checked at build
  time and via the dossier evidence links, not in the browser).
- **Boot log tells the truth**: each loader line fires on the real event
  it names (typefaces loaded per-face — `6/6 OK` or `DEGRADED`, shaders
  compiled, particles seeded with the actual count, render loop linked).
  Failures log `FAIL` / `FALLBACK`. The loader is skippable
  (click / Escape).
- **Footer status is live**: `ALL SYSTEMS NOMINAL` / `RENDER DEGRADED ·
  CORE NOMINAL` (quality governor active) / `STATIC RENDER · CONTENT
  NOMINAL` (no WebGL / no JS). The clock reads EST/EDT correctly via Intl.
- **Native scroll**: smooth scrolling now eases `window.scrollTo` from
  wheel input instead of transforming a fixed wrapper — find-in-page,
  tab-focus, keyboard scrolling, scrollbar, history restoration all
  behave natively (the old approach silently broke them).
- **Accessibility hardening**: work rows are real `h3 > button`
  disclosures with `aria-controls` + labelled regions; dossiers render
  expanded without JS; type mode announces via a live region and never
  captures keys while a control has focus (or during IME composition);
  contrast floor raised (bone-faint is decorative-only now); 44px mobile
  nav targets; forced-colors support; WebGL context-loss recovery;
  Save-Data gets the light path.
- **Form resilience**: success only on confirmed 2xx; drafts persist in
  localStorage (timestamped, 7-day expiry, disclosed in the microcopy);
  the mailto fallback adds a copy-to-clipboard recovery row; honeypot +
  fill-time gate measured from first interaction — a too-fast submit is
  never silently dropped, it asks for one confirming press.

## Rendering & sound (v3)

- **Post-processing pipeline** (desktop): persistence buffer (motion trails),
  quarter-res two-pass bloom, radial chromatic aberration, vignette — all
  hand-rolled, ping-pong FBOs, frame-rate-independent trail decay
- **Fluid morphs**: curl advection peaks mid-transition so formations swirl
- **Synthesized sound** (SND toggle in nav, off by default): scroll-reactive
  drone, morph whooshes, hover blips, keystroke ticks — WebAudio, zero assets
- **Adaptive quality governor**: halves the particle budget if FPS drops,
  restores it when headroom returns
- `dist/og-image.png` — generated link-card image (set the absolute
  `og:image` URL in the head after deploy)

## The live engine (v2)

- **Type anything on the hero** — the keyboard is live; 42,000 particles
  typeset whatever the visitor types, in Clash Display, in real time
- **Scroll-scrubbed choreography** — formations morph with scroll position,
  forward and backward, like scrubbing a timeline
- **Work rows drive the engine** — hovering a project makes the field spell it
- Boot-sequence preloader; cursor labels (VIEW / TRANSMIT)

## The particle engine

- 42,000 particles (16,000 on mobile), one draw call, GL_POINTS
- Six formations: the **DMDS** wordmark (sampled from rendered type),
  ambient field, terrain grid (websites), phone (apps), neural sphere (AI),
  growth curve (marketing)
- Formations morph on scroll via GPU vertex interpolation with per-particle
  stagger; mouse repulsion and scroll-velocity turbulence in the vertex shader
- Graceful degradation: no WebGL → CSS gradient atmosphere; honors
  `prefers-reduced-motion` throughout

## Conversion layer (v5)

- **Transmit form** replaces the bare mailto: name/email/project-type/brief,
  honeypot spam trap, `[ SIGNAL RECEIVED ]` success state. Set
  `data-endpoint` on `#transmit` to your lead API URL at deploy; until then
  submissions compose a structured email as fallback.
- Mid-page shortcut CTA after Capabilities; plain-English translation lines
  in the Proof table; nav gets a solid blurred bar past the hero; mobile
  keeps all jump links (no hamburger needed); fixed a latent mobile
  layout-viewport overflow caused by the marquee.

## Before launch

- [ ] Swap the contact email in `src/index.html` **and** `src/main.js`
      (currently `dennis@shorevapesli.com`) for the studio address you
      want public
- [ ] Confirm the work-list blurbs (Zoo Code / Insure With Mink / Comfort
      Airz) say only what you want public
- [ ] Re-verify every entry in `src/claims.js` and bump `review_by`
      dates (the build fails on stale claims — that's intentional)
- [ ] Trademark: the site uses ® — confirm the DMDS registration is
      current; if it isn't registered, change ® to ™ site-wide
- [ ] If you wire a lead API: set `data-endpoint` on `#transmit` and
      rebuild — the build derives `connect-src` from it automatically
      (exact origin; `'none'` while unset). Make sure the endpoint does
      server-side validation, rate limiting, and origin checks (the
      client honeypot is not an abuse-control system)
- [ ] Add a real OG image (`og:image` meta) if you want rich link cards
- [ ] Optional: real domain + analytics — if you add analytics, update
      the form's "no third-party analytics" promise or don't add them
