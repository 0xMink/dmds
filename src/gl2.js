/* ═══════════════════════════════════════════════════════════════
   DMDS® — particle engine, tier 1 (WebGL2 GPGPU physical sim)
   Positions and velocities live in RGBA32F textures; a fragment
   pass integrates real forces every frame. One MRT sim pass, one
   render draw. Spec: docs/superpowers/specs/2026-07-17-gpgpu-
   physical-engine-design.md. Tier 2 (gl.js) is the fallback.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var MOBILE = Math.min(window.innerWidth, window.innerHeight) < 720 || "ontouchstart" in window;
  var SAVEDATA = !!(navigator.connection && navigator.connection.saveData);
  var DPR_CAP = MOBILE ? 1.5 : 1.75;
  var DEPTH_FREE = -2.0; // position.w sentinel (spec: grab depth channel)

  // ── debug/test configuration: only honored under ?debug=1 ──
  var DEBUG = /[?&]debug=1/.test(location.search);
  var N = (MOBILE || SAVEDATA) ? 256 : 512; // sim texture side; count = N*N
  if (DEBUG) {
    var m = location.search.match(/[?&]gl2n=(\d+)/);
    if (m) N = Math.max(8, Math.min(1024, parseInt(m[1], 10)));
  }

  var CAM_Z = 26, FOV = 35 * Math.PI / 180;

  // ── physics constants (models fixed by spec; numbers tuned by review) ──
  var K_SPRING = 26.0;   // formation spring gain (scaled per-particle)
  var K_DRAG = 5.2;      // time-based damping: v *= exp(-K_DRAG*dt)
  var F_MAX = 900.0;     // force cap, world units/s²
  var V_MAX = 90.0;      // velocity cap, world units/s
  var DT_MAX = 1 / 30;   // dt clamp
  var OOB = 60.0;        // out-of-bounds radius → reset to target
  var EPS_SNAP = 0.012;  // settle deadband, world units (≈0.5 device px)
  var V_SNAP = 0.06;

  /* ═══ shaders ═══ */
  var SIM_VS = "#version 300 es\nvoid main(){vec2 v=vec2(gl_VertexID==1?3.0:-1.0,gl_VertexID==2?3.0:-1.0);gl_Position=vec4(v,0.,1.);}";

  var SIM_FS = [
    "#version 300 es",
    "precision highp float;",
    "uniform sampler2D uPos, uVel, uTargA, uTargB;",
    "uniform float uDt, uTime, uMix, uNoise, uTurb, uExcite;",
    "uniform vec3 uCursor;",
    "uniform float uCursorStr;",
    "uniform int uN;",
    "layout(location=0) out vec4 oPos;",
    "layout(location=1) out vec4 oVel;",
    // particle identity from the output texel — gl_VertexID does not exist here
    "float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }",
    "void main(){",
    "  ivec2 c = ivec2(gl_FragCoord.xy);",
    "  float id = float(c.y * uN + c.x);",
    "  vec4 P = texelFetch(uPos, c, 0);",
    "  vec4 V = texelFetch(uVel, c, 0);",
    "  vec3 p = P.xyz, v = V.xyz;",
    "  float r1 = hash11(id * 0.1031 + 0.13), r2 = hash11(id * 0.2711 + 0.53),",
    "        r3 = hash11(id * 0.4177 + 0.29), r4 = hash11(id * 0.7331 + 0.71);",
    // staggered morph: each particle chases its own blend of the two targets
    "  float stag = clamp((uMix - r1 * 0.35) / 0.65, 0.0, 1.0);",
    "  stag = stag * stag * (3.0 - 2.0 * stag);",
    "  vec3 target = mix(texelFetch(uTargA, c, 0).xyz, texelFetch(uTargB, c, 0).xyz, stag);",
    // forces: formation spring (per-particle gain), turbulence, cursor, then drag
    "  vec3 F = " + K_SPRING.toFixed(1) + " * (0.55 + r2 * 0.9) * (target - p);",
    "  float sw = uMix * (1.0 - uMix) * 4.0;",
    "  float amp = (uTurb + uNoise * (0.5 + r3) * uExcite + sw * 2.1) * 34.0;",
    "  F += vec3(",
    "    sin(p.y * 0.35 + uTime * 0.9 + r4 * 6.283),",
    "    sin(p.z * 0.30 + uTime * 0.8 + r1 * 6.283),",
    "    sin(p.x * 0.32 + uTime * 0.7 + r2 * 6.283)",
    "  ) * amp * (0.6 + r3 * 1.4);",
    "  vec3 d = p - uCursor;",
    "  float d2 = dot(d.xy, d.xy);",
    "  F.xy += normalize(d.xy + 0.0001) * exp(-d2 * 0.14) * uCursorStr * 140.0;",
    "  float fl = length(F);",
    "  if (fl > " + F_MAX.toFixed(1) + ") F *= " + F_MAX.toFixed(1) + " / fl;",
    // semi-implicit Euler with time-based damping (60/120/144 Hz identical)
    "  v += F * uDt;",
    "  v *= exp(-" + K_DRAG.toFixed(1) + " * uDt);",
    "  float vl = length(v);",
    "  if (vl > " + V_MAX.toFixed(1) + ") v *= " + V_MAX.toFixed(1) + " / vl;",
    "  p += v * uDt;",
    // settle deadband: at rest the formation actually converges (crisp-lock)
    "  if (uExcite < 0.05 && distance(p, target) < " + EPS_SNAP.toFixed(3) + " && length(v) < " + V_SNAP.toFixed(2) + ") {",
    "    p = target; v = vec3(0.0);",
    "  }",
    // finite-value recovery: reassembly always wins
    "  bvec3 bad = bvec3(isnan(p.x) || isinf(p.x), isnan(p.y) || isinf(p.y), isnan(p.z) || isinf(p.z));",
    "  if (any(bad) || length(p) > " + OOB.toFixed(1) + ") { p = target; v = vec3(0.0); }",
    "  oPos = vec4(p, P.w);",
    "  oVel = vec4(v, V.w);",
    "}"
  ].join("\n");

  var REN_VS = [
    "#version 300 es",
    "precision highp float;",
    "uniform sampler2D uPos;",
    "uniform int uN;",
    "uniform mat4 uProj, uView;",
    "uniform float uTime, uSize;",
    "out float vMix;",
    "out float vTwinkle;",
    "out float vDepth;",
    "float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }",
    "void main(){",
    "  ivec2 c = ivec2(gl_VertexID % uN, gl_VertexID / uN);",
    "  float id = float(gl_VertexID);",
    "  vec3 pos = texelFetch(uPos, c, 0).xyz;",
    "  float r2 = hash11(id * 0.2711 + 0.53), r3 = hash11(id * 0.4177 + 0.29), r4 = hash11(id * 0.7331 + 0.71);",
    "  vec4 mv = uView * vec4(pos, 1.0);",
    "  gl_Position = uProj * mv;",
    "  float att = clamp(18.0 / -mv.z, 0.2, 2.2);",
    "  gl_PointSize = uSize * (0.55 + r3 * 0.9) * att;",
    "  vMix = r2;",
    "  vTwinkle = 0.62 + 0.38 * sin(uTime * 1.7 + r4 * 6.283);",
    "  vDepth = clamp((-mv.z - 14.0) / 26.0, 0.0, 1.0);",
    "}"
  ].join("\n");

  var REN_FS = [
    "#version 300 es",
    "precision mediump float;",
    "uniform vec3 uBone, uSignal;",
    "uniform float uDim;",
    "in float vMix;",
    "in float vTwinkle;",
    "in float vDepth;",
    "out vec4 outColor;",
    "void main(){",
    "  vec2 c = gl_PointCoord - 0.5;",
    "  float a = smoothstep(0.5, 0.08, length(c));",
    "  vec3 col = mix(uBone, uSignal, step(0.88, vMix));",
    "  a *= vTwinkle * mix(1.0, 0.35, vDepth) * uDim;",
    "  outColor = vec4(col * a, a);",
    "}"
  ].join("\n");

  // post shaders: GLSL ES 1.00 ports from gl.js — valid on a WebGL2 context
  var QUAD_VS = [
    "precision mediump float;",
    "attribute vec2 aXY;",
    "varying vec2 vUv;",
    "void main(){ vUv = aXY * 0.5 + 0.5; gl_Position = vec4(aXY, 0.0, 1.0); }"
  ].join("\n");
  var FADE_FS = [
    "precision mediump float;",
    "uniform sampler2D uTex;",
    "uniform float uDecay;",
    "varying vec2 vUv;",
    "void main(){ gl_FragColor = texture2D(uTex, vUv) * uDecay; }"
  ].join("\n");
  var BLUR_FS = [
    "precision mediump float;",
    "uniform sampler2D uTex;",
    "uniform vec2 uDir;",
    "varying vec2 vUv;",
    "void main(){",
    "  vec4 c = texture2D(uTex, vUv) * 0.227;",
    "  c += (texture2D(uTex, vUv + uDir * 1.384) + texture2D(uTex, vUv - uDir * 1.384)) * 0.316;",
    "  c += (texture2D(uTex, vUv + uDir * 3.230) + texture2D(uTex, vUv - uDir * 3.230)) * 0.070;",
    "  gl_FragColor = c;",
    "}"
  ].join("\n");
  var COMP_FS = [
    "precision mediump float;",
    "uniform sampler2D uField;",
    "uniform sampler2D uGlow;",
    "uniform float uPostMix;",
    "varying vec2 vUv;",
    "void main(){",
    "  vec2 c = vUv - 0.5;",
    "  float r = length(c);",
    "  float k = 0.0045 * r * uPostMix;",
    "  vec3 field;",
    "  field.r = texture2D(uField, vUv + c * k).r;",
    "  field.g = texture2D(uField, vUv).g;",
    "  field.b = texture2D(uField, vUv - c * k).b;",
    "  vec3 glow = texture2D(uGlow, vUv).rgb;",
    "  vec3 bg = mix(vec3(0.082, 0.080, 0.088), vec3(0.043, 0.043, 0.047), smoothstep(0.0, 1.0, distance(vUv, vec2(0.72, 0.92))));",
    "  vec3 col = bg + field + glow * (0.35 + 0.8 * uPostMix);",
    "  col *= 1.0 - 0.38 * smoothstep(0.5, 1.1, r);",
    "  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;",
    "  gl_FragColor = vec4(col, 1.0);",
    "}"
  ].join("\n");

  /* ═══ small kit ═══ */
  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function viewMatrix(rx, ry, z) {
    var cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
    return [cy, sx * sy, -cx * sy, 0, 0, cx, sx, 0, sy, -sx * cy, cx * cy, 0, 0, 0, -z, 1];
  }
  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function makeProgram(gl, vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  var state = {
    gl: null, canvas: null, ready: false, running: false, destroyed: false,
    // GPGPU
    posT: [null, null], velT: [null, null], simFbo: [null, null], cur: 0,
    targA: null, targB: null, simProg: null, simLoc: {}, vao: null,
    renProg: null, renLoc: {},
    // formations (CPU xyz arrays at current N)
    formations: {}, currentName: null, pairA: null, pairB: null,
    mix: 1, mode: "tween", tweenDur: 1.5, morphStart: 0, morphDur: REDUCED ? 0.01 : 1.5,
    time: 0, lastT: 0, turb: 0, turbTarget: 0, excite: 1,
    mouse: { x: 0, y: 0, wx: 0, wy: 0, str: 0, strTarget: 0 },
    dim: 1, dimTarget: 1, rot: { x: 0, y: 0 },
    fps: 60, frames: 0, fpsT: 0, hw: 8, hh: 8,
    post: false, quadBuf: null, progFade: null, progBlur: null, progComp: null,
    trailA: null, trailB: null, glowA: null, glowB: null, enabledAttribs: [],
    ms: null, firstFrame: false,
    listeners: [], raf: 0
  };

  function milestone(kind, detail) {
    if (state.ms) { try { state.ms(kind, detail); } catch (e) {} }
  }
  function listen(target, ev, fn) {
    target.addEventListener(ev, fn);
    state.listeners.push([target, ev, fn]);
  }
  function worldExtents() {
    var hh = CAM_Z * Math.tan(FOV / 2);
    state.hh = hh;
    state.hw = hh * (state.canvas.width / state.canvas.height);
  }

  /* ═══ formation generators — identical world-space math to gl.js,
     COUNT = N*N; ported so the two tiers speak the same shapes ═══ */
  var COUNT = N * N;
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
        x = (R() - 0.5) * 1.6; y = H / 2 - 1.05 + (R() - 0.5) * 0.22; z = 0.2;
      } else if (pick < 0.9) {
        var row = Math.floor(R() * 4);
        var bw = [3.8, 4.4, 2.9, 4.1][row];
        x = (R() - 0.5) * bw;
        y = 2.2 - row * 1.7 + (R() - 0.5) * 0.42;
        z = 0.1;
      } else {
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
      var ph = Math.acos(1 - 2 * (k + 0.5) / NN), th = Math.PI * (1 + Math.sqrt(5)) * k;
      var rad = 5.4;
      nodes.push([rad * Math.sin(ph) * Math.cos(th), rad * Math.cos(ph), rad * Math.sin(ph) * Math.sin(th)]);
    }
    var edges = [];
    for (var mI = 0; mI < NN; mI++) {
      var dists = [];
      for (var n2 = 0; n2 < NN; n2++) if (n2 !== mI) {
        var dx = nodes[mI][0] - nodes[n2][0], dy = nodes[mI][1] - nodes[n2][1], dz = nodes[mI][2] - nodes[n2][2];
        dists.push([dx * dx + dy * dy + dz * dz, n2]);
      }
      dists.sort(function (p, q) { return p[0] - q[0]; });
      edges.push([mI, dists[0][1]], [mI, dists[1][1]], [mI, dists[2][1]]);
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
        var bar = Math.floor(R() * 7);
        var bx = (bar / 6 - 0.5) * W * 0.92;
        var bh = 0.8 + Math.pow(bar / 6, 1.6) * 6.4;
        x = bx + (R() - 0.5) * (W / 11);
        y = -4.3 + R() * bh;
        z = (R() - 0.5) * 1.4;
      } else if (pick < 0.9) {
        var t = R();
        x = (t - 0.5) * W;
        y = curveY(t) + gauss() * 0.16 + 0.6;
        z = (R() - 0.5) * 0.8;
      } else {
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

  var textCache = {};
  function sampleText(str) {
    if (textCache[str]) return textCache[str];
    var ch = 360, fontSpec = "600 250px 'Clash Display', Arial";
    var probe = document.createElement("canvas").getContext("2d");
    probe.font = fontSpec;
    var cw = Math.max(200, Math.ceil(probe.measureText(str).width) + 100);
    var c = document.createElement("canvas");
    c.width = cw; c.height = ch;
    var ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.font = fontSpec;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(str, cw / 2, ch / 2 + 14);
    var img = ctx.getImageData(0, 0, cw, ch).data;
    var step = Math.max(2, Math.round(Math.sqrt((cw * ch) / 55000)));
    var xy = [];
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
    var out = { xy: xy, aspect: bw / bh };
    if (xy.length) textCache[str] = out;
    return out;
  }

  /* ═══ GPGPU resources ═══ */
  function makeStateTex(gl, data) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, N, N, 0, gl.RGBA, gl.FLOAT, data || null);
    return t;
  }
  function makeTargetTex(gl) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, N, N, 0, gl.RGBA, gl.FLOAT, null);
    return t;
  }
  var targScratch = null; // reused RGBA staging array
  function uploadTarget(gl, tex, xyz) {
    if (!targScratch) targScratch = new Float32Array(COUNT * 4);
    for (var i = 0; i < COUNT; i++) {
      targScratch[i * 4] = xyz[i * 3];
      targScratch[i * 4 + 1] = xyz[i * 3 + 1];
      targScratch[i * 4 + 2] = xyz[i * 3 + 2];
      targScratch[i * 4 + 3] = 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.FLOAT, targScratch);
  }

  function makeFBO(gl, w, h) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) throw new Error("fbo incomplete");
    return { tex: tex, fb: fb, w: w, h: h };
  }
  function destroyFBO(gl, f) {
    if (!f) return;
    gl.deleteTexture(f.tex);
    gl.deleteFramebuffer(f.fb);
  }
  function allocPostTargets() {
    var gl = state.gl, w = state.canvas.width, h = state.canvas.height;
    ["trailA", "trailB", "glowA", "glowB"].forEach(function (k) { destroyFBO(gl, state[k]); state[k] = null; });
    state.trailA = makeFBO(gl, w, h);
    state.trailB = makeFBO(gl, w, h);
    var qw = Math.max(2, w >> 2), qh = Math.max(2, h >> 2);
    state.glowA = makeFBO(gl, qw, qh);
    state.glowB = makeFBO(gl, qw, qh);
  }

  function buildGLResources() {
    var gl = state.gl;
    // test hook (?debug=1 only): injected failure AFTER the visible canvas
    // holds a WebGL2 context — the fallback MUST replace the canvas
    if (DEBUG && window.__DMDS_GL2_BREAK__) throw new Error("injected build failure");

    // sim: two RGBA32F ping-pong pairs behind two MRT FBOs
    var seed = new Float32Array(COUNT * 4);
    // seeded from an ambient scatter so first assembly is physical
    var scattered = genAmbient();
    for (var i = 0; i < COUNT; i++) {
      seed[i * 4] = scattered[i * 3];
      seed[i * 4 + 1] = scattered[i * 3 + 1];
      seed[i * 4 + 2] = scattered[i * 3 + 2];
      seed[i * 4 + 3] = DEPTH_FREE;
    }
    state.posT = [makeStateTex(gl, seed), makeStateTex(gl, null)];
    state.velT = [makeStateTex(gl, null), makeStateTex(gl, null)];
    for (var d = 0; d < 2; d++) {
      var fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.posT[d], 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, state.velT[d], 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("sim fbo incomplete");
      state.simFbo[d] = fb;
    }
    state.cur = 0;
    state.targA = makeTargetTex(gl);
    state.targB = makeTargetTex(gl);

    state.vao = gl.createVertexArray();
    state.simProg = makeProgram(gl, SIM_VS, SIM_FS);
    ["uPos", "uVel", "uTargA", "uTargB", "uDt", "uTime", "uMix", "uNoise", "uTurb", "uExcite", "uCursor", "uCursorStr", "uN"].forEach(function (n) {
      state.simLoc[n] = gl.getUniformLocation(state.simProg, n);
    });
    state.renProg = makeProgram(gl, REN_VS, REN_FS);
    ["uPos", "uN", "uProj", "uView", "uTime", "uSize", "uBone", "uSignal", "uDim"].forEach(function (n) {
      state.renLoc[n] = gl.getUniformLocation(state.renProg, n);
    });
    gl.useProgram(state.renProg);
    gl.uniform3f(state.renLoc.uBone, 0.93, 0.92, 0.89);
    gl.uniform3f(state.renLoc.uSignal, 1.0, 0.29, 0.0);

    // test hook (?debug=1): failure AFTER state textures, FBOs and both
    // programs exist — destroy() must clean partially-built resources
    if (DEBUG && window.__DMDS_GL2_BREAK_LATE__) throw new Error("injected late build failure");

    gl.clearColor(0, 0, 0, 0);
    gl.disable(gl.DEPTH_TEST);

    // post pipeline (desktop, not Save-Data)
    state.post = false;
    if (!MOBILE && !SAVEDATA) {
      try {
        var pf = makeProgram(gl, QUAD_VS, FADE_FS);
        state.progFade = { p: pf, aXY: gl.getAttribLocation(pf, "aXY"), uTex: gl.getUniformLocation(pf, "uTex"), uDecay: gl.getUniformLocation(pf, "uDecay") };
        var pb = makeProgram(gl, QUAD_VS, BLUR_FS);
        state.progBlur = { p: pb, aXY: gl.getAttribLocation(pb, "aXY"), uTex: gl.getUniformLocation(pb, "uTex"), uDir: gl.getUniformLocation(pb, "uDir") };
        var pc = makeProgram(gl, QUAD_VS, COMP_FS);
        state.progComp = { p: pc, aXY: gl.getAttribLocation(pc, "aXY"), uTex: gl.getUniformLocation(pc, "uField"), uGlow: gl.getUniformLocation(pc, "uGlow"), uPostMix: gl.getUniformLocation(pc, "uPostMix") };
        state.quadBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        state.post = true;
        allocPostTargets();
      } catch (e) {
        state.post = false;
      }
    }
  }

  function useAttribs(list) {
    var gl = state.gl;
    var want = {};
    list.forEach(function (a) { want[a.loc] = true; });
    state.enabledAttribs.forEach(function (l) { if (!want[l]) gl.disableVertexAttribArray(l); });
    list.forEach(function (a) {
      gl.bindBuffer(gl.ARRAY_BUFFER, a.buf);
      gl.enableVertexAttribArray(a.loc);
      gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, 0, 0);
    });
    state.enabledAttribs = list.map(function (a) { return a.loc; });
  }
  function drawQuad(prog, tex, uniforms) {
    var gl = state.gl;
    gl.useProgram(prog.p);
    useAttribs([{ loc: prog.aXY, buf: state.quadBuf, size: 2 }]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.uTex, 0);
    if (uniforms) uniforms();
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function resize() {
    var c = state.canvas, dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    var w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w; c.height = h;
      state.gl.viewport(0, 0, w, h);
      if (state.post) {
        try { allocPostTargets(); } catch (e) { state.post = false; }
      }
    }
    worldExtents();
  }

  function rebuildFormations() {
    state.formations = {
      logo: genLogo(sampleText("DMDS")),
      ambient: genAmbient(),
      grid: genGrid(),
      device: genDevice(),
      neural: genNeural(),
      curve: genCurve()
    };
    state.pairA = null; state.pairB = null;
  }
  function formationFor(name) {
    if (state.formations[name]) return state.formations[name];
    if (name && name.indexOf("text:") === 0) {
      var pts = sampleText(name.slice(5));
      if (!pts.xy.length) return null;
      var f = genLogo(pts);
      state.formations[name] = f;
      return f;
    }
    return null;
  }

  function excite(v) { state.excite = Math.min(1, Math.max(state.excite, v)); }

  function setFormation(name, instant, dur) {
    if (!state.ready || name === state.currentName) return;
    var target = formationFor(name);
    if (!target) return;
    var gl = state.gl;
    // physical engine: particles are wherever they are — the outgoing
    // blend becomes the new A so the spring path stays continuous
    var prev = formationFor(state.currentName) || target;
    uploadTarget(gl, state.targA, state.mix >= 1 ? prev : blendedTargets());
    uploadTarget(gl, state.targB, target);
    state.currentName = name;
    state.pairA = null; state.pairB = null;
    state.mode = "tween";
    state.tweenDur = REDUCED ? 0.01 : (dur || state.morphDur);
    state.mix = instant ? 1 : 0;
    state.morphStart = state.time;
    excite(1);
  }
  // CPU blend of the current pair at the current mix — used to freeze a
  // mid-morph state into slot A when a new formation interrupts
  var blendScratch = null;
  function blendedTargets() {
    if (!blendScratch) blendScratch = new Float32Array(COUNT * 3);
    var a = formationFor(state.pairA || state.currentName) || state.formations.ambient;
    var b = formationFor(state.pairB || state.currentName) || a;
    var t = smooth01(state.mix);
    for (var i = 0; i < COUNT * 3; i++) blendScratch[i] = a[i] + (b[i] - a[i]) * t;
    return blendScratch;
  }
  function smooth01(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

  function setMorphPair(a, b, t) {
    if (!state.ready) return;
    if (state.pairA !== a || state.pairB !== b) {
      var fa = formationFor(a), fb = formationFor(b);
      if (!fa || !fb) return;
      uploadTarget(state.gl, state.targA, fa);
      uploadTarget(state.gl, state.targB, fb);
      state.pairA = a; state.pairB = b;
    }
    state.mode = "scrub";
    var prev = state.mix;
    state.mix = Math.max(0, Math.min(1, t));
    state.currentName = state.mix >= 0.5 ? b : a;
    if (Math.abs(state.mix - prev) > 0.002) excite(Math.min(1, 0.4 + Math.abs(state.mix - prev) * 30));
  }

  // one MRT sim draw — callable from the frame loop AND from the
  // test-only manual stepper (exact state-transition tests need
  // single-step granularity)
  function simStep(dt, now) {
    var gl = state.gl;
    var nxt = 1 - state.cur;
    gl.bindVertexArray(state.vao);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.simFbo[nxt]);
    gl.viewport(0, 0, N, N);
    gl.useProgram(state.simProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, state.posT[state.cur]);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, state.velT[state.cur]);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, state.targA);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, state.targB);
    gl.uniform1i(state.simLoc.uPos, 0);
    gl.uniform1i(state.simLoc.uVel, 1);
    gl.uniform1i(state.simLoc.uTargA, 2);
    gl.uniform1i(state.simLoc.uTargB, 3);
    gl.uniform1f(state.simLoc.uDt, REDUCED ? Math.min(dt, 1 / 60) : dt);
    gl.uniform1f(state.simLoc.uTime, now);
    gl.uniform1f(state.simLoc.uMix, state.mode === "scrub" ? smooth01(state.mix) : state.mix);
    gl.uniform1f(state.simLoc.uNoise, REDUCED ? 0 : 0.085);
    gl.uniform1f(state.simLoc.uTurb, state.turb);
    gl.uniform1f(state.simLoc.uExcite, REDUCED ? 0 : state.excite);
    gl.uniform3f(state.simLoc.uCursor, state.mouse.wx, state.mouse.wy, 0);
    gl.uniform1f(state.simLoc.uCursorStr, state.mouse.str);
    gl.uniform1i(state.simLoc.uN, N);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    state.cur = nxt;
    gl.bindVertexArray(null);
  }

  function frame(now) {
    if (!state.running) return;
    state.raf = requestAnimationFrame(frame);
    var gl = state.gl;
    now *= 0.001;
    var dt = Math.min(now - state.lastT, DT_MAX) || 0.016;
    if (dt <= 0) dt = 0.016;
    state.lastT = now;
    state.time = now;

    state.frames++;
    if (now - state.fpsT > 0.5) { state.fps = Math.round(state.frames / (now - state.fpsT)); state.frames = 0; state.fpsT = now; }
    if (!state.firstFrame) { state.firstFrame = true; milestone("loop"); }

    if (state.mode === "tween" && state.mix < 1) {
      state.mix = Math.min(1, (now - state.morphStart) / state.tweenDur);
      excite(0.6 + state.mix * (1 - state.mix));
    }

    state.mouse.str += (state.mouse.strTarget - state.mouse.str) * (1 - Math.exp(-8 * dt));
    state.dim += (state.dimTarget - state.dim) * (1 - Math.exp(-5 * dt));
    state.turb += (state.turbTarget - state.turb) * (1 - Math.exp(-4 * dt));
    state.turbTarget *= Math.exp(-2.2 * dt);
    // excitement decays toward rest; crisp-lock rides this scalar
    state.excite *= Math.exp(-dt / 1.2);
    if (state.mouse.str > 0.2) excite(Math.min(1, state.mouse.str * 0.3));

    var ry = REDUCED ? 0 : Math.sin(now * 0.07) * 0.09 + state.mouse.x * 0.05;
    var rx = REDUCED ? 0 : Math.sin(now * 0.05) * 0.04 + state.mouse.y * 0.035;

    simStep(dt, now);

    // ── render pass ──
    function drawPoints() {
      gl.useProgram(state.renProg);
      state.enabledAttribs.forEach(function (l) { gl.disableVertexAttribArray(l); });
      state.enabledAttribs = [];
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, state.posT[state.cur]);
      gl.uniform1i(state.renLoc.uPos, 0);
      gl.uniform1i(state.renLoc.uN, N);
      gl.uniformMatrix4fv(state.renLoc.uProj, false, perspective(FOV, state.canvas.width / state.canvas.height, 0.1, 100));
      gl.uniformMatrix4fv(state.renLoc.uView, false, viewMatrix(rx, ry, CAM_Z));
      gl.uniform1f(state.renLoc.uTime, now);
      gl.uniform1f(state.renLoc.uSize, (MOBILE ? 1.35 : 1.6) * Math.min(window.devicePixelRatio || 1, DPR_CAP));
      gl.uniform1f(state.renLoc.uDim, state.dim);
      gl.drawArrays(gl.POINTS, 0, COUNT);
    }

    // crisp-lock: post intensity follows excitement
    var postMix = Math.min(1, state.excite * 1.6);

    if (state.post) {
      var W = state.canvas.width, H = state.canvas.height;
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, state.trailB.fb);
      gl.viewport(0, 0, W, H);
      drawQuad(state.progFade, state.trailA.tex, function () {
        // trails die fast at rest (decay rate rises as excitement falls)
        gl.uniform1f(state.progFade.uDecay, REDUCED ? 0.0 : Math.exp(-dt * (9 + (1 - postMix) * 30)));
      });
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      drawPoints();
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, state.glowA.fb);
      gl.viewport(0, 0, state.glowA.w, state.glowA.h);
      drawQuad(state.progBlur, state.trailB.tex, function () {
        gl.uniform2f(state.progBlur.uDir, 1 / state.glowA.w, 0);
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, state.glowB.fb);
      gl.viewport(0, 0, state.glowB.w, state.glowB.h);
      drawQuad(state.progBlur, state.glowA.tex, function () {
        gl.uniform2f(state.progBlur.uDir, 0, 1 / state.glowB.h);
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      drawQuad(state.progComp, state.trailB.tex, function () {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, state.glowB.tex);
        gl.uniform1i(state.progComp.uGlow, 1);
        gl.uniform1f(state.progComp.uPostMix, postMix);
        gl.activeTexture(gl.TEXTURE0);
      });
      var t = state.trailA; state.trailA = state.trailB; state.trailB = t;
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, state.canvas.width, state.canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      drawPoints();
    }
  }

  /* ═══ capability probe — throwaway canvas, production shape ═══ */
  function probe() {
    try {
      var c = document.createElement("canvas");
      c.width = 8; c.height = 8;
      var gl = c.getContext("webgl2", { antialias: false });
      if (!gl) return false;
      if (!gl.getExtension("EXT_color_buffer_float")) return false;
      var PN = 4;
      var mk = function (fmt) {
        var t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, fmt, PN, PN, 0, gl.RGBA, gl.FLOAT, null);
        return t;
      };
      var a = mk(gl.RGBA32F), b = mk(gl.RGBA32F);
      var fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, a, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, b, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      // 16F sampled target
      var t16 = mk(gl.RGBA16F);
      ok = ok && gl.getError() === gl.NO_ERROR;
      gl.deleteTexture(a); gl.deleteTexture(b); gl.deleteTexture(t16);
      gl.deleteFramebuffer(fb);
      var lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
      return ok;
    } catch (e) {
      return false;
    }
  }

  /* ═══ lifecycle ═══ */
  function destroy() {
    var gl = state.gl;
    state.running = false;
    state.ready = false;
    state.destroyed = true;
    clearTimeout(restoreTimer); // a stale loss timer must never fire post-destroy
    if (state.raf) cancelAnimationFrame(state.raf);
    state.listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
    state.listeners = [];
    if (gl) {
      try {
        [state.posT[0], state.posT[1], state.velT[0], state.velT[1], state.targA, state.targB].forEach(function (t) { if (t) gl.deleteTexture(t); });
        state.simFbo.forEach(function (f) { if (f) gl.deleteFramebuffer(f); });
        [state.simProg, state.renProg].forEach(function (p) { if (p) gl.deleteProgram(p); });
        [state.progFade, state.progBlur, state.progComp].forEach(function (pr) { if (pr) gl.deleteProgram(pr.p); });
        if (state.quadBuf) gl.deleteBuffer(state.quadBuf);
        if (state.vao) gl.deleteVertexArray(state.vao);
        ["trailA", "trailB", "glowA", "glowB"].forEach(function (k) { destroyFBO(gl, state[k]); state[k] = null; });
      } catch (e) {}
    }
    state.gl = null;
  }

  var RESTORE_TIMEOUT = 4000;
  var restoreTimer = 0;

  function init(canvas, onMilestone) {
    state.canvas = canvas;
    state.ms = onMilestone || null;
    // lifecycle reset: a destroyed engine must be fully re-initializable
    state.destroyed = false;
    state.ready = false;
    state.running = false;
    state.firstFrame = false;
    state.enabledAttribs = [];
    state.cur = 0;
    state.mix = 1;
    state.currentName = null;
    state.pairA = null; state.pairB = null;

    if (!probe()) return Promise.reject(new Error("gl2 probe failed"));

    var gl = canvas.getContext("webgl2", { alpha: true, antialias: false, powerPreference: "high-performance", premultipliedAlpha: true });
    if (!gl) return Promise.reject(new Error("no webgl2 on visible canvas"));
    state.gl = gl;
    if (!gl.getExtension("EXT_color_buffer_float")) return Promise.reject(new Error("no float render"));

    resize();
    try { buildGLResources(); } catch (e) { destroy(); return Promise.reject(e); }
    milestone("compile", "sim");
    milestone("post", state.post);

    listen(canvas, "webglcontextlost", function (e) {
      e.preventDefault();
      state.running = false;
      if (window.console) console.warn("[DMDS] gl2 context lost — render paused");
      // spec: no restoration within 4s → the page's engine boot chain
      // owns replacement; we surface it via status().running + onLost
      restoreTimer = setTimeout(function () {
        if (!state.running && state.onLostTimeout) state.onLostTimeout();
      }, RESTORE_TIMEOUT);
    });
    listen(canvas, "webglcontextrestored", function () {
      clearTimeout(restoreTimer);
      try {
        state.enabledAttribs = [];
        // pre-loss GL objects belong to a dead context epoch — deleting
        // them on the restored context raises INVALID_OPERATION; forget,
        // don't free
        state.posT = [null, null]; state.velT = [null, null]; state.simFbo = [null, null];
        state.targA = null; state.targB = null; state.simProg = null; state.renProg = null;
        state.progFade = null; state.progBlur = null; state.progComp = null;
        state.quadBuf = null; state.vao = null;
        state.trailA = null; state.trailB = null; state.glowA = null; state.glowB = null;
        // a restored context also forgets its extensions — re-enable float
        // rendering or RGBA32F FBOs come back incomplete
        if (!state.gl.getExtension("EXT_color_buffer_float")) throw new Error("float render unavailable after restore");
        buildGLResources();
        state.gl.viewport(0, 0, state.canvas.width, state.canvas.height);
        // rebuild directly into the current formation at current size
        var curF = formationFor(state.currentName) || state.formations.ambient;
        uploadTarget(state.gl, state.targA, curF);
        uploadTarget(state.gl, state.targB, curF);
        state.mix = 1;
        state.running = true;
        state.lastT = performance.now() * 0.001;
        state.raf = requestAnimationFrame(frame);
        if (window.console) console.info("[DMDS] gl2 context restored");
      } catch (err) {
        if (window.console) console.warn("[DMDS] gl2 context restore failed → demoting:", err && err.message);
        state.running = false;
        if (state.onLostTimeout) state.onLostTimeout();
      }
    });

    var fontsReady = (document.fonts && document.fonts.load)
      ? document.fonts.load("600 250px 'Clash Display'").then(function () { return document.fonts.ready; })
      : Promise.resolve();

    return fontsReady.then(function () {
      if (state.destroyed) throw new Error("destroyed during init");
      rebuildFormations();
      milestone("seed", COUNT);

      uploadTarget(gl, state.targA, state.formations.ambient);
      uploadTarget(gl, state.targB, state.formations.logo);
      state.currentName = "logo";
      state.mix = 0;
      state.morphStart = 0;
      state.mode = "tween";
      state.tweenDur = state.morphDur = REDUCED ? 0.01 : 2.2;
      state.excite = 1;
      state.ready = true;
      state.running = true;

      listen(window, "resize", function () {
        resize();
        Object.keys(state.formations).forEach(function (k) {
          if (k.indexOf("text:") === 0) delete state.formations[k];
        });
        rebuildFormations();
        var name = state.currentName;
        state.currentName = null;
        setFormation(name, true);
      });
      listen(window, "mousemove", function (e) {
        state.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        state.mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
        state.mouse.wx = state.mouse.x * state.hw;
        state.mouse.wy = -state.mouse.y * state.hh;
        state.mouse.strTarget = REDUCED ? 0 : 2.4;
      });
      listen(window, "mouseout", function () { state.mouse.strTarget = 0; });
      listen(document, "visibilitychange", function () {
        if (document.hidden) { state.running = false; }
        else if (!state.running && !state.destroyed) {
          state.running = true;
          state.lastT = performance.now() * 0.001; // dt clamp handles the gap
          state.raf = requestAnimationFrame(frame);
        }
      });

      state.raf = requestAnimationFrame(frame);
      setTimeout(function () { state.morphDur = REDUCED ? 0.01 : 1.5; }, 2400);
    });
  }

  /* ═══ test-only instruments ═══ */
  // overwrite one particle's position texel — lets tests inject NaN /
  // out-of-bounds states and prove the recovery branch, not argue it
  function debugPoke(index, x, y, z) {
    if (!DEBUG) throw new Error("debugPoke requires ?debug=1");
    var gl = state.gl;
    var data = new Float32Array([x, y, z, DEPTH_FREE]);
    gl.bindTexture(gl.TEXTURE_2D, state.posT[state.cur]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, index % N, Math.floor(index / N), 1, 1, gl.RGBA, gl.FLOAT, data);
  }
  function debugGLHealth() {
    if (!DEBUG) throw new Error("debugGLHealth requires ?debug=1");
    var gl = state.gl;
    var out = { error: gl.getError(), fbo: [] };
    for (var d = 0; d < 2; d++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, state.simFbo[d]);
      out.fbo.push(gl.checkFramebufferStatus(gl.FRAMEBUFFER));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }
  function debugReadState() {
    if (!DEBUG) throw new Error("debugReadState requires ?debug=1");
    if (N > 64) throw new Error("debugReadState limited to N<=64 (use debugReadSample at production N)");
    var gl = state.gl;
    var pos = new Float32Array(COUNT * 4), vel = new Float32Array(COUNT * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.simFbo[state.cur]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, pos);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, vel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { n: N, positions: pos, velocities: vel };
  }
  // deterministic 32×32 texel subset — works at ANY N, so production-size
  // behavior is measured, not inferred from small-N runs
  function debugReadSample() {
    if (!DEBUG) throw new Error("debugReadSample requires ?debug=1");
    var gl = state.gl, w = Math.min(32, N);
    var pos = new Float32Array(w * w * 4), vel = new Float32Array(w * w * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.simFbo[state.cur]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, w, w, gl.RGBA, gl.FLOAT, pos);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(0, 0, w, w, gl.RGBA, gl.FLOAT, vel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { n: N, w: w, positions: pos, velocities: vel };
  }
  // read the target textures themselves, so tests compare state against
  // the actual GPU-side targets rather than re-deriving them on the CPU
  function debugReadTargets(w) {
    if (!DEBUG) throw new Error("debugReadTargets requires ?debug=1");
    var gl = state.gl;
    w = Math.min(w || 32, N);
    var fb = gl.createFramebuffer();
    var out = {};
    [["a", state.targA], ["b", state.targB]].forEach(function (pair) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pair[1], 0);
      var data = new Float32Array(w * w * 4);
      gl.readPixels(0, 0, w, w, gl.RGBA, gl.FLOAT, data);
      out[pair[0]] = data;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    return out;
  }
  // advance the simulation manually with a fixed dt while paused —
  // single-step granularity for exact state-transition contracts
  function debugStep(steps, dt) {
    if (!DEBUG) throw new Error("debugStep requires ?debug=1");
    dt = dt || 1 / 60;
    for (var i = 0; i < (steps || 1); i++) {
      state.time += dt;
      simStep(dt, state.time);
    }
  }

  window.DMDS_GL2 = {
    probe: probe,
    init: init,
    destroy: destroy,
    setFormation: function (n, dur) { setFormation(n, false, dur); },
    setMorphPair: setMorphPair,
    setDim: function (v) { state.dimTarget = v; },
    kick: function (v) { state.turbTarget = Math.min(state.turbTarget + v, REDUCED ? 0 : 0.55); excite(0.7); },
    fps: function () { return state.fps; },
    isReady: function () { return state.ready; },
    pause: function () { state.running = false; },
    resume: function () {
      if (!state.destroyed && !state.running && state.ready) {
        state.running = true;
        state.lastT = performance.now() * 0.001; // dt clamp covers the gap
        state.raf = requestAnimationFrame(frame);
      }
    },
    onLostTimeout: function (fn) { state.onLostTimeout = fn; },
    status: function () { return { tier: "gl2", post: state.post, count: COUNT, max: COUNT, running: state.running, formation: state.currentName, mix: state.mix, excite: Math.round(state.excite * 100) / 100 }; },
    debugReadState: debugReadState,
    debugReadSample: debugReadSample,
    debugReadTargets: debugReadTargets,
    debugStep: debugStep,
    debugPoke: debugPoke,
    debugGLHealth: debugGLHealth
  };
})();
