# DMDS/OS Terminal — Phase 2 design

| | |
|---|---|
| **Date** | 2026-08-03 (rev 2 — external review incorporated: keyboard precedence model, state-restoration rule, unavailable-state outputs, a11y test enumeration, commercial hierarchy, no-game-abstractions; implementation begins with slice 1) |
| **Status** | Accepted |
| **Phase** | 2 of the staged-fusion roadmap (1: GPGPU engine ✓ · 2: terminal · 3: hidden game) |
| **Owner** | Dennis Mink (@0xMink) |
| **Governing docs** | DESIGN.md v2.2 (all MUSTs apply); this spec adds terminal-specific contracts |

## Concept

The site is framed as an engineering document with real instrumentation.
Phase 2 gives the visitor the console that document implies: **DMDS/OS**,
a terminal overlay in the site's instrument language that operates the
real page — the engine, the claim registry, the boot log, the governor —
through commands. Phase 1 made the field physical; Phase 2 makes the
*site* operable. It is the credibility artifact for the developer
audience (the visitor who opens a terminal is exactly the visitor who
will judge whether it's real), and it is the discovery surface Phase 3's
hidden game will live behind.

**The load-bearing rule carries over unchanged**: the terminal never
simulates. Every command reads live state or build-embedded data
labeled as such; there is no fake filesystem, no invented processes, no
decorative output. A terminal that lies would spend the credibility the
whole site exists to earn.

## Approaches considered

**A. Instrument console overlay (chosen).** A toggleable terminal panel
(native `<dialog>`) with a command dispatch table wired to the real
subsystems. ~12–15 KB. Escalates the concept, sets up Phase 3, testable
headlessly.

**B. Command palette (Ctrl-K style).** Fuzzy nav + a few status
commands, ~5 KB. Rejected: it's a navigation widget, not a concept
escalation — reads as SaaS chrome, not as DMDS/OS, and gives Phase 3
nothing to live in.

**C. Full fake-OS desktop (windows, files, apps).** Maximal spectacle,
rejected: file/process metaphors either lie (violating the truth
doctrine) or require mapping every artifact to something real (scope
blowout), plus a large a11y and byte surface. The terminal keeps the
OS *voice* without the OS *simulation*.

## Entry points

- **Nav toggle `TRM`** next to `SND` (real `<button>`, `aria-expanded`,
  `aria-controls="term"`). **Portrait phones keep it** (SND hides
  ≤560px; TRM does not — a soft keyboard has no backtick, so the
  launcher is the only door on phones and a hidden launcher would make
  the mobile terminal a room without one). Same ≥40px tap-target rule
  as the nav jump links; the input meets iOS's 16px no-zoom floor on
  coarse pointers.
- **Backtick `` ` ``** opens, globally (not just on the hero).
  Closing is Escape, the in-dialog CLOSE control, or `exit` — never
  backtick, because the terminal's own input is a form control and the
  router's guard 3 makes backtick literal there (see Keyboard
  precedence).
  Guards identical to the type-mode capture contract: never when focus
  is in `input, textarea, select, button, a, [contenteditable]`, never
  with Ctrl/Alt/Meta, never during IME composition. `` ` `` is excluded
  from the hero type-mode charset (currently unsupported there — stays
  that way).
- **Escape always closes** (native dialog behavior).
- No-JS: the terminal does not exist. **MUST**: no content is exclusive
  to the terminal — everything it prints is available or derivable
  elsewhere (page content, console, repo). It is chrome, not content.

## Architecture

New file `src/term.js` (isolation: main.js wires it, doesn't contain
it), inlined by build.sh like the other sources.

- **Public API**: `window.DMDS_TERM = { open(), close(), exec(line) →
  string[] }`. `exec` is a pure dispatch — parses, runs, returns output
  lines — so the entire command surface is testable headlessly without
  keyboard/DOM simulation. The DOM layer is a thin shell over `exec`.
- **Dispatch table**, not an interpreter: `COMMANDS = { name: { usage,
  desc, run(args, ctx) } }`. No eval, no string-built code, no dynamic
  property walks (CSP posture unchanged). Unknown command → honest
  error + `help` hint.
- **Context injection**: `ctx` carries the real handles — `GL` (engine
  facade), claims registry, `DMDS_BOOTLOG`, scroll controller, sound
  toggle. Handlers touch only `ctx`; no globals inside the table.
- **Rendering**: `textContent` and `createElement` only — the
  three-call-site `innerHTML` rule is not disturbed. Output is a
  scrollback `<pre>`-style region (mono, `--bone`), prompt line
  `dmds://$`, input is a real `<input>` (native editing, IME, SR
  support for free).
- **Dialog semantics**: native `<dialog>` + `showModal()` — top layer,
  focus trap, Escape, `::backdrop` for free. `aria-label="DMDS/OS
  terminal"`. Focus returns to the invoking control on close (APG).
  Panel is bottom-anchored, ~40vh, ink ground (`--ink-2`), hairline
  top rule, backdrop transparent-ink (the page stays visible — the
  terminal operates the page, so the page is the display).
- **History**: up/down through this session's commands, in-memory only
  (no localStorage — the privacy line "nothing beyond the four field
  values is stored" stays true). Tab completes command names.

## Command set (v1 — everything reads real state)

| Command | Reads/does |
|---|---|
| `help` | command table (usage + desc) |
| `status` | `GL.status()`: tier, particle count, baseline/ceiling, rung, post, degraded/sleeping, live FPS — same source as the footer |
| `gov` | governor decision history (read-only ring, newest last, same `seq`/`t`/`event`/`rung`/`n` fields the telemetry mode exposes) |
| `boot` | replays `window.DMDS_BOOTLOG` verbatim |
| `claims` | registry list: id, page value, visibility, review_by |
| `claims verify` | re-runs the claims↔DOM consistency check live, per-claim PASS/FAIL — same code path as the loader's VERIFY step |
| `build` | provenance stamp (`dmds-build` meta: commit + UTC time) + the attestation pointer (repo URL + `dist_sha256` self-check instructions) |
| `formation <name>` | drives the engine via the existing public API (`logo · ambient · grid · device · neural · curve`); enters a manual state governed by the existing non-interactive-exit contract (scroll 90px reclaims) |
| `type <text>` | typesets through the existing type-mode pipeline (same charset, same caps) |
| `goto <001–007\|name>` | scrolls to a section (native scroll adoption rules apply) |
| `dossier <W-01…>` | opens/focuses a work dossier (drives the real disclosure button) |
| `snd on\|off` | the existing sound toggle path (`aria-pressed` stays in sync); still never autoplays — `on` from the terminal is an explicit user action |
| `whoami` | prints the Operator card text |
| `contact` | closes the terminal, scrolls to the form, focuses the name field |
| `clear` | clears scrollback |
| `exit` | closes |

**Debug commands are not in the table.** `?debug=1` instrumentation
stays where it is; the terminal is a production surface and gains no
injection powers. The governor history read is the one telemetry-tier
item promoted to production — it is read-only, always-recorded, and
opening a terminal is a stronger explicit act than adding a query param.

**Phase 3 reservation**: no stub, no teaser command — a hint at a game
that doesn't exist yet would be the site's first lie. Phase 3 adds its
entry when there is something real behind it.

## Keyboard precedence (deterministic, not aspirational)

One document-level `keydown` router in term.js, guard order fixed and
each path tested:

1. `isComposing` → native (IME never intercepted).
2. Ctrl/Alt/Meta held → native.
3. Event target inside `input, textarea, select, button, a,
   [contenteditable]` → native. This includes the terminal's own input:
   backtick while typing in the terminal inserts a literal backtick.
4. Key is not `` ` `` → native.
5. Otherwise: open the terminal, `preventDefault`.

Why this cannot collide with hero type-mode: (a) `` ` `` is not in the
type-mode charset, so type-mode never consumes it; (b) while the
terminal is open, `showModal()` makes the rest of the page inert and
focus lives in the terminal's input, so type-mode's own focus guard
blocks it; (c) the router acts on exactly one key, so it can never
shadow type-mode's charset. **Close is Escape (native dialog), the
in-dialog CLOSE control, or `exit`** — backtick-to-close is
deliberately absent because the terminal's input is a form control and
rule 3 wins. Each of these six
paths (5 guards + open) is a required m5 test case.

## State restoration rule

Terminal commands that mutate the visible site are the same class as
direct manual interaction, and the same rules govern them:

- `formation` / `type` enter the engine's existing manual states;
  closing the terminal does **not** revert them — the visitor did it
  deliberately — and the existing non-interactive exits (90px scroll
  reclaim, idle timeout) restore scrub exactly as for hover/typing.
- `snd` flips the real toggle; the nav button's `aria-pressed` is the
  single source of truth and stays in sync. No revert on close.
- `goto` scrolls; scroll position is ordinary page state.
- The terminal itself restores **focus** to whatever held it before
  opening (stored at open, restored on `close` event).

One sentence of doctrine: **closing the terminal closes the terminal
— it never undoes what the visitor asked for, and nothing the
terminal can do outlives the page's existing reclaim rules.**

## Truthful unavailable states

Every command that reads a subsystem must answer honestly when that
subsystem is absent — refusals are output, never silence or throw:

- Static tier (no WebGL): `status` → `RENDER: STATIC · CONTENT NOMINAL
  — no engine active`; `formation`/`type` → `unavailable: no engine
  (static render)`; `gov` → `no governor: no engine`.
- Tier 2: `status` reports tier 2 truthfully; `gov` prints tier-2
  budget state and says the two-axis history belongs to tier 1.
- Empty boot log (terminal opened before boot finished, or buffer
  missing): `boot` → `boot log empty` — never a fabricated line.
- Sound unsupported (no AudioContext): `snd` → `unavailable: no audio
  support`, matching the hidden nav toggle.

## Commercial hierarchy

The terminal is secondary to the site's job. **MUST**: no content is
exclusive to the terminal (already a contract above); the contact path
never routes through it; `TRM` sits in the nav at the same visual
weight as `SND` — never styled to compete with CONTACT/TRANSMIT; no
puzzle gates anything a prospective client needs. The `contact`
command exists precisely so the terminal's most engaged users are one
word from the form.

## No premature game architecture

The command table is a flat object. No plugin system, no command
registration API, no event bus, no state machine beyond the dialog's
open/closed — Phase 3 gets abstractions when Phase 3 exists and shows
what it needs. Build the terminal as a terminal.

## Contracts (MUSTs, additive to DESIGN.md)

1. Every output line is read from live state or from build-embedded
   data explicitly labeled with its build time. Nothing simulated.
2. The capture contract: `` ` `` never fires from form controls, IME,
   or with modifiers; Escape always exits; opening announces via the
   dialog's accessible name; the terminal never intercepts keys while
   closed except the single guarded backtick.
3. No new `innerHTML` call sites. No eval. CSP hashes regenerate as
   usual; `connect-src` unchanged (the terminal makes no requests).
4. No storage: command history dies with the page.
5. No-JS and reduced-motion unaffected (dialog has no animation under
   reduced motion; grain/backdrop static). Forced colors: system
   colors, visible focus, no invisible states.
6. Size: terminal ≤ 15 KB raw addition; the 352 KB warn line holds
   (current 334 KB). If it can't fit, cut commands, not correctness.
7. Engine manual states entered via terminal obey the existing
   state-machine exits (scroll reclaim, idle) — the engine can never
   be wedged from the terminal either.

## Testing

New suite `tests/m5-terminal.js`, **sized to the shipped slice and
grown with it** — no checks for unbuilt commands, but nothing ships to
the public site untested: each slice lands with its tests in the same
release, and the runner/attestation inventory (PRODUCT_SUITES,
EXPECTED) is updated deliberately in the same commit.

A11y lifecycle checks (explicit, per review): initial focus lands in
the command input on open; focus returns to the pre-open element on
close; the output region is `role="log"` (`aria-live` implicit) so
command results are announced; the dialog has an accessible name; the
nav toggle's `aria-expanded` tracks open state; Escape closes; reduced
motion adds no animation to open/close; forced colors keeps the panel,
text, and focus visible.

Slice-1 checks:

- `exec` unit surface: every command against known page state — status
  fields match `GL.status()`, `claims verify` matches the loader check,
  `boot` equals `DMDS_BOOTLOG`, unknown commands error honestly.
- Capture contract: backtick in each guarded context (input focused,
  textarea, chip label, dossier button, with Ctrl/Meta held) does NOT
  open; backtick idle DOES; Escape closes; focus restoration asserted.
- Dialog a11y: `showModal` focus trap, accessible name, `aria-expanded`
  sync on the nav toggle, no-JS absence (html.no-js build served —
  terminal nodes inert/absent).
- Engine integration: `formation grid` moves the engine (status
  formation changes), scroll 90px reclaims to scrub — the existing
  m2-style invariant reused.
- Byte/CSP: build passes check.py (hashes, glyphs, budgets) with the
  new inline block.

Manual (open items): real screen reader open/announce/close; real
phone — virtual-keyboard resize behavior, focus zoom, home-indicator
spacing with the keyboard open, iOS Safari `<dialog>` behavior.
Headless viewport tests verify layout and reachability, not device
behavior; the safe-area CSS is present but `env()` insets are zero in
emulation, so device-inset behavior is unverified until the real-phone
check.

## Out of scope (YAGNI'd)

Fake filesystem, multi-window, command piping, scripting, persistent
history, remote anything, a `sudo` joke (it would be the site's second
lie), Phase 3 content.

## Rollout

Sliced, each slice a full release (source → dist → 5-suite regression
→ attestation with updated EXPECTED → push → public-bytes verify):

1. **Slice 1 — the shell**: dialog + nav toggle, keyboard router,
   focus lifecycle, parser/dispatch, `help` / `status` / `boot` /
   `build` / `clear` / `exit`, truthful unavailable states, m5 suite
   covering all of it.
2. **Slice 2 — operating the page**: `gov`, `claims` / `claims
   verify`, `formation`, `type`, `goto`, `dossier`, `snd`, `whoami`,
   `contact`; m5 grows accordingly.
3. Phase 3 entry lands only with Phase 3.
