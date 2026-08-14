/* DMDS™ subpage runtime — reveals, clock, transmit.
   No engine, no loader, no sound: subpages are the static tier by
   design. The transmit contract matches main.js: success only on a
   confirmed 2xx, drafts persist locally, mailto is a recovery path,
   and the visitor's message is never lost. */
(function () {
  "use strict";
  document.documentElement.classList.add("js", "loaded");

  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  /* ═══ Reveals — one-shot IntersectionObserver (styles gate on html.js,
     so no-JS readers see everything) ═══ */
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("is-in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.15 });
    $$(".reveal, .reveal-lines").forEach(function (el) { io.observe(el); });
  } else {
    $$(".reveal, .reveal-lines").forEach(function (el) { el.classList.add("is-in"); });
  }

  /* ═══ Clock — Intl supplies the zone label (never hardcoded) ═══ */
  var clockFmt = new Intl.DateTimeFormat("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
    timeZone: "America/New_York", timeZoneName: "short"
  });
  function tickClock() {
    var t = "", z = "ET";
    clockFmt.formatToParts(new Date()).forEach(function (p) {
      if (p.type === "hour" || p.type === "minute" || p.type === "second") t += (t ? ":" : "") + p.value;
      if (p.type === "timeZoneName") z = p.value;
    });
    var c1 = $("#clock"), c2 = $("#clock-2");
    if (c1) c1.textContent = t + " " + z;
    if (c2) c2.textContent = z;
  }
  tickClock();
  setInterval(tickClock, 1000);

  /* ═══ Transmit ═══ */
  (function () {
    var form = $("#transmit"), done = $("#transmit-done"), label = $("#transmit-label");
    var recover = $("#transmit-recover"), copyBtn = $("#copy-brief");
    if (!form) return;
    var els = form.elements;
    var formT0 = 0;
    var lastComposed = "";
    var DRAFT_KEY = "dmds-draft-contractor";
    var DRAFT_TTL = 7 * 86400000;
    var CTA_TEXT = label ? label.textContent : "GET YOUR FREE DIAGNOSIS";

    form.addEventListener("focusin", function () { if (!formT0) formT0 = performance.now(); });

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
      if (els.namedItem("_gotcha").value) return;
      if (!formT0 || performance.now() - formT0 < 2000) {
        formT0 = performance.now() - 2000;
        label.textContent = "QUICK CHECK — HIT THE BUTTON AGAIN TO SEND";
        setTimeout(function () { label.textContent = CTA_TEXT; }, 3000);
        return;
      }
      if (!form.reportValidity()) return;
      var data = {
        name: els.namedItem("name").value.trim(),
        email: els.namedItem("email").value.trim(),
        project: (form.querySelector("input[name=project]:checked") || {}).value || "Unspecified",
        brief: els.namedItem("brief").value.trim(),
        source: "dmds-contractor-page"
      };
      var endpoint = form.dataset.endpoint;
      function succeed() {
        try { localStorage.removeItem(DRAFT_KEY); } catch (err) {}
        form.hidden = true;
        done.hidden = false;
      }
      function fallbackMail() {
        var body = "Name: " + data.name + "\nEmail: " + data.email +
          "\nWhat's broken: " + data.project + "\n\nBrief:\n" + data.brief;
        lastComposed = "To: dennis@dmds.studio\nSubject: Contractor site inquiry — DMDS (" + data.project + ")\n\n" + body;
        window.location.href = "mailto:dennis@dmds.studio?subject=" +
          encodeURIComponent("Contractor site inquiry — DMDS (" + data.project + ")") +
          "&body=" + encodeURIComponent(body);
        label.textContent = "OPENING YOUR MAIL CLIENT…";
        if (recover) recover.hidden = false;
        setTimeout(function () { label.textContent = CTA_TEXT; }, 2500);
      }
      if (endpoint) {
        label.textContent = "SENDING…";
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
})();
