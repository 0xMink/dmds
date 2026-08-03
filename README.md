# DMDS™ — studio site

Single-page studio site for DMDS (websites · apps · AI · marketing).
Fully self-contained: **zero external requests** — fonts, styles, and
two hand-rolled WebGL particle engines are embedded in one HTML file
(~334 KB raw, ~136 KB gzipped).

**Live**: https://0xmink.github.io/dmds/ · **Design system**:
[DESIGN.md](DESIGN.md) — concept, tokens, contracts (MUST/SHOULD),
state machines, budgets, the verification regime.

The site's concept is *proof of work*: every quantitative claim on the
page lives in a versioned registry with a definition, source, and
review date; the boot log reports only events that actually happened;
and the released artifact is bound to its test evidence by an
attestation whose byte-hash you can check against the live URL
(see [Release & attestation](#release--attestation)).

## Structure

```
src/
  index.html   markup — semantic, accessible, OG/meta complete
  styles.css   design system (ink / bone / signal-orange, Clash Display + General Sans + Space Mono)
  fonts.css    six subsetted typefaces as base64 woff2 data URIs (~87 KB)
  claims.js    claim registry — every number on the page, with definition,
               source, verification method, and review date
  gl2.js       tier-1 engine: WebGL2 GPGPU physical simulation — positions
               and velocities in RGBA32F textures, a fragment pass
               integrates real forces every frame (desktop: 512² = 262,144
               particles; governor ladder 256²–1024²)
  gl.js        tier-2 engine: WebGL1 buffer morphing (42,000 particles,
               16,000 mobile) — the fallback when tier 1 can't run
  main.js      loader, engine tier chain, smooth scroll, cursor, scramble,
               reveals, HUD, transmit form
scripts/
  check.py     build verification: claims vs page, review dates, glyph
               coverage (parses the embedded woff2 cmaps), CSP hashes,
               provenance, size budgets — the build fails if any drift
tests/
  m1-core.js         59 checks — boot, production shape, morph, recovery,
                     lifecycle, fallback matrix
  m2-grab.js         55 checks — grab/tear/fling state machine + invariants
  m3-depth.js        35 checks — parallax, reduced-motion camera, dust
  m4-governor.js    142 checks — two-axis governor, resize-as-reinit,
                     demotion, power stop, status honesty
  m5-terminal.js     86 checks — DMDS/OS terminal: shell, keyboard
                     precedence, a11y, command truthfulness, real
                     fallback integration, mobile reachability
  run.sh             evidence runner — appends a ledger entry and archives
                     the gzipped log for every run (see below)
  attest.sh          release attestation — binds a passing batch to exact
                     dist bytes and the HTTP serving boundary
  attest-acceptance.sh  35 fault-injection cases proving attest.sh refuses
                     everything it claims to refuse
  attestation.json   the standing release certificate
  failures/          committed fire history — failure logs that led to fixes
build.sh       inlines everything, generates a hash-based CSP, stamps the
               commit + build time → dist/index.html, then runs check.py
.github/workflows/pages.yml   publishes dist/ VERBATIM (no build step)
dist/
  index.html   the deployable site — a single file, host it anywhere
```

## Build & verify

```bash
./build.sh                 # writes + verifies dist/index.html
python3 scripts/check.py   # verification alone (also run by build.sh)
```

Deploy `dist/index.html` to any static host. No build pipeline at the
host, no dependencies, no CDN; works from `file://`. Building requires
python3 (+ fontTools for the glyph check; degrades to a warning
without it).

The artifact ships with a build-generated Content-Security-Policy
(`default-src 'none'`, SHA-256 hashes for the inline blocks — no
`unsafe-inline`; `connect-src` is derived from the form's
`data-endpoint`: `'none'` while unset, the exact API origin once set)
and a provenance stamp (`<meta name="dmds-build">` = commit + UTC time,
`-dirty` if the source tree wasn't clean; set `SOURCE_DATE_EPOCH` to pin
the timestamp for reproducible builds). The stamp names the source
commit the artifact was built **from** — so the honest flow is: commit
source → `./build.sh` → commit `dist/` separately. If you hand-edit
`dist/index.html`, the CSP hashes stop matching and `check.py` fails —
rebuild from `src/` instead.

## Tests & evidence

```bash
tests/run.sh               # all five product suites (377 checks), one batch
tests/run.sh m1-core       # one suite
tests/run.sh m2-grab 5     # one suite N times (flake hunting)
```

Suites run the **built artifact** headlessly (Chromium + SwiftShader via
`playwright-core`; `npm install` inside `tests/` first). `run.sh` is an
evidence runner, not a verdict pipeline: every run appends a JSON ledger
line (`tests/run-manifest.jsonl` — commit, dirty-including-untracked,
pre/post tree signatures, dist/runner/log hashes, serialized run_id) and
archives the complete gzipped log content-addressed under
`tests/evidence/`, created and verified *before* the ledger entry that
names it. A tree that changes mid-run aborts with a distinguished exit.
Product failures are archived to committed `tests/failures/` — failures
that led to fixes are evidence too.

The engine's test instrumentation ships in the artifact, gated behind
`?debug=1` (debug API — every function throws without it) and
`?telemetry=1` (read-only observability, zero behavior change). There is
deliberately **no stripped production build**: the tested bytes are the
shipped bytes, and that identity is the point (rationale in DESIGN.md,
*Debug & telemetry surface*).

## Release & attestation

```bash
tests/attest.sh              # verify the ledger + evidence + dist + HTTP
                             # boundary, then issue tests/attestation.json
tests/attest.sh --no-http    # explicit disk-only attestation (marked as such)
tests/attest-acceptance.sh   # prove the verifier refuses what it claims to
```

`attest.sh` refuses unless one contiguous, same-batch, all-passing,
clean-tree ledger group with the expected suite/check inventory exists;
re-hashes and decompresses its evidence archives; and confirms the
`dist/index.html` bytes equal what an actual HTTP fetch of the served
file returns. Issuance is atomic (lock, unique temp, fsync, rename) with
every attested input re-validated under the lock. The certificate binds
batch → runs → dist bytes → HTTP boundary and self-hashes the verifier.

Release sequence: commit source → `./build.sh` → commit `dist/` → full
`run.sh` regression on the release-candidate commit → `attest.sh` →
commit `attestation.json` without rebuilding → push. GitHub Pages
deploys `dist/` **verbatim** — the workflow has no build step, so the
public serving boundary carries the attested bytes. Check it yourself:

```bash
curl -s https://0xmink.github.io/dmds/ | sha256sum
# equals .dist_sha256 in tests/attestation.json
```

## The site itself

- **Two-tier particle engine** (no three.js): WebGL2 GPGPU simulation
  with real integrated forces — grab the field, tear a clump off a
  formation, fling it — falling back to WebGL1 buffer morphing, then to
  a CSS atmosphere, then to a fully readable no-JS page. Type on the
  hero and 262,144 particles typeset it live; scroll scrubs formation
  morphs; hovering a work row makes the field spell the project.
- **Adaptive quality governor**: two axes (post/fill quality rungs, sim
  size ladder) with idle-deferred managed reinit, one-way tier demotion
  as the last resort, and a sequenced decision history. The footer
  status reports it honestly.
- **Truthful instrumentation**: boot-log lines fire on the real events
  they name (and mirror to a durable `window.DMDS_BOOTLOG`); the clock,
  FPS readout, and footer status are measured, not decorated.
- **Conversion layer**: transmit form with draft persistence
  (localStorage, 7-day expiry, disclosed), confirmed-2xx success only,
  mailto + copy-to-clipboard recovery, honeypot + fill-time gate that
  never silently drops a fast submit. Set `data-endpoint` on
  `#transmit` to a lead API and rebuild — the CSP `connect-src` derives
  from it automatically.
- **Accessibility**: WCAG 2.1 AA-audited (axe clean, keyboard-walked,
  320px reflow); native disclosure semantics throughout; reduced
  motion, forced colors, Save-Data, and no-JS all first-class. Text
  over the additive particle field sits on a feathered ink scrim —
  contrast an automated audit can't measure, treated as a design
  invariant.

## Post-launch completion

The site is live; "launch checklist" would be a fiction. What remains,
by category:

**Done**
- [x] Trademark (2026-08-03): switched ® → ™ site-wide. Scope of the
      finding, stated precisely: one USPTO search identified no federal
      DMDS registration, so the site must not display ® (which asserts
      one). ™ does not assert registration. This was **not** a
      trademark-clearance determination — no comprehensive search was
      performed, and ™ is no shield if the mark conflicts with
      someone's prior rights.
- [x] OG card (2026-08-03): `og:image` / `og:url` / `twitter:card`
      point at the deployed Pages URLs. A custom domain means updating
      all three and rebuilding.

**Open — launch-quality, blocked on owner action**
- [ ] Studio email: `dennis@shorevapesli.com` on a DMDS site reads as
      provisional and cross-brands an unrelated business. Fix = a DMDS
      domain (or any forwarding alias) → then swap in `src/index.html`
      **and** `src/main.js` and rebuild. Kept live only because no
      alternative exists yet — this is an active issue, not a resolved
      one.

**Open — blocked on owner-supplied facts**
- [ ] Verified outcome numbers for **Zoo Code and Insure With Mink
      only**. Comfort Airz stays framed as engineering/prototype work
      with implementation metrics (commits, models, specs — as its
      dossier already does); it must not acquire business-outcome
      claims (revenue, conversion, users, delivery) unless
      independently verified.
- [ ] Confirm or correct `platforms-production` ("3 PLATFORMS IN
      PRODUCTION" — its definition counts Comfort Airz as "live or in
      active production use", owner-verified 2026-07-08). If Comfort
      Airz is not in production use, the claim must drop to 2 or be
      redefined before its 2026-10-08 review date.

**Deferred (needs infrastructure that doesn't exist yet)**
- [ ] Lead API: set `data-endpoint` on `#transmit` and rebuild
      (server-side validation, rate limiting, and origin checks are
      the endpoint's job — the client honeypot is not an abuse-control
      system)

**Optional**
- [ ] Custom domain — if analytics ever accompany it, update the
      form's "no third-party analytics" promise first or don't add
      them
