/* ═══════════════════════════════════════════════════════════════
   DMDS® — particle engine
   Hand-rolled WebGL1. One draw call. Six formations, GPU-morphed.
   No three.js — every byte here is ours.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var MOBILE = Math.min(window.innerWidth, window.innerHeight) < 720 || "ontouchstart" in window;
  var COUNT = MOBILE ? 16000 : 42000;
  var DPR_CAP = MOBILE ? 1.5 : 1.75;

  var VERT = [
    "precision mediump float;",
    "attribute vec3 aPosA;",
    "attribute vec3 aPosB;",
    "attribute vec4 aRand;", // x: stagger  y: colorMix  z: size  w: phase
    "uniform mat4 uProj;",
    "uniform mat4 uView;",
    "uniform float uTime;",
    "uniform float uMix;",
    "uniform float uNoise;",
    "uniform float uTurb;",
    "uniform vec3 uMouse;",
    "uniform float uMouseStr;",
    "uniform float uSize;",
    "varying float vMix;",
    "varying float vTwinkle;",
    "varying float vDepth;",
    "float ease(float t){ return t<0.5 ? 4.0*t*t*t : 1.0-pow(-2.0*t+2.0,3.0)/2.0; }",
    "void main(){",
    "  float stag = clamp((uMix - aRand.x*0.35) / 0.65, 0.0, 1.0);",
    "  vec3 pos = mix(aPosA, aPosB, ease(stag));",
    // organic idle drift — three incommensurate sine fields ≈ cheap curl
    "  float amp = uNoise * (0.5 + aRand.z) + uTurb;",
    "  pos.x += amp * sin(pos.y*0.9 + uTime*0.7 + aRand.w*6.283);",
    "  pos.y += amp * sin(pos.z*1.1 + uTime*0.6 + aRand.w*4.0) * 0.8;",
    "  pos.z += amp * sin(pos.x*0.8 + uTime*0.5 + aRand.w*2.7) * 0.9;",
    // mouse repulsion in world space
    "  vec3 d = pos - uMouse;",
    "  float dist2 = dot(d.xy, d.xy);",
    "  pos.xy += normalize(d.xy + 0.0001) * exp(-dist2 * 0.18) * uMouseStr;",
    "  vec4 mv = uView * vec4(pos, 1.0);",
    "  gl_Position = uProj * mv;",
    "  float att = clamp(18.0 / -mv.z, 0.2, 2.2);",
    "  gl_PointSize = uSize * (0.55 + aRand.z * 0.9) * att;",
    "  vMix = aRand.y;",
    "  vTwinkle = 0.62 + 0.38 * sin(uTime * 1.7 + aRand.w * 6.283);",
    "  vDepth = clamp((-mv.z - 14.0) / 26.0, 0.0, 1.0);",
    "}"
  ].join("\n");

  var FRAG = [
    "precision mediump float;",
    "uniform vec3 uBone;",
    "uniform vec3 uSignal;",
    "uniform float uDim;",
    "varying float vMix;",
    "varying float vTwinkle;",
    "varying float vDepth;",
    "void main(){",
    "  vec2 c = gl_PointCoord - 0.5;",
    "  float d = length(c);",
    "  float a = smoothstep(0.5, 0.08, d);",
    "  vec3 col = mix(uBone, uSignal, step(0.88, vMix));",
    "  a *= vTwinkle * mix(1.0, 0.35, vDepth) * uDim;",
    "  gl_FragColor = vec4(col * a, a);",
    "}"
  ].join("\n");

  // ── tiny mat4 kit ──
  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function viewMatrix(rx, ry, z) {
    var cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
    // rotY then rotX then translate(0,0,-z)
    return [cy, sx * sy, -cx * sy, 0, 0, cx, sx, 0, sy, -sx * cy, cx * cy, 0, 0, 0, -z, 1];
  }

  var CAM_Z = 26, FOV = 35 * Math.PI / 180;

  var state = {
    gl: null, canvas: null, program: null, loc: {},
    bufA: null, bufB: null, bufR: null,
    formations: {}, currentName: null,
    curA: null, curB: null, mix: 1, mixTarget: 1, morphStart: 0, morphDur: REDUCED ? 0.01 : 1.5,
    time: 0, lastT: 0, turb: 0, turbTarget: 0,
    mouse: { x: 0, y: 0, wx: 0, wy: 0, str: 0, strTarget: 0 },
    dim: 1, dimTarget: 1,
    rot: { x: 0, y: 0 },
    fps: 60, frames: 0, fpsT: 0,
    hw: 8, hh: 8, ready: false, running: false
  };

  function worldExtents() {
    var hh = CAM_Z * Math.tan(FOV / 2);
    var hw = hh * (state.canvas.width / state.canvas.height);
    state.hw = hw; state.hh = hh;
  }

  // ═══ formation generators — each returns Float32Array(COUNT*3) ═══
  var R = (function () { var s = 1234567; return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; })();
  function gauss() { return (R() + R() + R() - 1.5) * 0.82; }

  function genAmbient() {
    var a = new Float32Array(COUNT * 3);
    for (var i = 0; i < COUNT; i++) {
      a[i * 3] = (R() * 2 - 1) * state.hw * 1.15;
      a[i * 3 + 1] = (R() * 2 - 1) * state.hh * 1.15;
      a[i * 3 + 2] = (R() * 2 - 1) * 9;
    }
    return a;
  }

  function genLogo(pts) {
    // pts: sampled text points in [0..1]x[0..1] (y up), aspect = w/h of text box
    var a = new Float32Array(COUNT * 3);
    var targetW = Math.min(state.hw * 1.5, state.hw * 2 * 0.78);
    var targetH = targetW / pts.aspect;
    var maxH = state.hh * 1.1;
    if (targetH > maxH) { targetH = maxH; targetW = targetH * pts.aspect; }
    var n = pts.xy.length / 2;
    for (var i = 0; i < COUNT; i++) {
      var j = (i % n) * 2;
      a[i * 3] = (pts.xy[j] - 0.5) * targetW + gauss() * 0.045;
      a[i * 3 + 1] = (pts.xy[j + 1] - 0.5) * targetH + gauss() * 0.045 + state.hh * 0.06;
      a[i * 3 + 2] = gauss() * 0.7;
    }
    return a;
  }

  function shiftX(kind) {
    if (MOBILE || state.hw < state.hh) return 0;
    return (kind === "left" ? -0.42 : 0.42) * state.hw;
  }

  function genGrid() {
    var a = new Float32Array(COUNT * 3);
    var cx = shiftX("right");
    var cols = Math.floor(Math.sqrt(COUNT));
    var w = Math.min(state.hw * 0.95, 13), d = 16;
    for (var i = 0; i < COUNT; i++) {
      var gx = (i % cols) / (cols - 1), gz = Math.floor(i / cols) / (cols - 1);
      var x = (gx - 0.5) * w, z = (gz - 0.5) * d;
      var y = -3.2 + Math.sin(x * 0.9) * Math.cos(z * 0.7) * 1.1 + Math.sin(z * 1.3) * 0.5;
      a[i * 3] = x + cx; a[i * 3 + 1] = y; a[i * 3 + 2] = z;
    }
    return a;
  }

  function genDevice() {
    var a = new Float32Array(COUNT * 3);
    var cx = shiftX("left");
    var W = 5.6, H = 11.2, r = 1.3;
    var perim = 2 * (W - 2 * r) + 2 * (H - 2 * r) + 2 * Math.PI * r;
    for (var i = 0; i < COUNT; i++) {
      var pick = R(), x, y, z;
      if (pick < 0.52) {
        // rounded-rect outline, 3 depth shells
        var t = R() * perim, hw2 = W / 2, hh2 = H / 2;
        var straightW = W - 2 * r, straightH = H - 2 * r, arc = Math.PI * r / 2;
        if (t < straightW) { x = -straightW / 2 + t; y = hh2; }
        else if ((t -= straightW) < arc) { var a1 = t / r; x = straightW / 2 + Math.sin(a1) * r; y = hh2 - r + Math.cos(a1) * r; }
        else if ((t -= arc) < straightH) { x = hw2; y = hh2 - r - t; }
        else if ((t -= straightH) < arc) { var a2 = t / r; x = hw2 - r + Math.cos(a2) * r; y = -hh2 + r - Math.sin(a2) * r; }
        else if ((t -= arc) < straightW) { x = hw2 - r - t; y = -hh2; }
        else if ((t -= straightW) < arc) { var a3 = t / r; x = -straightW / 2 - Math.sin(a3) * r; y = -hh2 + r - Math.cos(a3) * r; }
        else if ((t -= arc) < straightH) { x = -hw2; y = -hh2 + r + t; }
        else { var a4 = (t - straightH) / r; x = -hw2 + r - Math.cos(a4) * r; y = hh2 - r + Math.sin(a4) * r; }
        z = (Math.floor(R() * 3) - 1) * 0.35;
        x += gauss() * 0.03; y += gauss() * 0.03;
      } else if (pick < 0.62) {
        // dynamic island
        x = (R() - 0.5) * 1.6; y = H / 2 - 1.05 + (R() - 0.5) * 0.22; z = 0.2;
      } else if (pick < 0.9) {
        // UI bars on screen
        var row = Math.floor(R() * 4);
        var bw = [3.8, 4.4, 2.9, 4.1][row];
        x = (R() - 0.5) * bw;
        y = 2.2 - row * 1.7 + (R() - 0.5) * 0.42;
        z = 0.1;
      } else {
        // home indicator + sparkle inside
        if (R() < 0.5) { x = (R() - 0.5) * 2.2; y = -H / 2 + 0.7; z = 0.15; }
        else { x = (R() - 0.5) * (W - 1); y = (R() - 0.5) * (H - 1); z = -0.3; }
      }
      a[i * 3] = x + cx; a[i * 3 + 1] = y; a[i * 3 + 2] = z;
    }
    return a;
  }

  function genNeural() {
    var a = new Float32Array(COUNT * 3);
    var cx = shiftX("right");
    var NN = 34, nodes = [];
    for (var k = 0; k < NN; k++) {
      // fibonacci sphere
      var ph = Math.acos(1 - 2 * (k + 0.5) / NN), th = Math.PI * (1 + Math.sqrt(5)) * k;
      var rad = 5.4;
      nodes.push([rad * Math.sin(ph) * Math.cos(th), rad * Math.cos(ph), rad * Math.sin(ph) * Math.sin(th)]);
    }
    var edges = [];
    for (var m = 0; m < NN; m++) {
      var dists = [];
      for (var n2 = 0; n2 < NN; n2++) if (n2 !== m) {
        var dx = nodes[m][0] - nodes[n2][0], dy = nodes[m][1] - nodes[n2][1], dz = nodes[m][2] - nodes[n2][2];
        dists.push([dx * dx + dy * dy + dz * dz, n2]);
      }
      dists.sort(function (p, q) { return p[0] - q[0]; });
      edges.push([m, dists[0][1]], [m, dists[1][1]], [m, dists[2][1]]);
    }
    for (var i = 0; i < COUNT; i++) {
      var x, y, z;
      if (R() < 0.42) {
        var nd = nodes[Math.floor(R() * NN)];
        x = nd[0] + gauss() * 0.34; y = nd[1] + gauss() * 0.34; z = nd[2] + gauss() * 0.34;
      } else {
        var e = edges[Math.floor(R() * edges.length)];
        var t2 = R(), p1 = nodes[e[0]], p2 = nodes[e[1]];
        x = p1[0] + (p2[0] - p1[0]) * t2 + gauss() * 0.06;
        y = p1[1] + (p2[1] - p1[1]) * t2 + gauss() * 0.06;
        z = p1[2] + (p2[2] - p1[2]) * t2 + gauss() * 0.06;
      }
      a[i * 3] = x + cx; a[i * 3 + 1] = y; a[i * 3 + 2] = z;
    }
    return a;
  }

  function genCurve() {
    var a = new Float32Array(COUNT * 3);
    var cx = shiftX("left");
    var W = Math.min(state.hw * 0.9, 13);
    for (var i = 0; i < COUNT; i++) {
      var pick = R(), x, y, z;
      var curveY = function (t) { return -4 + 8.4 / (1 + Math.exp(-(t - 0.55) * 6.5)); };
      if (pick < 0.5) {
        // rising bars
        var bar = Math.floor(R() * 7);
        var bx = (bar / 6 - 0.5) * W * 0.92;
        var bh = 0.8 + Math.pow(bar / 6, 1.6) * 6.4;
        x = bx + (R() - 0.5) * (W / 11);
        y = -4.3 + R() * bh;
        z = (R() - 0.5) * 1.4;
      } else if (pick < 0.9) {
        // sigmoid growth line
        var t = R();
        x = (t - 0.5) * W;
        y = curveY(t) + gauss() * 0.16 + 0.6;
        z = (R() - 0.5) * 0.8;
      } else {
        // arrowhead at the tip
        var s = R(), branch = R() < 0.5 ? 1 : -1;
        var tipX = W / 2 + 0.2, tipY = curveY(1) + 0.75;
        x = tipX - s * 1.5;
        y = tipY - s * 1.5 * branch * (branch > 0 ? 0.15 : 1);
        if (branch > 0) { y = tipY - s * 0.25; x = tipX - s * 1.7; y = tipY - s * 1.55; }
        else { x = tipX - s * 1.9; y = tipY - s * 0.35; }
        x += gauss() * 0.05; y += gauss() * 0.05; z = (R() - 0.5) * 0.5;
      }
      a[i * 3] = x + cx; a[i * 3 + 1] = y; a[i * 3 + 2] = z;
    }
    return a;
  }

  // ── sample "DMDS" from an offscreen canvas ──
  function sampleLogo() {
    var cw = 1280, ch = 360;
    var c = document.createElement("canvas");
    c.width = cw; c.height = ch;
    var ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.font = "600 250px 'Clash Display', Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("DMDS", cw / 2, ch / 2 + 14);
    var img = ctx.getImageData(0, 0, cw, ch).data;
    var xy = [], step = 3;
    var minX = cw, maxX = 0, minY = ch, maxY = 0;
    for (var y = 0; y < ch; y += step) {
      for (var x = 0; x < cw; x += step) {
        if (img[(y * cw + x) * 4 + 3] > 128) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    var bw = maxX - minX || 1, bh = maxY - minY || 1;
    for (var y2 = 0; y2 < ch; y2 += step) {
      for (var x2 = 0; x2 < cw; x2 += step) {
        if (img[(y2 * cw + x2) * 4 + 3] > 128) {
          xy.push((x2 - minX) / bw, 1 - (y2 - minY) / bh);
        }
      }
    }
    return { xy: xy, aspect: bw / bh };
  }

  // ═══ GL setup ═══
  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function resize() {
    var c = state.canvas, dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    var w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w; c.height = h;
      state.gl.viewport(0, 0, w, h);
    }
    worldExtents();
  }

  function rebuildFormations(logoPts) {
    state.formations = {
      logo: genLogo(logoPts),
      ambient: genAmbient(),
      grid: genGrid(),
      device: genDevice(),
      neural: genNeural(),
      curve: genCurve()
    };
  }

  function setFormation(name, instant) {
    if (!state.ready || !state.formations[name] || name === state.currentName) return;
    var gl = state.gl;
    // freeze current interpolated positions into A
    if (state.mix < 1 && state.curA && state.curB) {
      var t = easeCubic(state.mix), a = state.curA, b = state.curB;
      var frozen = new Float32Array(COUNT * 3);
      for (var i = 0; i < COUNT * 3; i++) frozen[i] = a[i] + (b[i] - a[i]) * t;
      state.curA = frozen;
    } else {
      state.curA = state.curB || state.formations[name];
    }
    state.curB = state.formations[name];
    state.currentName = name;
    gl.bindBuffer(gl.ARRAY_BUFFER, state.bufA);
    gl.bufferData(gl.ARRAY_BUFFER, state.curA, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.bufB);
    gl.bufferData(gl.ARRAY_BUFFER, state.curB, gl.DYNAMIC_DRAW);
    state.mix = instant ? 1 : 0;
    state.morphStart = state.time;
  }

  function easeCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  function frame(now) {
    if (!state.running) return;
    requestAnimationFrame(frame);
    var gl = state.gl;
    now *= 0.001;
    var dt = Math.min(now - state.lastT, 0.05) || 0.016;
    state.lastT = now;
    state.time = now;

    // fps meter
    state.frames++;
    if (now - state.fpsT > 0.5) { state.fps = Math.round(state.frames / (now - state.fpsT)); state.frames = 0; state.fpsT = now; }

    // morph progress
    if (state.mix < 1) state.mix = Math.min(1, (now - state.morphStart) / state.morphDur);

    // smooth mouse strength + turbulence decay
    state.mouse.str += (state.mouse.strTarget - state.mouse.str) * (1 - Math.exp(-8 * dt));
    state.dim += (state.dimTarget - state.dim) * (1 - Math.exp(-5 * dt));
    state.turb += (state.turbTarget - state.turb) * (1 - Math.exp(-4 * dt));
    state.turbTarget *= Math.exp(-2.2 * dt);

    var ry = REDUCED ? 0 : Math.sin(now * 0.07) * 0.09 + state.mouse.x * 0.05;
    var rx = REDUCED ? 0 : Math.sin(now * 0.05) * 0.04 + state.mouse.y * 0.035;

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(state.program);
    gl.uniformMatrix4fv(state.loc.uProj, false, perspective(FOV, state.canvas.width / state.canvas.height, 0.1, 100));
    gl.uniformMatrix4fv(state.loc.uView, false, viewMatrix(rx, ry, CAM_Z));
    gl.uniform1f(state.loc.uTime, now);
    gl.uniform1f(state.loc.uMix, state.mix);
    gl.uniform1f(state.loc.uNoise, REDUCED ? 0.02 : 0.085);
    gl.uniform1f(state.loc.uTurb, state.turb);
    gl.uniform3f(state.loc.uMouse, state.mouse.wx, state.mouse.wy, 0);
    gl.uniform1f(state.loc.uMouseStr, state.mouse.str);
    gl.uniform1f(state.loc.uSize, (MOBILE ? 2.1 : 2.5) * Math.min(window.devicePixelRatio || 1, DPR_CAP));
    gl.uniform1f(state.loc.uDim, state.dim);
    gl.drawArrays(gl.POINTS, 0, COUNT);
  }

  function init(canvas) {
    state.canvas = canvas;
    var gl = canvas.getContext("webgl", { alpha: true, antialias: false, powerPreference: "high-performance", premultipliedAlpha: true });
    if (!gl) return Promise.reject(new Error("no webgl"));
    state.gl = gl;

    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return Promise.reject(new Error(gl.getProgramInfoLog(prog)));
    state.program = prog;
    gl.useProgram(prog);

    ["uProj", "uView", "uTime", "uMix", "uNoise", "uTurb", "uMouse", "uMouseStr", "uSize", "uBone", "uSignal", "uDim"].forEach(function (n) {
      state.loc[n] = gl.getUniformLocation(prog, n);
    });
    gl.uniform3f(state.loc.uBone, 0.93, 0.92, 0.89);
    gl.uniform3f(state.loc.uSignal, 1.0, 0.29, 0.0);

    // static per-particle randomness
    var rand = new Float32Array(COUNT * 4);
    for (var i = 0; i < COUNT; i++) {
      rand[i * 4] = R(); rand[i * 4 + 1] = R(); rand[i * 4 + 2] = R(); rand[i * 4 + 3] = R();
    }
    state.bufR = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, state.bufR);
    gl.bufferData(gl.ARRAY_BUFFER, rand, gl.STATIC_DRAW);
    var locR = gl.getAttribLocation(prog, "aRand");
    gl.enableVertexAttribArray(locR);
    gl.vertexAttribPointer(locR, 4, gl.FLOAT, false, 0, 0);

    state.bufA = gl.createBuffer();
    state.bufB = gl.createBuffer();

    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    resize();

    var fontsReady = (document.fonts && document.fonts.load)
      ? document.fonts.load("600 250px 'Clash Display'").then(function () { return document.fonts.ready; })
      : Promise.resolve();

    return fontsReady.then(function () {
      var logoPts = sampleLogo();
      state.logoPts = logoPts;
      rebuildFormations(logoPts);

      // wire attribute pointers once buffers hold data
      var scattered = genAmbient();
      state.curA = scattered;
      state.curB = state.formations.logo;
      state.currentName = "logo";
      var gl2 = state.gl;
      gl2.bindBuffer(gl2.ARRAY_BUFFER, state.bufA);
      gl2.bufferData(gl2.ARRAY_BUFFER, state.curA, gl2.DYNAMIC_DRAW);
      var locA = gl2.getAttribLocation(prog, "aPosA");
      gl2.enableVertexAttribArray(locA);
      gl2.vertexAttribPointer(locA, 3, gl2.FLOAT, false, 0, 0);
      gl2.bindBuffer(gl2.ARRAY_BUFFER, state.bufB);
      gl2.bufferData(gl2.ARRAY_BUFFER, state.curB, gl2.DYNAMIC_DRAW);
      var locB = gl2.getAttribLocation(prog, "aPosB");
      gl2.enableVertexAttribArray(locB);
      gl2.vertexAttribPointer(locB, 3, gl2.FLOAT, false, 0, 0);
      // note: attribute pointers bound once — bufferData on same buffer objects keeps bindings valid

      state.mix = 0;
      state.morphStart = 0;
      state.morphDur = REDUCED ? 0.01 : 2.2; // slow, cinematic first assembly
      state.ready = true;
      state.running = true;

      window.addEventListener("resize", function () {
        resize();
        rebuildFormations(state.logoPts);
        // snap current formation to its rebuilt geometry
        var name = state.currentName;
        state.currentName = null;
        setFormation(name, true);
      });

      window.addEventListener("mousemove", function (e) {
        state.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        state.mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
        state.mouse.wx = state.mouse.x * state.hw;
        state.mouse.wy = -state.mouse.y * state.hh;
        state.mouse.strTarget = REDUCED ? 0 : 2.4;
      });
      window.addEventListener("mouseout", function () { state.mouse.strTarget = 0; });

      document.addEventListener("visibilitychange", function () {
        if (document.hidden) { state.running = false; }
        else if (!state.running) { state.running = true; state.lastT = performance.now() * 0.001; requestAnimationFrame(frame); }
      });

      requestAnimationFrame(frame);
      // after the intro assembly, restore standard morph speed
      setTimeout(function () { state.morphDur = REDUCED ? 0.01 : 1.5; }, 2400);
    });
  }

  window.DMDS_GL = {
    init: init,
    setFormation: function (n) { setFormation(n, false); },
    setDim: function (v) { state.dimTarget = v; },
    kick: function (v) { state.turbTarget = Math.min(state.turbTarget + v, REDUCED ? 0 : 0.55); },
    fps: function () { return state.fps; },
    isReady: function () { return state.ready; }
  };
})();
