/* ═══════════════════════════════════════════════════════════════
   DMDS™ — DMDS/OS terminal (phase 2, slice 1)
   Spec: docs/superpowers/specs/2026-08-03-dmds-os-terminal-design.md
   The site's console: every command reads live state or
   build-embedded data labeled as such. Nothing simulated.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var dlg = document.getElementById("term");
  var out = document.getElementById("term-out");
  var input = document.getElementById("term-in");
  var form = document.getElementById("term-form");
  var toggle = document.getElementById("term-toggle");
  var closeBtn = document.getElementById("term-close");
  var DEBUG = /[?&]debug=1/.test(location.search);
  // native <dialog> is the accessibility foundation (top layer, focus
  // trap, Escape). No dialog support → the terminal honestly doesn't
  // exist: the toggle stays hidden and no key is ever intercepted.
  if (!dlg || !out || !input || !form || typeof dlg.showModal !== "function") return;

  var ctx = { gl: null, fps: null }; // injected by main.js after engine boot
  var hist = [], histIdx = 0, opener = null;

  /* ═══ commands — pure: parse, read real state, return lines ═══ */

  function cmdHelp() {
    var lines = ["DMDS/OS commands — every line below reads live state:"];
    var width = 0, name;
    for (name in COMMANDS) { width = Math.max(width, COMMANDS[name].usage.length); }
    var pad = new Array(width + 3).join(" ");
    for (name in COMMANDS) {
      var c = COMMANDS[name];
      lines.push("  " + (c.usage + pad).slice(0, width + 2) + c.desc);
    }
    lines.push("  ESC closes · UP/DOWN history · TAB completes");
    return lines;
  }

  function cmdStatus() {
    // ctx.gl may be an accessor: the live engine can change tier after
    // boot (governor demotion), and status must describe what is
    // actually rendering NOW, not what booted
    var engine = typeof ctx.gl === "function" ? ctx.gl() : ctx.gl;
    if (!engine) {
      return ["RENDER: STATIC · CONTENT NOMINAL — no engine active"];
    }
    var s = engine.status();
    var lines = [];
    if (s.tier === "gl2") {
      lines.push("TIER 1 · WEBGL2 GPGPU SIM · " + (s.running ? "RUNNING" : "STOPPED") + (s.sleeping ? " (REDUCED-MOTION SLEEP)" : ""));
      lines.push("PARTICLES " + s.count.toLocaleString("en-US") + " · BASELINE " + s.baseline.toLocaleString("en-US") + " · CEILING " + s.ceiling.toLocaleString("en-US"));
      lines.push("POST-FX " + (s.post ? "ON" : "OFF") + " · " + (s.degraded ? "DEGRADED (governor acted — that is it working)" : "FULL QUALITY"));
      lines.push("FORMATION " + s.formation + " · MIX " + s.mix.toFixed(2) + " · EXCITE " + s.excite.toFixed(2));
    } else {
      lines.push("TIER 2 · WEBGL1 BUFFER ENGINE · " + (s.running ? "RUNNING" : "STOPPED"));
      lines.push("PARTICLES " + s.count.toLocaleString("en-US") + " OF " + s.max.toLocaleString("en-US") + " · POST-FX " + (s.post ? "ON" : "OFF"));
      lines.push("(two-axis governor history is a tier-1 instrument; tier 2 keeps a simpler halve/restore budget)");
    }
    if (typeof ctx.fps === "function") {
      var f = ctx.fps();
      if (f) lines.push("FPS " + f + " (measured)");
    }
    return lines;
  }

  function cmdBoot() {
    var log = window.DMDS_BOOTLOG;
    if (!log || !log.length) return ["boot log empty"];
    return log.slice();
  }

  function cmdBuild() {
    var meta = document.querySelector('meta[name="dmds-build"]');
    var lines = [meta ? "BUILD " + meta.content + " (commit · UTC build time, stamped at build)" : "error: provenance stamp missing"];
    lines.push("SOURCE github.com/0xMink/dmds · attestation: tests/attestation.json");
    lines.push("VERIFY: sha256 of this page's served bytes == dist_sha256 in the attestation");
    return lines;
  }

  var COMMANDS = {
    help:   { usage: "help",   desc: "list commands", run: cmdHelp },
    status: { usage: "status", desc: "engine + render state, live", run: cmdStatus },
    boot:   { usage: "boot",   desc: "replay the boot log (real events)", run: cmdBoot },
    build:  { usage: "build",  desc: "artifact provenance + how to verify it", run: cmdBuild },
    clear:  { usage: "clear",  desc: "clear scrollback", run: function () { return []; } },
    exit:   { usage: "exit",   desc: "close the terminal", run: function () { return []; } }
  };

  function exec(line) {
    var argv = String(line).trim().split(/\s+/);
    var name = (argv[0] || "").toLowerCase();
    if (!name) return [];
    var c = COMMANDS[name];
    if (!c) return ["unknown command: " + name + " — 'help' lists what exists"];
    return c.run(argv.slice(1));
  }

  /* ═══ shell ═══ */

  function print(text, cls) {
    var div = document.createElement("div");
    if (cls) div.className = cls;
    div.textContent = text;
    out.appendChild(div);
    out.scrollTop = out.scrollHeight;
  }

  function banner() {
    print("DMDS/OS · site console — every command reads live state");
    print("'help' lists commands · ESC closes", "t-dim");
  }

  function open() {
    if (dlg.open) return;
    opener = document.activeElement;
    dlg.showModal();
    if (toggle) toggle.setAttribute("aria-expanded", "true");
    if (!out.childNodes.length) banner();
    input.focus();
  }

  dlg.addEventListener("close", function () {
    if (toggle) toggle.setAttribute("aria-expanded", "false");
    if (opener && opener.focus) { try { opener.focus(); } catch (e) {} }
    opener = null;
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var line = input.value;
    input.value = "";
    if (!line.trim()) return;
    hist.push(line);
    histIdx = hist.length;
    print("dmds://$ " + line, "t-cmd");
    var name = line.trim().split(/\s+/)[0].toLowerCase();
    if (name === "clear") { out.textContent = ""; return; }
    exec(line).forEach(function (l) {
      print(l, /^(unknown|unavailable|error)/.test(l) ? "t-err" : "");
    });
    if (name === "exit") dlg.close();
  });

  // ↑↓ history, TAB command completion — in-memory only (dies with the page)
  input.addEventListener("keydown", function (e) {
    if (e.key === "ArrowUp") {
      if (histIdx > 0) { histIdx--; input.value = hist[histIdx]; }
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      if (histIdx < hist.length - 1) { histIdx++; input.value = hist[histIdx]; }
      else { histIdx = hist.length; input.value = ""; }
      e.preventDefault();
    } else if (e.key === "Tab") {
      var pre = input.value.trim().toLowerCase();
      if (pre && pre.indexOf(" ") === -1) {
        for (var name in COMMANDS) {
          if (name.indexOf(pre) === 0) { input.value = name; break; }
        }
      }
      e.preventDefault();
    }
  });

  /* ═══ keyboard precedence router (spec: six paths, each tested) ═══
     Backtick opens. Close is Escape (native) or 'exit' — the terminal's
     own input is a form control, so rule 3 makes backtick literal there. */
  document.addEventListener("keydown", function (e) {
    if (e.isComposing) return;                                      // 1 IME
    if (e.ctrlKey || e.altKey || e.metaKey) return;                 // 2 modifiers
    var t = e.target;
    if (t && t.closest && t.closest("input, textarea, select, button, a, [contenteditable]")) return; // 3 controls
    if (e.key !== "`") return;                                      // 4 one key only
    e.preventDefault();
    open();                                                          // 5
  });

  if (toggle) {
    toggle.removeAttribute("hidden"); // no-JS / no-dialog never shows a dead control
    // showModal() makes the page inert while open, so this control is a
    // LAUNCHER in practice — the reachable close paths are the in-dialog
    // CLOSE button, Escape, and 'exit'. aria-expanded still reports state.
    toggle.addEventListener("click", function () {
      if (!dlg.open) open();
    });
  }
  if (closeBtn) closeBtn.addEventListener("click", function () { dlg.close(); });

  function setContext(c) {
    if (c && "gl" in c) ctx.gl = c.gl;
    if (c && "fps" in c) ctx.fps = c.fps;
  }

  window.DMDS_TERM = {
    open: open,
    close: function () { if (dlg.open) dlg.close(); },
    exec: exec,
    // one-shot bridge for main.js — consumed on first use so the public
    // API does not advertise a mutation channel for the state source
    _connect: function (c) {
      setContext(c);
      delete window.DMDS_TERM._connect;
    }
  };
  // test seam, same doctrine as the engine's: only honored under ?debug=1
  if (DEBUG) window.DMDS_TERM.debugSetContext = setContext;
})();
