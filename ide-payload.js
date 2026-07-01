/*
 * Claudosaurus — injected webview payload
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
 *   - Pause, don't reset: when Claude stops being busy mid-turn (a permission
 *     prompt, a VS Code popup stealing focus, a brief gap between tool calls)
 *     the game freezes and keeps its score, then resumes the same run when
 *     work continues. It only tears down once Claude is genuinely done.
 *   - Obstacles are cacti plus, past a score threshold, pterodactyls. There is
 *     no ducking: low/mid birds must be jumped, high birds fly over a grounded
 *     dino — so the right move is sometimes to do nothing.
 *   - Opt-in "always on" mode (window.__claudosaurus.setAlwaysOn(true))
 *     keeps the game up even when idle, for people who want always-on play.
 *   - The dino is drawn in the spinner's own colour, sampled live, so it
 *     matches the theme exactly. Strictly monochrome.
 *
 * Also loadable standalone (see game.html) for zero-token development.
 * All art is hand-drawn '#'-pixel bitmaps (dino, cacti, pterodactyl, cloud)
 * rendered as 1px rects in the sampled spinner colour — strictly monochrome,
 * no image assets, so nothing to load and no CSP surface.
 *
 * Vanilla JS, ES2019, no dependencies.
 */
(function () {
  "use strict";

  if (typeof window === "undefined") return;
  // Idempotent (re)load: tear down any previous instance first.
  if (window.__claudosaurus && typeof window.__claudosaurus.__destroy === "function") {
    try { window.__claudosaurus.__destroy(); } catch (e) { }
  }

  // Single source of truth for the version: the patcher (lib/patch.js) replaces
  // the token below with package.json's version when injecting. Loaded raw by
  // game.html (token left intact), so fall back to "dev" when unreplaced.
  var VERSION = "__CLAUDOSAURUS_VERSION__";
  if (/^__/.test(VERSION)) VERSION = "dev";

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

    // Obstacles: pterodactyls join the cacti once you pass birdMinScore.
    // No ducking — high birds fly over a grounded dino (do nothing), low/mid
    // birds must be jumped. Tune the gameplay feel here.
    enableBirds: true,
    birdMinScore: 150,

    // Pause-don't-reset behaviour. When Claude stops being "busy" (a
    // permission prompt, a VS Code popup stealing focus, a brief gap between
    // tool calls) the game freezes instead of tearing down, and resumes the
    // same run when work continues.
    pauseWhenUnfocused: true, // freeze while the webview lacks focus (popups/modals)
    // Hold the frozen game open while a real permission prompt is up. The
    // extension renders approval UI in a dedicated container (class
    // `permissionsContainer_*`), mounted ONLY when a request is pending — so
    // keying on it is exact, with no false-positives on idle input controls.
    pauseSelector: '[class*="permissionsContainer"]',
    endGraceMs: 1200,         // keep the frozen game this long after "done" before it vanishes
    resumeWindowMs: 180000,   // a run that restarts within this window resumes its score

    // Legacy fallback heuristic: sniff for an approve/deny *button* near the
    // spinner row by label. OFF by default now that `pauseSelector` keys on the
    // real permissionsContainer — the fuzzy scan false-positives on the 2026
    // input UI (send/mode buttons read like "run"/"always"/"cancel"), which
    // stranded the frozen game for up to maxHoldMs after every turn.
    detectPermissionButtons: false, // heuristic: treat approve/deny buttons as "paused, not done"
    promptScopeSelector: "",       // optional: limit the button scan to this container ("" = auto)
    pauseTextPattern: "",          // optional regex (string) on nearby text — opt-in, can false-positive
    maxHoldMs: 300000,             // safety cap: stop holding a frozen game after this with no resume

    // Difficulty / feel. Speed now ramps the way the real Chrome dino does:
    // a small CONSTANT acceleration every frame (not the old runaway curve), so
    // it stays fair far longer. Values are scaled to this strip's size. Presets
    // (setSpeed/setJump below) just bundle these.
    //
    // startSpeed 0 = "normal" (4.0 px/frame internally). Values above 0 are the
    // literal px/frame AND grant a proportional score head-start so faster
    // starters aren't penalised versus someone playing at normal speed.
    startSpeed: 0,         // 0 = normal (4.0); higher = faster + score headstart
    maxSpeed: 11.0,        // px/frame cap (Chrome: 13)
    acceleration: 0.0016,  // px/frame added each frame (Chrome: 0.001)
    gravity: 0.52,         // downward pull per frame (Chrome: 0.6)
    jumpVelocity: -9.0,    // upward kick on jump (Chrome: -12 on its scale)

    // Looks. Theme is absolute now: "day" forces a light scene (light bg, dark
    // sprites), "night" forces a dark scene (dark bg, light sprites), and "auto"
    // (default) simply matches the editor — light editor → light scene, dark
    // editor → dark scene — by sampling the editor's own fg/bg.
    theme: "auto",         // "day" (light) | "night" (dark) | "auto" (match editor) | "cycle" (flip every cycleScore pts)
    scanlines: false,      // CRT scanline overlay
    clouds: true,          // parallax background clouds
    cycleScore: 500,       // points between day↔night flips when theme is "cycle"

    // Feedback. Sound is OFF by default (a webview beeping mid-task is rude);
    // it's a one-tap toggle in the settings panel for those who want it.
    sound: false,          // jump / milestone / game-over blips via WebAudio

    debug: false // set true to log busy-content candidates while tuning
  };

  // ----------------------------------------------------------------
  // Tunables schema — the single place that documents every user-facing knob:
  // its range, step, and a one-line description. The settings panel builds its
  // sliders straight from this, so adding a knob here surfaces it in the UI.
  // (Edit CONFIG above to change a *default*; edit this to change a slider's
  // bounds.) Keys map 1:1 to CONFIG.
  // ----------------------------------------------------------------
  var TUNABLES = [
    { key: "startSpeed", label: "Start speed", min: 0, max: 5, step: 0.1, desc: "0 = normal; positive = faster + score headstart" },
    { key: "maxSpeed", label: "Max speed", min: 4, max: 20, step: 0.5, desc: "speed cap as the run ramps up" },
    { key: "acceleration", label: "Ramp", min: 0, max: 0.01, step: 0.0002, desc: "speed added each frame" },
    { key: "gravity", label: "Gravity", min: 0.3, max: 1.2, step: 0.01, desc: "downward pull per frame" }
  ];

  // Map the user-facing startSpeed (0 = normal) to an actual px/frame value.
  // The slider is additive: effective = 4.0 + startSpeed.
  // 0 → 4.0 ("normal"), positive → faster.
  function effectiveStartSpeed() {
    return 4.0 + CONFIG.startSpeed;
  }
  // Score head-start for players choosing a faster start speed.
  // Only kicks in when startSpeed > 0 (i.e. faster than normal).
  function startScoreOffset() {
    return CONFIG.startSpeed > 0 ? Math.floor(CONFIG.startSpeed * 15) : 0;
  }

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
  // Pterodactyl. Two frames flap the wings. Beak points left, toward the
  // running dino. Same '#'=pixel bitmap format as the dino.
  // ----------------------------------------------------------------
  var BIRD_FRAMES = [
    [ // wings up
      ".........#..",
      "........##..",
      "#....#####..",
      "##########..",
      ".#######....",
      "....#.......",
      "....#......."
    ],
    [ // wings down
      "....#.......",
      "....#.......",
      "#.......##..",
      "##########..",
      ".#########..",
      "#....####...",
      ".........#.."
    ]
  ];
  var BIRD_W = 12;
  var BIRD_H = BIRD_FRAMES[0].length; // 7 rows
  // Top offset above the ground for each flight height. The first (highest)
  // clears a grounded dino entirely — jumping into it is the mistake; the
  // lower two must be jumped. Mix gives the "jump or just stand there" feel.
  var BIRD_HEIGHTS = [48, 26, 14];

  // ----------------------------------------------------------------
  // Cacti — the real Chrome dino has a chunky central trunk with two stubby
  // arms. Small (single), a 2-up cluster, and a taller large variant.
  // ----------------------------------------------------------------
  var CACTUS_SMALL = [
    "....##...",
    "....##...",
    "....##...",
    "....##...",
    ".##.##...",
    ".##.##...",
    ".##.##.##",
    ".##.##.##",
    ".#####.##",
    "....##.##",
    "....#####",
    "....##...",
    "....##...",
    "....##...",
    "....##...",
    "....##...",
    "....##...",
    "....##..."
  ];
  // A cluster: two small cacti shoulder to shoulder.
  var CACTUS_DOUBLE = CACTUS_SMALL.map(function (row) { return row + ".." + row; });
  var CACTUS_LARGE = [
    "....###....",
    "....###....",
    "....###....",
    "....###....",
    "....###....",
    "....###....",
    ".##.###....",
    ".##.###....",
    ".##.###....",
    ".##.###.##.",
    ".##.###.##.",
    ".######.##.",
    "....###.##.",
    "....######.",
    "....###....",
    "....###....",
    "....###....",
    "....###....",
    "....###....",
    "....###....",
    "....###....",
    "....###....",
    "....###....",
    "....###...."
  ];
  var CACTI = [CACTUS_SMALL, CACTUS_DOUBLE, CACTUS_LARGE];

  // Small fair-weather cloud for the parallax backdrop.
  var CLOUD = [
    "...######...",
    ".##########.",
    "############",
    ".##########.",
    "...######..."
  ];
  var CLOUD_W = CLOUD[0].length;

  // ----------------------------------------------------------------
  // Colour helpers.
  // ----------------------------------------------------------------
  function themeForeground() {
    try {
      var cs = getComputedStyle(document.body || document.documentElement);
      var v = cs.getPropertyValue("--app-claude-orange") ||
        cs.getPropertyValue("--vscode-icon-foreground") ||
        cs.getPropertyValue("--vscode-editor-foreground");
      if (v && v.trim()) return v.trim();
      if (cs.color) return cs.color;
    } catch (e) { }
    return "#ea580c";
  }
  // The editor background, used as the "ink" colour in inverted (night) mode.
  function themeBackground() {
    try {
      var cs = getComputedStyle(document.body || document.documentElement);
      var v = cs.getPropertyValue("--vscode-editor-background") ||
        cs.getPropertyValue("--vscode-sideBar-background");
      if (v && v.trim()) return v.trim();
      if (cs.backgroundColor && !isTransparent(cs.backgroundColor)) return cs.backgroundColor;
    } catch (e) { }
    return "#1e1e1e";
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
    } catch (e) { }
    return null;
  }

  // ----------------------------------------------------------------
  // Sound — a tiny WebAudio blip engine. Off unless CONFIG.sound is on. The
  // AudioContext is created lazily on the first sound (always triggered by a
  // jump, i.e. a user gesture, so autoplay policies are satisfied) and reused.
  // ----------------------------------------------------------------
  var audioCtx = null;
  function audio() {
    if (audioCtx) return audioCtx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    } catch (e) { audioCtx = null; }
    return audioCtx;
  }
  // type: "jump" | "score" | "over". Short square-wave blips, kept quiet.
  function sfx(type) {
    if (!CONFIG.sound) return;
    var ac = audio();
    if (!ac) return;
    try {
      if (ac.state === "suspended") ac.resume();
      var t = ac.currentTime;
      var osc = ac.createOscillator();
      var gain = ac.createGain();
      osc.type = "square";
      if (type === "jump") { osc.frequency.setValueAtTime(660, t); osc.frequency.exponentialRampToValueAtTime(990, t + 0.09); }
      else if (type === "score") { osc.frequency.setValueAtTime(880, t); osc.frequency.setValueAtTime(1320, t + 0.06); }
      else { osc.frequency.setValueAtTime(440, t); osc.frequency.exponentialRampToValueAtTime(110, t + 0.22); }
      var dur = type === "over" ? 0.26 : 0.1;
      gain.gain.setValueAtTime(0.05, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain); gain.connect(ac.destination);
      osc.start(t); osc.stop(t + dur);
    } catch (e) { }
  }

  // ----------------------------------------------------------------
  // Lifetime stats — games played, total distance (in "ground pixels"), and
  // jumps. Persisted separately from options so a Reset of difficulty/theme
  // never wipes a player's history.
  // ----------------------------------------------------------------
  var STATS_KEY = "claudeRexStats";
  function readStats() {
    try {
      var o = JSON.parse(localStorage.getItem(STATS_KEY) || "{}") || {};
      return { games: o.games | 0, distance: o.distance | 0, jumps: o.jumps | 0 };
    } catch (e) { return { games: 0, distance: 0, jumps: 0 }; }
  }
  function bumpStats(delta) {
    try {
      var s = readStats();
      if (delta.games) s.games += delta.games;
      if (delta.distance) s.distance += Math.round(delta.distance);
      if (delta.jumps) s.jumps += delta.jumps;
      localStorage.setItem(STATS_KEY, JSON.stringify(s));
      return s;
    } catch (e) { return null; }
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
    // fg = the spinner's sampled colour; bg = editor background. We sort them by
    // brightness so the theme can be absolute regardless of editor: `lightInk`
    // is always the brighter of the two, `darkInk` the dimmer. `color` is
    // whichever is currently inking the sprites (set live each frame in render).
    var fg = color || themeForeground();
    var bg = themeBackground();
    // Brightness (Rec. 601 luma) of a CSS colour, normalised via the canvas so
    // hex / rgb() / named colours all parse. 0 = black, 255 = white.
    function luma(c) {
      try {
        ctx.fillStyle = "#000";
        ctx.fillStyle = c;            // canvas normalises to #rrggbb or rgba(...)
        var s = ctx.fillStyle, m;
        if ((m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s)))
          return parseInt(m[1], 16) * 0.299 + parseInt(m[2], 16) * 0.587 + parseInt(m[3], 16) * 0.114;
        if ((m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s)))
          return (+m[1]) * 0.299 + (+m[2]) * 0.587 + (+m[3]) * 0.114;
      } catch (e) { }
      return 128;
    }
    var fgBright = luma(fg) >= luma(bg);
    var lightInk = fgBright ? fg : bg; // the brighter colour
    var darkInk = fgBright ? bg : fg;  // the dimmer colour
    color = fg;

    var STATE = { READY: 0, RUNNING: 1, OVER: 2 };
    var resumeCountdown = 0;
    var lastMilestone = 0;   // last score threshold we blipped at (multiple of 100)
    var runJumps = 0;       // jumps this run, flushed to lifetime stats on game over
    var settingsHotspot = null; // canvas-space bounds of the "⚙ settings" button (set in drawHud)

    var dino = { x: 22, w: DINO_W, h: DINO_H, y: GROUND - DINO_H, vy: 0, onGround: true };

    var obstacles = [];
    var clouds = [];
    var cloudGap = 0;
    var spawnGap = 0;
    var distance = 0;
    var speed = CONFIG.startSpeed;
    var score = 0;
    var hi = readHi();
    var frame = 0;
    var state = STATE.READY;
    var rafId = null;
    var ro = null;
    var alive = true;
    var paused = false;
    var helpMode = false;

    function readHi() {
      try { return parseInt(localStorage.getItem(CONFIG.hiScoreKey) || "0", 10) || 0; }
      catch (e) { return 0; }
    }
    function writeHi(v) { try { localStorage.setItem(CONFIG.hiScoreKey, String(v)); } catch (e) { } }

    function reset() {
      obstacles = [];
      clouds = [];
      cloudGap = 30;
      spawnGap = 70;
      var offset = startScoreOffset();
      distance = offset * 7; // pre-roll distance so the score readout starts at the offset
      speed = effectiveStartSpeed();
      score = offset;
      frame = 0;
      lastMilestone = offset - (offset % 100);
      runJumps = 0;
      dino.x = 24;
      dino.w = DINO_W;
      dino.h = DINO_H;
      dino.y = GROUND - dino.h;
      dino.vy = 0;
      dino.onGround = true;
    }

    function jump() {
      if (state === STATE.READY || state === STATE.OVER) { state = STATE.RUNNING; reset(); return; }
      if (dino.onGround) { dino.vy = CONFIG.jumpVelocity; dino.onGround = false; runJumps++; sfx("jump"); }
    }

    function spawn() {
      // Pterodactyl once we're past the threshold (~1 in 3 spawns).
      if (CONFIG.enableBirds && score >= CONFIG.birdMinScore && Math.random() < 0.32) {
        var top = BIRD_HEIGHTS[(Math.random() * BIRD_HEIGHTS.length) | 0];
        obstacles.push({ type: "bird", x: W + 8, y: GROUND - top, w: BIRD_W, h: BIRD_H });
        return;
      }
      // Cactus: small most often, then a cluster, then the tall one.
      var roll = Math.random();
      var sprite = roll < 0.5 ? CACTUS_SMALL : roll < 0.8 ? CACTUS_DOUBLE : CACTUS_LARGE;
      var w = sprite[0].length, h = sprite.length;
      obstacles.push({ type: "cactus", sprite: sprite, x: W + 8, y: GROUND - h, w: w, h: h });
    }

    function aabb(a, b) {
      return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    }

    function update() {
      frame++;
      // Constant per-frame acceleration, just like the real game — a steady,
      // fair ramp instead of the old distance-proportional (runaway) curve.
      speed = Math.min(CONFIG.maxSpeed, speed + CONFIG.acceleration);
      distance += speed;
      score = Math.floor(distance / 7);

      // Every 100 points: a blip, like the real game.
      if (score - lastMilestone >= 100) {
        lastMilestone = score - (score % 100);
        sfx("score");
      }

      dino.vy += CONFIG.gravity;
      dino.y += dino.vy;
      if (dino.y >= GROUND - dino.h) { dino.y = GROUND - dino.h; dino.vy = 0; dino.onGround = true; }

      if (--spawnGap <= 0) {
        spawn();
        spawnGap = Math.max(40, Math.round(100 - speed * 4 + Math.random() * 50));
      }
      for (var i = obstacles.length - 1; i >= 0; i--) {
        obstacles[i].x -= speed;
        if (obstacles[i].x + obstacles[i].w < 0) obstacles.splice(i, 1);
      }

      // Clouds drift by at half speed for a touch of parallax depth.
      if (CONFIG.clouds && --cloudGap <= 0) {
        clouds.push({ x: W + 10, y: 6 + Math.random() * (GROUND * 0.45) });
        cloudGap = 140 + (Math.random() * 220 | 0);
      }
      for (var c = clouds.length - 1; c >= 0; c--) {
        clouds[c].x -= speed * 0.5;
        if (clouds[c].x + CLOUD_W < 0) clouds.splice(c, 1);
      }

      var db = { x: dino.x + 4, y: dino.y + 7, w: 15, h: dino.h - 10 };
      for (var j = 0; j < obstacles.length; j++) {
        var o = obstacles[j];
        // Inset by 1px so grazing an edge pixel is forgiven on both types.
        if (aabb(db, { x: o.x + 1, y: o.y + 1, w: o.w - 2, h: o.h - 2 })) {
          state = STATE.OVER;
          if (score > hi) { hi = score; writeHi(hi); }
          bumpStats({ games: 1, distance: distance, jumps: runJumps });
          sfx("over");
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
      var x = Math.round(o.x), y = Math.round(o.y);
      if (o.type === "bird") {
        drawBitmap(BIRD_FRAMES[(frame >> 2) & 1], x, y); // flap wings
        return;
      }
      if (o.sprite) drawBitmap(o.sprite, x, y);
    }

    function drawClouds() {
      if (!CONFIG.clouds) return;
      ctx.globalAlpha = 0.22;
      for (var i = 0; i < clouds.length; i++) drawBitmap(CLOUD, clouds[i].x, clouds[i].y);
      ctx.globalAlpha = 1;
    }

    // Deterministic per-world-pixel hash so the ground texture scrolls
    // smoothly without flicker (the same x always renders the same bump).
    function gnoise(n) {
      n = (n ^ 61) ^ (n >>> 16);
      n = (n + (n << 3)) >>> 0;
      n = n ^ (n >>> 4);
      n = (n * 0x27d4eb2d) >>> 0;
      return (n ^ (n >>> 15)) >>> 0;
    }

    function drawGround() {
      ctx.fillStyle = color;
      // Main ground line.
      ctx.globalAlpha = 0.75;
      ctx.fillRect(0, GROUND + 1, W, 1);
      // Scrolling speckle + occasional bumps, varied like the real terrain.
      ctx.globalAlpha = 0.5;
      var base = Math.floor(distance);
      for (var x = 0; x < W; x++) {
        var n = gnoise(base + x);
        if ((n & 15) === 0) ctx.fillRect(x, GROUND + 3, 1, 1);       // lower speckle
        else if ((n & 31) === 5) ctx.fillRect(x, GROUND + 4, 1, 1);  // sparser deeper fleck
        if ((n & 511) === 7) ctx.fillRect(x, GROUND - 1, 2, 1);       // small raised bump
        else if ((n & 1023) === 3) ctx.fillRect(x, GROUND - 2, 3, 1); // rarer wider bump
      }
      ctx.globalAlpha = 1;
    }

    function pad(n) {
      var s = String(Math.floor(n));
      while (s.length < 4) s = "0" + s;
      return s;
    }

    function drawHud() {
      ctx.fillStyle = color;
      ctx.font = '11px ui-monospace, "Cascadia Code", Menlo, Consolas, monospace';
      ctx.textBaseline = "top";
      ctx.textAlign = "right";
      ctx.globalAlpha = 0.85;
      ctx.fillText("HI " + pad(hi) + "  " + pad(score), W - 6, 4);
      // Settings button, tucked in the corner. The "?" key can't be relied on
      // (the chat input holds keyboard focus, so it just types "?"), so this
      // label is a click/tap target — its bounds are recorded for onPointer.
      ctx.textAlign = "left";
      ctx.globalAlpha = helpMode ? 0.8 : 0.45;
      var label = "⚙ settings";
      ctx.fillText(label, 6, 4);
      settingsHotspot = { x: 0, y: 0, w: 6 + ctx.measureText(label).width + 8, h: 20 };
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

    // Resolve the current scene to { ink, fill }. `ink` is the sprite colour;
    // `fill` is the canvas background (null = transparent, i.e. show the editor
    // through so it matches natively). day = light scene, night = dark scene,
    // auto = whatever the editor already is (fg over its own bg).
    var DAY = { ink: darkInk, fill: lightInk };   // dark sprites on a light field
    var NIGHT = { ink: lightInk, fill: darkInk };  // light sprites on a dark field
    function sceneColors() {
      // Chrome-style flip: when theme is "cycle", alternate day/night every
      // `cycleScore` points. Otherwise the theme is absolute.
      if (CONFIG.theme === "cycle" && state === STATE.RUNNING) {
        var phase = Math.floor(score / Math.max(1, CONFIG.cycleScore)) % 2;
        return phase ? NIGHT : DAY;
      }
      if (CONFIG.theme === "day") return DAY;
      if (CONFIG.theme === "night") return NIGHT;
      return { ink: fg, fill: null }; // auto: match the editor
    }

    // Format a tunable's value for its slider readout.
    function fmtVal(key, v) {
      v = +v;
      if (key === "acceleration") return v.toFixed(4);
      if (key === "gravity") return v.toFixed(2);
      return v.toFixed(1);
    }
    // Friendly lifetime-distance readout (distance is in ground pixels).
    function fmtDist(px) {
      if (px >= 100000) return (px / 1000).toFixed(0) + "k";
      if (px >= 1000) return (px / 1000).toFixed(1) + "k";
      return String(px | 0);
    }
    // Which preset (if any) the current numbers correspond to — else "custom".
    function presetName(presets) {
      for (var k in presets) {
        var p = presets[k], match = true;
        for (var pk in p) if (CONFIG[pk] !== p[pk]) { match = false; break; }
        if (match) return k;
      }
      return "custom";
    }

    var modal = null;
    var advancedOpen = false; // disclosure state for the Advanced section (persists across rebuilds)
    function buildSettingsModal() {
      var speedName = presetName(SPEED_PRESETS);
      var jumpName = presetName(JUMP_PRESETS);

      var div = document.createElement("div");
      div.style.cssText = "position:absolute; inset:0; background:rgba(10,10,10,0.94); color:#e0e0e0; z-index:10; display:flex; flex-direction:column; gap:3px; padding: 8px 12px 8px; font-family: ui-monospace, monospace; font-size: 11px; box-sizing: border-box; overflow-y: auto; backdrop-filter: blur(4px);";

      var hostW = canvas.parentNode ? canvas.parentNode.clientWidth : W;
      var wide = hostW >= 340;

      var rowStyle = "display:flex; align-items:center; justify-content:space-between; gap:8px;";
      var labelStyle = "opacity:0.75; white-space:nowrap;";
      var subheadStyle = "opacity:0.4; font-size:9px; letter-spacing:1px; text-transform:uppercase; margin:3px 0 1px;";

      // --- Dot-slider toggle (Claude effort-style) ---
      // Label shows current value in parentheses, e.g. "Theme (Auto)".
      // A horizontal track with small dots and a larger sliding circle thumb.
      function dotSliderHtml(id, label, opts, current) {
        var activeIdx = 0, activeTxt = opts[0][1];
        for (var i = 0; i < opts.length; i++) {
          if (opts[i][0] === current) { activeIdx = i; activeTxt = opts[i][1]; break; }
        }
        var trackW = Math.max(60, opts.length * 18);
        var r = 5; // thumb radius (half of 10px thumb)
        var dotSpacing = (trackW - 2 * r) / (opts.length - 1);

        // Build the dots
        var dotsHtml = '';
        for (var d = 0; d < opts.length; d++) {
          var cx = r + d * dotSpacing;
          var isActive = d === activeIdx;
          var dotColor = '#555';
          if (d < activeIdx) {
            dotColor = 'rgba(255, 255, 255, 0.7)';
          } else if (d === opts.length - 1) {
            dotColor = '#a78bfa'; // Purple for the last option dot
          }
          dotsHtml += '<span data-seg-idx="' + d + '" data-seg-val="' + opts[d][0] + '" data-seg-txt="' + opts[d][1] + '" ' +
            'style="position:absolute; left:' + cx + 'px; top:50%; transform:translate(-50%,-50%); ' +
            'width:' + (isActive ? '0' : '4') + 'px; height:' + (isActive ? '0' : '4') + 'px; ' +
            'border-radius:50%; background:' + dotColor + '; cursor:pointer; transition:all .2s; z-index:3;"></span>';
        }

        var thumbLeft = r + activeIdx * dotSpacing;
        // Sliding thumb
        var thumbHtml = '<span id="' + id + '-thumb" style="position:absolute; left:' + thumbLeft + 'px; top:50%; ' +
          'transform:translate(-50%,-50%); width:10px; height:10px; border-radius:50%; ' +
          'background:#ccc; box-shadow:0 0 3px rgba(0,0,0,0.5); transition:left .2s; z-index:4; cursor:pointer;"></span>';

        // Background track with blue active overlay
        var activeBarHtml = '<span id="' + id + '-active" style="position:absolute; left:0; top:0; bottom:0; width:' + thumbLeft + 'px; ' +
          'background:#2563eb; transition:width .2s;"></span>';
        var trackHtml = '<div style="position:absolute; inset:0; background:#2a2a2a; border-radius:6px; overflow:hidden;">' + activeBarHtml + '</div>';

        return '<div style="' + rowStyle + '">' +
          '<span id="' + id + '-label" style="' + labelStyle + '">' + label + ' <span style="opacity:0.55;">(' + activeTxt + ')</span></span>' +
          '<div id="' + id + '" data-dot-spacing="' + dotSpacing + '" ' +
          'style="position:relative; width:' + trackW + 'px; height:12px; flex-shrink:0; cursor:pointer;">' +
          trackHtml + dotsHtml + thumbHtml + '</div></div>';
      }

      // Simple on/off toggle (same as before)
      function toggleHtml(id, label, on) {
        var bg = on ? '#2563eb' : '#333';
        var dot = on ? 'translateX(12px)' : 'translateX(0)';
        return '<div style="' + rowStyle + '"><span style="' + labelStyle + '">' + label + '</span>' +
          '<label id="' + id + '" style="display:inline-block; width:24px; height:12px; background:' + bg + '; border-radius:6px; position:relative; cursor:pointer; transition:background .2s; flex-shrink:0;">' +
          '<span style="position:absolute; top:1px; left:1px; width:10px; height:10px; background:#e0e0e0; border-radius:50%; transition:transform .2s; transform:' + dot + ';"></span>' +
          '</label></div>';
      }
      function sliderHtml(t) {
        var v = CONFIG[t.key];
        return '<div style="display:flex; flex-direction:column; gap:1px;" title="' + t.desc + '">' +
          '<div style="display:flex; justify-content:space-between; align-items:baseline;">' +
          '<span style="opacity:0.75;">' + t.label + '</span>' +
          '</div>' +
          '<input id="cr-' + t.key + '" class="cr-range" type="range" min="' + t.min + '" max="' + t.max + '" step="' + t.step + '" value="' + v + '">' +
          '</div>';
      }

      var themeRow = dotSliderHtml("cr-theme", "Theme", [["auto", "Auto"], ["day", "Day"], ["night", "Night"], ["cycle", "Cycle"]], CONFIG.theme);
      var speedRow = dotSliderHtml("cr-speed", "Speed", [["slow", "Slow"], ["normal", "Normal"], ["fast", "Fast"], ["custom", "Custom"]], speedName);
      var jumpRow = dotSliderHtml("cr-jump", "Jump", [["floaty", "Floaty"], ["normal", "Normal"], ["snappy", "Snappy"], ["custom", "Custom"]], jumpName);

      // Main panel: theme, speed/jump segmented presets, sound + always-on toggles.
      var mainToggles = toggleHtml("cr-sound", "Sound", CONFIG.sound) +
        toggleHtml("cr-alwayson", "Always-on", CONFIG.alwaysOn);

      // Advanced panel = power-user controls: scanlines toggle + fine-tune sliders.
      var advToggles = toggleHtml("cr-scanlines", "Scanlines", CONFIG.scanlines);

      var colWrap = "display:grid; grid-template-columns:" + (wide ? "1fr 1fr" : "1fr") + "; column-gap:22px; row-gap:3px;";

      var slidersHtml = "";
      for (var s = 0; s < TUNABLES.length; s++) slidersHtml += sliderHtml(TUNABLES[s]);
      var slidersWrap = '<div style="display:grid; grid-template-columns:' + (wide ? "1fr 1fr" : "1fr") + '; column-gap:18px; row-gap:5px;">' + slidersHtml + '</div>';

      // Collapsible Advanced disclosure. The caret + body visibility track
      // `advancedOpen` so the chosen state survives a modal rebuild (resize).
      var advHeader = '<div id="cr-adv-toggle" style="' + subheadStyle + ' cursor:pointer; display:flex; align-items:center; gap:5px; user-select:none;">' +
        '<span id="cr-adv-caret">' + (advancedOpen ? "▾" : "▸") + '</span><span>Advanced</span></div>';
      var advBody = '<div id="cr-adv-body" style="display:' + (advancedOpen ? "block" : "none") + ';">' +
        '<div style="' + colWrap + '">' + advToggles + '</div>' +
        slidersWrap +
        '</div>';
      var advancedHtml = advHeader + advBody;

      var st = readStats();
      var statsLine = '<div style="opacity:0.45; text-align:center; font-size:9.5px; padding-top:1px;">' +
        'games ' + st.games + ' · jumps ' + st.jumps + ' · dist ' + fmtDist(st.distance) + '</div>';

      var btnBase = "flex:1; color:#e0e0e0; border:1px solid #555; padding:3px 0; cursor:pointer; border-radius:4px; font-weight:600; font-size:11px; font-family:inherit; transition:background .15s, border-color .15s; background:#2a2a2a;";

      // Range inputs styled only via `accent-color` vanish in webviews that ship
      // an `input{appearance:none}` reset (no track, no thumb). So we draw the
      // track + thumb ourselves, scoped to our modal and flagged !important, so
      // the sliders render the same everywhere — editor webview or browser.
      var rangeCss =
        '<style>' +
        '.claudosaurus-host input.cr-range{-webkit-appearance:none!important;appearance:none!important;' +
        'width:100%!important;height:3px!important;margin:4px 0!important;padding:0!important;' +
        'background:#3a3f47!important;border:none!important;border-radius:1.5px!important;outline:none!important;cursor:pointer!important;}' +
        '.claudosaurus-host input.cr-range::-webkit-slider-runnable-track{height:3px;background:#3a3f47;border-radius:1.5px;}' +
        '.claudosaurus-host input.cr-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;' +
        'width:9px;height:9px;margin-top:-3px;border:none;border-radius:50%;background:#9ab;cursor:pointer;}' +
        '.claudosaurus-host input.cr-range::-moz-range-track{height:3px;background:#3a3f47;border-radius:1.5px;}' +
        '.claudosaurus-host input.cr-range::-moz-range-thumb{width:9px;height:9px;border:none;border-radius:50%;background:#9ab;cursor:pointer;}' +
        '</style>';

      div.innerHTML =
        rangeCss +
        '<div style="display:flex; justify-content:center; align-items:center; padding-bottom:1px; position:relative;">' +
        '<span style="font-size:11px; font-weight:700; letter-spacing:0.5px; line-height:1;">CLAUDOSAURUS</span>' +
        '<span style="opacity:0.3; font-size:9px; position:absolute; left:0; top:4px;">v' + VERSION + '</span>' +
        '<span style="cursor:pointer; color:#ff5f56; opacity:0.5; padding:0 2px; font-size:11px; line-height:1; transition:opacity .15s; position:absolute; right:0; top:4px;" id="cr-close">✖</span>' +
        '</div>' +
        '<div style="' + colWrap + '; padding-top:4px;">' + themeRow + speedRow + jumpRow + mainToggles + '</div>' +
        advancedHtml +
        statsLine +
        '<div style="display:flex; gap:8px; padding-top:3px;">' +
        '<button id="cr-reset" style="' + btnBase + '">Reset</button>' +
        '<button id="cr-github" style="' + btnBase + '">GitHub</button>' +
        '</div>';

      // --- Wiring -----------------------------------------------------
      div.querySelector('#cr-close').onclick = function () { setHelp(false); };
      div.querySelector('#cr-close').onmouseenter = function () { this.style.opacity = '1'; };
      div.querySelector('#cr-close').onmouseleave = function () { this.style.opacity = '0.5'; };

      // Keep the fine-tune sliders showing live CONFIG values (e.g. after a
      // preset pick changes several at once).
      function syncSliders() {
        for (var i = 0; i < TUNABLES.length; i++) {
          var t = TUNABLES[i];
          var inp = div.querySelector('#cr-' + t.key);
          var lab = div.querySelector('#crv-' + t.key);
          if (inp) inp.value = CONFIG[t.key];
          if (lab) lab.textContent = fmtVal(t.key, CONFIG[t.key]);
        }
      }

      // Wire dot-slider toggles: clicking a dot moves the thumb and fires onChange.
      function wireDotSlider(id, labelText, onChange) {
        var container = div.querySelector('#' + id);
        if (!container) return;
        var dots = container.querySelectorAll('[data-seg-val]');
        var thumb = div.querySelector('#' + id + '-thumb');
        var activeBar = div.querySelector('#' + id + '-active');
        var labelEl = div.querySelector('#' + id + '-label');
        var trackW = Math.max(60, dots.length * 18);
        var r = 5;
        var dotSpacing = (trackW - 2 * r) / (dots.length - 1);
        function selectDot(seg) {
          var idx = parseInt(seg.getAttribute('data-seg-idx'), 10);
          var val = seg.getAttribute('data-seg-val');
          var txt = seg.getAttribute('data-seg-txt');
          var cx = r + idx * dotSpacing;
          // Move thumb
          if (thumb) thumb.style.left = cx + 'px';
          // Move active bar
          if (activeBar) activeBar.style.width = cx + 'px';
          // Shrink active dot, restore others
          for (var j = 0; j < dots.length; j++) {
            var dotIdx = parseInt(dots[j].getAttribute('data-seg-idx'), 10);
            var isHit = dotIdx === idx;
            dots[j].style.width = isHit ? '0' : '4px';
            dots[j].style.height = isHit ? '0' : '4px';
            if (dotIdx < idx) {
              dots[j].style.background = 'rgba(255, 255, 255, 0.7)';
            } else if (dotIdx === dots.length - 1) {
              dots[j].style.background = '#a78bfa';
            } else {
              dots[j].style.background = '#555';
            }
          }
          // Update label text
          if (labelEl) labelEl.innerHTML = labelText + ' <span style="opacity:0.55;">(' + txt + ')</span>';
          onChange(val);
        }
        for (var si = 0; si < dots.length; si++) {
          (function (seg) { seg.onclick = function () { selectDot(seg); }; })(dots[si]);
        }
        // Wire track clicking to select closest dot
        container.onclick = function (e) {
          if (e.target.hasAttribute('data-seg-val')) return;
          if (e.target === thumb) return;
          var rect = container.getBoundingClientRect();
          var clickX = e.clientX - rect.left;
          var closestDot = null;
          var minDist = Infinity;
          for (var j = 0; j < dots.length; j++) {
            var dotX = r + j * dotSpacing;
            var dist = Math.abs(clickX - dotX);
            if (dist < minDist) {
              minDist = dist;
              closestDot = dots[j];
            }
          }
          if (closestDot) selectDot(closestDot);
        };
      }
      // Programmatically move the dot-slider to a given value (e.g. "custom").
      function syncDotSlider(id, labelText, val) {
        var container = div.querySelector('#' + id);
        if (!container) return;
        var dots = container.querySelectorAll('[data-seg-val]');
        var thumb = div.querySelector('#' + id + '-thumb');
        var activeBar = div.querySelector('#' + id + '-active');
        var labelEl = div.querySelector('#' + id + '-label');
        var trackW = Math.max(60, dots.length * 18);
        var r = 5;
        var dotSpacing = (trackW - 2 * r) / (dots.length - 1);
        for (var j = 0; j < dots.length; j++) {
          if (dots[j].getAttribute('data-seg-val') === val) {
            var idx = parseInt(dots[j].getAttribute('data-seg-idx'), 10);
            var cx = r + idx * dotSpacing;
            if (thumb) thumb.style.left = cx + 'px';
            if (activeBar) activeBar.style.width = cx + 'px';
            for (var k = 0; k < dots.length; k++) {
              var dotIdx = parseInt(dots[k].getAttribute('data-seg-idx'), 10);
              var isHit = dotIdx === idx;
              dots[k].style.width = isHit ? '0' : '4px';
              dots[k].style.height = isHit ? '0' : '4px';
              if (dotIdx < idx) {
                dots[k].style.background = 'rgba(255, 255, 255, 0.7)';
              } else if (dotIdx === dots.length - 1) {
                dots[k].style.background = '#a78bfa';
              } else {
                dots[k].style.background = '#555';
              }
            }
            var txt = dots[j].getAttribute('data-seg-txt');
            if (labelEl) labelEl.innerHTML = labelText + ' <span style="opacity:0.55;">(' + txt + ')</span>';
            break;
          }
        }
      }

      wireDotSlider('cr-theme', 'Theme', function (val) { window.__claudosaurus.setTheme(val); });
      wireDotSlider('cr-speed', 'Speed', function (val) {
        if (val !== 'custom') { window.__claudosaurus.setSpeed(val); syncSliders(); }
      });
      wireDotSlider('cr-jump', 'Jump', function (val) {
        if (val !== 'custom') { window.__claudosaurus.setJump(val); syncSliders(); }
      });

      // Toggles: each flips its CONFIG flag via the public API and updates its
      // own switch visuals in place (no rebuild).
      function wireToggle(id, getOn, apply) {
        var el = div.querySelector('#' + id);
        if (!el) return;
        el.onclick = function () {
          var on = !getOn();
          apply(on);
          el.style.background = on ? '#2563eb' : '#333';
          el.querySelector('span').style.transform = on ? 'translateX(12px)' : 'translateX(0)';
        };
      }
      wireToggle('cr-scanlines', function () { return CONFIG.scanlines; }, function (on) { window.__claudosaurus.setScanlines(on); });
      wireToggle('cr-sound', function () { return CONFIG.sound; }, function (on) { window.__claudosaurus.setSound(on); });
      wireToggle('cr-alwayson', function () { return CONFIG.alwaysOn; }, function (on) { window.__claudosaurus.setAlwaysOn(on); });

      // Advanced disclosure: flip visibility + caret in place (no rebuild — the
      // hidden controls are already wired).
      var advToggleEl = div.querySelector('#cr-adv-toggle');
      var advBodyEl = div.querySelector('#cr-adv-body');
      var advCaretEl = div.querySelector('#cr-adv-caret');
      if (advToggleEl) advToggleEl.onclick = function () {
        advancedOpen = !advancedOpen;
        if (advBodyEl) advBodyEl.style.display = advancedOpen ? 'block' : 'none';
        if (advCaretEl) advCaretEl.textContent = advancedOpen ? '▾' : '▸';
        var host = canvas.parentNode;
        if (host) {
          host.style.height = div.scrollHeight + 'px';
          host.style.scrollMarginBottom = '90px';
          setTimeout(function () {
            try { host.scrollIntoView({ behavior: 'smooth', block: 'end' }); } catch (e) { }
          }, 60);
        }
      };

      // Sliders: live-apply on input; leaving a preset flips its select to Custom.
      for (var si = 0; si < TUNABLES.length; si++) {
        (function (t) {
          var inp = div.querySelector('#cr-' + t.key);
          var lab = div.querySelector('#crv-' + t.key);
          if (!inp) return;
          inp.oninput = function () {
            var num = parseFloat(inp.value);
            var o = {}; o[t.key] = num;
            window.__claudosaurus.setOptions(o);
            if (lab) lab.textContent = fmtVal(t.key, num);
            if (t.key === "startSpeed" || t.key === "maxSpeed" || t.key === "acceleration") {
              syncDotSlider('cr-speed', 'Speed', 'custom');
            } else if (t.key === "gravity") {
              syncDotSlider('cr-jump', 'Jump', 'custom');
            }
          };
          // Don't let a drag on the slider bubble out to the canvas (= a jump).
          inp.onmousedown = function (e) { e.stopPropagation(); };
          inp.ontouchstart = function (e) { e.stopPropagation(); };
        })(TUNABLES[si]);
      }

      var btns = div.querySelectorAll('button');
      for (var b = 0; b < btns.length; b++) {
        btns[b].onmouseenter = function () { this.style.background = '#3a3a3a'; this.style.borderColor = '#777'; };
        btns[b].onmouseleave = function () { this.style.background = '#2a2a2a'; this.style.borderColor = '#555'; };
      }

      div.querySelector('#cr-reset').onclick = function () {
        window.__claudosaurus.resetOptions();
        setHelp(false);
        setTimeout(function () { setHelp(true); }, 50);
      };
      div.querySelector('#cr-github').onclick = function () { window.open("https://github.com/animeshlego5/Claudosaurus", "_blank"); };

      div.onmousedown = function (e) { e.stopPropagation(); };
      div.ontouchstart = function (e) { e.stopPropagation(); };
      div.oncontextmenu = function (e) { e.stopPropagation(); };

      return div;
    }

    // Toggle the settings overlay. The host grows to SETTINGS_H while open so
    // the (now taller) panel has room; the canvas itself keeps its strip height.
    function setHelp(on) {
      if (on === helpMode) return;
      helpMode = on;

      var host = canvas.parentNode;
      if (host) {
        // Always rebuild — never cache a stale layout (width may have changed).
        if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
        modal = null;
        if (on) {
          modal = buildSettingsModal();
          host.appendChild(modal);
          host.style.height = modal.scrollHeight + 'px';
          host.style.scrollMarginBottom = '90px';
          // Auto-scroll so it's fully visible above the sticky input area
          setTimeout(function () {
            try { host.scrollIntoView({ behavior: 'smooth', block: 'end' }); } catch (e) { }
          }, 60);
        } else {
          host.style.height = "";
          host.style.scrollMarginBottom = "";
        }
      }
      render();
    }

    // Rebuild the modal on live resize so the two-column breakpoint responds.
    function rebuildModalIfOpen() {
      if (!helpMode || !modal) return;
      var host = canvas.parentNode;
      if (!host) return;
      if (modal.parentNode) modal.parentNode.removeChild(modal);
      modal = buildSettingsModal();
      host.appendChild(modal);
    }

    function drawScanlines() {
      if (!CONFIG.scanlines) return;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.10;
      for (var y = 0; y < H; y += 2) ctx.fillRect(0, y, W, 1);
      ctx.globalAlpha = 1;
    }

    function render() {
      var sc = sceneColors();
      color = sc.ink; // every draw fn inks in `color`
      ctx.clearRect(0, 0, W, H);
      if (sc.fill) { ctx.fillStyle = sc.fill; ctx.fillRect(0, 0, W, H); }
      drawClouds();
      drawGround();
      drawDino();
      for (var i = 0; i < obstacles.length; i++) drawObstacle(obstacles[i]);
      drawHud();
      if (paused && state === STATE.RUNNING) drawCenter("paused", "resumes when Claude continues");
      else if (resumeCountdown > 0 && state === STATE.RUNNING) {
        var num = Math.ceil(resumeCountdown / 30);
        drawCenter("resuming in " + num + "...", "");
      }
      else if (state === STATE.READY) drawCenter("CLAUDOSAURUS", "press space / tap to run");
      else if (state === STATE.OVER) drawCenter("game over · " + pad(score), "space / tap to retry");
      drawScanlines();
    }

    function loop() {
      if (!alive) return;
      if (!document.contains(canvas)) { teardown(); return; }
      if (!helpMode && state === STATE.RUNNING && !paused) {
        if (resumeCountdown > 0) resumeCountdown--;
        else update();
      }
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
      if (isTypingTarget(e.target)) return; // never hijack keys while typing in chat
      // "?" toggles the settings cheatsheet; Esc closes it.
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) { e.preventDefault(); setHelp(!helpMode); return; }
      if (e.key === "Escape" && helpMode) { e.preventDefault(); setHelp(false); return; }
      if (helpMode) return; // swallow gameplay keys while the cheatsheet is up
      if (e.code === "Space" || e.key === " " || e.code === "ArrowUp" || e.key === "ArrowUp") {
        e.preventDefault();
        jump();
      }
    }
    // Map a mouse/touch event to canvas (drawing-buffer) coordinates.
    function pointerPos(e) {
      try {
        var rect = canvas.getBoundingClientRect();
        var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
        var cx = t ? t.clientX : e.clientX;
        var cy = t ? t.clientY : e.clientY;
        if (cx == null || cy == null) return null;
        return {
          x: (cx - rect.left) * (W / (rect.width || W)),
          y: (cy - rect.top) * (H / (rect.height || H))
        };
      } catch (err) { return null; }
    }
    function inHotspot(pt, h) {
      return !!(pt && h && pt.x >= h.x && pt.x <= h.x + h.w && pt.y >= h.y && pt.y <= h.y + h.h);
    }
    function onPointer(e) {
      if (!alive) return;
      if (e.type === "mousedown" && e.button !== 0) return; // ignore right/middle click
      e.preventDefault();
      // Take keyboard focus so Space/Arrow/"?" reach the game from here on.
      // preventDefault above suppresses the implicit focus, so do it explicitly.
      try { canvas.focus({ preventScroll: true }); } catch (err) { try { canvas.focus(); } catch (e2) { } }
      // The "⚙ settings" corner button opens the panel — the reliable path,
      // since the chat input owns the keyboard so the "?" shortcut can't fire.
      if (inHotspot(pointerPos(e), settingsHotspot)) { setHelp(!helpMode); return; }
      if (helpMode) { setHelp(false); return; } // a tap on the game dismisses the cheatsheet
      jump();
    }
    function onContextMenu(e) { e.preventDefault(); } // block right-click menu so focus never leaves

    function teardown() {
      alive = false;
      if (rafId) cancelAnimationFrame(rafId);
      if (ro) { try { ro.disconnect(); } catch (e) { } ro = null; }
      window.removeEventListener("keydown", onKey, true);
      canvas.removeEventListener("mousedown", onPointer);
      canvas.removeEventListener("touchstart", onPointer);
      canvas.removeEventListener("contextmenu", onContextMenu);
    }

    this.resize = function (newW) {
      newW = Math.max(CONFIG.minWidth, Math.floor(newW));
      if (newW > 0 && newW !== W) {
        canvas.width = newW; W = newW; ctx.imageSmoothingEnabled = false;
        rebuildModalIfOpen();
      }
    };

    this.start = function () {
      window.addEventListener("keydown", onKey, true);
      canvas.addEventListener("mousedown", onPointer);
      canvas.addEventListener("touchstart", onPointer, { passive: false });
      canvas.addEventListener("contextmenu", onContextMenu);
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

    // Freeze / unfreeze the simulation while keeping the scene on screen.
    this.pause = function () {
      paused = true;
      setHelp(false);
    };
    this.resume = function () {
      if (paused) {
        paused = false;
        if (state === STATE.RUNNING) resumeCountdown = 90;
      }
    };
    this.isPaused = function () { return paused; };
    this.toggleHelp = function () { setHelp(!helpMode); };

    // Snapshot / restore so a run survives a teardown (e.g. a permission
    // prompt that recreates the spinner row) and continues where it left off.
    this.getState = function () {
      return {
        distance: distance, speed: speed, score: score, frame: frame,
        spawnGap: spawnGap, state: state,
        dino: { y: dino.y, vy: dino.vy, onGround: dino.onGround },
        obstacles: obstacles.map(function (o) { return { type: o.type, x: o.x, y: o.y, w: o.w, h: o.h, sprite: o.sprite }; })
      };
    };
    this.restore = function (s) {
      if (!s) return;
      distance = s.distance || 0;
      speed = s.speed || CONFIG.startSpeed;
      score = s.score || 0;
      frame = s.frame || 0;
      lastMilestone = score - (score % 100); // don't re-flash past milestones on resume
      spawnGap = s.spawnGap || 70;
      // A restored-from-crash run resumes live rather than on the game-over screen.
      state = (s.state === STATE.OVER) ? STATE.RUNNING : (s.state || STATE.RUNNING);
      if (state === STATE.RUNNING) resumeCountdown = 90;
      if (s.dino) { dino.y = s.dino.y; dino.vy = s.dino.vy; dino.onGround = s.dino.onGround; }
      obstacles = (s.obstacles || []).map(function (o) { return { type: o.type, x: o.x, y: o.y, w: o.w, h: o.h, sprite: o.sprite }; });
      if (score > hi) hi = score;
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
    // Focusable so it can own the keyboard. Without this, keydown always targets
    // the chat input (a typing target) and the game's key handler bails out — so
    // Space/Arrow/"?" never reach the game and only mouse clicks work. We never
    // auto-focus (that would steal focus mid-chat); a click focuses it on demand.
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Claudosaurus dino game — click, then Space or Up to jump");
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
    return row.querySelector('[class*="icon_"],[class*="text_"],[class*="dot"],[class*="progress"],[class*="spinner"]') ||
      row.querySelector(CONFIG.busyContentSelector);
  }

  var active = null; // { row, host, game, hidden: [[el, prevDisplay], ...] }
  var notBusySince = 0;   // when the active row last went quiet (0 = it's busy)
  var lastSnapshot = null; // { at, data } of the most recent torn-down run

  // Labels that read like an approval prompt's buttons. Matched at the START of
  // a button's text so ordinary prose buttons elsewhere don't trip it.
  var APPROVE_RE = /^\s*(yes|no|allow|deny|approve|reject|accept|run|cancel|always|don'?t|do you|proceed|grant|confirm|y\s*\/\s*n)\b/i;

  function isVisible(el) {
    return !!(el && el.offsetParent !== null);
  }
  // The container to scan for a permission prompt. Configurable; otherwise walk
  // a few levels up from the spinner row to reach the surrounding chat panel.
  function promptScope() {
    if (CONFIG.promptScopeSelector) {
      try { return document.querySelector(CONFIG.promptScopeSelector); } catch (e) { return null; }
    }
    var n = active && active.row;
    for (var hops = 0; n && n.parentElement && hops < 4; hops++) n = n.parentElement;
    return n || (active && active.row) || null;
  }
  // Is an approve/deny button visible in scope? (the robust default detector)
  function permissionButtonsUp() {
    if (!CONFIG.detectPermissionButtons) return false;
    var scope = promptScope();
    if (!scope) return false;
    var btns;
    try { btns = scope.querySelectorAll('button,[role="button"]'); } catch (e) { return false; }
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || "").trim();
      if (t && t.length <= 24 && APPROVE_RE.test(t) && isVisible(btns[i])) return true;
    }
    return false;
  }
  // Optional opt-in prose scan (off by default — can false-positive on output).
  function permissionTextUp() {
    if (!CONFIG.pauseTextPattern) return false;
    var scope = promptScope();
    if (!scope) return false;
    try { return new RegExp(CONFIG.pauseTextPattern, "i").test(scope.textContent || ""); }
    catch (e) { return false; }
  }
  // A permission-style prompt is currently on screen, by any of the signals.
  function promptUp() {
    try {
      if (CONFIG.pauseSelector && document.querySelector(CONFIG.pauseSelector)) return true;
    } catch (e) { }
    return permissionButtonsUp() || permissionTextUp();
  }
  // Freeze the simulation: the tab is hidden, a VS Code popup/modal stole focus,
  // or a prompt is up. Purely visual — does NOT by itself keep the game alive.
  function shouldFreeze() {
    if (document.hidden) return true;
    if (CONFIG.pauseWhenUnfocused && typeof document.hasFocus === "function" && !document.hasFocus()) return true;
    return promptUp();
  }
  // Hold the (frozen) game open instead of tearing it down: a permission prompt
  // means the turn is paused, not finished. Focus/visibility do NOT hold — a
  // turn that finishes while unfocused should still tidy itself away.
  function shouldHold() { return promptUp(); }

  // Remember an in-progress run so a quick re-spawn resumes it.
  function saveSnapshot() {
    if (!active || !active.game) return;
    try {
      var s = active.game.getState();
      if (s && s.score > 0) lastSnapshot = { at: Date.now(), data: s };
    } catch (e) { }
  }

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
    host.className = "claudosaurus-host";
    host.style.width = "100%";
    host.style.margin = "2px 0";
    host.style.position = "relative";

    var canvas = buildCanvas();
    host.appendChild(canvas);
    row.appendChild(host);

    var game = new DinoGame(canvas, color);
    // Resume the previous run if it ended recently (e.g. a permission prompt
    // briefly tore the spinner row down), otherwise start fresh.
    if (lastSnapshot && Date.now() - lastSnapshot.at < CONFIG.resumeWindowMs) {
      try { game.restore(lastSnapshot.data); } catch (e) { }
    }
    lastSnapshot = null;
    notBusySince = 0;
    host.__game = game;
    game.start();
    requestAnimationFrame(function () { game.resize(host.clientWidth || canvas.clientWidth || 320); });

    active = { row: row, host: host, game: game, hidden: hidden };
  }

  function endGame() {
    if (!active) return;
    try { active.game.teardown(); } catch (e) { }
    if (active.host && active.host.parentNode) active.host.parentNode.removeChild(active.host);
    for (var i = 0; i < active.hidden.length; i++) {
      try { active.hidden[i][0].style.display = active.hidden[i][1] || ""; } catch (e) { }
    }
    if (active.row) {
      active.row.style.height = "";
      active.row.style.flexDirection = "";
      active.row.style.alignItems = "";
    }
    active = null;
    notBusySince = 0;
  }

  // Safety net: tear down any host that isn't the one we're actively tracking.
  // A chat-panel re-render can detach our `active` bookkeeping from a canvas
  // that's still in the DOM — the spinner row gets renamed/rebuilt with our
  // host still nested inside it — leaving a game that animates forever after
  // the turn ends. `active.host` is always preserved; everything else is an
  // orphan and gets reaped. (Diagnosed via: spinnerRow matches 0, active false,
  // yet a game still on screen.)
  function reapOrphanHosts() {
    var hosts = document.querySelectorAll(".claudosaurus-host");
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i];
      if (active && h === active.host) continue;
      if (h.__game) { try { h.__game.teardown(); } catch (e) { } }
      if (h.parentNode) h.parentNode.removeChild(h);
    }
  }

  function evaluate() {
    reapOrphanHosts();
    if (CONFIG.alwaysOn) {
      if (active) {
        if (active.row && !document.contains(active.row)) { saveSnapshot(); endGame(); return; }
        if (shouldFreeze()) active.game.pause(); else active.game.resume();
        return;
      }
      var r = document.querySelector(CONFIG.spinnerRowSelector);
      if (r) startGame(r);
      return;
    }
    // Default: the game runs while the row is busy, freezes (without resetting)
    // when a popup/lost-focus/prompt interrupts, and only tears down once Claude
    // is genuinely done — quiet, no prompt up, past the grace window.
    if (active) {
      if (!active.row || !document.contains(active.row)) { saveSnapshot(); endGame(); return; }
      if (rowBusy(active.row)) {
        if (shouldFreeze()) active.game.pause(); else active.game.resume();
        notBusySince = 0;
        return;
      }
      // Not busy: freeze, then either hold (a prompt is up) or count down to end.
      active.game.pause();
      if (!notBusySince) notBusySince = Date.now();
      var idle = Date.now() - notBusySince;
      // A permission prompt holds the frozen game open (paused, score kept) — but
      // not forever: the maxHold cap guarantees a stuck detector can't strand it.
      if (shouldHold() && idle < CONFIG.maxHoldMs) return;
      if (idle >= CONFIG.endGraceMs) { saveSnapshot(); endGame(); }
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
    requestAnimationFrame(function () { pending = false; try { evaluate(); } catch (e) { } });
  }

  // --- TEMP diagnostics: log spinner-ish elements as they appear, from
  // inside the webview, so we can identify the real "working" indicator.
  var seenDbg = {};
  function debugReport(el) {
    var c = typeof el.className === "string" ? el.className : (el.className && el.className.baseVal) || "";
    var anim = "?";
    try { anim = getComputedStyle(el).animationName; } catch (e) { }
    var hit = (anim && anim !== "none") ||
      /spin|load|think|progress|pending|working|dot|cursor|busy|stream|typing|ellipsis|loader/i.test(c);
    if (!hit) return;
    var key = c + "|" + anim;
    if (seenDbg[key]) return;
    seenDbg[key] = 1;
    console.log("[claudosaurus] candidate:", el.tagName, JSON.stringify(c), "anim=" + anim);
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
    // Re-evaluate the moment focus/visibility flips so pausing on a popup and
    // resuming afterwards feel instant.
    document.addEventListener("visibilitychange", scheduleEvaluate);
    window.addEventListener("blur", scheduleEvaluate, true);
    window.addEventListener("focus", scheduleEvaluate, true);
    scheduleEvaluate();
  }

  function removeGames(includeTestRows) {
    if (active) endGame();
    var hosts = document.querySelectorAll(".claudosaurus-host");
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i];
      if (h.__game) { try { h.__game.teardown(); } catch (e) { } }
      if (h.parentNode) h.parentNode.removeChild(h);
    }
    if (includeTestRows) {
      var rows = document.querySelectorAll(".spinnerRow_TEST");
      for (var k = 0; k < rows.length; k++) if (rows[k].parentNode) rows[k].parentNode.removeChild(rows[k]);
    }
  }

  function destroy() {
    if (observer) { try { observer.disconnect(); } catch (e) { } observer = null; }
    if (poll) { clearInterval(poll); poll = null; }
    document.removeEventListener("visibilitychange", scheduleEvaluate);
    window.removeEventListener("blur", scheduleEvaluate, true);
    window.removeEventListener("focus", scheduleEvaluate, true);
    removeGames(true);
  }

  // ----------------------------------------------------------------
  // Options: presets + persistence. Everything DinoGame reads lives in
  // CONFIG and is read live each frame, so changes apply to a running game.
  // ----------------------------------------------------------------
  var SPEED_PRESETS = {
    slow: { startSpeed: -1.0, maxSpeed: 8.5, acceleration: 0.001 },
    normal: { startSpeed: 0, maxSpeed: 11.0, acceleration: 0.0016 },
    fast: { startSpeed: 1.2, maxSpeed: 14.0, acceleration: 0.0024 }
  };
  var JUMP_PRESETS = {
    floaty: { gravity: 0.38, jumpVelocity: -8.0 },
    normal: { gravity: 0.52, jumpVelocity: -9.0 },
    snappy: { gravity: 0.76, jumpVelocity: -10.0 }
  };
  // Only these keys are persisted (everything user-tunable; not selectors/internals).
  var PERSIST_KEYS = [
    "startSpeed", "maxSpeed", "acceleration", "gravity", "jumpVelocity",
    "theme", "scanlines", "clouds", "cycleScore",
    "sound", "enableBirds", "birdMinScore"
  ];
  var OPTIONS_KEY = "claudeRexOptions";

  function loadOptions() {
    try {
      var raw = localStorage.getItem(OPTIONS_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      for (var i = 0; i < PERSIST_KEYS.length; i++) {
        var k = PERSIST_KEYS[i];
        if (o && o.hasOwnProperty(k)) CONFIG[k] = o[k];
      }
      // Migrate the retired dayNightCycle flag: it's now theme "cycle".
      if (o && o.dayNightCycle && (!o.theme || o.theme === "auto")) CONFIG.theme = "cycle";
    } catch (e) { }
  }
  function saveOptions() {
    try {
      var o = {};
      for (var i = 0; i < PERSIST_KEYS.length; i++) o[PERSIST_KEYS[i]] = CONFIG[PERSIST_KEYS[i]];
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(o));
    } catch (e) { }
  }
  function applyOptions(o) {
    if (!o) return;
    for (var k in o) if (o.hasOwnProperty(k)) CONFIG[k] = o[k];
    saveOptions();
    scheduleEvaluate();
  }

  // Selector overrides — kept separate from the options above so a normal
  // settings change never persists a (possibly stale) selector. If a future
  // extension update breaks detection, users can self-heal without re-patching
  // or editing code: __claudosaurus.setSelectors({ spinnerRow, busyContent }).
  // These are only persisted (and thus only override the code defaults) once
  // explicitly set, so the shipped defaults stay authoritative otherwise.
  var DEFAULT_SELECTORS = {
    spinnerRowSelector: CONFIG.spinnerRowSelector,
    busyContentSelector: CONFIG.busyContentSelector
  };
  var SELECTORS_KEY = "claudeRexSelectors";
  function loadSelectors() {
    try {
      var raw = localStorage.getItem(SELECTORS_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && o.spinnerRowSelector) CONFIG.spinnerRowSelector = o.spinnerRowSelector;
      if (o && o.busyContentSelector) CONFIG.busyContentSelector = o.busyContentSelector;
    } catch (e) { }
  }

  // ----------------------------------------------------------------
  // Public API + bootstrap.
  // ----------------------------------------------------------------
  window.__claudosaurus = {
    version: VERSION,
    config: CONFIG,
    DinoGame: DinoGame,
    clear: function () { removeGames(true); },
    __destroy: destroy,
    // Always-on: keep the game up even when Claude is idle.
    setAlwaysOn: function (on) {
      CONFIG.alwaysOn = !!on;
      try { localStorage.setItem(ALWAYS_ON_KEY, on ? "1" : "0"); } catch (e) { }
      if (!on) removeGames(false);
      scheduleEvaluate();
      return CONFIG.alwaysOn;
    },
    // Manual freeze/unfreeze of the current run (the auto-pause handles popups
    // and permission prompts on its own; these are for tinkering).
    pause: function () { if (active && active.game) active.game.pause(); },
    resume: function () { if (active && active.game) active.game.resume(); },
    // Toggle the in-canvas settings cheatsheet (same as pressing "?" in-game).
    help: function () { if (active && active.game) active.game.toggleHelp(); },

    // Customisation (all persist to localStorage and apply to the live game).
    presets: { speed: SPEED_PRESETS, jump: JUMP_PRESETS },
    setOptions: function (o) { applyOptions(o); return CONFIG; },
    setSpeed: function (name) { // "slow" | "normal" | "fast"
      if (SPEED_PRESETS[name]) applyOptions(SPEED_PRESETS[name]);
      return name;
    },
    setJump: function (name) { // "floaty" | "normal" | "snappy"
      if (JUMP_PRESETS[name]) applyOptions(JUMP_PRESETS[name]);
      return name;
    },
    setTheme: function (name) { // "day" | "night" | "auto" | "cycle"
      var ok = { day: 1, night: 1, auto: 1, cycle: 1 };
      applyOptions({ theme: ok[name] ? name : "auto" });
      return CONFIG.theme;
    },
    setScanlines: function (on) { applyOptions({ scanlines: !!on }); return CONFIG.scanlines; },
    setSound: function (on) { applyOptions({ sound: !!on }); return CONFIG.sound; },
    // Back-compat shim: the old day/night cycle is now the "cycle" theme.
    setDayNight: function (on) { applyOptions({ theme: on ? "cycle" : "auto" }); return CONFIG.theme === "cycle"; },
    // Lifetime stats: read the running totals, or wipe them.
    stats: function () { return readStats(); },
    resetStats: function () { try { localStorage.removeItem(STATS_KEY); } catch (e) { } return readStats(); },
    // Detection self-heal: override the spinner/busy selectors if an extension
    // update ever breaks detection (persists). resetSelectors() restores defaults.
    setSelectors: function (o) {
      o = o || {};
      if (o.spinnerRow) CONFIG.spinnerRowSelector = String(o.spinnerRow);
      if (o.busyContent) CONFIG.busyContentSelector = String(o.busyContent);
      try { localStorage.setItem(SELECTORS_KEY, JSON.stringify({ spinnerRowSelector: CONFIG.spinnerRowSelector, busyContentSelector: CONFIG.busyContentSelector })); } catch (e) { }
      scheduleEvaluate();
      return { spinnerRow: CONFIG.spinnerRowSelector, busyContent: CONFIG.busyContentSelector };
    },
    resetSelectors: function () {
      CONFIG.spinnerRowSelector = DEFAULT_SELECTORS.spinnerRowSelector;
      CONFIG.busyContentSelector = DEFAULT_SELECTORS.busyContentSelector;
      try { localStorage.removeItem(SELECTORS_KEY); } catch (e) { }
      scheduleEvaluate();
      return DEFAULT_SELECTORS;
    },
    resetOptions: function () {
      applyOptions({
        startSpeed: 0, maxSpeed: 11.0, acceleration: 0.0016, gravity: 0.52, jumpVelocity: -9.0,
        theme: "auto", scanlines: false, clouds: true, cycleScore: 500,
        sound: false, enableBirds: true, birdMinScore: 150
      });
      return CONFIG;
    },
    // Inject a fake, persistent busy spinner so you can play on demand. The
    // data-permission-mode marker is what makes the row read as "busy".
    spawnTest: function () {
      removeGames(true);
      var row = document.createElement("div");
      row.className = "spinnerRow_TEST";
      row.style.cssText = "display:flex;align-items:center;min-height:1.85em;margin:8px 0;width:100%;";
      var dot = document.createElement("div");
      dot.className = "spinner_TEST";
      dot.setAttribute("data-permission-mode", "default");
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
      console.log("[claudosaurus] spinnerRow matches:", rows.length,
        "| busy rows:", busy,
        "| freeze:", shouldFreeze(), "| promptUp:", promptUp(),
        "| permBtns:", permissionButtonsUp(), "| hold:", shouldHold(),
        "| active:", !!active,
        "| paused:", !!(active && active.game && active.game.isPaused()),
        "| alwaysOn:", CONFIG.alwaysOn,
        "| colour:", sample ? colorOfSpinner(sample) : "(none)");
      return { rows: rows.length, busy: busy, freeze: shouldFreeze(), promptUp: promptUp() };
    }
  };
  // Backward-compat alias so any existing console snippets still work.
  window.__claudeRex = window.__claudosaurus;

  function boot() {
    try {
      loadOptions(); // restore the user's saved difficulty/theme tweaks
      loadSelectors(); // restore any user selector overrides (drift self-heal)
      console.log("[claudosaurus] v" + window.__claudosaurus.version + " by @animeshlego5 running @ " + location.href);
      startObserver();
      if (/[?&]claudeRexForce=1/.test(location.search)) window.__claudosaurus.spawnTest();
    } catch (e) {
      try { console.warn("[claudosaurus] failed to start:", e); } catch (_) { }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
