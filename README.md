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
  gl.js        hand-rolled WebGL1 particle engine (no three.js)
  main.js      loader, virtual scroll, cursor, scramble, reveals, HUD
build.sh       inlines everything → dist/index.html
dist/
  index.html   the deployable site — a single file, host it anywhere
```

## Build & deploy

```bash
./build.sh              # writes dist/index.html
```

Deploy `dist/index.html` to any static host (Vercel, Netlify, Cloudflare
Pages, S3, or a plain nginx root). No build pipeline, no dependencies,
no CDN, works from `file://`.

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

## Before launch

- [ ] Swap the contact email in `src/index.html` (currently
      `dennis@shorevapesli.com`) for the studio address you want public
- [ ] Confirm the work-list blurbs (Zoo Code / Insure With Mink / Comfort
      Airz) say only what you want public
- [ ] Add a real OG image (`og:image` meta) if you want rich link cards
- [ ] Optional: real domain + analytics
