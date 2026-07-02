(function () {
  'use strict';

  var VERSION = '0.2.1';

  // ---------------------------------------------------------------------
  // Tuning
  // ---------------------------------------------------------------------
  var LANES = 4;                 // lanes across the promenade
  var RUN_DISTANCE = 400;        // metres, Tiki Beach to Daytona
  var WALK_SPEED = 10;           // metres per second
  var LANE_SLIDE_MS = 180;       // duration of the lane change tween
  var TILE_METRES = 2.5;         // promenade tile size in metres
  var BUILDING_METRES = 6;       // depth of one building block in metres
  var PERSPECTIVE = 11;          // larger = gentler recede, more visible ahead
  var DEPTH_CURVE = 1.55;        // >1 keeps mid-distance gradual, rushes at end
  var DRAW_DISTANCE = 170;       // metres of world drawn ahead of the player
  var HORIZON_FRAC = 0.47;       // horizon line as a fraction of screen height

  // ---------------------------------------------------------------------
  // Canvas
  // ---------------------------------------------------------------------
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var W = 0;                     // CSS pixel width
  var H = 0;                     // CSS pixel height

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  window.addEventListener('resize', resize);
  resize();

  // ---------------------------------------------------------------------
  // Layout — widths are defined at the player's depth (d = 1).
  // Beach strip on the left, buildings on the right, 4-lane promenade
  // in between, all converging on the vanishing point.
  // ---------------------------------------------------------------------
  function beachWidth() { return W * 0.18; }
  function buildingWidth() { return W * 0.18; }
  function promenadeWidth() { return W * 0.44; }
  function promenadeLeft() { return (W - promenadeWidth()) / 2; }
  function laneWidth() { return promenadeWidth() / LANES; }

  function laneCentreX(lane) {
    return promenadeLeft() + laneWidth() * (lane - 0.5);
  }

  function playerY() {
    return H * 0.78; // lower third of the screen
  }

  // ---------------------------------------------------------------------
  // Perspective — the reusable depth system.
  //
  // Depth d runs from 0 at the horizon to 1 level with the player (and
  // slightly beyond 1 for the strip between the player and the bottom
  // edge of the screen). Everything in the world derives its screen
  // position and scale from d, so Phase 2 hazards and power-ups can use
  // exactly the same projection:
  //
  //   var d = depthOf(metresAhead);        // world distance -> depth
  //   var y = depthToY(d);                 // depth -> screen y
  //   var x = depthToX(xAtPlayerDepth, d); // lane/offset x -> screen x
  //   var s = d;                           // depth doubles as scale
  // ---------------------------------------------------------------------
  function horizonY() { return H * HORIZON_FRAC; }
  function vanishingX() { return W / 2; }

  function depthOf(metresAhead) {
    // Hyperbolic falloff, then a gentle exponent so distant things hold
    // their apparent distance longer and only swell in the final metres.
    return Math.pow(PERSPECTIVE / (PERSPECTIVE + metresAhead), DEPTH_CURVE);
  }

  function depthToY(d) {
    return horizonY() + (playerY() - horizonY()) * d;
  }

  // Project an x defined at the player's depth to its position at depth d.
  function depthToX(xAtPlayer, d) {
    return vanishingX() + (xAtPlayer - vanishingX()) * d;
  }

  // Depth of the bottom edge of the screen (a little behind the player).
  function bottomDepth() {
    return (H - horizonY()) / (playerY() - horizonY());
  }

  // World metres ahead corresponding to the bottom edge (negative).
  // Inverse of depthOf, including the DEPTH_CURVE exponent.
  function bottomMetres() {
    var d = bottomDepth();
    return PERSPECTIVE * (Math.pow(d, -1 / DEPTH_CURVE) - 1);
  }

  // ---------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------
  var STATE_TITLE = 0;   // start screen overlay showing
  var STATE_READY = 1;   // world visible, waiting for first movement
  var STATE_WALKING = 2; // run in progress
  var STATE_DONE = 3;    // reached Daytona, end screen showing

  var state = STATE_TITLE;
  var distance = 0;          // metres walked
  var elapsed = 0;           // seconds since the timer started
  var lane = 2;              // current lane, 1..LANES
  var slide = null;          // active lane tween {fromX, toX, t}
  var playerX = 0;           // player centre x at player depth, CSS pixels
  var lastTime = 0;

  var startScreen = document.getElementById('start-screen');
  var endScreen = document.getElementById('end-screen');
  var endTimeEl = document.getElementById('end-time');
  var versionEl = document.getElementById('version');
  var walkAgainBtn = document.getElementById('walk-again');

  versionEl.textContent = 'v' + VERSION;

  function resetRun() {
    distance = 0;
    elapsed = 0;
    lane = 2;
    slide = null;
    playerX = laneCentreX(lane);
    state = STATE_READY;
  }

  function startWalking() {
    state = STATE_WALKING;
  }

  function finishRun() {
    state = STATE_DONE;
    endTimeEl.textContent = elapsed.toFixed(1) + 's';
    endScreen.classList.remove('hidden');
  }

  // ---------------------------------------------------------------------
  // Lane movement — smooth eased slide, never an instant jump
  // ---------------------------------------------------------------------
  function easeInOutQuad(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function moveLane(dir) {
    if (state !== STATE_READY && state !== STATE_WALKING) return;

    var target = lane + dir;
    if (target < 1 || target > LANES) return; // edge hazards come later

    lane = target;
    slide = { fromX: playerX, toX: laneCentreX(lane), t: 0 };

    if (state === STATE_READY) startWalking(); // first movement starts the run
  }

  function updateSlide(dt) {
    if (!slide) return;
    slide.t += (dt * 1000) / LANE_SLIDE_MS;
    if (slide.t >= 1) {
      playerX = slide.toX;
      slide = null;
    } else {
      playerX = slide.fromX + (slide.toX - slide.fromX) * easeInOutQuad(slide.t);
    }
  }

  // ---------------------------------------------------------------------
  // Input — swipe anywhere, arrow keys on desktop
  // ---------------------------------------------------------------------
  var touchStartX = null;
  var touchStartY = null;
  var SWIPE_THRESHOLD = 30; // CSS pixels

  document.addEventListener('touchstart', function (e) {
    var t = e.changedTouches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
  }, { passive: true });

  document.addEventListener('touchend', function (e) {
    if (touchStartX === null) return;
    var t = e.changedTouches[0];
    var dx = t.clientX - touchStartX;
    var dy = t.clientY - touchStartY;
    touchStartX = null;
    touchStartY = null;
    if (Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
      moveLane(dx > 0 ? 1 : -1);
    }
  }, { passive: true });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      moveLane(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      moveLane(1);
    }
  });

  startScreen.addEventListener('click', function () {
    if (state !== STATE_TITLE) return;
    startScreen.classList.add('hidden');
    resetRun();
  });

  walkAgainBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    endScreen.classList.add('hidden');
    resetRun();
  });

  // ---------------------------------------------------------------------
  // Drawing — placeholder graphics, everything on canvas.
  // The world is drawn back to front: sky, sea and beach on the left,
  // promenade in the middle, buildings on the right, then the player.
  // ---------------------------------------------------------------------

  // Deterministic pseudo-random for stable building shapes and windows.
  function rand(seed) {
    var x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function drawSky() {
    var hy = horizonY();

    // Faint warm glow where the promenade meets the horizon —
    // the lights of Daytona in the distance.
    var glowH = H * 0.08;
    var g = ctx.createLinearGradient(0, hy - glowH, 0, hy);
    g.addColorStop(0, 'rgba(255, 209, 102, 0)');
    g.addColorStop(1, 'rgba(255, 209, 102, 0.18)');
    ctx.fillStyle = g;
    ctx.fillRect(0, hy - glowH, W, glowH);
  }

  function drawBeach() {
    var hy = horizonY();
    var dMax = bottomDepth();
    var promLeft = promenadeLeft();
    var beachOuter = promLeft - beachWidth();

    // Sea fills everything left of the beach's outer edge line
    ctx.fillStyle = '#2e6fa3';
    ctx.beginPath();
    ctx.moveTo(vanishingX(), hy);
    ctx.lineTo(0, hy);
    ctx.lineTo(0, H);
    ctx.lineTo(depthToX(beachOuter, dMax), H);
    ctx.closePath();
    ctx.fill();

    // Sandy strip between the sea and the promenade
    ctx.fillStyle = '#e8c76f';
    ctx.beginPath();
    ctx.moveTo(vanishingX(), hy);
    ctx.lineTo(depthToX(beachOuter, dMax), H);
    ctx.lineTo(depthToX(promLeft, dMax), H);
    ctx.closePath();
    ctx.fill();

    // Foam line where sea meets sand
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(vanishingX(), hy);
    ctx.lineTo(depthToX(beachOuter, dMax), H);
    ctx.stroke();
  }

  function drawPromenade() {
    var hy = horizonY();
    var dMax = bottomDepth();
    var left = promenadeLeft();
    var right = left + promenadeWidth();

    // Light sandy-grey trapezoid converging on the vanishing point
    ctx.fillStyle = '#c9c2b4';
    ctx.beginPath();
    ctx.moveTo(vanishingX(), hy);
    ctx.lineTo(depthToX(left, dMax), H);
    ctx.lineTo(depthToX(right, dMax), H);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(90, 85, 75, 0.18)';
    ctx.lineWidth = 1;

    // Tile lines across the promenade, packing together with distance
    var firstRow = Math.ceil((distance + bottomMetres()) / TILE_METRES);
    var lastRow = Math.floor((distance + DRAW_DISTANCE) / TILE_METRES);
    for (var k = firstRow; k <= lastRow; k++) {
      var d = depthOf(k * TILE_METRES - distance);
      var y = depthToY(d);
      ctx.beginPath();
      ctx.moveTo(depthToX(left, d), y);
      ctx.lineTo(depthToX(right, d), y);
      ctx.stroke();
    }

    // Lane lines running from the vanishing point to the bottom edge
    for (var i = 1; i < LANES * 2; i++) {
      var x = left + (promenadeWidth() / (LANES * 2)) * i;
      ctx.beginPath();
      ctx.moveTo(vanishingX(), hy);
      ctx.lineTo(depthToX(x, dMax), H);
      ctx.stroke();
    }

    // Kerbs along both edges of the promenade
    ctx.strokeStyle = 'rgba(90, 85, 75, 0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(vanishingX(), hy);
    ctx.lineTo(depthToX(left, dMax), H);
    ctx.moveTo(vanishingX(), hy);
    ctx.lineTo(depthToX(right, dMax), H);
    ctx.stroke();
  }

  function drawBuildings() {
    var right = promenadeLeft() + promenadeWidth();
    var outer = right + buildingWidth();
    var mBottom = bottomMetres();

    // Repeating blocks along the right edge, drawn far to near so the
    // closer facades overlap the distant ones.
    var firstBlock = Math.floor((distance + mBottom) / BUILDING_METRES);
    var lastBlock = Math.floor((distance + DRAW_DISTANCE) / BUILDING_METRES);

    for (var b = lastBlock; b >= firstBlock; b--) {
      var m = Math.max(b * BUILDING_METRES - distance, mBottom);
      var d = depthOf(m);
      var y = depthToY(d);

      var inset = 4 + rand(b) * (buildingWidth() * 0.2);
      var xL = depthToX(right + inset, d);
      var xR = depthToX(outer - 2, d);
      var hgt = (H * 0.22 + rand(b + 57) * H * 0.1) * d;

      ctx.fillStyle = (b % 2 === 0) ? '#12233d' : '#152a47';
      ctx.fillRect(xL, y - hgt, xR - xL, hgt);

      // Lit window rectangles on the facade
      var cols = 2;
      var rows = 3;
      var winW = (xR - xL) / (cols * 2 + 1);
      var winH = hgt / (rows * 2 + 1);
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          if (rand(b * 31 + r * 7 + c * 3) < 0.45) continue; // dark window
          ctx.fillStyle = 'rgba(255, 209, 102, 0.85)';
          ctx.fillRect(
            xL + winW * (c * 2 + 1),
            y - hgt + winH * (r * 2 + 1),
            winW,
            winH
          );
        }
      }
    }
  }

  function drawPlayer(time) {
    var x = playerX;
    var y = playerY();
    var bodyW = Math.min(laneWidth() * 0.7, 56);
    var bodyH = bodyW * 1.5;
    var headR = bodyW * 0.42;

    // Walking bob while moving
    var bob = 0;
    if (state === STATE_WALKING) {
      bob = Math.sin(time / 90) * 2;
    }

    // Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.beginPath();
    ctx.ellipse(x, y + bodyH * 0.55, bodyW * 0.75, bodyW * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body — rounded rectangle
    ctx.fillStyle = '#e63946';
    roundRect(x - bodyW / 2, y - bodyH / 2 + bob, bodyW, bodyH, bodyW * 0.35);
    ctx.fill();

    // Head circle
    ctx.fillStyle = '#f4d1ae';
    ctx.beginPath();
    ctx.arc(x, y - bodyH / 2 - headR * 0.7 + bob, headR, 0, Math.PI * 2);
    ctx.fill();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawHUD() {
    var stripH = 44;

    // Translucent dark strip
    ctx.fillStyle = 'rgba(10, 22, 40, 0.72)';
    ctx.fillRect(0, 0, W, stripH);

    ctx.textBaseline = 'middle';
    ctx.font = '16px "DM Mono", monospace';

    // Distance top left
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(Math.floor(distance) + 'm / ' + RUN_DISTANCE + 'm', 14, stripH / 2);

    // Timer top right
    ctx.fillStyle = '#ffd166';
    ctx.textAlign = 'right';
    ctx.fillText(elapsed.toFixed(1) + 's', W - 14, stripH / 2);
  }

  // ---------------------------------------------------------------------
  // Main loop — requestAnimationFrame
  // ---------------------------------------------------------------------
  function frame(time) {
    var dt = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 0;
    lastTime = time;

    if (state === STATE_WALKING) {
      distance += WALK_SPEED * dt;
      elapsed += dt;
      if (distance >= RUN_DISTANCE) {
        distance = RUN_DISTANCE;
        finishRun();
      }
    }

    updateSlide(dt);

    // Sky and side fills share the page background colour
    ctx.fillStyle = '#0a1628';
    ctx.fillRect(0, 0, W, H);

    drawSky();
    drawBeach();
    drawPromenade();
    drawBuildings();

    if (state !== STATE_TITLE) {
      if (playerX === 0) playerX = laneCentreX(lane);
      drawPlayer(time);
      drawHUD();
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
