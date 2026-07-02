(function () {
  'use strict';

  var VERSION = '0.1.1';

  // ---------------------------------------------------------------------
  // Tuning
  // ---------------------------------------------------------------------
  var LANES = 4;                 // lanes across the promenade
  var RUN_DISTANCE = 400;        // metres, Tiki Beach to Daytona
  var WALK_SPEED = 10;           // metres per second
  var METRES_VISIBLE = 25;       // world metres visible per screen height
  var LANE_SLIDE_MS = 180;       // duration of the lane change tween
  var TILE_METRES = 2.5;         // promenade tile size in metres
  var BUILDING_METRES = 6;       // height of one building block in metres

  // ---------------------------------------------------------------------
  // Canvas
  // ---------------------------------------------------------------------
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var W = 0;                     // CSS pixel width
  var H = 0;                     // CSS pixel height
  var PPM = 0;                   // pixels per metre

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    PPM = H / METRES_VISIBLE;
  }

  window.addEventListener('resize', resize);
  resize();

  // ---------------------------------------------------------------------
  // Layout — beach strip on the left, buildings on the right,
  // 4-lane promenade in between.
  // ---------------------------------------------------------------------
  function beachWidth() { return Math.round(W * 0.16); }
  function buildingWidth() { return Math.round(W * 0.16); }
  function promenadeLeft() { return beachWidth(); }
  function promenadeWidth() { return W - beachWidth() - buildingWidth(); }
  function laneWidth() { return promenadeWidth() / LANES; }

  function laneCentreX(lane) {
    return promenadeLeft() + laneWidth() * (lane - 0.5);
  }

  function playerY() {
    return H * 0.78; // lower third of the screen
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
  var playerX = 0;           // player centre x in CSS pixels
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
  // Drawing — placeholder graphics, everything on canvas
  // ---------------------------------------------------------------------

  // Deterministic pseudo-random for stable building windows.
  function rand(seed) {
    var x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function drawPromenade(scrollPx) {
    var left = promenadeLeft();
    var width = promenadeWidth();

    // Light sandy-grey surface
    ctx.fillStyle = '#c9c2b4';
    ctx.fillRect(left, 0, width, H);

    // Subtle tile lines scrolling downward
    var tilePx = TILE_METRES * PPM;
    ctx.strokeStyle = 'rgba(90, 85, 75, 0.18)';
    ctx.lineWidth = 1;

    var offsetY = scrollPx % tilePx;
    for (var y = offsetY - tilePx; y < H + tilePx; y += tilePx) {
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + width, y);
      ctx.stroke();
    }
    for (var i = 1; i < LANES * 2; i++) {
      var x = left + (width / (LANES * 2)) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
  }

  function drawBeach() {
    var bw = beachWidth();

    // Sandy yellow strip
    ctx.fillStyle = '#e8c76f';
    ctx.fillRect(0, 0, bw, H);

    // Blue sea edge on the outermost left
    var seaW = Math.max(6, Math.round(bw * 0.35));
    ctx.fillStyle = '#2e6fa3';
    ctx.fillRect(0, 0, seaW, H);

    // Foam line where sea meets sand
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(seaW, 0, 2, H);

    // Kerb between beach and promenade
    ctx.fillStyle = 'rgba(90, 85, 75, 0.35)';
    ctx.fillRect(bw - 3, 0, 3, H);
  }

  function drawBuildings(scrollPx) {
    var bw = buildingWidth();
    var left = W - bw;

    // Base strip
    ctx.fillStyle = '#0a1628';
    ctx.fillRect(left, 0, bw, H);

    // Kerb between promenade and buildings
    ctx.fillStyle = 'rgba(90, 85, 75, 0.35)';
    ctx.fillRect(left, 0, 3, H);

    // Repeating navy blocks with lit windows, scrolling downward
    var blockPx = BUILDING_METRES * PPM;
    var firstBlock = Math.floor(-scrollPx / blockPx) - 1;
    var lastBlock = firstBlock + Math.ceil(H / blockPx) + 2;

    for (var b = firstBlock; b <= lastBlock; b++) {
      var y = b * blockPx + scrollPx;
      var inset = 4 + rand(b) * (bw * 0.2);

      ctx.fillStyle = (b % 2 === 0) ? '#12233d' : '#152a47';
      ctx.fillRect(left + inset, y + 3, bw - inset - 2, blockPx - 6);

      // Lit window rectangles
      var cols = 2;
      var rows = 3;
      var winW = (bw - inset - 2) / (cols * 2 + 1);
      var winH = (blockPx - 6) / (rows * 2 + 1);
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          if (rand(b * 31 + r * 7 + c * 3) < 0.45) continue; // dark window
          ctx.fillStyle = 'rgba(255, 209, 102, 0.85)';
          ctx.fillRect(
            left + inset + winW * (c * 2 + 1),
            y + 3 + winH * (r * 2 + 1),
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
    var bodyW = Math.min(laneWidth() * 0.42, 34);
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

    // The world scrolls downward as the player walks up
    var scrollPx = distance * PPM;

    ctx.clearRect(0, 0, W, H);
    drawPromenade(scrollPx);
    drawBeach();
    drawBuildings(scrollPx);

    if (state !== STATE_TITLE) {
      if (playerX === 0) playerX = laneCentreX(lane);
      drawPlayer(time);
      drawHUD();
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
