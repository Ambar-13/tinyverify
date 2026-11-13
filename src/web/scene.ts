/**
 * The picture behind the demo page: a halftone print of one large word and a shoal of goldfish, drawn on a canvas. It
 * is plain browser JavaScript, served inline before the page script. The page script tells it two things only: which
 * word to print (Scene.word) and what the shoal should do (Scene.mode). Nothing here talks to the network.
 */

export const SCENE_SOURCE = String.raw`
var Scene = (function () {
  'use strict';
  var still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var FONT = '"Bricolage Grotesque"';
  var HOME_WORD = 'TinyVerify';
  var TONE_SCALE = 1 / 3;
  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  var cv = document.getElementById('ht');
  var ask = document.getElementById('ask');
  var gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
  // Two tone pictures feed the print. The first holds the ink (red channel) and the orange (green channel);
  // the second holds the fish's yellow (red channel) and red (green channel).
  var tone = document.createElement('canvas'), tctx = tone.getContext('2d');
  var tone2 = document.createElement('canvas'), tctx2 = tone2.getContext('2d');
  var wordA = document.createElement('canvas'), wordB = document.createElement('canvas');
  var W = 0, H = 0, DPR = 1, mobile = false;
  var tex = null, tex2 = null, uni = {};

  // ---- the halftone print: four screens of dots, each at its own angle. Each ink dot is printed over a slightly
  // larger dot of bare paper, so the word keeps a white rim and stays readable when a fish swims behind it.

  var VERTEX = ['#version 300 es', 'in vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }'].join('\n');
  var FRAGMENT = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D uTone, uTone2; uniform vec2 uRes; uniform float uCell; uniform vec3 uLens; uniform float uLensR;',
    'out vec4 o;',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
    'float layer(sampler2D tx, vec2 p, float ang, int ch, float grow){',
    '  float c = cos(ang), s = sin(ang);',
    '  mat2 R = mat2(c, s, -s, c);',
    '  vec2 q = R * p;',
    '  vec2 cc = (floor(q / uCell) + .5) * uCell;',
    '  vec2 pc = transpose(R) * cc;',
    '  vec2 uv = vec2(pc.x / uRes.x, 1. - pc.y / uRes.y);',
    '  vec4 t4 = texture(tx, uv);',
    '  float t = ch == 0 ? t4.r : t4.g;',
    '  float r = uCell * .5 * sqrt(t) * 1.2 + grow;',
    '  float d = length(q - cc);',
    '  return (1. - smoothstep(r - .9, r + .9, d)) * smoothstep(.015, .06, t);',
    '}',
    'void main(){',
    '  vec2 p = gl_FragCoord.xy;',
    '  vec2 d = p - uLens.xy;',
    '  float k = uLens.z * .26 * exp(-dot(d, d) / (2. * uLensR * uLensR));',
    '  p = uLens.xy + d * (1. - k);',
    '  float ink = layer(uTone, p, .7854, 0, 0.);',
    '  float rim = layer(uTone, p, .7854, 0, uCell * .34);',
    '  float ora = layer(uTone, p, .2618, 1, 0.);',
    '  float yel = layer(uTone2, p, 0., 0, 0.);',
    '  float red = layer(uTone2, p, 1.309, 1, 0.);',
    '  vec3 col = vec3(1., 1., .996);',
    '  col *= mix(vec3(1.), vec3(1., .8, .2), yel * .95);',
    '  col *= mix(vec3(1.), vec3(.96, .45, .13), ora * .96);',
    '  col *= mix(vec3(1.), vec3(.86, .18, .15), red * .95);',
    '  col = mix(col, vec3(1., 1., .996), rim);',
    '  col *= mix(vec3(1.), vec3(.115, .105, .095), ink);',
    '  col *= .988 + .016 * hash(floor(gl_FragCoord.xy));',
    '  o = vec4(col, 1.);',
    '}'
  ].join('\n');

  function shader(type, source) {
    var s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    return s;
  }
  function texture(unit) {
    var t = gl.createTexture();
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  if (gl) {
    var prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    tex = texture(gl.TEXTURE0);
    tex2 = texture(gl.TEXTURE1);
    ['uTone', 'uTone2', 'uRes', 'uCell', 'uLens', 'uLensR'].forEach(function (n) { uni[n] = gl.getUniformLocation(prog, n); });
    gl.uniform1i(uni.uTone, 0);
    gl.uniform1i(uni.uTone2, 1);
  }

  // ---- the large word, printed in the ink screen

  var word = HOME_WORD, nextWord = null, morph = 0;
  var askBottom = 200, wordBottom = 0;

  function paintWord(target, text) {
    var c = target.getContext('2d');
    target.width = tone.width;
    target.height = tone.height;
    c.clearRect(0, 0, target.width, target.height);
    var k = TONE_SCALE, left = (mobile ? 18 : W * .04) * k;
    var size = (mobile ? W * .2 : Math.min(W * .155, H * .3)) * k;
    var maxW = (W - (mobile ? 36 : W * .08)) * k;
    function setFont() { c.font = '800 ' + size + 'px ' + FONT; c.letterSpacing = (-size * .045) + 'px'; }
    setFont();
    // Every word is sized as if it were at least as wide as the name, so a short verdict is not printed larger.
    var w = Math.max(c.measureText(HOME_WORD).width, c.measureText(text).width);
    // A window with no width yet has no room to fit to; the word is painted again when the window gets its size.
    if (maxW > 0 && w > maxW) { size *= maxW / w; setFont(); }
    // On phones the word sits just under the search box, whatever the screen height.
    wordBottom = mobile ? Math.max(askBottom + 30 + size / k * .74, H * .3) : H * .955;
    var base = wordBottom * k;
    var g = c.createLinearGradient(0, base - size * .75, 0, base);
    g.addColorStop(0, 'rgb(255,0,0)');
    g.addColorStop(1, 'rgb(185,0,0)');
    c.fillStyle = g;
    c.fillText(text, left, base);
  }

  function settleWord() {
    word = nextWord;
    nextWord = null;
    morph = 0;
    paintWord(wordA, word);
  }

  function setWord(text) {
    if (text === (nextWord || word)) return;
    if (nextWord) settleWord();
    nextWord = text;
    paintWord(wordB, text);
    morph = 0;
    if (still) settleWord();
  }

  // ---- the shoal

  var fish = [];
  // What the page asked for (swim, search, check, orbit, hide) and how the shoal steers to do it.
  var asked = 'swim', mode = 'swim';
  var orbitCentres = [];
  var pointer = { x: -999, y: -999, inside: false };
  var startle = { x: 0, y: 0, s: 0 };

  function makeShoal() {
    fish.length = 0;
    var n = mobile ? 9 : 16;
    for (var i = 0; i < n; i++) {
      var L = (i === 0 ? rand(210, 240) : rand(105, 165)) * (mobile ? .62 : 1);
      var a = rand(0, Math.PI * 2);
      fish.push({
        x: rand(0, W), y: rand(H * .25, H * .9), vx: Math.cos(a) * 50, vy: Math.sin(a) * 50, ang: a,
        flip: Math.cos(a) >= 0 ? 1 : -1, L: L, ph: rand(0, 6.3), wander: rand(0, 6.3),
        tx: null, ty: null, tang: null, speed: rand(.85, 1.15), entered: false
      });
    }
  }

  function swimBox(f) {
    var half = f.L * .5, m = mobile ? 10 : 60;
    return { l: m + half, r: W - m - half, t: (mobile ? askBottom + 30 : H * .16) + f.L * .2, b: H - (mobile ? 80 : 90) - f.L * .2 };
  }

  // The acceleration on one fish: keep with the shoal, keep apart, wander, head for a target, flee, stay in the water.
  function pull(f, dt, topSpeed) {
    var ax = 0, ay = 0, cx = 0, cy = 0, avx = 0, avy = 0, cnt = 0, sx = 0, sy = 0;
    fish.forEach(function (g) {
      if (g === f) return;
      var dx = g.x - f.x, dy = g.y - f.y, d2 = dx * dx + dy * dy;
      if (d2 >= 260 * 260) return;
      cx += g.x; cy += g.y; avx += g.vx; avy += g.vy; cnt++;
      var r = (f.L + g.L) * .62;
      if (d2 < r * r) { var d = Math.sqrt(d2) || 1, push = 1 - d / r; sx -= dx / d * push; sy -= dy / d * push; }
    });
    if (cnt && mode === 'swim') {
      ax += (avx / cnt - f.vx) * .7; ay += (avy / cnt - f.vy) * .7;
      ax += (cx / cnt - f.x) * .18; ay += (cy / cnt - f.y) * .18;
    }
    var sepW = mode === 'form' ? 260 : 520;
    ax += sx * sepW; ay += sy * sepW;
    if (mode === 'swim') {
      f.wander += rand(-1, 1) * dt * 1.6;
      ax += Math.cos(f.wander) * 26; ay += Math.sin(f.wander) * 14;
    }
    if (f.tx !== null) {
      var tx = f.tx - f.x, ty = f.ty - f.y, td = Math.hypot(tx, ty) || 1;
      var want = Math.min(topSpeed, td * 2.6);
      ax += (tx / td * want - f.vx) * 3.4; ay += (ty / td * want - f.vy) * 3.4;
    }
    // Fear steers the velocity away from a point; it never shoves the fish backwards.
    var fears = [];
    if (pointer.inside && mode !== 'form') fears.push([pointer.x, pointer.y, 105, 1]);
    if (startle.s > 0) fears.push([startle.x, startle.y, 170, startle.s * 1.4]);
    fears.forEach(function (fear) {
      var fx = f.x - fear[0], fy = f.y - fear[1], fd = Math.hypot(fx, fy);
      if (fd > fear[2] || fd < 1) return;
      var fk = (1 - fd / fear[2]) * fear[3];
      ax += (fx / fd * 260 - f.vx) * 2.4 * fk; ay += (fy / fd * 260 - f.vy) * 2.4 * fk;
    });
    var am = Math.hypot(ax, ay);
    if (am > 900) { ax *= 900 / am; ay *= 900 / am; }
    // The water's edges are added after the cap, so nothing can carry a fish off screen while it swims.
    if (mode === 'swim') {
      var b = swimBox(f);
      var edge = function (e) { return e * 5 + e * e * .06; };
      if (f.x < b.l) ax += edge(b.l - f.x);
      if (f.x > b.r) ax -= edge(f.x - b.r);
      if (f.y < b.t) ay += edge(b.t - f.y);
      if (f.y > b.b) ay -= edge(f.y - b.b);
    }
    return [ax, ay];
  }

  // Moves one fish by its acceleration and returns its new speed.
  function move(f, a, dt, topSpeed) {
    f.vx += a[0] * dt; f.vy += a[1] * dt;
    var sp = Math.hypot(f.vx, f.vy);
    var max = topSpeed * (mode === 'swim' && (pointer.inside || startle.s > 0) ? 2.6 : 1);
    var s = clamp(sp, mode === 'form' && f.tx !== null ? 0 : 24, max);
    if (sp > 0) { f.vx *= s / sp; f.vy *= s / sp; }
    f.x += f.vx * dt; f.y += f.vy * dt;
    if (mode === 'swim' && f.entered) {
      var box = swimBox(f), pad = f.L * .35;
      f.x = clamp(f.x, box.l - pad - 30, box.r + pad + 30);
      f.y = clamp(f.y, box.t - 40, box.b + 40);
    }
    if (!f.entered && f.x > 0 && f.x < W) f.entered = true;
    return s;
  }

  // The heading turns at a limited rate, and only while the fish is actually moving.
  function turn(f, speed, dt) {
    var heading = f.ang;
    if (speed > 14) heading = Math.atan2(f.vy, f.vx);
    if (mode === 'form' && f.tx !== null && Math.hypot(f.tx - f.x, f.ty - f.y) < 28) heading = f.tang;
    var da = Math.atan2(Math.sin(heading - f.ang), Math.cos(heading - f.ang));
    f.ang += clamp(da, -4.2 * dt, 4.2 * dt);
    // Seen from the side: going from right to left, the fish turns through edge-on and never flips.
    var side = Math.cos(f.ang) >= 0 ? 1 : -1;
    f.flip += (side - f.flip) * Math.min(1, dt * 5);
    f.ph += dt * (3 + speed * .04);
  }

  function steer(dt) {
    var maxBase = mode === 'swim' ? 85 : mode === 'hide' ? 360 : 330;
    startle.s = Math.max(0, startle.s - dt * 1.6);
    fish.forEach(function (f) {
      var topSpeed = maxBase * f.speed;
      var speed = move(f, pull(f, dt, topSpeed), dt, topSpeed);
      turn(f, speed, dt);
    });
  }

  function poly(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();
  }
  function oval(ctx, x, y, rx, ry) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // A goldfish seen from the side: orange body, yellow face and belly, red fins and tail, a large eye with an ink pupil.
  function drawFish(f) {
    var k = TONE_SCALE, L = f.L * k, ry = L * .17;
    var pitchMax = mode === 'form' ? 1.1 : .55;
    var pitch = clamp(Math.atan2(Math.sin(f.ang), Math.abs(Math.cos(f.ang))), -pitchMax, pitchMax);
    var th = pitch * (f.flip >= 0 ? 1 : -1), c = Math.cos(th), s = Math.sin(th);
    var wav = Math.sin(f.ph) * ry * .22, fl = .82 + .18 * Math.sin(f.ph * 1.6);

    // Red: the tail fan and the fins.
    tctx2.setTransform(c * f.flip, s * f.flip, -s, c, f.x * k, f.y * k);
    tctx2.fillStyle = 'rgb(0,235,0)';
    poly(tctx2, [[-L * .2, -ry * .22], [-L * .52, -ry * 1.3 * fl + wav], [-L * .42, wav * .6], [-L * .52, ry * 1.3 * fl + wav], [-L * .2, ry * .22]]);
    poly(tctx2, [[L * .2, -ry * .9], [-L * .02, -ry * 1.75 + wav * .3], [-L * .13, -ry * .75]]);
    poly(tctx2, [[L * .2, ry * .55], [L * .03, ry * 1.25 + wav * .3], [L * .1, ry * .35]]);
    // Yellow: the face and the belly.
    tctx2.fillStyle = 'rgb(225,0,0)';
    oval(tctx2, L * .12, ry * .42, L * .27, ry * .55);
    tctx2.fillStyle = 'rgb(150,0,0)';
    oval(tctx2, L * .34, 0, L * .12, ry * .8);

    // Orange: the body, darker on the back and lighter towards the belly.
    tctx.setTransform(c * f.flip, s * f.flip, -s, c, f.x * k, f.y * k);
    var g = tctx.createLinearGradient(0, -ry, 0, ry);
    g.addColorStop(0, 'rgb(0,255,0)');
    g.addColorStop(1, 'rgb(0,110,0)');
    tctx.fillStyle = g;
    oval(tctx, L * .1, 0, L * .36, ry);
    poly(tctx, [[-L * .14, -ry * .55], [-L * .25, -ry * .16], [-L * .25, ry * .16], [-L * .14, ry * .55]]);

    // The eye: a clear white, then an ink pupil.
    [tctx, tctx2].forEach(function (ctx) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.arc(L * .3, -ry * .2, ry * .38, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
    });
    tctx.fillStyle = 'rgb(255,0,0)';
    tctx.beginPath(); tctx.arc(L * .32, -ry * .18, ry * .2, 0, Math.PI * 2); tctx.fill();
  }

  // ---- where the shoal goes

  function clearTargets() { fish.forEach(function (f) { f.tx = f.ty = f.tang = null; }); }

  function hideAtEdges() {
    fish.forEach(function (f) {
      f.entered = false;
      f.tx = Math.random() < .5 ? rand(-260, -60) : W + rand(60, 260);
      f.ty = rand(H * .2, H);
    });
  }

  // The larger fish line up along a tick; the rest circle it loosely.
  function formCheck() {
    var s = mobile ? Math.min(W * .36, H * .2) : Math.min(W, H) * .44;
    var cx = mobile ? W * .5 : W * .33, cy = mobile ? wordBottom + s * .85 : H * .5;
    var A = [cx - s * .45, cy], B = [cx - s * .12, cy + s * .33], C = [cx + s * .5, cy - s * .4];
    var segs = [[A, B], [B, C]];
    var lens = segs.map(function (g) { return Math.hypot(g[1][0] - g[0][0], g[1][1] - g[0][1]); });
    var total = lens[0] + lens[1];
    var avg = fish.reduce(function (sum, f) { return sum + f.L; }, 0) / fish.length;
    var onPath = Math.min(fish.length, Math.max(4, Math.round(total / (avg * .8))));
    var free = fish.slice();
    for (var i = 0; i < onPath; i++) {
      var d = (i + .5) / onPath * total, si = 0;
      if (d > lens[0]) { d -= lens[0]; si = 1; }
      var p = segs[si][0], q = segs[si][1], t = d / lens[si];
      var px = p[0] + (q[0] - p[0]) * t, py = p[1] + (q[1] - p[1]) * t;
      var best = 0, bd = Infinity;
      free.forEach(function (f, n) { var dist = Math.hypot(f.x - px, f.y - py); if (dist < bd) { bd = dist; best = n; } });
      var chosen = free.splice(best, 1)[0];
      chosen.tx = px; chosen.ty = py; chosen.tang = Math.atan2(q[1] - p[1], q[0] - p[0]);
    }
    free.forEach(function (f, n) {
      var a = n / free.length * 6.28;
      f.tx = cx + Math.cos(a) * s * 1.05; f.ty = cy + Math.sin(a) * s * .7; f.tang = a + 1.57;
    });
  }

  // One ring while a check is under way; two rings when the visitor has to choose between records.
  function setOrbits() {
    if (asked === 'search') orbitCentres = mobile ? [[W * .5, H * .58]] : [[W * .36, H * .6]];
    else orbitCentres = mobile ? [[W * .3, H * .48], [W * .7, H * .48]] : [[W * .2, H * .55], [W * .44, H * .55]];
  }

  function updateOrbits(time) {
    var one = orbitCentres.length === 1;
    fish.forEach(function (f, i) {
      var c = orbitCentres[i % orbitCentres.length];
      var r = (mobile ? 64 : one ? 150 : 120) + (i % 4) * 22;
      var a = time * .9 * (one || i % 2 ? 1 : -1) + i * 1.1;
      f.tx = c[0] + Math.cos(a) * r; f.ty = c[1] + Math.sin(a) * r * .75;
    });
  }

  function setMode(name) {
    asked = name;
    if (!fish.length) return;
    if (name === 'check') { mode = 'form'; formCheck(); }
    else if (name === 'hide') { mode = 'hide'; hideAtEdges(); }
    else if (name === 'search' || name === 'orbit') { mode = 'orbit'; setOrbits(); }
    else { mode = 'swim'; clearTargets(); }
  }

  // ---- drawing

  var last = performance.now(), lens = 0;

  function frame(now) {
    var dt = Math.min(.05, (now - last) / 1000);
    last = now;
    if (!still) {
      if (mode === 'orbit') updateOrbits(now / 1000);
      steer(dt);
    }
    if (nextWord) {
      morph = Math.min(1, morph + dt / 1.3);
      if (morph === 1) settleWord();
    }
    lens += ((pointer.inside ? 1 : 0) - lens) * Math.min(1, dt * 6);
    [[tctx, tone], [tctx2, tone2]].forEach(function (pair) {
      pair[0].setTransform(1, 0, 0, 1, 0, 0);
      pair[0].globalCompositeOperation = 'source-over';
      pair[0].fillStyle = '#000';
      pair[0].fillRect(0, 0, pair[1].width, pair[1].height);
      pair[0].globalCompositeOperation = 'lighter';
    });
    var mix = morph * morph * (3 - 2 * morph);
    tctx.globalAlpha = 1 - mix;
    tctx.drawImage(wordA, 0, 0);
    if (nextWord) { tctx.globalAlpha = mix; tctx.drawImage(wordB, 0, 0); }
    tctx.globalAlpha = 1;
    fish.forEach(drawFish);
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx2.setTransform(1, 0, 0, 1, 0, 0);
    if (gl) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tex2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tone2);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tone);
      gl.uniform3f(uni.uLens, pointer.x * DPR, (H - pointer.y) * DPR, lens);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    requestAnimationFrame(frame);
  }

  function resize() {
    var wasMobile = mobile;
    W = innerWidth; H = innerHeight; mobile = W < 860;
    askBottom = ask.getBoundingClientRect().bottom;
    DPR = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    tone.width = tone2.width = Math.ceil(W * TONE_SCALE);
    tone.height = tone2.height = Math.ceil(H * TONE_SCALE);
    if (gl) {
      gl.viewport(0, 0, cv.width, cv.height);
      gl.uniform2f(uni.uRes, cv.width, cv.height);
      gl.uniform1f(uni.uCell, (mobile ? 7 : 8) * DPR);
      gl.uniform1f(uni.uLensR, 62 * DPR);
    }
    paintWord(wordA, word);
    if (nextWord) paintWord(wordB, nextWord);
    if (fish.length && wasMobile !== mobile) makeShoal();
    if (fish.length && asked !== 'swim') setMode(asked);
  }

  addEventListener('pointermove', function (e) {
    pointer.x = e.clientX; pointer.y = e.clientY;
    pointer.inside = e.pointerType === 'mouse' && !e.target.closest('.ui');
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', function () { pointer.inside = false; });
  cv.addEventListener('pointerdown', function (e) { startle.x = e.clientX; startle.y = e.clientY; startle.s = 1; });
  addEventListener('resize', resize);

  // The word is drawn once its typeface has loaded, or after 2.5 seconds with the fallback face.
  var ready = document.fonts.load('800 200px ' + FONT);
  function start() {
    resize();
    makeShoal();
    // The shoal arrives from the left.
    if (!still) fish.forEach(function (f) { f.x = mobile ? rand(-160, -40) : rand(-500, -60); f.vx = rand(220, 320); f.vy = rand(-20, 20); });
    setMode(asked);
    requestAnimationFrame(frame);
  }
  Promise.race([ready, new Promise(function (r) { setTimeout(r, 2500); })]).then(start, start);

  return { word: setWord, mode: setMode };
})();
`;
