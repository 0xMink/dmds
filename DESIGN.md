# DMDS® Design System

> Source of truth for visual and interaction decisions on the DMDS studio site.

## Concept: _Proof of Work_

Every agency says "we build great things"; almost none can prove it. DMDS
ships formally specified, audited, zero-trust systems — so the site is framed
as an **engineering document that happens to be beautiful**. Mono annotations
(`[ SEC.03 / PROOF OF WORK ]`, `FIG.01`, coordinates, live EST clock, FPS
readout), hairline rules, spec-sheet tables — the technical-poster language of
a place that measures things. The tone: sharp, declarative, zero beige.

The centerpiece is a hand-rolled WebGL particle field (deliberately **not**
three.js — custom GLSL is the point) that assembles the DMDS wordmark from
42,000 particles on load, then morphs through four formations as the visitor
scrolls the capabilities: terrain grid → phone → neural sphere → growth curve.
The four disciplines are drawn in the same particle system because that's the
pitch: one studio, one engine, different formations.

## Color

| Token       | Value                   | Usage                                  |
| ----------- | ----------------------- | -------------------------------------- |
| `--ink`     | `#0b0b0c`               | Page ground                            |
| `--ink-2`   | `#131315`               | Loader panels, raised surfaces         |
| `--bone`    | `#edeae3`               | Primary text — warm, editorial white   |
| `--bone-dim`| `rgba(237,234,227,.52)` | Secondary text                         |
| `--signal`  | `#ff4a00`               | THE accent — test-equipment orange     |
| `--line`    | `rgba(237,234,227,.13)` | Hairlines                              |

One accent, spent deliberately: cursor, indices, hover fills, ~12% of
particles. Single-theme by design — the site commits to one visual world.

## Type

- **Clash Display 500/600** — display voice. Poster-scale headlines,
  clamp()-fluid up to 10rem.
- **General Sans 400/500** — body voice.
- **Space Mono 400/700** — the instrument voice: annotations, nav, HUD,
  tags, footer. Uppercase, tracked +0.14em, 11px.

All six faces subsetted (latin basic + typographic punctuation + arrows) and
embedded as data URIs: ~87 KB total, zero layout shift, zero external requests.

## Motion

- **Loader**: time-driven counter + status lines, exits with a horizontal
  panel wipe; hard 2.6 s timeout so nothing can trap the visitor.
- **Virtual scroll**: hand-rolled lerp (factor 0.085) on desktop pointers;
  native scroll on touch and for `prefers-reduced-motion`.
- **Reveals**: clip-path line reveals for display type, translate+fade for
  body; IntersectionObserver, one-shot.
- **Manifesto**: per-word illumination driven by scroll progress.
- **Scramble**: technical-glyph decode on nav/CTA hover.
- **Particles**: 1.5 s eased GPU morphs with per-particle stagger; mouse
  repulsion; scroll velocity feeds turbulence; per-section dim factor keeps
  text legible over the field.
- Cursor: signal dot + lagging ring, `pointer: fine` only.

Reduced motion collapses all of the above to near-static.

## The engine as instrument (v2)

The particle system is not a background — it's the product demo. Three ways
visitors operate it: typing on the hero (live typesetting via the same
canvas-sampling pipeline that builds the wordmark), scrolling (morphs are
scrubbed by scroll position through `setMorphPair`, not fired by triggers),
and hovering work rows (the field spells the project). Manual modes lock the
engine; scrolling ~90 px reclaims it for the scrub choreography.

Brand signature: terminal punctuation set in signal orange (`.sig`) — the
period as a shipped deliverable.

## Voice / copy rules

- Declarative, load-bearing sentences. "Engineered, not decorated."
- No unverifiable superlatives: every stat on the page must stay true
  (20+ providers routed, 0 templates used).
- Section indices are real navigation (001–006), not decoration.

## Accessibility

- Semantic sections, skip link, visible focus rings, `aria-hidden` on all
  decorative layers, visually-hidden h1, keyboard-focusable work rows.
- Content fully readable with JS disabled (reveals are gated on `html.js`).
