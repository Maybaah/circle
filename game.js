/* Draw a Perfect Circle for Maybaah's Arcade.
   One tape per run: a seed plus every point the pointer passed through, each
   written as the milliseconds since the point before it. The seed decides where
   the stroke has to start and which way it has to go, so the Worker rebuilds
   the same marker, walks the same polyline and computes the accuracy itself. */

(() => {
  "use strict";

  /* ── the engine ──────────────────────────────────────────────────────────
     Everything between these markers is duplicated, byte for byte, in
     site/worker/src/index.js. Drift means the page shows an accuracy the
     referee does not agree with, and every submission stops verifying. */

  const CIRCLE_SIZE = 1000;
  const CIRCLE_CX = 500, CIRCLE_CY = 500;
  const CIRCLE_MIN_R = 70, CIRCLE_MAX_R = 470;
  const CIRCLE_SAMPLES = 180;
  const CIRCLE_MIN_POINTS = 36;
  const CIRCLE_MAX_POINTS = 4000;
  const CIRCLE_MAX_STEP = 24;
  const CIRCLE_BACK = 3;
  const CIRCLE_START_TOL = 22;
  const CIRCLE_MIN_MS = 400, CIRCLE_MAX_MS = 40000;
  const CIRCLE_MAX_GAP = 400;

  function circleMulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* The seed is the whole setup: which spoke the stroke starts on and which way
     it runs. Both come off the generator in this order, so a page and the
     referee draw the same marker from the same number. */
  function circleStart(seed) {
    const rnd = circleMulberry32(seed >>> 0);
    const deg = Math.floor(rnd() * 360);
    const dir = rnd() < 0.5 ? 1 : -1;
    return { deg, dir };
  }

  /* Screen space: y grows downward, so a rising angle is clockwise and dir 1 is
     clockwise. */
  function circleAngle(x, y) {
    const a = Math.atan2(y - CIRCLE_CY, x - CIRCLE_CX) * 180 / Math.PI;
    return a < 0 ? a + 360 : a;
  }

  function circleDelta(from, to) {
    let d = to - from;
    while (d > 180) d -= 360;
    while (d <= -180) d += 360;
    return d;
  }

  function circleRadius(x, y) {
    const dx = x - CIRCLE_CX, dy = y - CIRCLE_CY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* Every field is variable width, so each point is closed with a semicolon:
     without it a gap of 12 followed by an x of 500 reads as a gap of 12500. */
  const CIRCLE_TAPE_RE = /^(\d{1,4},\d{1,4},\d{1,4};)*$/;

  function circleEncode(points) {
    return points.map((p) => p.dt + "," + p.x + "," + p.y + ";").join("");
  }

  function circleDecode(tape) {
    if (typeof tape !== "string" || tape.length > 16 * CIRCLE_MAX_POINTS) return null;
    if (!CIRCLE_TAPE_RE.test(tape)) return null;
    const points = [];
    const re = /(\d{1,4}),(\d{1,4}),(\d{1,4});/g;
    let m;
    while ((m = re.exec(tape))) points.push({ dt: +m[1], x: +m[2], y: +m[3] });
    return points;
  }

  /* Kasa's circle fit, in closed form: the algebraic least squares of
     x² + y² + Ax + By + C = 0, which is eight sums and one 3x3 solve, with no
     iteration to go wrong on either side. */
  function circleDet3(m) {
    return m[0] * (m[4] * m[8] - m[5] * m[7])
         - m[1] * (m[3] * m[8] - m[5] * m[6])
         + m[2] * (m[3] * m[7] - m[4] * m[6]);
  }

  function circleFit(xs, ys) {
    const n = xs.length;
    let Suu = 0, Suv = 0, Svv = 0, Su = 0, Sv = 0, Suz = 0, Svz = 0, Sz = 0;
    for (let k = 0; k < n; k++) {
      const u = xs[k], v = ys[k], z = u * u + v * v;
      Suu += u * u; Suv += u * v; Svv += v * v;
      Su += u; Sv += v;
      Suz += u * z; Svz += v * z; Sz += z;
    }
    const base = [Suu, Suv, Su, Suv, Svv, Sv, Su, Sv, n];
    const rhs = [-Suz, -Svz, -Sz];
    const det = circleDet3(base);
    if (!(Math.abs(det) > 1e-6)) return null;
    const col = (c) => {
      const m = base.slice();
      m[c] = rhs[0]; m[c + 3] = rhs[1]; m[c + 6] = rhs[2];
      return circleDet3(m) / det;
    };
    const A = col(0), B = col(1), C = col(2);
    const rr = (A * A + B * B) / 4 - C;
    if (!(rr > 0)) return null;
    return { x: -A / 2, y: -B / 2, r: Math.sqrt(rr) };
  }

  /* The stroke is walked once to check it is a single sweep, then resampled at
     a fixed number of equal angles so a fast hand and a slow one are measured
     the same way, and a circle is fitted to those samples. Fitting the centre
     rather than assuming it is what forgives drawing around the wrong point,
     because being off centre is not being out of round, and that leaves the
     whole penalty on the wobble, which is the thing anyone is testing. */
  function circleReplay(seed, points) {
    if (!Array.isArray(points) || points.length < CIRCLE_MIN_POINTS) {
      return { ok: false, reason: "that stroke has too few points to be a circle" };
    }
    if (points.length > CIRCLE_MAX_POINTS) return { ok: false, reason: "bad stroke log" };

    const start = circleStart(seed);
    const first = points[0];
    if (first.dt !== 0) return { ok: false, reason: "bad stroke log" };
    if (first.x > CIRCLE_SIZE || first.y > CIRCLE_SIZE) {
      return { ok: false, reason: "the stroke left the field" };
    }
    if (Math.abs(circleDelta(start.deg, circleAngle(first.x, first.y))) > CIRCLE_START_TOL) {
      return { ok: false, reason: "the stroke did not start on the marker" };
    }

    const n = points.length;
    const cum = new Array(n);
    cum[0] = 0;
    let timeMs = 0;
    let prev = circleAngle(first.x, first.y);
    let r = circleRadius(first.x, first.y);
    if (r < CIRCLE_MIN_R || r > CIRCLE_MAX_R) {
      return { ok: false, reason: "the stroke ran outside the ring" };
    }

    for (let i = 1; i < n; i++) {
      const p = points[i];
      if (p.dt > CIRCLE_MAX_GAP) return { ok: false, reason: "the stroke stalled" };
      if (p.x > CIRCLE_SIZE || p.y > CIRCLE_SIZE) {
        return { ok: false, reason: "the stroke left the field" };
      }
      timeMs += p.dt;
      r = circleRadius(p.x, p.y);
      if (r < CIRCLE_MIN_R || r > CIRCLE_MAX_R) {
        return { ok: false, reason: "the stroke ran outside the ring" };
      }
      const here = circleAngle(p.x, p.y);
      const step = circleDelta(prev, here) * start.dir;
      if (step > CIRCLE_MAX_STEP) return { ok: false, reason: "the stroke jumped" };
      if (step < -CIRCLE_BACK) return { ok: false, reason: "the stroke doubled back" };
      prev = here;
      /* a running maximum, so the small backwards wobble the check above allows
         cannot make the sweep non-monotone and break the resample below */
      cum[i] = Math.max(cum[i - 1], cum[i - 1] + step);
    }

    if (timeMs < CIRCLE_MIN_MS) return { ok: false, reason: "that stroke was too fast to be drawn" };
    if (timeMs > CIRCLE_MAX_MS) return { ok: false, reason: "that stroke took too long" };

    const total = cum[n - 1];
    if (total < 360) return { ok: false, reason: "the circle never closed" };
    if (total > 360 + CIRCLE_MAX_STEP) return { ok: false, reason: "the stroke ran past the close" };

    /* The samples are taken in the frame the sweep ran in rather than the
       field's, which costs nothing: a fitted circle does not care how the page
       was holding the paper. */
    const xs = new Array(CIRCLE_SAMPLES);
    const ys = new Array(CIRCLE_SAMPLES);
    let j = 1;
    for (let k = 0; k < CIRCLE_SAMPLES; k++) {
      const want = ((k + 0.5) * 360) / CIRCLE_SAMPLES;
      while (j < n - 1 && cum[j] < want) j++;
      const span = cum[j] - cum[j - 1];
      const t = span > 0 ? (want - cum[j - 1]) / span : 0;
      const lo = circleRadius(points[j - 1].x, points[j - 1].y);
      const hi = circleRadius(points[j].x, points[j].y);
      const rk = lo + (hi - lo) * t;
      const th = (want * Math.PI) / 180;
      xs[k] = rk * Math.cos(th);
      ys[k] = rk * Math.sin(th);
    }

    const fit = circleFit(xs, ys);
    if (!fit) return { ok: false, reason: "that stroke is not a circle" };
    if (fit.r < CIRCLE_MIN_R || fit.r > CIRCLE_MAX_R) {
      return { ok: false, reason: "the stroke ran outside the ring" };
    }

    let dev = 0;
    for (let k = 0; k < CIRCLE_SAMPLES; k++) {
      const dx = xs[k] - fit.x, dy = ys[k] - fit.y;
      dev += Math.abs(Math.sqrt(dx * dx + dy * dy) - fit.r);
    }
    dev /= CIRCLE_SAMPLES;

    const acc = Math.max(0, 1 - dev / fit.r);
    return {
      ok: true,
      acc,
      timeMs,
      radius: fit.r,
      dev,
      pct: Math.round(acc * 10000) / 100,
      score: -Math.round(acc * 1e6),
    };
  }

  /* ── end of the engine ── */

  const canvas = document.getElementById("pad");
  const ctx = canvas.getContext("2d");
  const overlay = document.getElementById("overlay");
  const ovTitle = document.getElementById("ov-title");
  const ovSub = document.getElementById("ov-sub");
  const ovStart = document.getElementById("ov-start");
  const elSweep = document.getElementById("h-sweep");
  const elRadius = document.getElementById("h-radius");
  const elTime = document.getElementById("h-time");
  const elBest = document.getElementById("h-best");
  const btnNew = document.getElementById("btn-new");
  const submitWrap = document.getElementById("submit-run");
  const runName = document.getElementById("run-name");
  const runStatus = document.getElementById("run-status");
  const btnSubmit = document.getElementById("btn-submit-run");

  canvas.width = CIRCLE_SIZE;
  canvas.height = CIRCLE_SIZE;

  let S = null;

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function fmt(ms) {
    return window.Arcade ? Arcade.fmtTime(ms) : (ms / 1000).toFixed(1) + "s";
  }

  function best() {
    if (!window.Arcade) return null;
    const runs = Arcade.getScores("circle").filter((s) => typeof s.pct === "number");
    if (!runs.length) return null;
    return runs.sort((x, y) => y.pct - x.pct)[0];
  }

  function syncHud() {
    const sweep = S && S.cum.length ? Math.min(360, S.cum[S.cum.length - 1]) : 0;
    elSweep.textContent = Math.round((sweep / 360) * 100) + "%";
    elRadius.textContent = S && S.lastR ? Math.round(S.lastR) : 0;
    if (S && S.result) elTime.textContent = fmt(S.result.timeMs);
    else if (S && S.drawing) elTime.textContent = fmt(S.timeMs);
    else elTime.textContent = fmt(0);
    const b = best();
    elBest.textContent = b ? b.pct.toFixed(2) + "%" : "none";
  }

  function paint() {
    const ink = css("--text-muted") || "#71717a";
    const accent = css("--accent") || "#e4e4e7";
    const good = css("--success") || "#4ade80";

    ctx.clearRect(0, 0, CIRCLE_SIZE, CIRCLE_SIZE);

    /* the marker is a spoke rather than a ring: it says where to start and
       which way to go without handing anyone a circle to trace */
    const rad = (S.start.deg * Math.PI) / 180;
    ctx.save();
    ctx.setLineDash([14, 12]);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(CIRCLE_CX + Math.cos(rad) * CIRCLE_MIN_R, CIRCLE_CY + Math.sin(rad) * CIRCLE_MIN_R);
    ctx.lineTo(CIRCLE_CX + Math.cos(rad) * CIRCLE_MAX_R, CIRCLE_CY + Math.sin(rad) * CIRCLE_MAX_R);
    ctx.stroke();
    ctx.restore();

    /* the arrow sits on the spoke at mid radius, turned a quarter turn the way
       the stroke has to run */
    const mid = (CIRCLE_MIN_R + CIRCLE_MAX_R) / 2;
    ctx.save();
    ctx.translate(CIRCLE_CX + Math.cos(rad) * mid, CIRCLE_CY + Math.sin(rad) * mid);
    ctx.rotate(rad + (S.start.dir > 0 ? Math.PI / 2 : -Math.PI / 2));
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(0, -22);
    ctx.lineTo(15, 12);
    ctx.lineTo(-15, 12);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(CIRCLE_CX, CIRCLE_CY, 7, 0, Math.PI * 2);
    ctx.fill();

    if (S.points.length > 1) {
      ctx.strokeStyle = S.dead ? (css("--danger") || "#fb6a69") : accent;
      ctx.lineWidth = 6;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(S.points[0].x, S.points[0].y);
      for (let i = 1; i < S.points.length; i++) ctx.lineTo(S.points[i].x, S.points[i].y);
      ctx.stroke();
    }

    /* the circle the score was measured against, drawn only once there is one:
       mean radius, shifted by the offset the fit forgave */
    if (S.result) {
      const fit = fitCircle();
      ctx.save();
      ctx.setLineDash([10, 10]);
      ctx.strokeStyle = good;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(fit.x, fit.y, fit.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* The engine fits in the frame the sweep ran in, so turning that circle back
     into one on the field means rotating it by the start angle and, going
     anticlockwise, flipping it. Only the drawing needs this; the score never
     does, which is why it lives out here rather than in the engine. */
  function fitCircle() {
    const n = S.points.length;
    const xs = [], ys = [];
    let j = 1;
    for (let k = 0; k < CIRCLE_SAMPLES; k++) {
      const want = ((k + 0.5) * 360) / CIRCLE_SAMPLES;
      while (j < n - 1 && S.cum[j] < want) j++;
      const span = S.cum[j] - S.cum[j - 1];
      const t = span > 0 ? (want - S.cum[j - 1]) / span : 0;
      const lo = circleRadius(S.points[j - 1].x, S.points[j - 1].y);
      const hi = circleRadius(S.points[j].x, S.points[j].y);
      const rk = lo + (hi - lo) * t;
      const th = (want * Math.PI) / 180;
      xs.push(rk * Math.cos(th));
      ys.push(rk * Math.sin(th));
    }
    const fit = circleFit(xs, ys);
    if (!fit) return { r: 0, x: CIRCLE_CX, y: CIRCLE_CY };
    const rot = (S.start.deg * Math.PI) / 180;
    const d = S.start.dir;
    return {
      r: fit.r,
      x: CIRCLE_CX + fit.x * Math.cos(rot) - d * fit.y * Math.sin(rot),
      y: CIRCLE_CY + fit.x * Math.sin(rot) + d * fit.y * Math.cos(rot),
    };
  }

  function showOverlay(title, sub, button) {
    ovTitle.textContent = title;
    ovSub.textContent = sub;
    ovStart.textContent = button;
    overlay.classList.add("show");
  }

  function newRun() {
    const seed = Math.floor(Math.random() * 0x100000000) >>> 0;
    S = {
      seed,
      start: circleStart(seed),
      points: [],
      cum: [],
      timeMs: 0,
      last: 0,
      lastAngle: 0,
      lastR: 0,
      drawing: false,
      dead: false,
      result: null,
    };
    submitWrap.style.display = "none";
    runStatus.textContent = "";
    showOverlay("Draw a Perfect Circle",
      "Start on the marker, follow the arrow, and come all the way back round " +
      "in one stroke. Nothing is measured until you close it.",
      "Ready");
    paint();
    syncHud();
  }

  function arm() {
    if (!S || S.result || S.dead) newRun();
    overlay.classList.remove("show");
    canvas.classList.add("armed");
    syncHud();
  }

  function abandon(why) {
    S.drawing = false;
    S.dead = true;
    canvas.classList.remove("armed");
    paint();
    showOverlay("Stroke void", why, "Try again");
    syncHud();
  }

  function fieldPoint(e) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = Math.round(((e.clientX - rect.left) / rect.width) * CIRCLE_SIZE);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * CIRCLE_SIZE);
    if (x < 0 || y < 0 || x > CIRCLE_SIZE || y > CIRCLE_SIZE) return null;
    return { x, y };
  }

  function onDown(e) {
    if (!S || S.result || S.dead) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (overlay.classList.contains("show")) return;
    const p = fieldPoint(e);
    if (!p) return;
    e.preventDefault();

    const r = circleRadius(p.x, p.y);
    if (r < CIRCLE_MIN_R || r > CIRCLE_MAX_R) {
      abandon("The stroke has to start inside the ring, between the centre dot and the edge.");
      return;
    }
    if (Math.abs(circleDelta(S.start.deg, circleAngle(p.x, p.y))) > CIRCLE_START_TOL) {
      abandon("The stroke has to start on the marker.");
      return;
    }

    S.drawing = true;
    S.points = [{ dt: 0, x: p.x, y: p.y }];
    S.cum = [0];
    S.timeMs = 0;
    S.last = performance.now();
    S.lastAngle = circleAngle(p.x, p.y);
    S.lastR = r;
    /* a pointer that is not actually down throws here rather than returning,
       and losing capture is a worse stroke, not a broken one */
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    paint();
    syncHud();
  }

  function onMove(e) {
    if (!S || !S.drawing) return;
    const p = fieldPoint(e);
    if (!p) return;
    e.preventDefault();

    const now = performance.now();
    const dt = Math.round(now - S.last);
    if (dt > CIRCLE_MAX_GAP) {
      abandon("The stroke stalled for longer than the tape allows.");
      return;
    }
    const here = circleAngle(p.x, p.y);
    const step = circleDelta(S.lastAngle, here) * S.start.dir;
    /* a point that moved nowhere carries no angle and no information, so it is
       dropped here rather than padding a tape the Worker has to walk */
    if (step === 0 && p.x === S.points[S.points.length - 1].x && p.y === S.points[S.points.length - 1].y) return;
    if (step > CIRCLE_MAX_STEP) {
      abandon("The pointer jumped too far around the centre in one step.");
      return;
    }
    if (step < -CIRCLE_BACK) {
      abandon("The stroke doubled back. One sweep, one direction.");
      return;
    }
    const r = circleRadius(p.x, p.y);
    if (r < CIRCLE_MIN_R || r > CIRCLE_MAX_R) {
      abandon("The stroke ran outside the ring.");
      return;
    }

    S.points.push({ dt, x: p.x, y: p.y });
    S.cum.push(Math.max(S.cum[S.cum.length - 1], S.cum[S.cum.length - 1] + step));
    S.timeMs += dt;
    S.last = now;
    S.lastAngle = here;
    S.lastR = r;

    if (S.points.length > CIRCLE_MAX_POINTS) {
      abandon("That stroke has more points than a tape can carry.");
      return;
    }
    if (S.timeMs > CIRCLE_MAX_MS) {
      abandon("That stroke took longer than the tape allows.");
      return;
    }

    paint();
    syncHud();
    if (S.cum[S.cum.length - 1] >= 360) finish();
  }

  function onUp() {
    if (!S || !S.drawing) return;
    abandon("The stroke lifted before the circle closed.");
  }

  /* The page scores itself with the same replay the Worker runs, so the number
     on the screen is the number on the board or the run does not go up at all. */
  function finish() {
    S.drawing = false;
    canvas.classList.remove("armed");
    const run = circleReplay(S.seed, S.points);
    if (!run.ok) {
      abandon("This stroke did not verify locally: " + run.reason + ".");
      return;
    }
    S.result = run;
    paint();
    showOverlay("Closed",
      run.pct.toFixed(2) + "% round · radius " + Math.round(run.radius) +
      " · " + fmt(run.timeMs) + ". The dashed circle is what you were measured against. " +
      "Name the run for the leaderboard.",
      "Draw another");
    if (window.Arcade) {
      Arcade.addScore("circle", {
        pct: run.pct,
        timeMs: run.timeMs,
        radius: Math.round(run.radius),
      });
      submitWrap.style.display = "flex";
      runName.value = (Arcade.getPlayer && Arcade.getPlayer()) || "";
    }
    syncHud();
  }

  async function submitRun() {
    if (!window.Arcade || !S || !S.result) return;
    const name = (runName.value || "").trim();
    if (name && Arcade.setPlayer) Arcade.setPlayer(name);
    runStatus.textContent = "submitting…";
    btnSubmit.disabled = true;
    try {
      const res = await Arcade.submit("circle", {
        seed: S.seed,
        moves: circleEncode(S.points),
      });
      runStatus.textContent = res && res.rank ? "ranked #" + res.rank : "submitted";
    } catch (err) {
      runStatus.textContent = (err && err.message) || "submission failed";
    } finally {
      btnSubmit.disabled = false;
    }
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  ovStart.addEventListener("click", arm);
  btnNew.addEventListener("click", () => { newRun(); arm(); });
  btnSubmit.addEventListener("click", submitRun);

  document.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (e.key === " " || e.key === "Enter") {
      if (S && S.drawing) return;
      e.preventDefault();
      if (S && (S.result || S.dead)) newRun();
      arm();
    }
  });

  function tick() {
    if (S && S.drawing) syncHud();
    requestAnimationFrame(tick);
  }

  newRun();
  requestAnimationFrame(tick);

  /* exposed for the staging checks */
  window.__circle = {
    state: () => S,
    replay: circleReplay,
    encode: circleEncode,
    decode: circleDecode,
    start: circleStart,
  };
})();
