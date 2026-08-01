/* ═══════════════════════════════════════════════════════════════
   DMDS® — interaction layer
   Loader · virtual scroll · cursor · scramble · reveals · HUD
   ═══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var doc = document.documentElement;
  doc.classList.add("js");

  var REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var TOUCH = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  var SMOOTH = !REDUCED && !TOUCH;

  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  /* ═══ Claim verification — the registry is the source of truth ═══ */
  function verifyClaims() {
    var reg = window.DMDS_CLAIMS && window.DMDS_CLAIMS.claims;
    var failures = [], checked = 0;
    if (!reg) return { ok: false, checked: 0, failures: ["claim registry missing"] };
    $$("[data-claim]").forEach(function (el) {
      var id = el.dataset.claim, c = reg[id];
      if (!c) { failures.push(id + ": on page, not in registry"); return; }
      checked++;
      var dom = (el.dataset.count !== undefined ? el.dataset.count : el.textContent).trim();
      if (dom !== String(c.page)) failures.push(id + ": page says “" + dom + "”, registry says “" + c.page + "”");
    });
    Object.keys(reg).forEach(function (id) {
      if (reg[id].dom && !document.querySelector("[data-claim='" + id + "']")) {
        failures.push(id + ": in registry, missing from page");
      }
    });
    return { ok: !failures.length, checked: checked, failures: failures };
  }

  /* ═══ Preloader — boot sequence ═══
     The bar is a time-paced animation (it makes no factual claim);
     every LOG LINE is fired by the event it names, or not at all. */
  var loader = $("#loader"), pctEl = $("#loader-pct"), barEl = $("#loader-bar"), statusEl = $("#loader-status");
  var logEl = $("#loader-log");
  var progress = 0, target = 0, loadDone = false, booted = false;
  var RAMP = REDUCED ? 500 : 1800;

  function bootLog(label, value, opts) {
    opts = opts || {};
    var line = document.createElement("div");
    line.className = "loader__log-line" + (opts.last ? " loader__log-line--last" : "");
    var dots = new Array(Math.max(2, 30 - label.length)).join(".");
    line.innerHTML = "<span>" + label + " " + dots + "</span><span>" + value + "</span>";
    logEl.appendChild(line);
    statusEl.textContent = (opts.status || label).toUpperCase();
  }

  var loaderT0 = performance.now();
  function tickLoader() {
    // time-driven so blocked frames (shader compile) can't stall the count
    var elapsed = performance.now() - loaderT0;
    target = Math.max(target, Math.min(loadDone ? 100 : 92, (elapsed / RAMP) * 100));
    // eased, but with a floor once ready so low frame rates can't
    // stretch the asymptotic tail — the bar always closes promptly
    progress += Math.max((target - progress) * 0.2, loadDone ? 0.75 : 0);
    progress = Math.min(progress, target);
    var p = Math.min(100, Math.round(progress));
    pctEl.textContent = ("00" + p).slice(-3);
    barEl.style.width = p + "%";
    if (p < 100) requestAnimationFrame(tickLoader);
    else finishLoader();
  }

  var finished = false;
  function finishLoader() {
    if (finished) return;
    finished = true;
    loader.classList.add("loader--done");
    doc.classList.add("loaded");
    setTimeout(function () { loader.remove(); }, 1100);
    // let the cinematic wordmark assembly finish before scroll owns the field
    setTimeout(function () { manualLock = false; }, 2300);
  }

  // the loader never holds usable content hostage: click or Escape skips it
  function skipLoader() { loadDone = true; progress = target = 100; }
  loader.addEventListener("click", skipLoader);
  window.addEventListener("keydown", function (e) {
    if (!finished && e.key === "Escape") skipLoader();
  });

  // fonts.ready settles even when a face fails — load each required face
  // and report the real count, so the OK is earned per-face
  if (document.fonts && document.fonts.load) {
    var FACES = [
      '500 1em "Clash Display"', '600 1em "Clash Display"',
      '400 1em "General Sans"', '500 1em "General Sans"',
      '400 1em "Space Mono"', '700 1em "Space Mono"'
    ];
    Promise.all(FACES.map(function (f) {
      return document.fonts.load(f, "DMDS").then(
        function (m) { return m.length > 0; },
        function () { return false; }
      );
    })).then(function (r) {
      var ok = r.filter(Boolean).length;
      bootLog("MOUNT /typefaces (" + ok + "/" + FACES.length + ")",
        ok === FACES.length ? "OK" : "DEGRADED");
    });
  }

  /* ═══ GL boot — tier chain: gl2 (GPGPU sim) → gl1 → CSS ═══
     A canvas that ever held a WebGL2 context can't hand out WebGL1,
     so a failed tier-1 init tears down and replaces the canvas node
     before tier 2 boots. */
  var glOK = false;
  var GL = null;
  function onMilestone(kind, detail) {
    if (kind === "compile") bootLog(detail === "sim" ? "COMPILE sim + render" : "COMPILE vertex + fragment", "OK");
    else if (kind === "post") bootLog("PIPELINE post-fx", detail ? "ON" : "DIRECT");
    else if (kind === "seed") bootLog("SEED particles", Number(detail).toLocaleString("en-US"));
    else if (kind === "loop") bootLog("LINK render loop", "OK");
  }
  function replaceCanvas(old) {
    var fresh = old.cloneNode(false);
    old.parentNode.replaceChild(fresh, old);
    return fresh;
  }
  function bootTier2(canvas) {
    if (!window.DMDS_GL) return Promise.reject(new Error("no engine"));
    return window.DMDS_GL.init(canvas, onMilestone).then(function () { GL = window.DMDS_GL; });
  }
  var glInit = (function () {
    var canvas = $("#gl");
    if (window.DMDS_GL2 && window.DMDS_GL2.probe()) {
      return window.DMDS_GL2.init(canvas, onMilestone).then(function () {
        GL = window.DMDS_GL2;
        function toTier2() {
          // tear down tier 1, boot tier 2 on a fresh canvas — used by both
          // the context-restore timeout and the governor's perf demotion
          try { window.DMDS_GL2.destroy(); } catch (e) {}
          bootTier2(replaceCanvas($("#gl"))).catch(function () {});
        }
        GL.onLostTimeout(toTier2);
        if (GL.onDemote) GL.onDemote(toTier2);
      }, function (err) {
        if (window.console) console.warn("[DMDS] gl2 init failed → tier 2:", err && err.message);
        try { window.DMDS_GL2.destroy(); } catch (e) {}
        return bootTier2(replaceCanvas(canvas));
      });
    }
    return bootTier2(canvas);
  })()
    .then(function () {
      glOK = true;
      // truthful affordance: advertise the grab only where it exists
      // (tier-1 physical engine, non-touch pointer)
      var hint = $("#engine-hint");
      if (hint && !TOUCH && GL && GL.status().tier === "gl2") {
        hint.innerHTML = "[ <b>FIELD IS PHYSICAL</b> ]&nbsp;&nbsp;GRAB THE WORDMARK — TEAR IT. IT RECOVERS. TYPE ANYTHING.";
      }
    })
    .catch(function () {
      $("#gl").style.opacity = "0.5"; /* CSS gradient fallback remains */
      bootLog("COMPILE render engine", "FAIL");
      bootLog("FALLBACK static field", "ACTIVE");
    });

  // a consistency check — the DOM against the embedded registry — not a
  // re-proof of the underlying facts; those live behind the evidence links
  var claimReport = verifyClaims();
  bootLog("VERIFY claims↔DOM (" + claimReport.checked + ")", claimReport.ok ? "PASS" : "FAIL");
  if (!claimReport.ok && window.console) console.warn("[DMDS] claim verification failed:", claimReport.failures);

  Promise.all([
    glInit,
    new Promise(function (res) {
      if (document.readyState === "complete") res();
      else window.addEventListener("load", res);
    })
  ]).then(function () {
    if (!booted) { booted = true; bootLog("BOOT dmds.sys", "READY", { last: true, status: "ALL CHECKS COMPLETE" }); }
    loadDone = true;
  });

  // hard timeout so a stalled asset never traps the visitor
  setTimeout(function () {
    if (!booted) { booted = true; bootLog("BOOT dmds.sys", "TIMEOUT — CONTINUING", { last: true }); }
    loadDone = true;
  }, 2600);
  requestAnimationFrame(tickLoader);

  /* ═══ Smooth scroll — native scroll is the source of truth ═══
     Wheel input retargets `targetY`; a rAF loop eases the REAL scroll
     position toward it with window.scrollTo. Anything else that moves
     the page (keys, find-in-page, tab focus, scrollbar, history) is
     detected as an external scroll and adopted, never fought. */
  var cur = 0, targetY = 0, contentH = 0, vh = window.innerHeight;

  function measure() {
    vh = window.innerHeight;
    contentH = document.documentElement.scrollHeight;
    measureSections();
  }

  /* section metadata for HUD + formations */
  var sections = [];
  function measureSections() {
    sections = $$(".section[data-formation]").map(function (el) {
      return { el: el, top: el.offsetTop, height: el.offsetHeight, formation: el.dataset.formation, index: el.dataset.index, dim: parseFloat(el.dataset.dim || "1") };
    });
  }

  var hudFill = $("#hud-fill"), hudCurrent = $("#hud-current");
  var manifestoWords = [];
  var manifestoSection = $("#manifesto");
  var lastFormation = "", lastIndex = "", lastY = 0;
  var manualLock = true; // starts locked for the intro assembly
  var manualY0 = 0;      // scroll position when a manual mode grabbed the engine

  function smooth01(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

  function onScrollUpdate(y) {
    // HUD progress
    var max = Math.max(contentH - vh, 1);
    hudFill.style.height = Math.min(100, (y / max) * 100) + "%";

    // dominant section (HUD index)
    var mid = y + vh * 0.5, active = sections[0], activeI = 0;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].top <= mid) { active = sections[i]; activeI = i; }
    }
    if (active && active.index !== lastIndex) {
      hudCurrent.textContent = active.index;
      lastIndex = active.index;
    }

    // scroll-scrubbed formation choreography: the field morphs WITH the
    // scroll, forward and backward, like scrubbing a timeline
    if (glOK && !manualLock && sections.length) {
      if (REDUCED) {
        if (active.formation !== lastFormation) {
          GL.setFormation(active.formation);
          GL.setDim(active.dim);
          lastFormation = active.formation;
        }
      } else {
        var cur = 0, t = 0;
        for (var s = 0; s + 1 < sections.length; s++) {
          var wStart = sections[s + 1].top - vh * 0.9;
          var wEnd = sections[s + 1].top - vh * 0.2;
          if (y >= wEnd) { cur = s + 1; t = 0; }
          else if (y > wStart) { cur = s; t = (y - wStart) / (wEnd - wStart); break; }
          else break;
        }
        var a = sections[cur], b = sections[Math.min(cur + 1, sections.length - 1)];
        GL.setMorphPair(a.formation, b.formation, t);
        GL.setDim(a.dim + (b.dim - a.dim) * smooth01(t));
        var nowFormation = t >= 0.5 ? b.formation : a.formation;
        if (nowFormation !== lastFormation) sfx("morph");
        lastFormation = nowFormation;
      }
    }

    // manifesto word illumination
    if (manifestoWords.length) {
      var mTop = manifestoSection.offsetTop;
      var p = (y - mTop + vh * 0.78) / (manifestoSection.offsetHeight * 0.82);
      var lit = Math.floor(Math.max(0, Math.min(1, p)) * manifestoWords.length);
      for (var w = 0; w < manifestoWords.length; w++) {
        manifestoWords[w].classList.toggle("lit", w < lit);
      }
    }

    // scroll velocity → particle turbulence + drone swell
    var v = Math.abs(y - lastY);
    if (v > 2 && glOK) GL.kick(v * 0.004);
    if (snd.on && snd.droneGain) {
      var dg = 0.05 + Math.min(v * 0.005, 0.11);
      if (Math.abs(dg - snd.droneTarget) > 0.012) {
        snd.droneTarget = dg;
        snd.droneGain.gain.setTargetAtTime(dg, snd.ctx.currentTime, 0.25);
      }
    }
    lastY = y;

    // scrolling far enough reclaims the engine from hover/typing
    if (manualLock && doc.classList.contains("loaded") && Math.abs(y - manualY0) > 90) {
      if (typingActive) exitType(true);
      manualLock = false;
    }
  }

  var nav = $("#nav"), navScrolled = false;
  var lastSetY = -1;
  var maxScroll = function () { return Math.max(0, contentH - vh); };

  if (SMOOTH) {
    window.addEventListener("wheel", function (e) {
      if (e.ctrlKey || e.metaKey) return; // pinch-zoom / modifier gestures stay native
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // horizontal swipes stay native
      e.preventDefault();
      var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * vh : e.deltaY;
      targetY = Math.max(0, Math.min(maxScroll(), targetY + dy));
    }, { passive: false });
  }

  function raf() {
    requestAnimationFrame(raf);
    var y = window.scrollY || window.pageYOffset;
    if (SMOOTH) {
      // external movement (keys, find, focus, scrollbar, history) wins
      if (Math.abs(y - lastSetY) > 1.5) cur = targetY = y;
      if (Math.abs(targetY - cur) > 0.15) {
        cur += (targetY - cur) * 0.085;
        lastSetY = cur;
        window.scrollTo(0, cur);
      } else {
        cur = targetY;
        lastSetY = y;
      }
    } else {
      cur = y;
    }
    var scrolled = cur > vh * 0.7;
    if (scrolled !== navScrolled) {
      navScrolled = scrolled;
      nav.classList.toggle("nav--scrolled", scrolled);
    }
    // scroll-driven camera parallax (tier 1 only; tier 2 has no camera truck)
    if (glOK && GL.setScroll) GL.setScroll(maxScroll() ? cur / maxScroll() : 0);
    onScrollUpdate(cur);
    updateCursor();
  }

  /* anchor navigation: retarget the eased scroll (desktop) or hand the
     jump to native smooth scrolling (touch / reduced motion) */
  $$("a[href^='#']").forEach(function (a) {
    a.addEventListener("click", function (e) {
      var id = a.getAttribute("href");
      var el = id.length > 1 && $(id);
      if (!el) return;
      e.preventDefault();
      if (SMOOTH) targetY = Math.max(0, Math.min(maxScroll(), el.offsetTop));
      else window.scrollTo({ top: el.offsetTop, behavior: REDUCED ? "auto" : "smooth" });
    });
  });

  /* ═══ Manifesto: wrap words ═══ */
  (function () {
    var el = $("#manifesto-text");
    if (!el) return;
    var words = el.textContent.trim().split(/\s+/);
    el.innerHTML = words.map(function (w) { return "<span class='w'>" + w + "</span>"; }).join(" ");
    manifestoWords = $$(".w", el);
  })();

  /* ═══ Reveals ═══ */
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) {
        en.target.classList.add("is-in");
        io.unobserve(en.target);
        if (en.target.classList.contains("stat")) countUp(en.target);
      }
    });
  }, { rootMargin: "0px 0px -12% 0px", threshold: 0.05 });
  $$(".reveal, .reveal-lines").forEach(function (el) { io.observe(el); });

  /* ═══ Stat counters ═══
     Markup carries the real value (no-JS readers see the truth);
     the animation resets to 0 and counts back up to data-count. */
  function countUp(stat) {
    var numEl = $(".stat__num", stat);
    if (!numEl) return;
    var end = parseInt(numEl.dataset.count, 10) || 0;
    var t0 = null;
    function step(ts) {
      if (!t0) t0 = ts;
      var p = Math.min(1, (ts - t0) / 1400);
      var eased = 1 - Math.pow(1 - p, 4);
      numEl.textContent = Math.round(end * eased);
      if (p < 1) requestAnimationFrame(step);
    }
    if (REDUCED) { numEl.textContent = end; } else { numEl.textContent = "0"; requestAnimationFrame(step); }
  }

  /* ═══ Scramble text ═══ */
  var GLYPHS = "█▓▒░<>/\\{}[]()=+*#%@$0123456789";
  function scramble(el) {
    if (REDUCED || el._scrambling) return;
    el._scrambling = true;
    var original = el.dataset.text || el.textContent;
    el.dataset.text = original;
    var frame = 0, total = Math.max(10, original.length * 2);
    (function run() {
      frame++;
      var out = "";
      for (var i = 0; i < original.length; i++) {
        var revealAt = (i / original.length) * total * 0.7;
        out += frame > revealAt + 4 ? original[i]
             : original[i] === " " ? " "
             : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      el.textContent = out;
      if (frame < total) requestAnimationFrame(run);
      else { el.textContent = original; el._scrambling = false; }
    })();
  }
  $$(".scramble").forEach(function (el) {
    // the accessible name must never scramble: SRs announce at focus
    // time, mid-animation — pin the real name before any frame runs
    if (!el.hasAttribute("aria-label")) el.setAttribute("aria-label", el.textContent.trim());
    el.addEventListener("mouseenter", function () { scramble(el); });
    el.addEventListener("focus", function () { scramble(el); });
  });

  /* ═══ Hero: live typesetting — the engine takes dictation ═══
     Ambient capture is deliberately narrow: hero on stage only, no
     modifier keys, no IME composition, never when focus is inside an
     interactive element, preventDefault only on keys it consumes.
     Activation and exit are announced to assistive technology. */
  var engineHint = $("#engine-hint"), engineInput = $("#engine-input"), engineBuffer = $("#engine-buffer");
  var engineLive = $("#engine-live");
  var typeBuffer = "", typeTimer = null, typeIdleTimer = null, typingActive = false;

  function announce(msg) { if (engineLive) engineLive.textContent = msg; }

  function updateReadout() {
    if (!engineInput) return;
    engineHint.hidden = typingActive;
    engineInput.hidden = !typingActive;
    engineBuffer.textContent = typeBuffer;
  }

  function exitType(silent) {
    if (!typingActive && !typeBuffer) return;
    typingActive = false;
    typeBuffer = "";
    clearTimeout(typeTimer);
    clearTimeout(typeIdleTimer);
    updateReadout();
    announce("Type mode exited.");
    if (!silent && glOK) GL.setFormation("logo", 1.1);
    manualLock = false;
  }

  if (!TOUCH && !REDUCED) {
    window.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      var tgt = e.target;
      if (tgt && tgt.closest && tgt.closest("input, textarea, select, button, a, [contenteditable]")) return;
      if (!glOK || !doc.classList.contains("loaded")) return;
      if (cur > vh * 0.6) return; // keyboard is live only while the hero is on stage
      var k = e.key;
      if (k === "Escape") { exitType(); return; }
      if (k === "Backspace") {
        if (!typingActive) return;
        typeBuffer = typeBuffer.slice(0, -1);
      } else if (/^[a-zA-Z0-9 !?&+.\-]$/.test(k)) {
        if (k === " " && !typingActive) return; // space still scrolls until you're typing
        if (typeBuffer.length >= 12) return;
        typeBuffer += k.toUpperCase();
      } else return;
      e.preventDefault();
      if (!typingActive) announce("Type mode active — the particle field is typesetting your input. Press Escape to exit.");
      typingActive = true;
      manualLock = true;
      manualY0 = cur;
      updateReadout();
      sfx("key");
      clearTimeout(typeTimer);
      typeTimer = setTimeout(function () {
        var s = typeBuffer.trim();
        GL.setFormation(s ? "text:" + s : "logo", 0.9);
        sfx("morph");
      }, 200);
      clearTimeout(typeIdleTimer);
      typeIdleTimer = setTimeout(exitType, 9000);
    });
  }

  /* ═══ Dossiers: native disclosure buttons open the evidence ═══
     aria-expanded lives on the button, visibility on the row class;
     without JS the dossiers simply render expanded. */
  $$(".work__row").forEach(function (row) {
    var btn = $("button.work__line", row), dossier = $(".dossier", row);
    if (!btn || !dossier) return;
    btn.addEventListener("click", function () {
      var open = row.classList.toggle("open");
      btn.setAttribute("aria-expanded", String(open));
      sfx("blip");
      measure();               // dossier changes page height — virtual scroll must know
      setTimeout(measure, 400);
    });
  });

  /* ═══ Work rows drive the engine ═══ */
  $$(".work__row[data-particles]").forEach(function (row) {
    if (TOUCH || REDUCED) return;
    row.addEventListener("mouseenter", function () {
      if (!glOK || typingActive) return;
      manualLock = true;
      manualY0 = cur;
      GL.setDim(0.95);
      GL.setFormation("text:" + row.dataset.particles, 1.0);
      sfx("morph");
    });
    row.addEventListener("mouseleave", function () {
      if (!glOK || typingActive) return;
      GL.setDim(0.32);
      GL.setFormation("ambient", 1.0);
      manualLock = false;
    });
  });

  /* ═══ Custom cursor ═══ */
  var cursor = $(".cursor"), dot = $(".cursor__dot"), ring = $(".cursor__ring");
  var mx = -100, my = -100, rx = -100, ry = -100;
  if (!TOUCH) {
    window.addEventListener("mousemove", function (e) { mx = e.clientX; my = e.clientY; });
    window.addEventListener("mousedown", function () { cursor.classList.add("cursor--down"); });
    window.addEventListener("mouseup", function () { cursor.classList.remove("cursor--down"); });
    var cursorLabel = $("#cursor-label");
    $$("[data-cursor], a, button").forEach(function (el) {
      el.addEventListener("mouseenter", function () {
        cursor.classList.add("cursor--active");
        var label = el.dataset.cursorLabel || "";
        cursorLabel.textContent = label;
        cursor.classList.toggle("cursor--labeled", !!label);
        sfx("blip");
      });
      el.addEventListener("mouseleave", function () {
        cursor.classList.remove("cursor--active");
        cursor.classList.remove("cursor--labeled");
      });
    });
  }
  function updateCursor() {
    if (TOUCH) return;
    dot.style.transform = "translate(" + mx + "px," + my + "px)";
    rx += (mx - rx) * 0.16;
    ry += (my - ry) * 0.16;
    ring.style.transform = "translate(" + rx + "px," + ry + "px) scale(var(--ring-s,1))";
  }

  /* ═══ Magnetic CTA ═══ */
  $$("[data-magnetic]").forEach(function (el) {
    if (TOUCH || REDUCED) return;
    var strength = 0.32;
    el.addEventListener("mousemove", function (e) {
      var r = el.getBoundingClientRect();
      var dx = e.clientX - (r.left + r.width / 2);
      var dy = e.clientY - (r.top + r.height / 2);
      el.style.transform = "translate(" + dx * strength + "px," + dy * strength + "px)";
    });
    el.addEventListener("mouseleave", function () {
      el.style.transition = "transform .6s cubic-bezier(.19,1,.22,1)";
      el.style.transform = "";
      setTimeout(function () { el.style.transition = ""; }, 600);
    });
  });

  /* ═══ Transmit form ═══
     Success shows only after the endpoint confirms (HTTP 2xx). On any
     failure the filled form stays on screen, the draft is in
     localStorage, and a copy-to-clipboard recovery path appears —
     losing the visitor's message is the one unforgivable failure. */
  (function () {
    var form = $("#transmit"), done = $("#transmit-done"), label = $("#transmit-label");
    var recover = $("#transmit-recover"), copyBtn = $("#copy-brief");
    if (!form) return;
    var els = form.elements;
    var formT0 = 0; // stamped on first real interaction, not page load
    var lastComposed = "";
    var DRAFT_KEY = "dmds-draft";
    var DRAFT_TTL = 7 * 86400000; // drafts expire — this is a recovery net, not storage

    form.addEventListener("focusin", function () { if (!formT0) formT0 = performance.now(); });

    // draft preservation: survive reloads, crashes, and mailto detours
    try {
      var draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
      if (draft && (!draft.t || Date.now() - draft.t > DRAFT_TTL)) {
        localStorage.removeItem(DRAFT_KEY);
        draft = null;
      }
      if (draft) {
        if (draft.name) els.namedItem("name").value = draft.name;
        if (draft.email) els.namedItem("email").value = draft.email;
        if (draft.brief) els.namedItem("brief").value = draft.brief;
        if (draft.project) {
          var radio = form.querySelector("input[name=project][value='" + draft.project + "']");
          if (radio) radio.checked = true;
        }
      }
    } catch (e) {}
    var draftTimer = null;
    form.addEventListener("input", function () {
      if (!formT0) formT0 = performance.now();
      clearTimeout(draftTimer);
      draftTimer = setTimeout(function () {
        try {
          localStorage.setItem(DRAFT_KEY, JSON.stringify({
            t: Date.now(),
            name: els.namedItem("name").value,
            email: els.namedItem("email").value,
            project: (form.querySelector("input[name=project]:checked") || {}).value,
            brief: els.namedItem("brief").value
          }));
        } catch (e) {}
      }, 400);
    });

    if (copyBtn) copyBtn.addEventListener("click", function () {
      function flash(ok) {
        copyBtn.textContent = ok ? "COPIED" : "SELECT + COPY MANUALLY";
        setTimeout(function () { copyBtn.textContent = "COPY MESSAGE"; }, 2200);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(lastComposed).then(function () { flash(true); }, function () { flash(false); });
      } else {
        var ta = document.createElement("textarea");
        ta.value = lastComposed;
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(ta);
        flash(ok);
      }
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (els.namedItem("_gotcha").value) return;               // bot: honeypot
      // instant fill (autofill, paste, bot) is a risk signal, not proof —
      // never silently eat the submission: ask for one confirming press
      if (!formT0 || performance.now() - formT0 < 2000) {
        formT0 = performance.now() - 2000; // the next press goes through
        label.textContent = "QUICK CHECK — PRESS TRANSMIT AGAIN TO SEND";
        setTimeout(function () { label.textContent = "START A PROJECT"; }, 3000);
        return;
      }
      if (!form.reportValidity()) return;
      var data = {
        name: els.namedItem("name").value.trim(),
        email: els.namedItem("email").value.trim(),
        project: (form.querySelector("input[name=project]:checked") || {}).value || "Unspecified",
        brief: els.namedItem("brief").value.trim(),
        source: "dmds-site"
      };
      var endpoint = form.dataset.endpoint;
      function succeed() {
        try { localStorage.removeItem(DRAFT_KEY); } catch (err) {}
        form.hidden = true;
        done.hidden = false;
        sfx("morph");
        measure();
      }
      function fallbackMail() {
        var body = "Name: " + data.name + "\nEmail: " + data.email +
          "\nBuilding: " + data.project + "\n\nBrief:\n" + data.brief;
        lastComposed = "To: dennis@shorevapesli.com\nSubject: Project inquiry — DMDS (" + data.project + ")\n\n" + body;
        window.location.href = "mailto:dennis@shorevapesli.com?subject=" +
          encodeURIComponent("Project inquiry — DMDS (" + data.project + ")") +
          "&body=" + encodeURIComponent(body);
        label.textContent = "OPENING YOUR MAIL CLIENT…";
        if (recover) { recover.hidden = false; measure(); }
        setTimeout(function () { label.textContent = "START A PROJECT"; }, 2500);
      }
      if (endpoint) {
        label.textContent = "TRANSMITTING…";
        fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data)
        }).then(function (r) {
          if (r.ok) succeed(); else fallbackMail();
        }).catch(fallbackMail);
      } else {
        fallbackMail();
      }
    });
  })();

  /* ═══ Sound — synthesized in-house, zero assets ═══ */
  var snd = { ctx: null, on: false, master: null, droneGain: null, droneTarget: 0.05 };

  function sndInit() {
    if (snd.ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    var ctx = snd.ctx = new AC();
    snd.master = ctx.createGain();
    snd.master.gain.value = 0;
    snd.master.connect(ctx.destination);

    // drone: two detuned oscillators through a dark lowpass
    var lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 190; lp.Q.value = 0.6;
    snd.droneGain = ctx.createGain();
    snd.droneGain.gain.value = 0.05;
    [55, 55.7].forEach(function (f) {
      var o = ctx.createOscillator();
      o.type = "sawtooth"; o.frequency.value = f;
      o.connect(lp); o.start();
    });
    lp.connect(snd.droneGain);
    snd.droneGain.connect(snd.master);

    // airy noise bed
    var len = ctx.sampleRate * 2;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.4;
    var noise = ctx.createBufferSource();
    noise.buffer = buf; noise.loop = true;
    var bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 420; bp.Q.value = 0.4;
    var ng = ctx.createGain(); ng.gain.value = 0.012;
    noise.connect(bp); bp.connect(ng); ng.connect(snd.master); noise.start();
  }

  function sfx(kind) {
    if (!snd.on || !snd.ctx) return;
    var ctx = snd.ctx, t = ctx.currentTime;
    if (kind === "blip") {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(920, t);
      o.frequency.exponentialRampToValueAtTime(1480, t + 0.06);
      g.gain.setValueAtTime(0.05, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      o.connect(g); g.connect(snd.master); o.start(t); o.stop(t + 0.12);
    } else if (kind === "key") {
      var o2 = ctx.createOscillator(), g2 = ctx.createGain();
      o2.type = "square"; o2.frequency.value = 1700 + Math.random() * 500;
      g2.gain.setValueAtTime(0.028, t);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
      o2.connect(g2); g2.connect(snd.master); o2.start(t); o2.stop(t + 0.05);
    } else if (kind === "morph") {
      var len = ctx.sampleRate * 0.5;
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      var src = ctx.createBufferSource(); src.buffer = buf;
      var f = ctx.createBiquadFilter();
      f.type = "bandpass"; f.Q.value = 1.4;
      f.frequency.setValueAtTime(180, t);
      f.frequency.exponentialRampToValueAtTime(1300, t + 0.4);
      var g3 = ctx.createGain();
      g3.gain.setValueAtTime(0.1, t);
      g3.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      src.connect(f); f.connect(g3); g3.connect(snd.master); src.start(t);
    }
  }

  var sndToggle = $("#snd-toggle");
  if (sndToggle) {
    sndToggle.addEventListener("click", function () {
      sndInit();
      if (!snd.ctx) return;
      if (snd.ctx.state === "suspended") snd.ctx.resume();
      snd.on = !snd.on;
      snd.master.gain.setTargetAtTime(snd.on ? 0.85 : 0, snd.ctx.currentTime, 0.15);
      sndToggle.innerHTML = "SND&nbsp;·&nbsp;" + (snd.on ? "ON" : "OFF");
      sndToggle.classList.toggle("on", snd.on);
      sndToggle.setAttribute("aria-pressed", String(snd.on));
      if (snd.on) sfx("blip");
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (!snd.ctx) return;
    if (document.hidden) snd.ctx.suspend();
    else if (snd.on) snd.ctx.resume();
  });

  /* ═══ Tab title: signal integrity ═══ */
  var baseTitle = document.title;
  window.addEventListener("blur", function () { document.title = "[ SIGNAL LOST ] — DMDS®"; });
  window.addEventListener("focus", function () { document.title = baseTitle; });

  /* ═══ Clocks + FPS ═══
     The zone label comes from Intl, so it reads EST or EDT truthfully
     across daylight-saving transitions. */
  var clockFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short"
  });
  function tickClock() {
    var t = "", zone = "ET";
    clockFmt.formatToParts(new Date()).forEach(function (p) {
      if (p.type === "hour" || p.type === "minute" || p.type === "second") t += (t ? ":" : "") + p.value;
      else if (p.type === "timeZoneName") zone = p.value;
    });
    t += " " + zone;
    var c1 = $("#clock"), c2 = $("#clock-2");
    if (c1) c1.textContent = t;
    if (c2) c2.textContent = t;
  }
  tickClock();
  setInterval(tickClock, 1000);

  var fpsEl = $("#fps");
  setInterval(function () {
    if (fpsEl && glOK) fpsEl.textContent = GL.fps();
  }, 800);

  /* ═══ Footer status: says what the renderer is actually doing ═══ */
  var sysStatus = $("#sys-status");
  function updateSysStatus() {
    if (!sysStatus) return;
    if (!glOK) { sysStatus.textContent = "STATIC RENDER · CONTENT NOMINAL"; return; }
    var s = GL.status();
    // tier 1 reports a governed `degraded` flag (post rungs count too, not
    // just particle cuts); tier 2 keeps the count<max convention
    var degraded = s.degraded !== undefined ? s.degraded : s.count < s.max;
    sysStatus.textContent = degraded
      ? "RENDER DEGRADED · CORE NOMINAL"
      : "ALL SYSTEMS NOMINAL";
  }
  glInit.then(updateSysStatus);
  setInterval(updateSysStatus, 4000);

  /* ═══ Boot ═══ */
  window.addEventListener("resize", measure);
  // re-measure after fonts settle layout
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { setTimeout(measure, 60); });
  measure();
  setTimeout(measure, 400);
  raf();

  /* eslint-disable no-console */
  glInit.then(function () {
    var s0 = glOK ? GL.status() : null;
    var count = s0 ? (s0.count || s0.max).toLocaleString("en-US") + " particles · 1 draw call" : "static render";
    console.log(
      "%c DMDS® %c ENGINEERED, NOT DECORATED. \n" +
      "%c " + count + " · 0 external requests on load.\n" +
      " We audit our console too. → dennis@shorevapesli.com",
      "background:#ff4a00;color:#0b0b0c;font-weight:bold;padding:4px 8px;",
      "background:#0b0b0c;color:#edeae3;padding:4px 8px;",
      "color:#8a8781;"
    );
  });
})();
