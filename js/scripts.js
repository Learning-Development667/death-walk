(function () {
  'use strict';

  var VERSION = '0.6.2';

  // ---------------------------------------------------------------------
  // Tuning
  // ---------------------------------------------------------------------
  var RUN_DISTANCE = 400;        // metres, Tiki Beach to Daytona
  var WALK_SPEED = 5;            // metres per second (400m in ~80s)
  var TILE_METRES = 2.5;         // promenade tile size in metres
  var GRID_COLUMNS = 8;          // longitudinal tile grid lines (visual only)
  var BUILDING_METRES = 6;       // depth of one building block in metres
  var PERSPECTIVE = 11;          // larger = gentler recede, more visible ahead
  var DEPTH_CURVE = 1.55;        // >1 keeps mid-distance gradual, rushes at end
  var MIN_SPREAD = 0.18;         // lateral width floor at the horizon
  var DRAW_DISTANCE = 170;       // metres of world drawn ahead of the player
  var HORIZON_FRAC = 0.47;       // horizon line as a fraction of screen height
  var FOLLOW_RATE = 12;          // drag smoothing, higher = snappier follow
  var KEY_SPEED = 1.2;           // held arrow key speed, promenade widths/sec

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
  // The walkable promenade runs from the sea wall on the left to the
  // building kerb on the right; the beach sits below and beyond the wall.
  // ---------------------------------------------------------------------

  // Left edge of the walkable area — the sea-wall line. This is the
  // Tiki Tumble trigger: a player standing at playerU === 0 is exactly
  // on this line, and Phase 3's fall event fires when they step past it.
  function wallX() { return W * 0.10; }

  function buildingWidth() { return W * 0.18; }
  function promenadeLeft() { return wallX(); }
  function promenadeWidth() { return W * 0.72 - wallX(); }

  // Total drop from the promenade edge down to the sand, at the player's
  // depth. Grows with distance walked: a shallow step near Tiki Beach,
  // a serious ledge by the time Daytona is close.
  function dropHeight() {
    return H * (0.025 + 0.045 * (distance / RUN_DISTANCE));
  }

  var LEDGE_STEPS = 3;                        // drops in the stepped ledge
  function stepTread() { return W * 0.04; }   // tread width at player depth
  function ledgeOuterX() { return wallX() - stepTread() * (LEDGE_STEPS - 1); }
  function shoreX() { return wallX() - W * 0.34; } // shoreline at player depth

  function playerY() {
    return H * 0.89; // close to the bottom edge, long view ahead
  }

  // ---------------------------------------------------------------------
  // Perspective — the reusable depth system.
  //
  // Depth d runs from 0 at the horizon to 1 level with the player (and
  // slightly beyond 1 for the strip between the player and the bottom
  // edge of the screen). Everything in the world derives its screen
  // position and scale from d, so hazards and power-ups can use exactly
  // the same projection:
  //
  //   var d = depthOf(metresAhead);        // world distance -> depth
  //   var y = depthToY(d);                 // depth -> screen y
  //   var x = depthToX(xAtPlayerDepth, d); // lane/offset x -> screen x
  //   var s = spreadOf(d);                 // depth -> scale factor
  //
  // Lateral spread has a floor (MIN_SPREAD) so the scene narrows with
  // distance but never converges to a point — the ground keeps usable
  // width at the horizon for distant hazards and landmarks.
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

  // Lateral/size scale at depth d: 1 at the player, floored at MIN_SPREAD
  // by the horizon instead of shrinking to zero.
  function spreadOf(d) {
    return MIN_SPREAD + (1 - MIN_SPREAD) * d;
  }

  // Project an x defined at the player's depth to its position at depth d.
  function depthToX(xAtPlayer, d) {
    return vanishingX() + (xAtPlayer - vanishingX()) * spreadOf(d);
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
  var elapsed = 0;           // run clock in seconds (collisions add penalties)
  var playerU = 0.5;         // player position across the promenade, 0..1
  var targetU = 0.5;         // where the player is easing toward, 0..1
  var lastTime = 0;
  var frameNow = 0;          // current rAF timestamp, ms

  // Collision effect timers (rAF-clock ms) and skid state
  var invulnUntil = 0;       // no repeat hits while this is in the future
  var shakeUntil = 0;        // screen shake window after a stumble
  var flashUntil = 0;        // player flash window after a stumble
  var skidUntil = 0;         // control lost while sliding on puke
  var skidVel = 0;           // sideways slip, promenade-widths per second

  var startScreen = document.getElementById('start-screen');
  var endScreen = document.getElementById('end-screen');
  var endTimeEl = document.getElementById('end-time');
  var versionEl = document.getElementById('version');
  var walkAgainBtn = document.getElementById('walk-again');

  versionEl.textContent = 'v' + VERSION;

  // Player centre x in CSS pixels at the player's depth.
  function playerScreenX() {
    return promenadeLeft() + promenadeWidth() * playerU;
  }

  function playerWidth() {
    return Math.min(promenadeWidth() * 0.14, 46);
  }

  function resetRun() {
    distance = 0;
    elapsed = 0;
    playerU = 0.5;
    targetU = 0.5;
    hazards.length = 0;
    spawnTimer = 0.02; // hazards from the very first walking frame
    invulnUntil = 0;
    shakeUntil = 0;
    flashUntil = 0;
    skidUntil = 0;
    skidVel = 0;
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
  // Movement — free horizontal movement across the promenade.
  // targetU is where input wants the player; playerU eases toward it so
  // dragging feels smooth rather than jittery. Both are clamped to [0, 1]
  // (0 = beach kerb, 1 = building kerb) so the player can stand right on
  // a boundary line but never cross into the beach or building zones.
  // ---------------------------------------------------------------------
  function clamp01(v) {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  function canMove() {
    return state === STATE_READY || state === STATE_WALKING;
  }

  function setTargetFromScreenX(x) {
    targetU = clamp01((x - promenadeLeft()) / promenadeWidth());
  }

  function updatePlayer(dt) {
    // Skidding on puke: the player slips sideways with no control until
    // the skid window ends, then resumes from wherever they ended up.
    if (frameNow < skidUntil) {
      playerU = clamp01(playerU + skidVel * dt);
      skidVel *= Math.pow(0.02, dt); // slide dies away quickly
      targetU = playerU;
      return;
    }

    // Held arrow keys steer the target at a constant speed
    var dir = (rightHeld ? 1 : 0) - (leftHeld ? 1 : 0);
    if (dir !== 0 && canMove()) {
      targetU = clamp01(targetU + dir * KEY_SPEED * dt);
    }

    // Ease toward the target — light smoothing, no instant snap
    var ease = 1 - Math.exp(-FOLLOW_RATE * dt);
    playerU = clamp01(playerU + (targetU - playerU) * ease);
  }

  // ---------------------------------------------------------------------
  // Input — drag-to-follow touch anywhere on screen, held arrow keys on
  // desktop. While a finger is down its horizontal position steers the
  // player directly; lifting the finger leaves the player where they are.
  // ---------------------------------------------------------------------
  var dragging = false;
  var leftHeld = false;
  var rightHeld = false;

  document.addEventListener('touchstart', function (e) {
    var t = e.touches[0];
    if (!t || !canMove()) return;
    dragging = true;
    setTargetFromScreenX(t.clientX);
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    var t = e.touches[0];
    if (!t || !dragging || !canMove()) return;
    setTargetFromScreenX(t.clientX);
    if (state === STATE_READY) startWalking(); // first movement starts the run
  }, { passive: true });

  document.addEventListener('touchend', function (e) {
    if (e.touches.length === 0) dragging = false;
  }, { passive: true });

  document.addEventListener('touchcancel', function () {
    dragging = false;
  }, { passive: true });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      leftHeld = true;
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      rightHeld = true;
    } else {
      return;
    }
    if (state === STATE_READY) startWalking(); // first movement starts the run
  });

  document.addEventListener('keyup', function (e) {
    if (e.key === 'ArrowLeft') leftHeld = false;
    else if (e.key === 'ArrowRight') rightHeld = false;
  });

  window.addEventListener('blur', function () {
    leftHeld = false;
    rightHeld = false;
    dragging = false;
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
  // Hazards — data-driven: each type is a config entry, and adding a new
  // hazard type means adding an entry here, not writing new logic.
  //
  //   speed    m/s toward the player, independent of the walk speed
  //   spawn    [nearest, furthest] metres ahead to appear at
  //   width    collision + draw width in px at the player's depth
  //   drift    constant sideways speed in promenade-widths/sec (random
  //            direction per hazard; 0 = locked straight)
  //   wander   sinusoidal wander instead of drift: [amplitude, Hz]
  //   lurch    erratic wander: [max speed, min secs, max secs] — picks a
  //            new random sideways velocity on a random timer
  //   group    [min, max] members walking together (hen parties, lads)
  //   ground   static patch stuck to the promenade surface
  //   effect   'stumble' (invuln + shake + flash + penalty) or 'skid'
  //   penalty  seconds added to the run clock on collision
  //   weight   relative spawn frequency
  //   colour   placeholder shape colour until real art lands
  // ---------------------------------------------------------------------
  var HAZARD_TYPES = {
    pedestrian: { speed: 1.2, spawn: [50, 80],  width: 30, drift: 0.012,
                  effect: 'stumble', penalty: 2, weight: 24, colour: '#7fb069' },
    jogger:     { speed: 4.5, spawn: [60, 100], width: 22, drift: 0,
                  effect: 'stumble', penalty: 2, weight: 16, colour: '#f77f00' },
    scooter:    { speed: 9.5, spawn: [25, 45],  width: 46, drift: 0.10,
                  effect: 'stumble', penalty: 2, weight: 13, colour: '#9d4edd' },
    henParty:   { speed: 1.6, spawn: [50, 80],  width: 20, wander: [0.22, 0.25],
                  group: [2, 3],
                  effect: 'stumble', penalty: 2, weight: 11, colour: '#ff70a6' },
    drunkLads:  { speed: 1.4, spawn: [45, 75],  width: 27, lurch: [0.16, 0.5, 1.3],
                  group: [2, 3],
                  effect: 'stumble', penalty: 2, weight: 13, colour: '#4d96ff' },
    performer:  { speed: 0.15, spawn: [50, 110], width: 24, drift: 0,
                  effect: 'stumble', penalty: 2, weight: 10, colour: '#25ced1' },
    puke:       { speed: 0,   spawn: [40, 70],  width: 44, drift: 0, ground: true,
                  effect: 'skid', penalty: 0, weight: 13, colour: '#8aa62f' },
  };

  // ---------------------------------------------------------------------
  // Fixed scenery — obstacles placed at regular intervals along the
  // route, identical every run (no spawning, no cleanup: positions are
  // computed from distance on demand). A new scenery type is a config
  // entry here, same as hazards.
  //
  //   interval  metres between placements
  //   offset    metres before the first placement
  //   lanes     u positions cycled by placement index (palms alternate
  //             sides; benches hug the beach edge)
  //   jitter    small deterministic variation on the lane position
  //   width     draw width in px at the player's depth
  //   hit       collision width as a fraction of width (palm trunks are
  //             narrower than their canopy)
  //   penalty   seconds added on collision (always a stumble)
  // ---------------------------------------------------------------------
  var SCENERY_TYPES = {
    palm:  { interval: 18, offset: 10, lanes: [0.24, 0.76], jitter: 0.05,
             width: 30, hit: 0.5, penalty: 2 },
    bench: { interval: 48, offset: 30, lanes: [0.07], jitter: 0.02,
             width: 38, hit: 0.9, penalty: 2 },
  };

  function sceneryU(cfg, k) {
    return cfg.lanes[k % cfg.lanes.length] + (rand(k * 7.3) - 0.5) * cfg.jitter;
  }

  // All scenery items currently in view, as {key, cfg, worldZ, u}.
  function sceneryItems() {
    var items = [];
    for (var key in SCENERY_TYPES) {
      var cfg = SCENERY_TYPES[key];
      var kMin = Math.max(0,
        Math.ceil((distance + bottomMetres() - 2 - cfg.offset) / cfg.interval));
      var kMax = Math.floor((distance + DRAW_DISTANCE - cfg.offset) / cfg.interval);
      for (var k = kMin; k <= kMax; k++) {
        items.push({
          key: key,
          cfg: cfg,
          scenery: true,
          worldZ: cfg.offset + k * cfg.interval,
          u: sceneryU(cfg, k),
        });
      }
    }
    return items;
  }

  var SPAWN_INTERVAL_START = 1.3; // seconds between spawns at 0m
  var SPAWN_INTERVAL_END = 0.8;   // and by the 400m mark
  var STUMBLE_INVULN_MS = 1200;
  var STUMBLE_SHAKE_MS = 450;
  var STUMBLE_FLASH_MS = 700;
  var SKID_MS = 380;
  var SKID_SPEED = 0.55;          // initial sideways slip, widths/sec

  var hazards = [];
  var spawnTimer = 1.5;

  function spawnInterval() {
    var t = distance / RUN_DISTANCE;
    return SPAWN_INTERVAL_START + (SPAWN_INTERVAL_END - SPAWN_INTERVAL_START) * t;
  }

  function pickHazardType() {
    var total = 0;
    var key;
    for (key in HAZARD_TYPES) total += HAZARD_TYPES[key].weight;
    var r = Math.random() * total;
    for (key in HAZARD_TYPES) {
      r -= HAZARD_TYPES[key].weight;
      if (r <= 0) return key;
    }
    return 'pedestrian';
  }

  function spawnHazard() {
    var key = pickHazardType();
    var cfg = HAZARD_TYPES[key];
    var h = {
      key: key,
      cfg: cfg,
      worldZ: distance + cfg.spawn[0] + Math.random() * (cfg.spawn[1] - cfg.spawn[0]),
      age: 0,
      hit: false, // ground patches only trigger once
      members: null,
      driftVel: 0,
      wanderAmp: 0,
      wanderOmega: 0,
      phase: 0,
      u0: 0,
      u: 0,
    };

    if (cfg.wander) {
      h.wanderAmp = cfg.wander[0];
      h.wanderOmega = cfg.wander[1] * Math.PI * 2;
      h.phase = Math.random() * Math.PI * 2;
      var margin = h.wanderAmp + 0.06;
      h.u0 = margin + Math.random() * (1 - margin * 2);
    } else if (cfg.lurch) {
      h.u0 = 0.15 + Math.random() * 0.7;
      h.driftVel = cfg.lurch[0] * (Math.random() * 2 - 1);
      h.lurchTimer = cfg.lurch[1] + Math.random() * (cfg.lurch[2] - cfg.lurch[1]);
    } else {
      h.u0 = 0.06 + Math.random() * 0.88;
      if (cfg.drift) h.driftVel = cfg.drift * (Math.random() < 0.5 ? -1 : 1);
    }
    h.u = h.u0;

    if (cfg.group) {
      var count = cfg.group[0] +
        Math.floor(Math.random() * (cfg.group[1] - cfg.group[0] + 1));
      h.members = [];
      for (var i = 0; i < count; i++) {
        h.members.push({
          du: (i - (count - 1) / 2) * 0.055 + (Math.random() - 0.5) * 0.02,
          dz: (Math.random() - 0.5) * 2.5,
        });
      }
    }

    hazards.push(h);
  }

  // Overlap test at the player's depth between the player's body and a
  // point at position u with the given width (px at player depth).
  function overlapsPlayer(u, widthPx) {
    var hx = promenadeLeft() + promenadeWidth() * u;
    var gap = Math.abs(hx - playerScreenX());
    return gap < (playerWidth() + widthPx) * 0.5 * 0.8; // slight forgiveness
  }

  function triggerStumble(cfg) {
    invulnUntil = frameNow + STUMBLE_INVULN_MS;
    shakeUntil = frameNow + STUMBLE_SHAKE_MS;
    flashUntil = frameNow + STUMBLE_FLASH_MS;
    elapsed += cfg.penalty; // time penalty straight onto the run clock
  }

  function triggerSkid(h) {
    h.hit = true;
    skidUntil = frameNow + SKID_MS;
    // Slip away from the patch's centre — or a random way if dead-centre
    var away = playerU === h.u ? (Math.random() < 0.5 ? -1 : 1)
                               : (playerU < h.u ? -1 : 1);
    skidVel = away * SKID_SPEED;
    elapsed += h.cfg.penalty;
  }

  function updateHazards(dt) {
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnHazard();
      spawnTimer = spawnInterval();
    }

    for (var i = hazards.length - 1; i >= 0; i--) {
      var h = hazards[i];
      var cfg = h.cfg;
      h.age += dt;
      h.worldZ -= cfg.speed * dt;

      if (h.wanderAmp) {
        h.u = h.u0 + h.wanderAmp * Math.sin(h.phase + h.wanderOmega * h.age);
      } else if (cfg.lurch) {
        // Erratic: lurch onto a new random heading every so often
        h.lurchTimer -= dt;
        if (h.lurchTimer <= 0) {
          h.driftVel = cfg.lurch[0] * (Math.random() * 2 - 1);
          h.lurchTimer = cfg.lurch[1] + Math.random() * (cfg.lurch[2] - cfg.lurch[1]);
        }
        h.u += h.driftVel * dt;
      } else if (h.driftVel) {
        h.u += h.driftVel * dt;
      }

      var m = h.worldZ - distance;

      // Cleanup: fully past the player, or drifted off the promenade
      if (m < bottomMetres() - 2 || h.u < -0.05 || h.u > 1.05) {
        hazards.splice(i, 1);
        continue;
      }

      // Collisions, checked at the player's depth
      if (cfg.ground) {
        if (!h.hit && frameNow >= skidUntil &&
            Math.abs(m) < 1.0 && overlapsPlayer(h.u, cfg.width)) {
          triggerSkid(h);
        }
      } else if (frameNow >= invulnUntil) {
        if (h.members) {
          for (var j = 0; j < h.members.length; j++) {
            var mem = h.members[j];
            if (Math.abs(m + mem.dz) < 0.6 &&
                overlapsPlayer(h.u + mem.du, cfg.width)) {
              triggerStumble(cfg);
              break;
            }
          }
        } else if (Math.abs(m) < 0.6 && overlapsPlayer(h.u, cfg.width)) {
          triggerStumble(cfg);
        }
      }
    }

    // Fixed scenery collides like any stationary hazard: a stumble
    if (frameNow >= invulnUntil) {
      var items = sceneryItems();
      for (var si = 0; si < items.length; si++) {
        var it = items[si];
        var sm = it.worldZ - distance;
        if (Math.abs(sm) < 0.7 &&
            overlapsPlayer(it.u, it.cfg.width * it.cfg.hit)) {
          triggerStumble(it.cfg);
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Drawing — placeholder graphics, everything on canvas.
  // The world is drawn back to front: sky, sea and beach on the left,
  // promenade in the middle, buildings on the right, then the player.
  // Every strip runs between its horizon corners (spread floored at
  // MIN_SPREAD) and its bottom corners, so the whole scene shares one
  // coherent wide-angle perspective.
  // ---------------------------------------------------------------------

  // Deterministic pseudo-random for stable building shapes and windows.
  function rand(seed) {
    var x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  // Fill the quad a strip [xa..xb] (at player depth) covers on screen.
  function fillStrip(xa, xb, colour) {
    var hy = horizonY();
    var dMax = bottomDepth();
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(depthToX(xa, 0), hy);
    ctx.lineTo(depthToX(xb, 0), hy);
    ctx.lineTo(depthToX(xb, dMax), H);
    ctx.lineTo(depthToX(xa, dMax), H);
    ctx.closePath();
    ctx.fill();
  }

  // Stroke the line a longitudinal edge at x (at player depth) makes.
  function strokeEdge(x, colour, width) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(depthToX(x, 0), horizonY());
    ctx.lineTo(depthToX(x, bottomDepth()), H);
    ctx.stroke();
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

  // The beach is a sunken plane: its vertical drop below the promenade
  // grows with depth d (zero at the horizon, full drop at the player),
  // so it shares the same horizon but visibly tilts away at a different
  // angle to the main trapezoid — a lower area you would fall into,
  // not a continuation of the walkable surface.
  function sunkenY(d, dropAtPlayer) {
    return depthToY(d) + dropAtPlayer * d;
  }

  function drawBeach() {
    var hy = horizonY();
    var dMax = bottomDepth();
    var xw = ledgeOuterX();             // sand starts at the ledge's base
    var xs = shoreX();
    var sandDrop = dropHeight();        // sand sits at the base of the drop
    var shoreDrop = dropHeight() + H * 0.075; // constant extra slope to the sea

    // Sea fills everything left of the shoreline
    ctx.fillStyle = '#2e6fa3';
    ctx.beginPath();
    ctx.moveTo(depthToX(xs, 0), hy);
    ctx.lineTo(0, hy);
    ctx.lineTo(0, H);
    ctx.lineTo(depthToX(xs, dMax), sunkenY(dMax, shoreDrop));
    ctx.closePath();
    ctx.fill();

    // Sloping sand between the base of the wall and the shoreline
    ctx.fillStyle = '#e8c76f';
    ctx.beginPath();
    ctx.moveTo(depthToX(xw, 0), hy);
    ctx.lineTo(depthToX(xs, 0), hy);
    ctx.lineTo(depthToX(xs, dMax), sunkenY(dMax, shoreDrop));
    ctx.lineTo(depthToX(xw, dMax), sunkenY(dMax, sandDrop));
    ctx.closePath();
    ctx.fill();

    // Foam line where sea meets sand
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(depthToX(xs, 0), hy);
    ctx.lineTo(depthToX(xs, dMax), sunkenY(dMax, shoreDrop));
    ctx.stroke();
  }

  // The boardwalk ledge — the visible boundary of the walkable area and
  // the future Tiki Tumble edge. The promenade ends at wallX() and steps
  // down onto the sand over flat treads, the total drop growing with
  // distance walked (see dropHeight()). The steps descend seaward, so
  // their vertical faces point away from the camera — each step reads as
  // a tread plus a dark seam at the edge above it, and the promenade
  // (drawn after) naturally occludes whatever the lip hides at this
  // grazing angle.
  function drawLedge() {
    var hy = horizonY();
    var dMax = bottomDepth();
    var drop = dropHeight();
    var faceH = drop / LEDGE_STEPS;

    for (var s = 0; s < LEDGE_STEPS - 1; s++) {
      var x = wallX() - stepTread() * s;         // tread's inner edge line
      var xNext = x - stepTread();
      var o = faceH * (s + 1);                   // this tread's drop offset

      // Flat tread
      ctx.fillStyle = (s % 2 === 0) ? '#b8ac97' : '#aca08b';
      ctx.beginPath();
      ctx.moveTo(depthToX(x, 0), hy);
      ctx.lineTo(depthToX(xNext, 0), hy);
      ctx.lineTo(depthToX(xNext, dMax), sunkenY(dMax, o));
      ctx.lineTo(depthToX(x, dMax), sunkenY(dMax, o));
      ctx.closePath();
      ctx.fill();

      // Dark seam along the tread's inner (higher) edge
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(depthToX(x, 0), hy);
      ctx.lineTo(depthToX(x, dMax), sunkenY(dMax, o));
      ctx.stroke();
    }

    // Shadow where the ledge base meets the sand
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.30)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(depthToX(ledgeOuterX(), 0), hy);
    ctx.lineTo(depthToX(ledgeOuterX(), dMax), sunkenY(dMax, drop));
    ctx.stroke();

    // Bright lip along the promenade's edge — the Tiki Tumble line
    strokeEdge(wallX(), '#f2e9d8', 3);
  }

  function drawPromenade() {
    var dMax = bottomDepth();
    var left = promenadeLeft();
    var right = left + promenadeWidth();

    // Light sandy-grey surface
    fillStrip(left, right, '#c9c2b4');

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

    // Longitudinal tile grid lines narrowing toward the horizon
    for (var i = 1; i < GRID_COLUMNS; i++) {
      var x = left + (promenadeWidth() / GRID_COLUMNS) * i;
      ctx.beginPath();
      ctx.moveTo(depthToX(x, 0), horizonY());
      ctx.lineTo(depthToX(x, dMax), H);
      ctx.stroke();
    }

    // Kerb along the building edge; the sea wall marks the left edge
    strokeEdge(right, 'rgba(90, 85, 75, 0.35)', 3);
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
      var s = spreadOf(d);

      var inset = 4 + rand(b) * (buildingWidth() * 0.2);
      var xL = depthToX(right + inset, d);
      var xR = depthToX(outer - 2, d);
      var hgt = (H * 0.22 + rand(b + 57) * H * 0.1) * s;

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
    var x = playerScreenX();
    var y = playerY();
    var bodyW = playerWidth();
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

    // Body — rounded rectangle, flickering white during a stumble
    var flashing = time < flashUntil && Math.floor(time / 70) % 2 === 0;
    ctx.fillStyle = flashing ? '#ffffff' : '#e63946';
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

  // A simple standing figure: shadow, rounded body, head. Used by most
  // hazard types with different widths/heights/colours.
  function drawFigure(x, feetY, w, h, colour) {
    var headR = w * 0.4;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.beginPath();
    ctx.ellipse(x, feetY, w * 0.7, w * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = colour;
    roundRect(x - w / 2, feetY - h, w, h, w * 0.35);
    ctx.fill();

    ctx.fillStyle = '#f4d1ae';
    ctx.beginPath();
    ctx.arc(x, feetY - h - headR * 0.6, headR, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawHazard(h, m) {
    var cfg = h.cfg;

    // Static puke patch, flat on the promenade surface
    if (cfg.ground) {
      var d = depthOf(m);
      var s = spreadOf(d);
      var x = depthToX(promenadeLeft() + promenadeWidth() * h.u, d);
      var y = depthToY(d);
      var rx = cfg.width * 0.5 * s;

      ctx.fillStyle = cfg.colour;
      ctx.beginPath();
      ctx.ellipse(x, y, rx, rx * 0.34, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
      ctx.beginPath();
      ctx.ellipse(x - rx * 0.3, y + rx * 0.05, rx * 0.35, rx * 0.13, 0, 0, Math.PI * 2);
      ctx.ellipse(x + rx * 0.4, y - rx * 0.04, rx * 0.22, rx * 0.09, 0, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    // Group hazards: draw every member
    if (h.members) {
      for (var i = 0; i < h.members.length; i++) {
        var mem = h.members[i];
        var dm = m + mem.dz;
        if (dm > DRAW_DISTANCE || dm < bottomMetres()) continue;
        var dd = depthOf(dm);
        var ss = spreadOf(dd);
        var xx = depthToX(promenadeLeft() + promenadeWidth() * (h.u + mem.du), dd);
        var yy = depthToY(dd);
        var ww = cfg.width * ss;

        if (h.key === 'henParty') {
          // Petite, bouncing on their heels, white party sashes
          var bob = Math.abs(Math.sin(h.age * 6 + i * 1.9)) * 3 * ss;
          drawFigure(xx, yy - bob, ww, ww * 1.35, cfg.colour);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
          ctx.lineWidth = Math.max(1, ww * 0.14);
          ctx.beginPath();
          ctx.moveTo(xx - ww * 0.4, yy - bob - ww * 1.25);
          ctx.lineTo(xx + ww * 0.4, yy - bob - ww * 0.35);
          ctx.stroke();
        } else {
          // Drunk lads: stocky, square-shouldered, visibly swaying,
          // pint in hand
          var sway = Math.sin(h.age * 3.2 + i * 2.4) * 0.09;
          ctx.save();
          ctx.translate(xx, yy);
          ctx.rotate(sway);
          drawFigure(0, 0, ww * 1.1, ww * 1.15, cfg.colour);
          ctx.fillStyle = '#ffd166';
          ctx.fillRect(ww * 0.55, -ww * 0.95, ww * 0.22, ww * 0.3);
          ctx.restore();
        }
      }
      return;
    }

    var d2 = depthOf(m);
    var s2 = spreadOf(d2);
    var x2 = depthToX(promenadeLeft() + promenadeWidth() * h.u, d2);
    var y2 = depthToY(d2);
    var w2 = cfg.width * s2;

    if (h.key === 'scooter') {
      // Unmistakably a vehicle: chassis, wheels, steering column,
      // helmeted rider — wide and low
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.beginPath();
      ctx.ellipse(x2, y2, w2 * 0.65, w2 * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#2b2d42'; // wheels
      ctx.beginPath();
      ctx.arc(x2 - w2 * 0.38, y2 - w2 * 0.08, w2 * 0.14, 0, Math.PI * 2);
      ctx.arc(x2 + w2 * 0.38, y2 - w2 * 0.08, w2 * 0.14, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = cfg.colour; // chassis
      roundRect(x2 - w2 * 0.5, y2 - w2 * 0.42, w2, w2 * 0.3, w2 * 0.1);
      ctx.fill();

      ctx.strokeStyle = cfg.colour; // steering column + handlebar
      ctx.lineWidth = Math.max(2, w2 * 0.08);
      ctx.beginPath();
      ctx.moveTo(x2 - w2 * 0.34, y2 - w2 * 0.42);
      ctx.lineTo(x2 - w2 * 0.34, y2 - w2 * 0.95);
      ctx.moveTo(x2 - w2 * 0.5, y2 - w2 * 0.95);
      ctx.lineTo(x2 - w2 * 0.18, y2 - w2 * 0.95);
      ctx.stroke();

      ctx.fillStyle = cfg.colour; // seated rider
      roundRect(x2 - w2 * 0.02, y2 - w2 * 0.85, w2 * 0.32, w2 * 0.45, w2 * 0.1);
      ctx.fill();
      ctx.fillStyle = '#f4d1ae';
      ctx.beginPath();
      ctx.arc(x2 + w2 * 0.14, y2 - w2 * 0.97, w2 * 0.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2b2d42'; // helmet
      ctx.beginPath();
      ctx.arc(x2 + w2 * 0.14, y2 - w2 * 1.0, w2 * 0.15, Math.PI, 0);
      ctx.fill();
      return;
    }

    if (h.key === 'jogger') {
      // Tall, thin, leaning hard into the run, white headband
      ctx.save();
      ctx.translate(x2, y2);
      ctx.rotate(-0.16);
      drawFigure(0, 0, w2, w2 * 2.3, cfg.colour);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-w2 * 0.4, -w2 * 2.3 - w2 * 0.62, w2 * 0.8, w2 * 0.16);
      ctx.restore();
      return;
    }

    if (h.key === 'performer') {
      // Wide-brimmed hat, arms out frozen mid-act, pitch cone beside
      drawFigure(x2, y2, w2, w2 * 1.4, cfg.colour);
      ctx.strokeStyle = cfg.colour; // outstretched arms
      ctx.lineWidth = Math.max(2, w2 * 0.14);
      ctx.beginPath();
      ctx.moveTo(x2 - w2 * 0.95, y2 - w2 * 1.35);
      ctx.lineTo(x2 + w2 * 0.95, y2 - w2 * 1.35);
      ctx.stroke();
      ctx.fillStyle = '#2b2d42'; // hat brim
      ctx.beginPath();
      ctx.ellipse(x2, y2 - w2 * 1.4 - w2 * 0.55, w2 * 0.55, w2 * 0.14, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffd166'; // pitch cone
      ctx.beginPath();
      ctx.moveTo(x2 + w2 * 1.1, y2);
      ctx.lineTo(x2 + w2 * 1.5, y2);
      ctx.lineTo(x2 + w2 * 1.3, y2 - w2 * 0.6);
      ctx.closePath();
      ctx.fill();
      return;
    }

    // Pedestrian: the plain, unhurried default — round body, flat cap
    drawFigure(x2, y2, w2, w2 * 1.5, cfg.colour);
    ctx.fillStyle = '#5a4a3a';
    ctx.beginPath();
    ctx.arc(x2, y2 - w2 * 1.5 - w2 * 0.38, w2 * 0.42, Math.PI, 0);
    ctx.fill();
  }

  function drawScenery(it, m) {
    var cfg = it.cfg;
    var d = depthOf(m);
    var s = spreadOf(d);
    var x = depthToX(promenadeLeft() + promenadeWidth() * it.u, d);
    var y = depthToY(d);
    var w = cfg.width * s;

    if (it.key === 'palm') {
      var trunkH = w * 2.4;
      var top = y - trunkH;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.beginPath();
      ctx.ellipse(x, y, w * 0.45, w * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();

      // Trunk, tapering toward the top
      ctx.fillStyle = '#8b5a2b';
      ctx.beginPath();
      ctx.moveTo(x - w * 0.14, y);
      ctx.lineTo(x + w * 0.14, y);
      ctx.lineTo(x + w * 0.07, top);
      ctx.lineTo(x - w * 0.07, top);
      ctx.closePath();
      ctx.fill();

      // Fronds fanning out from the crown
      ctx.fillStyle = '#3aa060';
      var angles = [-1.25, -0.65, 0, 0.65, 1.25];
      for (var a = 0; a < angles.length; a++) {
        var ang = angles[a];
        ctx.beginPath();
        ctx.ellipse(
          x + Math.sin(ang) * w * 0.55,
          top - Math.cos(ang) * w * 0.3,
          w * 0.6, w * 0.19, ang, 0, Math.PI * 2
        );
        ctx.fill();
      }
      ctx.fillStyle = '#2c7a49'; // crown centre
      ctx.beginPath();
      ctx.arc(x, top, w * 0.16, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    // Bench: dual-sided promenade bench, drawn with genuine front-to-back
    // length receding toward the horizon — near and far ends are each
    // projected through their own depth (same technique as the ledge
    // steps and kerb lines), so the seats and backrest are true 3D
    // planks rather than a flat cutout facing the camera.
    var lenM = 1.8;                 // physical length along the route
    var dNear = depthOf(m - lenM / 2);
    var dFar = depthOf(m + lenM / 2);
    var yNear = depthToY(dNear);
    var yFar = depthToY(dFar);
    var sNear = spreadOf(dNear);
    var sFar = spreadOf(dFar);
    var centreAtPlayer = promenadeLeft() + promenadeWidth() * it.u;
    var xNear = depthToX(centreAtPlayer, dNear);
    var xFar = depthToX(centreAtPlayer, dFar);

    var seatOff = cfg.width * 0.5;  // centre to outer seat edge
    var backOff = cfg.width * 0.06; // backrest half-thickness
    var legOff = cfg.width * 0.36;  // centre to leg position
    var legW = cfg.width * 0.07;
    var seatH = cfg.width * 0.16;   // seat height above the ground
    var backH = cfg.width * 0.6;    // backrest height above the seat

    // Shadow footprint — bigger at the near end, same recession cue
    // every other piece of scenery uses
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.beginPath();
    ctx.ellipse(xNear, yNear, seatOff * sNear * 1.05, seatOff * sNear * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Legs at both ends, both sides — smaller and higher toward the horizon
    ctx.fillStyle = '#3d2c20';
    ctx.fillRect(xFar - legOff * sFar - legW * sFar / 2, yFar, legW * sFar, -seatH * sFar);
    ctx.fillRect(xFar + legOff * sFar - legW * sFar / 2, yFar, legW * sFar, -seatH * sFar);
    ctx.fillRect(xNear - legOff * sNear - legW * sNear / 2, yNear, legW * sNear, -seatH * sNear);
    ctx.fillRect(xNear + legOff * sNear - legW * sNear / 2, yNear, legW * sNear, -seatH * sNear);

    // Two seat planks flanking the backrest — one facing the beach, one
    // facing the promenade — each a quad running from the near end to
    // the far end so it visibly recedes rather than sitting flat
    ctx.fillStyle = '#a0623a';
    var sides = [-1, 1];
    for (var si = 0; si < sides.length; si++) {
      var sd = sides[si];
      ctx.beginPath();
      ctx.moveTo(xNear + sd * seatOff * sNear, yNear - seatH * sNear);
      ctx.lineTo(xNear + sd * backOff * sNear, yNear - seatH * sNear);
      ctx.lineTo(xFar + sd * backOff * sFar, yFar - seatH * sFar);
      ctx.lineTo(xFar + sd * seatOff * sFar, yFar - seatH * sFar);
      ctx.closePath();
      ctx.fill();
    }

    // Shared central backrest, a panel running the same near-to-far length
    ctx.fillStyle = '#7d4b2b';
    ctx.beginPath();
    ctx.moveTo(xNear, yNear - seatH * sNear);
    ctx.lineTo(xNear, yNear - (seatH + backH) * sNear);
    ctx.lineTo(xFar, yFar - (seatH + backH) * sFar);
    ctx.lineTo(xFar, yFar - seatH * sFar);
    ctx.closePath();
    ctx.fill();

    // Top rail cap along the backrest, tapering toward the horizon
    ctx.fillStyle = '#5c3820';
    ctx.beginPath();
    ctx.moveTo(xNear - backOff * 1.8 * sNear, yNear - (seatH + backH) * sNear);
    ctx.lineTo(xNear + backOff * 1.8 * sNear, yNear - (seatH + backH) * sNear);
    ctx.lineTo(xFar + backOff * 1.8 * sFar, yFar - (seatH + backH) * sFar);
    ctx.lineTo(xFar - backOff * 1.8 * sFar, yFar - (seatH + backH) * sFar);
    ctx.closePath();
    ctx.fill();
  }

  // Hazards and fixed scenery drawn together, far-to-near so overlaps
  // stack correctly; split around the player's depth so passed objects
  // draw over them.
  function drawWorldObjects(behindPlayer) {
    var items = sceneryItems();
    for (var i = 0; i < hazards.length; i++) items.push(hazards[i]);
    items.sort(function (a, b) { return b.worldZ - a.worldZ; });

    for (var j = 0; j < items.length; j++) {
      var m = items[j].worldZ - distance;
      if (m > DRAW_DISTANCE) continue;
      if (behindPlayer ? m >= 0 : m < 0) continue;
      if (items[j].scenery) drawScenery(items[j], m);
      else drawHazard(items[j], m);
    }
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
    frameNow = time;

    if (state === STATE_WALKING) {
      distance += WALK_SPEED * dt;
      elapsed += dt;
      updateHazards(dt);
      if (distance >= RUN_DISTANCE) {
        distance = RUN_DISTANCE;
        finishRun();
      }
    }

    updatePlayer(dt);

    // Screen shake after a stumble — the whole scene judders briefly
    var shaking = time < shakeUntil;
    if (shaking) {
      ctx.save();
      ctx.translate((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6);
    }

    // Sky and side fills share the page background colour
    ctx.fillStyle = '#0a1628';
    ctx.fillRect(-8, -8, W + 16, H + 16);

    drawSky();
    drawBeach();
    drawLedge();
    drawPromenade();
    drawBuildings();

    drawWorldObjects(false); // still ahead of the player
    if (state !== STATE_TITLE) drawPlayer(time);
    drawWorldObjects(true);  // already passed, closer to the camera

    if (shaking) ctx.restore();

    if (state !== STATE_TITLE) {
      drawHUD();
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
