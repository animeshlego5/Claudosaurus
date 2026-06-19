/*
 * Claude-Rex — injected webview payload
 * ------------------------------------------------------------------
 * Appended (wrapped in marker comments) to the Claude Code extension's
 * `webview/index.js` by install.js. Runs inside the chat-panel webview,
 * in the same nonce'd context as the bundle, so it needs no CSP changes.
 *
 * Behaviour:
 *   - The chat panel keeps a "spinner row" container mounted at all
 *     times; only the actual spinner *inside* it appears while Claude is
 *     working. So we key the game on the visible busy-spinner element,
 *     NOT the persistent row — the dino shows only while Claude works,
 *     and vanishes when it finishes.
 *   - Opt-in "always on" mode (window.__claudeRex.setAlwaysOn(true))
 *     keeps the game up even when idle, for people who want free play.
 *   - The dino is drawn in the spinner's own colour, sampled live, so it
 *     matches the theme exactly. Strictly monochrome.
 *
 * Also loadable standalone (see game.html) for zero-token development.
 * The T-Rex sprite is the authentic Chrome dino, decoded from the
 * Chromium offline sprite sheet into a 25x29 bitmap.
 *
 * Vanilla JS, ES2019, no dependencies.
 */
(function () {
  "use strict";

  if (typeof window === "undefined") return;
  // Idempotent (re)load: tear down any previous instance first.
  if (window.__claudeRex && typeof window.__claudeRex.__destroy === "function") {
    try { window.__claudeRex.__destroy(); } catch (e) {}
  }

  // ----------------------------------------------------------------
  // Configuration.
  // ----------------------------------------------------------------
  var ALWAYS_ON_KEY = "claudeRexAlwaysOn";
  function readAlwaysOn() {
    try { return localStorage.getItem(ALWAYS_ON_KEY) === "1"; } catch (e) { return false; }
  }

  var CONFIG = {
    // Persistent container that holds the spinner (always in the DOM).
    spinnerRowSelector: '[class*="spinnerRow"]',
    // Verified live: while Claude works, the row's inner div fills with a
    // container carrying data-permission-mode (+ the verb text). When idle
    // the inner div is empty. So "busy" == the row contains this content.
    busyContentSelector: '[data-permission-mode],[class*="container_"]',
    gameHeight: 100, // px — height of the inline game strip
    minWidth: 200,   // px — clamp so the game stays playable when narrow
    hiScoreKey: "claudeRexHiScore",
    alwaysOn: readAlwaysOn(), // opt-in free play (persisted)
    debug: false // set true to log busy-content candidates while tuning
  };

  // ----------------------------------------------------------------
  // Authentic Chrome T-Rex sprite. '#' = pixel. Body is shared; legs
  // swap to animate the run.
  // ----------------------------------------------------------------
  var DINO_BODY = [
    "...............##########",
    ".............##############",
    ".............###...########",
    ".............###.#.########",
    ".............###..#########",
    ".............##############",
    ".............##############",
    ".............##############",
    ".............##############",
    ".............###########",
    "#...........#######",
    "#.........#########",
    "##........#########",
    "###.....#############",
    "####...############.#",
    "###################",
    "###################",
    "###################",
    ".##################",
    "..###############",
    "...##############",
    "....############",
    ".....##########",
    "......#####.###",
    ".......####.###"
  ];
  var DINO_LEGS_RUN = [
    [".......##....##", ".......#.....##", ".......##....###", ".......##....###"],
    [".......##....##", ".......##.....#", ".......###...##", ".......###...##"]
  ];
  var DINO_LEGS_JUMP = [".......##....##", ".......##....##", ".......##....##", ".......##....##"];
  var DINO_W = 25;
  var DINO_H = DINO_BODY.length + 4; // 29 rows

  // ----------------------------------------------------------------
  // Colour helpers.
  // ----------------------------------------------------------------
  function themeForeground() {
    try {
      var cs = getComputedStyle(document.body || document.documentElement);
      var v = cs.getPropertyValue("--vscode-icon-foreground") ||
              cs.getPropertyValue("--vscode-editor-foreground");
      if (v && v.trim()) return v.trim();
      if (cs.color) return cs.color;
    } catch (e) {}
    return "#8a8a8a";
  }
  function isTransparent(c) {
    return !c || c === "transparent" || /rgba?\([^)]*,\s*0(\.0+)?\)\s*$/.test(c);
  }
  // The colour the spinner actually renders in — ring spinners colour via
  // border, text spinners via `color`. Pick the first opaque candidate.
  function colorOfSpinner(el) {
    if (!el) return null;
    try {
      var cs = getComputedStyle(el);
      var cands = [cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor,
                   cs.borderTopColor, cs.color, cs.backgroundColor];
      for (var i = 0; i < cands.length; i++) if (!isTransparent(cands[i])) return cands[i];
    } catch (e) {}
    return null;
  }

  // ----------------------------------------------------------------
  // The game. Self-contained; renders into a provided <canvas> in the
  // given colour. Supports live resize via resize(newWidth).
  // ----------------------------------------------------------------
  function DinoGame(canvas, color) {
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    var W = canvas.width;
    var H = canvas.height;
    var GROUND = H - 12;
    color = color || themeForeground();

    var STATE = { READY: 0, RUNNING: 1, OVER: 2 };

    var GRAVITY = 0.62;
    var JUMP_V = -7.6;
    var BASE_SPEED = 3.0;
    var MAX_SPEED = 12;

    var dino = { x: 22, w: DINO_W, h: DINO_H, y: GROUND - DINO_H, vy: 0, onGround: true };

    var obstacles = [];
    var spawnGap = 0;
    var distance = 0;
    var speed = BASE_SPEED;
    var score = 0;
    var hi = readHi();
    var frame = 0;
    var state = STATE.READY;
    var rafId = null;
    var ro = null;
    var alive = true;

    function readHi() {
      try { return parseInt(localStorage.getItem(CONFIG.hiScoreKey) || "0", 10) || 0; }
      catch (e) { return 0; }
    }
    function writeHi(v) { try { localStorage.setItem(CONFIG.hiScoreKey, String(v)); } catch (e) {} }

    function reset() {
      obstacles = [];
      spawnGap = 70;
      distance = 0;
      speed = BASE_SPEED;
      score = 0;
      frame = 0;
      dino.y = GROUND - dino.h;
      dino.vy = 0;
      dino.onGround = true;
    }

    function jump() {
      if (state === STATE.READY || state === STATE.OVER) { state = STATE.RUNNING; reset(); return; }
      if (dino.onGround) { dino.vy = JUMP_V; dino.onGround = false; }
    }

    function spawn() {
      var tall = Math.random() < 0.4;
      var h = tall ? 26 : 17;
      var w = Math.random() < 0.3 ? 14 : 8;
      obstacles.push({ x: W + 8, w: w, h: h });
    }

    function aabb(a, b) {
      return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    }

    function update() {
      frame++;
      speed = Math.min(MAX_SPEED, BASE_SPEED + distance / 700);
      distance += speed;
      score = Math.floor(distance / 7);

      dino.vy += GRAVITY;
      dino.y += dino.vy;
      if (dino.y >= GROUND - dino.h) { dino.y = GROUND - dino.h; dino.vy = 0; dino.onGround = true; }

      if (--spawnGap <= 0) {
        spawn();
        spawnGap = Math.max(34, Math.round(95 - speed * 3 + Math.random() * 45));
      }
      for (var i = obstacles.length - 1; i >= 0; i--) {
        obstacles[i].x -= speed;
        if (obstacles[i].x + obstacles[i].w < 0) obstacles.splice(i, 1);
      }

      var db = { x: dino.x + 4, y: dino.y + 7, w: 15, h: dino.h - 10 };
      for (var j = 0; j < obstacles.length; j++) {
        var o = obstacles[j];
        if (aabb(db, { x: o.x, y: GROUND - o.h, w: o.w, h: o.h })) {
          state = STATE.OVER;
          if (score > hi) { hi = score; writeHi(hi); }
          return;
        }
      }
    }

    // Round to whole pixels so 1px sprite cells never land on a half-pixel
    // (which the canvas would anti-alias, making the dino look faded mid-jump).
    function drawBitmap(rows, ox, oy) {
      ctx.fillStyle = color;
      ox = Math.round(ox);
      oy = Math.round(oy);
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        for (var c = 0; c < row.length; c++) {
          if (row.charCodeAt(c) === 35 /* '#' */) ctx.fillRect(ox + c, oy + r, 1, 1);
        }
      }
    }

    function drawDino() {
      var legs;
      if (!dino.onGround) legs = DINO_LEGS_JUMP;
      else if (state === STATE.RUNNING) legs = DINO_LEGS_RUN[(frame >> 3) & 1];
      else legs = DINO_LEGS_RUN[0];
      drawBitmap(DINO_BODY, dino.x, dino.y);
      drawBitmap(legs, dino.x, dino.y + DINO_BODY.length);
    }

    function drawObstacle(o) {
      ctx.fillStyle = color;
      var x = Math.round(o.x), y = GROUND - o.h;
      ctx.fillRect(x, y, o.w, o.h);
      ctx.fillRect(x - 3, y + 6, 3, 3);
      ctx.fillRect(x + o.w, y + 9, 3, 3);
    }

    function drawGround() {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(0, GROUND + 1);
      ctx.lineTo(W, GROUND + 1);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function pad(n) {
      var s = String(Math.floor(n));
      while (s.length < 5) s = "0" + s;
      return s;
    }

    function drawHud() {
      ctx.fillStyle = color;
      ctx.font = '11px ui-monospace, "Cascadia Code", Menlo, Consolas, monospace';
      ctx.textBaseline = "top";
      ctx.textAlign = "right";
      ctx.globalAlpha = 0.85;
      ctx.fillText("HI " + pad(hi) + "  " + pad(score), W - 6, 4);
      ctx.globalAlpha = 1;
      ctx.textAlign = "left";
    }

    function drawCenter(line1, line2) {
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.globalAlpha = 0.9;
      ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText(line1, W / 2, GROUND / 2 - 8);
      if (line2) {
        ctx.globalAlpha = 0.55;
        ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
        ctx.fillText(line2, W / 2, GROUND / 2 + 8);
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = "left";
    }

    function render() {
      ctx.clearRect(0, 0, W, H);
      drawGround();
      drawDino();
      for (var i = 0; i < obstacles.length; i++) drawObstacle(obstacles[i]);
      drawHud();
      if (state === STATE.READY) drawCenter("CLAUDE-REX", "press space / tap to run");
      else if (state === STATE.OVER) drawCenter("game over · " + pad(score), "space / tap to retry");
    }

    function loop() {
      if (!alive) return;
      if (!document.contains(canvas)) { teardown(); return; }
      if (state === STATE.RUNNING) update();
      render();
      rafId = requestAnimationFrame(loop);
    }

    function isTypingTarget(t) {
      if (!t) return false;
      var tag = (t.tagName || "").toLowerCase();
      return tag === "input" || tag === "textarea" || t.isContentEditable;
    }
    function onKey(e) {
      if (!alive) return;
      if (e.code === "Space" || e.key === " " || e.code === "ArrowUp" || e.key === "ArrowUp") {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        jump();
      }
    }
    function onPointer(e) { if (!alive) return; e.preventDefault(); jump(); }

    function teardown() {
      alive = false;
      if (rafId) cancelAnimationFrame(rafId);
      if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
      window.removeEventListener("keydown", onKey, true);
      canvas.removeEventListener("mousedown", onPointer);
      canvas.removeEventListener("touchstart", onPointer);
    }

    this.resize = function (newW) {
      newW = Math.max(CONFIG.minWidth, Math.floor(newW));
      if (newW > 0 && newW !== W) { canvas.width = newW; W = newW; ctx.imageSmoothingEnabled = false; }
    };

    this.start = function () {
      window.addEventListener("keydown", onKey, true);
      canvas.addEventListener("mousedown", onPointer);
      canvas.addEventListener("touchstart", onPointer, { passive: false });
      if (typeof ResizeObserver !== "undefined") {
        var self = this;
        ro = new ResizeObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            var w = entries[i].contentRect && entries[i].contentRect.width;
            if (w) self.resize(w);
          }
        });
        try { ro.observe(canvas); } catch (e) { ro = null; }
      }
      loop();
    };
    this.teardown = teardown;
  }

  // ----------------------------------------------------------------
  // Hijack glue — show the game only while a busy spinner is present.
  // ----------------------------------------------------------------
  function buildCanvas() {
    var canvas = document.createElement("canvas");
    canvas.width = 320; // placeholder; ResizeObserver fits it on insert
    canvas.height = CONFIG.gameHeight;
    canvas.style.width = "100%";
    canvas.style.height = CONFIG.gameHeight + "px";
    canvas.style.display = "block";
    canvas.style.imageRendering = "pixelated";
    canvas.style.cursor = "pointer";
    canvas.style.outline = "none";
    return canvas;
  }

  function rowBusy(row) {
    try { return !!row.querySelector(CONFIG.busyContentSelector); } catch (e) { return false; }
  }
  function findBusyRow() {
    var rows = document.querySelectorAll(CONFIG.spinnerRowSelector);
    for (var i = 0; i < rows.length; i++) if (rowBusy(rows[i])) return rows[i];
    return null;
  }
  function colorSourceIn(row) {
    return row.querySelector('[class*="icon_"],[class*="text_"]') ||
           row.querySelector(CONFIG.busyContentSelector);
  }

  var active = null; // { row, host, game, hidden: [[el, prevDisplay], ...] }

  function startGame(row) {
    if (active || !row) return;

    // Match the working indicator's own colour.
    var color = colorOfSpinner(colorSourceIn(row)) || themeForeground();

    // Hide the row's existing content (status / verb) so the game replaces
    // it inline. We hide (not remove) — the bundle still owns those nodes,
    // so when it empties them we know Claude has finished.
    var hidden = [];
    for (var i = 0; i < row.children.length; i++) {
      var ch = row.children[i];
      hidden.push([ch, ch.style.display]);
      ch.style.display = "none";
    }

    row.style.height = "auto";
    row.style.flexDirection = "column";
    row.style.alignItems = "stretch";

    var host = document.createElement("div");
    host.className = "claude-rex-host";
    host.style.width = "100%";
    host.style.margin = "2px 0";

    var canvas = buildCanvas();
    host.appendChild(canvas);
    row.appendChild(host);

    var game = new DinoGame(canvas, color);
    host.__game = game;
    game.start();
    requestAnimationFrame(function () { game.resize(host.clientWidth || canvas.clientWidth || 320); });

    active = { row: row, host: host, game: game, hidden: hidden };
  }

  function endGame() {
    if (!active) return;
    try { active.game.teardown(); } catch (e) {}
    if (active.host && active.host.parentNode) active.host.parentNode.removeChild(active.host);
    for (var i = 0; i < active.hidden.length; i++) {
      try { active.hidden[i][0].style.display = active.hidden[i][1] || ""; } catch (e) {}
    }
    if (active.row) {
      active.row.style.height = "";
      active.row.style.flexDirection = "";
      active.row.style.alignItems = "";
    }
    active = null;
  }

  function evaluate() {
    if (CONFIG.alwaysOn) {
      if (active) {
        if (active.row && !document.contains(active.row)) endGame();
        return;
      }
      var r = document.querySelector(CONFIG.spinnerRowSelector);
      if (r) startGame(r);
      return;
    }
    // Default: the game lives exactly as long as the row has busy content.
    if (active) {
      if (!active.row || !document.contains(active.row) || !rowBusy(active.row)) endGame();
      return;
    }
    var row = findBusyRow();
    if (row) startGame(row);
  }

  var observer = null;
  var pending = false;
  var poll = null;
  function scheduleEvaluate() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; try { evaluate(); } catch (e) {} });
  }

  // --- TEMP diagnostics: log spinner-ish elements as they appear, from
  // inside the webview, so we can identify the real "working" indicator.
  var seenDbg = {};
  function debugReport(el) {
    var c = typeof el.className === "string" ? el.className : (el.className && el.className.baseVal) || "";
    var anim = "?";
    try { anim = getComputedStyle(el).animationName; } catch (e) {}
    var hit = (anim && anim !== "none") ||
      /spin|load|think|progress|pending|working|dot|cursor|busy|stream|typing|ellipsis|loader/i.test(c);
    if (!hit) return;
    var key = c + "|" + anim;
    if (seenDbg[key]) return;
    seenDbg[key] = 1;
    console.log("[claude-rex] candidate:", el.tagName, JSON.stringify(c), "anim=" + anim);
  }
  function debugScan(node) {
    if (!CONFIG.debug || !node || node.nodeType !== 1) return;
    debugReport(node);
    if (node.querySelectorAll) { var a = node.querySelectorAll("*"); for (var i = 0; i < a.length; i++) debugReport(a[i]); }
  }

  function startObserver() {
    observer = new MutationObserver(function (muts) {
      if (CONFIG.debug) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) debugScan(added[j]);
        }
      }
      scheduleEvaluate();
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"]
    });
    // Safety net for transitions the observer might miss.
    poll = setInterval(scheduleEvaluate, 500);
    scheduleEvaluate();
  }

  function removeGames(includeTestRows) {
    if (active) endGame();
    var hosts = document.querySelectorAll(".claude-rex-host");
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i];
      if (h.__game) { try { h.__game.teardown(); } catch (e) {} }
      if (h.parentNode) h.parentNode.removeChild(h);
    }
    if (includeTestRows) {
      var rows = document.querySelectorAll(".spinnerRow_TEST");
      for (var k = 0; k < rows.length; k++) if (rows[k].parentNode) rows[k].parentNode.removeChild(rows[k]);
    }
  }

  function destroy() {
    if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
    if (poll) { clearInterval(poll); poll = null; }
    removeGames(true);
  }

  // ----------------------------------------------------------------
  // Public API + bootstrap.
  // ----------------------------------------------------------------
  window.__claudeRex = {
    version: "0.6.0",
    config: CONFIG,
    DinoGame: DinoGame,
    clear: function () { removeGames(true); },
    __destroy: destroy,
    // Free play: keep the game up even when Claude is idle.
    setAlwaysOn: function (on) {
      CONFIG.alwaysOn = !!on;
      try { localStorage.setItem(ALWAYS_ON_KEY, on ? "1" : "0"); } catch (e) {}
      if (!on) removeGames(false);
      scheduleEvaluate();
      return CONFIG.alwaysOn;
    },
    // Inject a fake, persistent busy spinner so you can play on demand.
    spawnTest: function () {
      removeGames(true);
      var row = document.createElement("div");
      row.className = "spinnerRow_TEST";
      row.style.cssText = "display:flex;align-items:center;min-height:1.85em;margin:8px 0;width:100%;";
      var dot = document.createElement("div");
      dot.className = "spinner_TEST";
      dot.textContent = "● working…";
      row.appendChild(dot);
      (document.body || document.documentElement).appendChild(row);
      scheduleEvaluate();
      return row;
    },
    // Print what we currently detect (handy if the dino doesn't appear).
    diagnose: function () {
      var rows = document.querySelectorAll(CONFIG.spinnerRowSelector);
      var busy = 0, sample = null;
      for (var i = 0; i < rows.length; i++) {
        if (rowBusy(rows[i])) { busy++; if (!sample) sample = colorSourceIn(rows[i]); }
      }
      console.log("[claude-rex] spinnerRow matches:", rows.length,
        "| busy rows:", busy, "| alwaysOn:", CONFIG.alwaysOn, "| active:", !!active,
        "| colour:", sample ? colorOfSpinner(sample) : "(none)");
      return { rows: rows.length, busy: busy };
    }
  };

  function boot() {
    try {
      console.log("[claude-rex] v" + window.__claudeRex.version + " running @ " + location.href);
      startObserver();
      if (/[?&]claudeRexForce=1/.test(location.search)) window.__claudeRex.spawnTest();
    } catch (e) {
      try { console.warn("[claude-rex] failed to start:", e); } catch (_) {}
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
