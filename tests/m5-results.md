# M5 — DMDS/OS terminal (Phase 2)

Spec: `docs/superpowers/specs/2026-08-03-dmds-os-terminal-design.md`
(rev 2, review-incorporated). One rule governs everything here: the
terminal never simulates — every command reads live state or
build-embedded data labeled as such.

## Slice 1 (2026-08-03) — shell, router, first commands

Shipped: native-`<dialog>` bottom sheet (top layer, focus trap, Escape
free; no dialog support → no terminal, toggle stays hidden), pure
`exec(line) → lines` dispatch, keyboard precedence router (five guards
+ open, one key), `help` / `status` / `boot` / `build` / `clear` /
`exit`, truthful unavailable states (static tier, tier 2), in-memory
history + tab completion, in-dialog CLOSE control, safe-area bottom
padding. +12 KB raw (334→346; warn line 352 holds).

**Design decision proven necessary during implementation**: `status`
reads the engine through an *accessor*, not a snapshot — `GL` is
reassigned when the governor demotes to tier 2, and a captured
reference would report a destroyed engine's state. The context tests
exercise the real fallback module's `status()` (which honestly
reported `PARTICLES 0 OF 42,000 · STOPPED` for the un-booted module —
the truthfulness rule holding at a boundary nobody designed for).

## Slice 1 revision (same day) — external review closure

The first cut drew a review that was right about most of what it
challenged; the notable items, each now closed with evidence:

1. **`platforms-production` corrected 3 → 2** (the substantive one):
   Comfort Airz removed from the "in production" definition — it is
   engineering/prototype work and its dossier carries implementation
   metrics only. The registry definition states the exclusion and the
   restore condition (owner verification of production use).
2. **The nav TRM control's close branch was unreachable**: showModal()
   makes the page inert, so clicking the toggle again was impossible
   while open. It is now honestly a launcher; the dialog carries its
   own CLOSE control (tested by pointer).
3. **Real forced-colors focus bug**: forced-colors mode drops
   box-shadow, and the input's outline was `none` — a focused input
   with NO visible indicator. Fixed (outline restored under
   forced-colors) and now emulated in the suite.
4. **Public `setContext` weakened the truth story**: replaced with a
   one-shot `_connect` bridge consumed by main.js; the production API
   advertises no mutation channel (asserted). The test seam
   `debugSetContext` exists only under `?debug=1`, same doctrine as
   the engine's debug surface.
5. **Coverage claims trued up** (45 → 70 checks): synthetic-IME guard
   test (labeled synthetic — it exercises the branch, not a real IME
   session); context-level tests renamed `context:*` and moved behind
   `?debug=1`; a REAL WebGL-unavailable integration test (getContext
   override → terminal reports STATIC through the actual
   engine-selection path, boot replay carries the honest FALLBACK
   line); reduced motion asserts computed transition/animation are
   zero; mobile at 320×568 / 375×667 / 667×375 (toggle hidden ≤560,
   full-width panel, no overflow, input on-screen, safe-area padding);
   help-column alignment (width computed, not the 10-char slice that
   would have truncated slice 2's `claims verify`).

One review claim was factually wrong and is worth the record: it
asserted the post-rewrite release never rebuilt dist from the final
source commit. It had — `built dist/index.html: 344 KB (commit
8af6ebb)`, stamp verified, dist committed separately (19a7efc). The
transcript the reviewer saw ended mid-regression; the lesson kept is
about legibility (make the rebuild its own visible step), not
correctness.

**Suite: tests/m5-terminal.js — 70 checks** across nine sections:
API/markup contract incl. bridge-consumed + no-mutation-channel,
exec truthfulness against the real engine/boot-buffer/stamp, keyboard
precedence router (all six paths), a11y lifecycle (initial focus,
focus restored to opener, aria-expanded both ways, role=log), shell
behaviors (echo/history/tab/clear/exit/close-button/scrollback),
context-level unavailable states (?debug=1), real no-GL integration,
reduced motion (functional + actually unanimated), forced colors
(boundary + focus indicator), three mobile viewports, no-JS.

**Test-infra lesson (recurrence of a known one)**: the first smoke run
saw `aria-expanded` stale 200 ms after Escape — not a bug: the
dialog's `close` event is dispatched via the task queue, and under
SwiftShader at ~1 fps the main thread lags task delivery past any
fixed wait. The suite polls for task-queue state, never wall-clock
waits. (Same family as the round-7 "wall-clock waits vs SwiftShader
slow-motion" lesson; now it has a dialog-shaped instance.)

**Process slips, recorded**: (a) the slice's first source commit swept
the smoke-built dirty-stamped dist in via `git add -A` — caught before
push (the follow-up dist commit's suspiciously tiny diff was the
tell); both unpushed commits rewritten to restore the two-commit
provenance flow. (b) The revision's first RC build stamped `-dirty`
because uncommitted ledger growth (fixture drills + a killed partial
batch) counted — ledgers committed first, rebuilt clean. The stamp
discipline caught its author twice in one day; both times before
anything was pushed.

**Inventory**: PRODUCT_SUITES five suites; attest.sh EXPECTED
m5-terminal 70 (total 361), updated in the same commits as the suite
changes (the tripwire MUST). Runner-bytes change → fixture drills 3/3
(pass=0 ledgered, fail=1 bannerless+archived, taint=77
tree_stable:false); verifier-bytes changes → attest_sha256 rotates and
attest-acceptance reran against the final certificate.


## Slice 1 rev 2 (same day) — second review round

The reviewer conceded the rebuild claim ("my previous claim … was
wrong" — the receipts held) and narrowed to six issues; all six
accepted, two of them real product defects:

1. **The mobile door**: the TRM launcher was hidden ≤560px while the
   mobile tests opened the terminal programmatically — "a wonderfully
   preserved room with no door." Portrait phones now keep the
   launcher (SND still hides), with the nav's ≥40px tap-target rule
   asserted in BOTH dimensions (measured values preserved in the check
   detail) and the input configured at the 16px floor intended to
   avoid iOS focus zoom — the computed size is proven; Safari's actual
   behavior is a real-phone item. Tap-to-open is tested with real
   touch taps at all three viewports.
2. **Bridge lifecycle**: a failed engine boot left the one-shot
   `_connect` exposed forever (the connect call lived in the success
   continuation) — contradicting the "no mutation channel" claim on
   exactly the static path. The connect now runs in a final `.then`
   after the catch — every boot outcome consumes it — and the suite
   asserts `_connect === undefined` after real static AND real tier-2
   boots. Precise claim: **no persistent mutation channel after
   boot** — the bridge necessarily exists on the API for the moments
   between script evaluation and boot completion.
3. Safe-area test relabeled: `env()` insets are 0 in headless — the
   check verifies base padding; device-inset behavior is a real-phone
   item and the spec's manual list says so.
4. Help alignment asserted across all rows.
5. Forced-colors coverage widened to the stated contract: close
   button, prompt, output, error text.
6. Mobile testing labeled as what it is: viewport testing. The
   real-phone check (virtual keyboard, focus zoom, home indicator,
   iOS `<dialog>`) remains an open owner item.

Status wording, precisely: all six findings were **addressed**;
real-device validation remains **open** (it cannot be closed from a
headless box).

New real integrations this round: tier-2 boot (webgl2-only nulled →
gl1 boots; the terminal truthfully reported the governor had already
halved the budget under SwiftShader: `PARTICLES 10,500 OF 42,000` —
unprompted honesty from the status pipeline). Suite 70 → **86
checks**; EXPECTED total 377.

## Slice 1 rev 3 (same day) — the assertion that earned its keep

The third review round asked that the tap-target check assert BOTH
dimensions ("probable geometry is not evidence"). Strengthening the
assertion immediately found a real defect: the TRM launcher measured
44.3px tall but only **35.8px wide**. Side padding 0.4rem → 0.6rem;
now 44.3 × 42.2px (values preserved in the check detail), 320px
viewport still overflow-free. Docs trued in the same commit: the
spec's "opens/closes globally" line corrected to the accepted model
(backtick opens; Escape / in-dialog CLOSE / `exit` close), DESIGN.md
and README updated to five suites / 377 checks. m5 stays 86 checks —
an assertion was strengthened, not added.

## Slice 2 — planned

`gov`, `claims` / `claims verify`, `formation`, `type`, `goto`,
`dossier`, `snd`, `whoami`, `contact`; suite grows accordingly. Phase
3 entry lands only with Phase 3.
