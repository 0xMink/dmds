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
    "uniform float uSwirl;",
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
    // curl advection — peaks mid-morph so transitions swirl like fluid
    "  float sw = uMix * (1.0 - uMix) * 4.0;",
    "  pos += vec3(",
    "    sin(pos.y*0.35 + uTime*0.9 + aRand.w*6.283),",
    "    sin(pos.z*0.30 + uTime*0.8 + aRand.x*6.283),",
    "    sin(pos.x*0.32 + uTime*0.7 + aRand.y*6.283)",
    "  ) * sw * (0.6 + aRand.z * 1.4) * uSwirl;",
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

  // ── post-processing shaders ──
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
    "varying vec2 vUv;",
    "void main(){",
    "  vec2 c = vUv - 0.5;",
    "  float r = length(c);",
    // radial chromatic aberration on the particle field
    "  float k = 0.0045 * r;",
    "  vec3 field;",
    "  field.r = texture2D(uField, vUv + c * k).r;",
    "  field.g = texture2D(uField, vUv).g;",
    "  field.b = texture2D(uField, vUv - c * k).b;",
    "  vec3 glow = texture2D(uGlow, vUv).rgb;",
    // background: deep ink with a faint warm lift top-right
    "  vec3 bg = mix(vec3(0.082, 0.080, 0.088), vec3(0.043, 0.043, 0.047), smoothstep(0.0, 1.0, distance(vUv, vec2(0.72, 0.92))));",
    "  vec3 col = bg + field + glow * 1.15;",
    "  col *= 1.0 - 0.38 * smoothstep(0.5, 1.1, r);",
    // dither to kill gradient banding
    "  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;",
    "  gl_FragColor = vec4(col, 1.0);",
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
    pairA: null, pairB: null, mode: "tween", tweenDur: 1.5,
    curA: null, curB: null, mix: 1, mixTarget: 1, morphStart: 0, morphDur: REDUCED ? 0.01 : 1.5,
    time: 0, lastT: 0, turb: 0, turbTarget: 0,
    mouse: { x: 0, y: 0, wx: 0, wy: 0, str: 0, strTarget: 0 },
    dim: 1, dimTarget: 1,
    rot: { x: 0, y: 0 },
    fps: 60, frames: 0, fpsT: 0,
    hw: 8, hh: 8, ready: false, running: false,
    // post pipeline
    post: false, quadBuf: null, progFade: null, progBlur: null, progComp: null,
    trailA: null, trailB: null, glowA: null, glowB: null,
    locPoints: null, enabledAttribs: [],
    // adaptive quality governor
    drawCount: 0, govT: 0
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

  // ── sample arbitrary text from an offscreen canvas (normalized, cached) ──
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
    // adaptive step: aim for a healthy sample pool on any text length
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

  // ═══ GL setup ═══
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

  function allocTargets() {
    var gl = state.gl, w = state.canvas.width, h = state.canvas.height;
    ["trailA", "trailB", "glowA", "glowB"].forEach(function (k) { destroyFBO(gl, state[k]); });
    state.trailA = makeFBO(gl, w, h);
    state.trailB = makeFBO(gl, w, h);
    var qw = Math.max(2, w >> 2), qh = Math.max(2, h >> 2);
    state.glowA = makeFBO(gl, qw, qh);
    state.glowB = makeFBO(gl, qw, qh);
  }

  // attribute switching between the points pass and fullscreen-quad passes
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
        try { allocTargets(); } catch (e) { state.post = false; }
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
    state.pairA = null; state.pairB = null; // force scrub rebuffer
  }

  // resolve a formation by name; "text:STR" typesets STR on demand
  function formationFor(name) {
    if (state.formations[name]) return state.formations[name];
    if (name && name.indexOf("text:") === 0) {
      var str = name.slice(5);
      var pts = sampleText(str);
      if (!pts.xy.length) return null;
      var f = genLogo(pts);
      state.formations[name] = f;
      return f;
    }
    return null;
  }

  function setFormation(name, instant, dur) {
    if (!state.ready || name === state.currentName) return;
    var target = formationFor(name);
    if (!target) return;
    var gl = state.gl;
    // freeze current interpolated positions into A
    if (state.mix < 1 && state.curA && state.curB) {
      var t = state.mode === "scrub" ? smooth01(state.mix) : easeCubic(state.mix);
      var a = state.curA, b = state.curB;
      var frozen = new Float32Array(COUNT * 3);
      for (var i = 0; i < COUNT * 3; i++) frozen[i] = a[i] + (b[i] - a[i]) * t;
      state.curA = frozen;
    } else {
      state.curA = state.curB || target;
    }
    state.curB = target;
    state.currentName = name;
    state.pairA = null; state.pairB = null;
    gl.bindBuffer(gl.ARRAY_BUFFER, state.bufA);
    gl.bufferData(gl.ARRAY_BUFFER, state.curA, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.bufB);
    gl.bufferData(gl.ARRAY_BUFFER, state.curB, gl.DYNAMIC_DRAW);
    state.mode = "tween";
    state.tweenDur = REDUCED ? 0.01 : (dur || state.morphDur);
    state.mix = instant ? 1 : 0;
    state.morphStart = state.time;
  }

  function smooth01(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

  // scroll-scrubbed morphing: pin the pair, drive mix directly
  function setMorphPair(a, b, t) {
    if (!state.ready) return;
    if (state.pairA !== a || state.pairB !== b) {
      var fa = formationFor(a), fb = formationFor(b);
      if (!fa || !fb) return;
      var gl = state.gl;
      state.curA = fa; state.curB = fb;
      state.pairA = a; state.pairB = b;
      state.currentName = t >= 0.5 ? b : a;
      gl.bindBuffer(gl.ARRAY_BUFFER, state.bufA);
      gl.bufferData(gl.ARRAY_BUFFER, state.curA, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, state.bufB);
      gl.bufferData(gl.ARRAY_BUFFER, state.curB, gl.DYNAMIC_DRAW);
    }
    state.mode = "scrub";
    state.mix = Math.max(0, Math.min(1, t));
    state.currentName = state.mix >= 0.5 ? b : a;
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

    // morph progress (scrub mode is driven externally)
    if (state.mode === "tween" && state.mix < 1) state.mix = Math.min(1, (now - state.morphStart) / state.tweenDur);

    // smooth mouse strength + turbulence decay
    state.mouse.str += (state.mouse.strTarget - state.mouse.str) * (1 - Math.exp(-8 * dt));
    state.dim += (state.dimTarget - state.dim) * (1 - Math.exp(-5 * dt));
    state.turb += (state.turbTarget - state.turb) * (1 - Math.exp(-4 * dt));
    state.turbTarget *= Math.exp(-2.2 * dt);

    var ry = REDUCED ? 0 : Math.sin(now * 0.07) * 0.09 + state.mouse.x * 0.05;
    var rx = REDUCED ? 0 : Math.sin(now * 0.05) * 0.04 + state.mouse.y * 0.035;

    // adaptive quality governor: protect frame rate before aesthetics
    if (!state.govLocked && now - state.govT > 2 && state.fpsT > 3) {
      state.govT = now;
      if (state.fps < 40 && state.drawCount > COUNT / 4) {
        state.drawCount = Math.floor(state.drawCount / 2);
        if (window.console) console.info("[DMDS] governor: particle budget → " + state.drawCount);
      } else if (state.fps > 56 && state.drawCount < COUNT) {
        state.drawCount = Math.min(COUNT, state.drawCount * 2);
      }
    }

    function drawPoints() {
      gl.useProgram(state.program);
      useAttribs([
        { loc: state.locPoints.aPosA, buf: state.bufA, size: 3 },
        { loc: state.locPoints.aPosB, buf: state.bufB, size: 3 },
        { loc: state.locPoints.aRand, buf: state.bufR, size: 4 }
      ]);
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
      gl.uniform1f(state.loc.uSwirl, REDUCED ? 0 : 2.1);
      gl.drawArrays(gl.POINTS, 0, state.drawCount);
    }

    if (state.post) {
      var W = state.canvas.width, H = state.canvas.height;
      // 1 — persistence: previous trail, decayed, into the other trail buffer
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, state.trailB.fb);
      gl.viewport(0, 0, W, H);
      drawQuad(state.progFade, state.trailA.tex, function () {
        // frame-rate-independent persistence (~9/s decay)
        gl.uniform1f(state.progFade.uDecay, REDUCED ? 0.0 : Math.exp(-dt * 9));
      });
      // 2 — points, additive, on top of the decayed trail
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      drawPoints();
      gl.disable(gl.BLEND);
      // 3 — bloom: downsample + separable blur at quarter res
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
      // 4 — composite: field + glow + chromatic aberration + vignette
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      drawQuad(state.progComp, state.trailB.tex, function () {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, state.glowB.tex);
        gl.uniform1i(state.progComp.uGlow, 1);
        gl.activeTexture(gl.TEXTURE0);
      });
      // swap trail buffers
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

    state.bufA = gl.createBuffer();
    state.bufB = gl.createBuffer();
    state.locPoints = {
      aPosA: gl.getAttribLocation(prog, "aPosA"),
      aPosB: gl.getAttribLocation(prog, "aPosB"),
      aRand: gl.getAttribLocation(prog, "aRand")
    };
    state.drawCount = COUNT;

    gl.clearColor(0, 0, 0, 0);
    gl.disable(gl.DEPTH_TEST);

    // post-processing pipeline (desktop): trails, bloom, aberration
    if (!MOBILE) {
      try {
        var pf = makeProgram(gl, QUAD_VS, FADE_FS);
        state.progFade = { p: pf, aXY: gl.getAttribLocation(pf, "aXY"), uTex: gl.getUniformLocation(pf, "uTex"), uDecay: gl.getUniformLocation(pf, "uDecay") };
        var pb = makeProgram(gl, QUAD_VS, BLUR_FS);
        state.progBlur = { p: pb, aXY: gl.getAttribLocation(pb, "aXY"), uTex: gl.getUniformLocation(pb, "uTex"), uDir: gl.getUniformLocation(pb, "uDir") };
        var pc = makeProgram(gl, QUAD_VS, COMP_FS);
        state.progComp = { p: pc, aXY: gl.getAttribLocation(pc, "aXY"), uTex: gl.getUniformLocation(pc, "uField"), uGlow: gl.getUniformLocation(pc, "uGlow") };
        state.quadBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        state.post = true;
      } catch (e) {
        state.post = false; // direct path still works
      }
    }

    resize();
    if (state.post) {
      try { allocTargets(); } catch (e) { state.post = false; }
    }

    var fontsReady = (document.fonts && document.fonts.load)
      ? document.fonts.load("600 250px 'Clash Display'").then(function () { return document.fonts.ready; })
      : Promise.resolve();

    return fontsReady.then(function () {
      rebuildFormations();

      // wire attribute pointers once buffers hold data
      var scattered = genAmbient();
      state.curA = scattered;
      state.curB = state.formations.logo;
      state.currentName = "logo";
      var gl2 = state.gl;
      gl2.bindBuffer(gl2.ARRAY_BUFFER, state.bufA);
      gl2.bufferData(gl2.ARRAY_BUFFER, state.curA, gl2.DYNAMIC_DRAW);
      gl2.bindBuffer(gl2.ARRAY_BUFFER, state.bufB);
      gl2.bufferData(gl2.ARRAY_BUFFER, state.curB, gl2.DYNAMIC_DRAW);
      // attribute binding happens per-pass via useAttribs()

      state.mix = 0;
      state.morphStart = 0;
      state.mode = "tween";
      state.tweenDur = state.morphDur = REDUCED ? 0.01 : 2.2; // slow, cinematic first assembly
      state.ready = true;
      state.running = true;

      window.addEventListener("resize", function () {
        resize();
        // drop world-space text formations; normalized samples in textCache survive
        Object.keys(state.formations).forEach(function (k) {
          if (k.indexOf("text:") === 0) delete state.formations[k];
        });
        rebuildFormations();
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
    setFormation: function (n, dur) { setFormation(n, false, dur); },
    setMorphPair: setMorphPair,
    setDim: function (v) { state.dimTarget = v; },
    setBudget: function (n) { state.drawCount = Math.min(COUNT, n | 0); state.govLocked = true; },
    kick: function (v) { state.turbTarget = Math.min(state.turbTarget + v, REDUCED ? 0 : 0.55); },
    fps: function () { return state.fps; },
    isReady: function () { return state.ready; }
  };
})();
