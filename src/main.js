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
  if (SMOOTH) doc.classList.add("smooth");

  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  /* ═══ Preloader — boot sequence ═══ */
  var loader = $("#loader"), pctEl = $("#loader-pct"), barEl = $("#loader-bar"), statusEl = $("#loader-status");
  var logEl = $("#loader-log");
  var progress = 0, target = 0, loadDone = false;
  var STATUSES = ["INITIALIZING RENDER", "EMBEDDING TYPEFACES", "COMPILING SHADERS", "SEEDING 42,000 PARTICLES", "ALL SYSTEMS NOMINAL"];
  var BOOT_LOG = [
    [4,  "MOUNT /typefaces", "OK"],
    [22, "COMPILE vertex + fragment", "OK"],
    [42, "SEED particles", "42,000"],
    [62, "LINK render loop", "60 FPS"],
    [82, "VERIFY claims", "PASS"],
    [97, "BOOT dmds.sys", "READY"]
  ];
  var logIdx = 0;

  var loaderT0 = performance.now();
  function tickLoader() {
    // time-driven so blocked frames (shader compile) can't stall the count
    var elapsed = performance.now() - loaderT0;
    target = Math.max(target, Math.min(loadDone ? 100 : 92, (elapsed / 1800) * 100));
    progress += (target - progress) * 0.2;
    var p = Math.min(100, Math.round(progress));
    pctEl.textContent = ("00" + p).slice(-3);
    barEl.style.width = p + "%";
    statusEl.textContent = STATUSES[Math.min(Math.floor(p / 22), STATUSES.length - 1)];
    while (logIdx < BOOT_LOG.length && p >= BOOT_LOG[logIdx][0]) {
      var entry = BOOT_LOG[logIdx];
      var line = document.createElement("div");
      line.className = "loader__log-line" + (logIdx === BOOT_LOG.length - 1 ? " loader__log-line--last" : "");
      var dots = new Array(Math.max(2, 30 - entry[1].length)).join(".");
      line.innerHTML = "<span>" + entry[1] + " " + dots + "</span><span>" + entry[2] + "</span>";
      logEl.appendChild(line);
      logIdx++;
    }
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

  /* ═══ GL boot ═══ */
  var glOK = false;
  var glInit = (window.DMDS_GL ? window.DMDS_GL.init($("#gl")) : Promise.reject())
    .then(function () { glOK = true; })
    .catch(function () { $("#gl").style.opacity = "0.5"; /* CSS gradient fallback remains */ });

  Promise.all([
    glInit,
    new Promise(function (res) {
      if (document.readyState === "complete") res();
      else window.addEventListener("load", res);
    })
  ]).then(function () { loadDone = true; });

  // hard timeout so a stalled asset never traps the visitor
  setTimeout(function () { loadDone = true; }, 2600);
  requestAnimationFrame(tickLoader);

  /* ═══ Virtual scroll ═══ */
  var wrap = $("#scroll-wrap");
  var cur = 0, targetY = 0, contentH = 0, vh = window.innerHeight;

  function measure() {
    vh = window.innerHeight;
    contentH = wrap.scrollHeight;
    if (SMOOTH) document.body.style.height = contentH + "px";
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
          window.DMDS_GL.setFormation(active.formation);
          window.DMDS_GL.setDim(active.dim);
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
        window.DMDS_GL.setMorphPair(a.formation, b.formation, t);
        window.DMDS_GL.setDim(a.dim + (b.dim - a.dim) * smooth01(t));
        lastFormation = t >= 0.5 ? b.formation : a.formation;
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

    // scroll velocity → particle turbulence
    var v = Math.abs(y - lastY);
    if (v > 2 && glOK) window.DMDS_GL.kick(v * 0.004);
    lastY = y;

    // scrolling far enough reclaims the engine from hover/typing
    if (manualLock && doc.classList.contains("loaded") && Math.abs(y - manualY0) > 90) {
      if (typingActive) exitType(true);
      manualLock = false;
    }
  }

  function raf() {
    requestAnimationFrame(raf);
    targetY = window.scrollY || window.pageYOffset;
    if (SMOOTH) {
      cur += (targetY - cur) * 0.085;
      if (Math.abs(targetY - cur) < 0.1) cur = targetY;
      wrap.style.transform = "translate3d(0," + -cur + "px,0)";
    } else {
      cur = targetY;
    }
    onScrollUpdate(cur);
    updateCursor();
  }

  /* anchor navigation works against native scroll position */
  $$("a[href^='#']").forEach(function (a) {
    a.addEventListener("click", function (e) {
      var id = a.getAttribute("href");
      var el = id.length > 1 && $(id);
      if (!el) return;
      e.preventDefault();
      window.scrollTo({ top: el.offsetTop, behavior: SMOOTH ? "auto" : "smooth" });
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

  /* ═══ Stat counters ═══ */
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
    if (REDUCED) { numEl.textContent = end; } else { requestAnimationFrame(step); }
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
    el.addEventListener("mouseenter", function () { scramble(el); });
    el.addEventListener("focus", function () { scramble(el); });
  });

  /* ═══ Hero: live typesetting — the engine takes dictation ═══ */
  var engineHint = $("#engine-hint"), engineInput = $("#engine-input"), engineBuffer = $("#engine-buffer");
  var typeBuffer = "", typeTimer = null, typeIdleTimer = null, typingActive = false;

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
    if (!silent && glOK) window.DMDS_GL.setFormation("logo", 1.1);
    manualLock = false;
  }

  if (!TOUCH && !REDUCED) {
    window.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
      typingActive = true;
      manualLock = true;
      manualY0 = cur;
      updateReadout();
      clearTimeout(typeTimer);
      typeTimer = setTimeout(function () {
        var s = typeBuffer.trim();
        window.DMDS_GL.setFormation(s ? "text:" + s : "logo", 0.9);
      }, 200);
      clearTimeout(typeIdleTimer);
      typeIdleTimer = setTimeout(exitType, 9000);
    });
  }

  /* ═══ Work rows drive the engine ═══ */
  $$(".work__row[data-particles]").forEach(function (row) {
    if (TOUCH || REDUCED) return;
    row.addEventListener("mouseenter", function () {
      if (!glOK || typingActive) return;
      manualLock = true;
      manualY0 = cur;
      window.DMDS_GL.setDim(0.95);
      window.DMDS_GL.setFormation("text:" + row.dataset.particles, 1.0);
    });
    row.addEventListener("mouseleave", function () {
      if (!glOK || typingActive) return;
      window.DMDS_GL.setDim(0.32);
      window.DMDS_GL.setFormation("ambient", 1.0);
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

  /* ═══ Clocks + FPS ═══ */
  var clockFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  function tickClock() {
    var t = clockFmt.format(new Date()) + " EST";
    var c1 = $("#clock"), c2 = $("#clock-2");
    if (c1) c1.textContent = t;
    if (c2) c2.textContent = t;
  }
  tickClock();
  setInterval(tickClock, 1000);

  var fpsEl = $("#fps");
  setInterval(function () {
    if (fpsEl && glOK) fpsEl.textContent = window.DMDS_GL.fps();
  }, 800);

  /* ═══ Boot ═══ */
  window.addEventListener("resize", measure);
  // re-measure after fonts settle layout
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { setTimeout(measure, 60); });
  measure();
  setTimeout(measure, 400);
  raf();

  /* eslint-disable no-console */
  console.log(
    "%c DMDS® %c ENGINEERED, NOT DECORATED. \n" +
    "%c 42,000 particles · 1 draw call · 0 external requests.\n" +
    " We audit our console too. → dennis@shorevapesli.com",
    "background:#ff4a00;color:#0b0b0c;font-weight:bold;padding:4px 8px;",
    "background:#0b0b0c;color:#edeae3;padding:4px 8px;",
    "color:#8a8781;"
  );
})();
