(function () {
  'use strict';

  var VERSION = '0.11.0';

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
  var HORIZON_FRAC = 0.40;       // horizon line as a fraction of screen height
  var PLAYER_Y_FRAC = 0.80;      // the avatar's neutral screen height
  var FOOTER_H = 128;            // bottom control zone: joystick + squad row
  var FOLLOW_RATE = 12;          // drag smoothing, higher = snappier follow
  var KEY_SPEED = 1.2;           // held arrow key speed, promenade widths/sec

  // ---------------------------------------------------------------------
  // Canvas
  // ---------------------------------------------------------------------
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var W = 0;                     // CSS pixel width
  var H = 0;                     // CSS pixel height
  var safeTop = 0;               // device status bar / notch inset, CSS px

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // env(safe-area-inset-top) via the hidden probe element — non-zero on
    // notched iPhones (Safari tab and installed PWA), zero elsewhere
    var probe = document.getElementById('safe-probe');
    safeTop = probe ? (parseFloat(getComputedStyle(probe).paddingTop) || 0) : 0;
  }

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
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
    // Raised from the old 0.89 to free the bottom of the screen for the
    // joystick zone; the horizon came up with it so the view is intact
    return H * PLAYER_Y_FRAC;
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

  // The gameplay view ends here; below is the control footer.
  function gameBottom() {
    return H - FOOTER_H;
  }

  // Depth of the bottom edge of the gameplay view (just behind the player).
  function bottomDepth() {
    return (gameBottom() - horizonY()) / (playerY() - horizonY());
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
  var playerV = 0.5;         // vertical position in the movement band, 0..1
  var targetV = 0.5;         // where vertical input wants the player
  var lastTime = 0;
  var frameNow = 0;          // current rAF timestamp, ms
  var paused = false;        // photo overlay showing — world frozen

  // Collision effect timers (rAF-clock ms) and skid state
  var invulnUntil = 0;       // no repeat hits while this is in the future
  var shakeUntil = 0;        // screen shake window after a stumble
  var shakeAmp = 6;          // shake violence: stumbles rattle, tumbles jolt
  var flashUntil = 0;        // player flash window after a stumble
  var skidUntil = 0;         // control lost while sliding on puke
  var skidVel = 0;           // sideways slip, promenade-widths per second

  // ---------------------------------------------------------------------
  // Tiki Tumble — pushing over the sea-wall lip drops you ~2ft onto the
  // beach. It stings (heavy time penalty, hard jolt) but never ends the
  // run: the player clambers back onto the promenade.
  // ---------------------------------------------------------------------
  var TUMBLE_MS = 900;         // how long the fall + clamber takes
  var TUMBLE_PENALTY = 5;      // seconds added to the run clock
  var TUMBLE_PRESS_S = 0.35;   // how long to push into the edge to go over
  var tumbleUntil = 0;
  var tumbleCount = 0;         // tumbles this run ("survived" = finish after)
  var wallPressT = 0;

  function triggerTumble() {
    wallPressT = 0;
    tumbleCount += 1;
    tumbleUntil = frameNow + TUMBLE_MS;
    invulnUntil = frameNow + TUMBLE_MS + 1200;
    shakeUntil = frameNow + 750;
    shakeAmp = 14; // a real drop, not a soft landing
    flashUntil = frameNow + TUMBLE_MS;
    elapsed += TUMBLE_PENALTY;
    streak = 0;
    // Recover a step in from the edge (the fall animation plays over it)
    playerU = 0.07;
    targetU = 0.07;
    notify('TIKI TUMBLE! +' + TUMBLE_PENALTY + 's', 3200);
  }

  // ---------------------------------------------------------------------
  // Squad composition — set by the start screen's character selection.
  // The flags below are now driven by the actual selection rather than
  // hardcoded. (Full Firefly avatars and a proper "playing as" picker
  // come in Phase 4; until then, Lee in the squad = Lee flavour.)
  // ---------------------------------------------------------------------
  var SQUAD_HAS_ADAM = false;  // true when Adam is picked into the squad
  var PLAYING_AS_LEE = false;  // true when Lee is picked into the squad

  var MATE_ROSTER = {
    adam:  { name: 'Adam',  colour: '#4d96ff' },
    lee:   { name: 'Lee',   colour: '#7fd069' },
    robby: { name: 'Robby', colour: '#f77f00' },
    steve: { name: 'Steve', colour: '#25ced1' },
  };

  var mateSel = { adam: false, lee: false, robby: false, steve: false };
  var squad = [];              // this run's mates: {key, name, colour, lost}
  var SQUAD_WIDTH_PER_MATE = 0.30; // extra collision width per linked mate

  function matesAlive() {
    var n = 0;
    for (var i = 0; i < squad.length; i++) if (!squad[i].lost) n++;
    return n;
  }

  // A mate takes the hit and retires to a bench; the group narrows.
  // The last remaining walker is never removed — solo stumbles only.
  function loseMate() {
    for (var i = squad.length - 1; i >= 0; i--) {
      if (!squad[i].lost) {
        squad[i].lost = true;
        notify(squad[i].name + ' sits this one out on a bench');
        return;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Score, streaks, and carried items
  // ---------------------------------------------------------------------
  var NEAR_MISS_PX = 26;       // extra margin beyond a hit that counts as close
  var NEAR_MISS_POINTS = 25;
  var DODGE_POINTS = 10;       // per hazard survived, scaled by the streak
  var LOOKY_POINTS = 100;
  var CHAT_MULT = 2;           // positive hen contact: points multiplier...
  var CHAT_MULT_MS = 15000;    // ...for this long
  var BRIDE_POINTS = 250;      // flat bonus for delivering the bride's rose
  var SWAGGER_CHAT = 1;        // drunk meter relief from a hen party bonus
  var SWAGGER_SUPER = 2.5;     // ...with the rose delivered to the bride
  var SWAGGER_LOOKY = 0.5;     // ...from a looky looky man
  var ADAM_INVULN_MS = 5000;   // shark-has-fed invincibility window

  var score = 0;
  var streak = 0;              // consecutive hazards survived since a stumble
  var multUntil = 0;           // hen-bonus points multiplier active until (ms)
  var roses = 0;               // carried roses from the rose seller

  // Wares bought from the looky looky men this run — each one appears on
  // every avatar in the squad row when collected
  var squadItems = { shades: false, hat: false, chain: false };

  // Achievements — simple local store for now (no Firestore yet).
  // Persists across runs within the session, never reset by resetRun.
  var achievements = {};

  var noticeText = '';
  var noticeUntil = 0;

  function notify(text, ms) {
    noticeText = text;
    noticeUntil = frameNow + (ms || 2600);
  }

  function unlockAchievement(id, label) {
    if (achievements[id]) return;
    achievements[id] = true;
    notify('ACHIEVEMENT: ' + label);
  }

  function scoreMult() {
    return frameNow < multUntil ? CHAT_MULT : 1;
  }

  function addScore(points) {
    score += Math.round(points * scoreMult());
  }

  var startScreen = document.getElementById('start-screen');
  var endScreen = document.getElementById('end-screen');
  var endTitleEl = document.getElementById('end-title');
  var endTimeEl = document.getElementById('end-time');
  var endScoreEl = document.getElementById('end-score');
  var versionEl = document.getElementById('version');
  var walkAgainBtn = document.getElementById('walk-again');

  versionEl.textContent = 'v' + VERSION;

  // Player centre x in CSS pixels at the player's depth.
  function playerScreenX() {
    return promenadeLeft() + promenadeWidth() * playerU;
  }

  // The player sprite's own body width
  function playerBodyW() {
    return Math.min(promenadeWidth() * 0.14, 46);
  }

  // Effective collision width: the whole arm-in-arm group. Wider squads
  // make every gap tighter; losing mates narrows it back down.
  function playerWidth() {
    return playerBodyW() * (1 + SQUAD_WIDTH_PER_MATE * matesAlive());
  }

  // ---------------------------------------------------------------------
  // Vertical movement — the avatar moves in a screen band as well as
  // sideways. Standing at (or above) the neutral line walks forward at
  // full speed; pulling down toward the bottom of the band slows and
  // then reverses the walk, letting the player deliberately drop back
  // (hazards keep approaching at their own pace regardless).
  // ---------------------------------------------------------------------
  var BAND_TOP_FRAC = 0.62;    // furthest forward the avatar can stand
  var BAND_BOTTOM_FRAC = 0.84; // furthest back
  var BACK_SPEED = 4;          // m/s walked backward at a full pull

  function neutralV() {
    return (PLAYER_Y_FRAC - BAND_TOP_FRAC) / (BAND_BOTTOM_FRAC - BAND_TOP_FRAC);
  }

  function avatarY() {
    return H * (BAND_TOP_FRAC + (BAND_BOTTOM_FRAC - BAND_TOP_FRAC) * playerV);
  }

  // Forward rate in m/s given the avatar's band position
  function walkRate() {
    var n = neutralV();
    if (playerV <= n) return WALK_SPEED;
    var f = (playerV - n) / (1 - n);
    return WALK_SPEED - (WALK_SPEED + BACK_SPEED) * f;
  }

  // The avatar's depth offset in metres from the reference plane (m = 0),
  // so collisions happen where the avatar actually stands.
  function playerM() {
    var dA = (avatarY() - horizonY()) / (playerY() - horizonY());
    return PERSPECTIVE * (Math.pow(dA, -1 / DEPTH_CURVE) - 1);
  }

  function resetRun() {
    distance = 0;
    elapsed = 0;
    playerU = 0.5;
    targetU = 0.5;
    playerV = neutralV();
    targetV = neutralV();
    hazards.length = 0;
    spawnTimer = 0.02; // and keep spawning from the very first frame
    pickups.length = 0;
    pickupTimer = 3;
    drunk = DRUNK_START;
    inputLog.length = 0;
    score = 0;
    streak = 0;
    multUntil = 0;
    roses = 0;
    squadItems.shades = false;
    squadItems.hat = false;
    squadItems.chain = false;
    selfieUsed = {};
    paused = false;
    noticeUntil = 0;
    roseSellerSpawned = false;
    joyId = null;
    joyDX = 0;
    joyDY = 0;
    tumbleUntil = 0;
    tumbleCount = 0;
    wallPressT = 0;
    shakeAmp = 6;

    // Build this run's squad from the start-screen selection and drive
    // the character flags from actual composition
    squad = [];
    for (var mk in MATE_ROSTER) {
      if (mateSel[mk]) {
        squad.push({
          key: mk,
          name: MATE_ROSTER[mk].name,
          colour: MATE_ROSTER[mk].colour,
          lost: false,
        });
      }
    }
    SQUAD_HAS_ADAM = !!mateSel.adam;
    PLAYING_AS_LEE = !!mateSel.lee;

    hidePhotoOverlay();

    // Pre-populate the corridor so the run starts as busy as it plays:
    // hazards spawn 25-110m out and take time to arrive, so an empty
    // start would otherwise stay empty for the first ~40m.
    for (var i = 0; i < 8; i++) {
      spawnHazard(10 + i * 10 + Math.random() * 6);
    }
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

  // ---------------------------------------------------------------------
  // The finish — and the chip shop just past it. Walking into Daytona at
  // 400m ends the run as normal; hugging the building side and pressing
  // on to the doorway beyond instead buys everyone chips. No hints.
  // ---------------------------------------------------------------------
  var CHIP_EXTRA_M = 12;       // the shop sits this far past Daytona
  var CHIP_LANE_U = 0.78;      // stay right of this to walk on past
  var CHIP_DOOR_U = 0.9;       // the doorway itself
  var CHIP_POINTS = 750;

  function chipShopZ() {
    return RUN_DISTANCE + CHIP_EXTRA_M;
  }

  function checkFinish() {
    if (distance < RUN_DISTANCE) return;
    if (distance >= chipShopZ()) {
      // Reached the shop's depth: through the door, or shrug and finish
      finishRun(playerU > CHIP_LANE_U);
    } else if (playerU <= CHIP_LANE_U) {
      // Anywhere but the far right at Daytona = the normal finish
      finishRun(false);
    }
    // else: hugging the building side — keep walking past Daytona
  }

  function finishRun(boughtChips) {
    state = STATE_DONE;

    if (boughtChips) addScore(CHIP_POINTS);

    // Squad payout: bigger starting squads score more, and bringing
    // every mate home intact is worth celebrating
    if (squad.length > 0) {
      score = Math.round(score * (1 + 0.15 * squad.length));
      if (matesAlive() === squad.length) {
        score += 250 * squad.length;
        unlockAchievement('nobodyLeftBehind', 'Nobody Left Behind');
      }
    }

    if (tumbleCount > 0) {
      unlockAchievement('tikiTumbleSurvivor', 'Tiki Tumble Survivor');
    }

    endTitleEl.innerHTML = boughtChips
      ? 'BOUGHT EVERYONE<br>CHIPS'
      : 'YOU MADE IT<br>TO DAYTONA';
    endTimeEl.textContent = elapsed.toFixed(1) + 's';
    endScoreEl.textContent = score + ' PTS';
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

  function updatePlayer(dt) {
    if (paused) return;

    // Mid-tumble: no control while falling off the ledge
    if (frameNow < tumbleUntil) return;

    // Skidding on puke: the player slips sideways with no control until
    // the skid window ends, then resumes from wherever they ended up.
    if (frameNow < skidUntil) {
      playerU = clamp01(playerU + skidVel * dt);
      skidVel *= Math.pow(0.02, dt); // slide dies away quickly
      targetU = playerU;
      return;
    }

    // Leaning into the sea-wall lip: keep pushing and over you go
    if (state === STATE_WALKING && playerU < 0.012 &&
        (joyDX < -0.5 || leftHeld)) {
      wallPressT += dt;
      if (wallPressT >= TUMBLE_PRESS_S) {
        triggerTumble();
        return;
      }
    } else {
      wallPressT = 0;
    }

    // Held arrow keys steer the target at a constant speed
    var dir = (rightHeld ? 1 : 0) - (leftHeld ? 1 : 0);
    if (dir !== 0 && canMove()) {
      targetU = clamp01(targetU + dir * KEY_SPEED * dt);
    }
    var vdir = (downHeld ? 1 : 0) - (upHeld ? 1 : 0);
    if (vdir !== 0 && canMove()) {
      targetV = clamp01(targetV + vdir * KEY_SPEED * dt);
    }

    // The joystick steers analog-style: deflection direction and
    // magnitude set the movement velocity on both axes together
    if (canMove() && (joyDX !== 0 || joyDY !== 0)) {
      targetU = clamp01(targetU + joyDX * JOY_RATE * dt);
      targetV = clamp01(targetV + joyDY * JOY_RATE * dt);
    }

    // Vertical follows its target with the same easing; drunk lag and
    // sway stay horizontal-only.
    var vEase = 1 - Math.exp(-FOLLOW_RATE * dt);
    playerV = clamp01(playerV + (targetV - playerV) * vEase);

    // Record raw input; the avatar responds to a delayed copy of it,
    // the delay growing with the drunk meter (input lag).
    inputLog.push({ t: frameNow, u: targetU });
    while (inputLog.length > 1 && inputLog[0].t < frameNow - 3000) {
      inputLog.shift();
    }

    // Involuntary sway layers on top of the (lagged) input — the player
    // fights the drift, they aren't locked out by it.
    var goal = laggedTargetU();
    if (state === STATE_WALKING && drunk > 0) {
      goal = clamp01(goal + swayOffset());
    }

    // Ease toward the goal — light smoothing, no instant snap
    var ease = 1 - Math.exp(-FOLLOW_RATE * dt);
    playerU = clamp01(playerU + (goal - playerU) * ease);
  }

  // The raw target as the avatar perceives it: the input sample from
  // (drunkFactor × LAG_MAX_MS) milliseconds ago.
  function laggedTargetU() {
    var lagMs = drunkFactor() * LAG_MAX_MS;
    if (lagMs <= 0 || inputLog.length === 0) return targetU;
    var cutoff = frameNow - lagMs;
    var u = inputLog[0].u; // input older than the whole log: use oldest
    for (var i = inputLog.length - 1; i >= 0; i--) {
      if (inputLog[i].t <= cutoff) {
        u = inputLog[i].u;
        break;
      }
    }
    return u;
  }

  // Side-to-side drift that grows in amplitude and frequency along the
  // drunk curve, capped at the *_MAX severity. Two offset sine waves so
  // it feels organic, not metronomic.
  function swayOffset() {
    var t = frameNow / 1000;
    var f = drunkFactor();
    var freq = SWAY_FREQ_BASE + (SWAY_FREQ_MAX - SWAY_FREQ_BASE) * f;
    return SWAY_AMP_MAX * f * (
      Math.sin(Math.PI * 2 * freq * t) +
      0.5 * Math.sin(Math.PI * 2 * freq * 1.7 * t + 1.3)
    );
  }

  // ---------------------------------------------------------------------
  // Input — a fixed virtual joystick in the bottom corner (left or right
  // hand, chosen on the start screen), so the player's thumb never
  // covers the play area. Analog: the nub's direction and distance from
  // centre set movement direction and intensity on both axes. Held
  // arrow keys remain for desktop testing.
  // ---------------------------------------------------------------------
  var JOY_BASE_R = 52;   // visual base radius, also full-deflection range
  var JOY_NUB_R = 22;    // draggable nub radius
  var JOY_ZONE_R = 110;  // touches this close to the base grab the stick
  var JOY_RATE = 1.6;    // widths (or band-heights) per second at full tilt

  var joySide = 'right'; // set by the start screen handedness choice
  var joyId = null;      // identifier of the finger on the stick
  var joyDX = 0;         // deflection, -1..1
  var joyDY = 0;

  var leftHeld = false;
  var rightHeld = false;
  var upHeld = false;
  var downHeld = false;

  function joyCentre() {
    return {
      x: joySide === 'left' ? 74 : W - 74,
      y: H - 74,
    };
  }

  function setJoyVector(t) {
    var c = joyCentre();
    var dx = (t.clientX - c.x) / JOY_BASE_R;
    var dy = (t.clientY - c.y) / JOY_BASE_R;
    var mag = Math.sqrt(dx * dx + dy * dy);
    if (mag > 1) {
      dx /= mag;
      dy /= mag;
    }
    joyDX = dx;
    joyDY = dy;
  }

  document.addEventListener('touchstart', function (e) {
    if (!canMove() || paused || joyId !== null) return;
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var c = joyCentre();
      var dx = t.clientX - c.x;
      var dy = t.clientY - c.y;
      if (dx * dx + dy * dy <= JOY_ZONE_R * JOY_ZONE_R) {
        joyId = t.identifier;
        setJoyVector(t);
        break;
      }
    }
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (joyId === null || paused) return;
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (t.identifier !== joyId) continue;
      setJoyVector(t);
      if (state === STATE_READY &&
          (Math.abs(joyDX) > 0.15 || Math.abs(joyDY) > 0.15)) {
        startWalking(); // first movement starts the run
      }
      break;
    }
  }, { passive: true });

  function releaseJoy(e) {
    if (joyId === null) return;
    for (var i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === joyId) {
        joyId = null;
        joyDX = 0;
        joyDY = 0;
        break;
      }
    }
  }

  document.addEventListener('touchend', releaseJoy, { passive: true });
  document.addEventListener('touchcancel', releaseJoy, { passive: true });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      leftHeld = true;
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      rightHeld = true;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      upHeld = true;
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      downHeld = true;
    } else {
      return;
    }
    if (state === STATE_READY) startWalking(); // first movement starts the run
  });

  document.addEventListener('keyup', function (e) {
    if (e.key === 'ArrowLeft') leftHeld = false;
    else if (e.key === 'ArrowRight') rightHeld = false;
    else if (e.key === 'ArrowUp') upHeld = false;
    else if (e.key === 'ArrowDown') downHeld = false;
  });

  window.addEventListener('blur', function () {
    leftHeld = false;
    rightHeld = false;
    upHeld = false;
    downHeld = false;
    dragging = false;
  });

  // Handedness pick doubles as the start button; a plain tap anywhere
  // else on the start screen keeps working (defaults right-handed).
  function beginRun(side) {
    if (state !== STATE_TITLE) return;
    if (side) joySide = side;
    startScreen.classList.add('hidden');
    resetRun();
  }

  startScreen.addEventListener('click', function () {
    beginRun(null);
  });

  var handLeftBtn = document.getElementById('hand-left');
  var handRightBtn = document.getElementById('hand-right');
  if (handLeftBtn) {
    handLeftBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      beginRun('left');
    });
  }
  if (handRightBtn) {
    handRightBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      beginRun('right');
    });
  }

  // Squad picker chips — toggle mates in and out before starting
  for (var mateKey in MATE_ROSTER) {
    (function (mk) {
      var btn = document.getElementById('mate-' + mk);
      if (!btn) return;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        mateSel[mk] = !mateSel[mk];
        btn.classList.toggle('on', mateSel[mk]);
      });
    })(mateKey);
  }

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

  // ---------------------------------------------------------------------
  // Pickups and the drunk meter — the signature mechanic. Data-driven
  // like hazards: a future power-up (water, coffee, kebab) is one entry
  // here with its own `drunk` delta (negative to sober up), not new
  // logic. Pickups sit on the promenade and are collected by walking
  // into them — no penalty, no stumble.
  //
  //   spawn   [nearest, furthest] metres ahead to appear at
  //   width   collection + draw width in px at the player's depth
  //   drunk   change to the drunk meter on collection
  //   weight  relative spawn frequency (matters once there are more)
  //   colour  placeholder silhouette colour
  // ---------------------------------------------------------------------
  var PICKUP_TYPES = {
    beer: { spawn: [45, 80], width: 20, drunk: 1, weight: 1, colour: '#ffc233' },
  };

  var PICKUP_INTERVAL_MIN = 5.5;  // seconds between pickup spawns
  var PICKUP_INTERVAL_MAX = 8.5;

  // Drunk tuning — deliberately surfaced as constants for playtesting.
  // Effects ramp along a controlled curve from sober to the cap and
  // never exceed it: the *_MAX values are the old 4-beer severity, now
  // the hardest the game ever gets, and DRUNK_CURVE shapes the climb
  // (>1 = the first beers are gentle steps, later ones bigger ones).
  var DRUNK_START = 1;            // baseline tipsiness leaving Tiki Beach
  var DRUNK_EFFECT_CAP = 4;       // beers at which effects max out
  var DRUNK_CURVE = 1.5;          // exponent shaping the 0..cap ramp
  var LAG_MAX_MS = 220;           // input lag at the cap
  var SWAY_AMP_MAX = 0.028;       // sway amplitude at the cap, promenade-widths
  var SWAY_FREQ_BASE = 0.4;       // sway cycles per second when barely drunk
  var SWAY_FREQ_MAX = 0.56;       // sway frequency at the cap

  // 0 sober -> 1 at the cap, eased so early beers are small steps;
  // beers past the cap change nothing but the meter.
  function drunkFactor() {
    var f = Math.min(drunk, DRUNK_EFFECT_CAP) / DRUNK_EFFECT_CAP;
    return Math.pow(f, DRUNK_CURVE);
  }
  var DRUNK_METER_MAX = 8;        // meter display cap (value itself is uncapped)

  var pickups = [];
  var pickupTimer = 3;
  var drunk = 0;                  // 0 = sober, +1 per beer
  var inputLog = [];              // recent {t, u} raw input samples for lag

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

  function weightedPick(types) {
    var total = 0;
    var key;
    var last = null;
    for (key in types) total += types[key].weight;
    var r = Math.random() * total;
    for (key in types) {
      last = key;
      r -= types[key].weight;
      if (r <= 0) return key;
    }
    return last;
  }

  // Spawn a hazard in its type's usual window ahead, or at an explicit
  // distance / forced type (used for run-start prefill and the
  // guaranteed rose seller).
  function spawnHazard(metresAhead, forceKey, forceVariant) {
    var key = forceKey || weightedPick(HAZARD_TYPES);
    var cfg = HAZARD_TYPES[key];
    var h = {
      key: key,
      cfg: cfg,
      worldZ: distance + (metresAhead !== undefined ? metresAhead :
        cfg.spawn[0] + Math.random() * (cfg.spawn[1] - cfg.spawn[0])),
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

    // Street performers come in flavours: the plain act, the rose
    // seller, and the looky looky men (three different wares)
    if (key === 'performer') {
      var roll = Math.random();
      h.variant = forceVariant ||
        (roll < 0.4 ? 'plain' : (roll < 0.65 ? 'roseSeller' : 'lookyMan'));
      if (h.variant === 'lookyMan') {
        var wares = ['shades', 'hat', 'chain'];
        h.wares = wares[Math.floor(Math.random() * wares.length)];
      }
    }

    // Some hen parties have the bride out with them — a bonus contact
    // rather than a hazard (see henBonus)
    if (key === 'henParty') {
      h.bride = Math.random() < 0.35;
    }

    hazards.push(h);
  }

  // The rose seller is guaranteed once, early-to-mid route, so there is
  // always time left to deliver the rose — random spawns alone left her
  // appearing too late (or never) in most runs.
  var ROSE_SELLER_AT = 70; // metres walked when she is placed ahead
  var roseSellerSpawned = false;

  function ensureRoseSeller() {
    if (roseSellerSpawned || distance < ROSE_SELLER_AT) return;
    roseSellerSpawned = true;
    spawnHazard(30 + Math.random() * 10, 'performer', 'roseSeller');
  }

  // Signed clearance in px between the player's body edge and a hazard
  // edge at position u: <= 0 means overlapping (a hit).
  function playerGapTo(u, widthPx) {
    var hx = promenadeLeft() + promenadeWidth() * u;
    return Math.abs(hx - playerScreenX()) -
      (playerWidth() + widthPx) * 0.5 * 0.8; // slight forgiveness
  }

  // Overlap test at the player's depth between the player's body and a
  // point at position u with the given width (px at player depth).
  function overlapsPlayer(u, widthPx) {
    return playerGapTo(u, widthPx) <= 0;
  }

  function triggerStumble(cfg) {
    invulnUntil = frameNow + STUMBLE_INVULN_MS;
    shakeUntil = frameNow + STUMBLE_SHAKE_MS;
    shakeAmp = 6;
    flashUntil = frameNow + STUMBLE_FLASH_MS;
    elapsed += cfg.penalty; // time penalty straight onto the run clock
    streak = 0;             // a real collision breaks the dodge streak

    // A significant collision costs the group a mate; the last walker
    // is never removed — they just stumble like always
    if (matesAlive() > 0) loseMate();
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
    ensureRoseSeller();

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
      var mA = m - playerM(); // depth relative to where the avatar stands

      // Cleanup: fully past the player, or drifted off the promenade
      if (m < bottomMetres() - 2 || h.u < -0.05 || h.u > 1.05) {
        hazards.splice(i, 1);
        continue;
      }

      // Collisions, checked at the avatar's actual depth
      if (cfg.ground) {
        if (!h.hit && frameNow >= skidUntil &&
            Math.abs(mA) < 1.0 && overlapsPlayer(h.u, cfg.width)) {
          triggerSkid(h);
        }
      } else if (!h.harmless) {
        var collided = false;
        if (h.members) {
          for (var j = 0; j < h.members.length; j++) {
            var mem = h.members[j];
            if (Math.abs(mA + mem.dz) < 0.6 &&
                overlapsPlayer(h.u + mem.du, cfg.width)) {
              collided = true;
              break;
            }
          }
        } else if (Math.abs(mA) < 0.6 &&
                   overlapsPlayer(h.u, cfg.width *
                     (h.variant === 'roseSeller' || h.variant === 'lookyMan'
                       ? 1.6 : 1))) {
          // Vendors get a friendlier catch radius — walking roughly into
          // them should reliably collect, they're rewards not hazards
          collided = true;
        }

        if (collided) {
          // Rewarding contacts deliberately ignore the post-stumble
          // invulnerability window — only the stumble itself is gated
          if (h.variant === 'roseSeller') collectRose(h);
          else if (h.variant === 'lookyMan') collectWares(h);
          else if (h.key === 'henParty' && (h.bride || roses > 0)) henBonus(h);
          else if (h.key === 'drunkLads' && roses > 0) shareRoses(h);
          else if (frameNow >= invulnUntil) {
            triggerStumble(cfg);
            h.hitPlayer = true;
          }
        }
      }

      checkPassed(h, mA);
    }

    // Fixed scenery collides like any stationary hazard: a stumble
    if (frameNow >= invulnUntil) {
      var items = sceneryItems();
      for (var si = 0; si < items.length; si++) {
        var it = items[si];
        var sm = it.worldZ - distance - playerM();
        if (Math.abs(sm) < 0.7 &&
            overlapsPlayer(it.u, it.cfg.width * it.cfg.hit)) {
          triggerStumble(it.cfg);
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Vendors — rose seller and looky looky man (performer variants).
  // Colliding with them rewards instead of stumbling.
  // ---------------------------------------------------------------------
  function collectRose(h) {
    h.harmless = true; // sold out — she won't trip you afterwards
    if (PLAYING_AS_LEE) {
      // TEMP Lee flavour until Phase 4 character select
      showPhotoOverlay({
        caption: 'Lee eats a rose... turns out they’re out of order. ' +
                 'Buying the lot!',
        colour: '#b23a48',
      });
    }
    roses += 1;
    notify('ROSE COLLECTED — you are carrying a rose', 4200);
  }

  // The looky looky men: contact instantly buys their wares — swagger,
  // points, and the item appears on every avatar in the squad row. No
  // cutscene: the squad row updating live IS the reward.
  function collectWares(h) {
    h.harmless = true;
    drunk = Math.max(0, drunk - SWAGGER_LOOKY);
    addScore(LOOKY_POINTS);
    squadItems[h.wares] = true;
    if (h.wares === 'shades') unlockAchievement('shadyBusiness', 'Shady Business');
    else if (h.wares === 'hat') unlockAchievement('hatsOff', 'Hats Off');
    else unlockAchievement('chainReaction', 'Chain Reaction');
    if (squadItems.shades && squadItems.hat && squadItems.chain) {
      // SECRET: the full set in a single run
      unlockAchievement('tatTrifecta', 'Tat Trifecta');
    }
    notify('Looky looky! +' + LOOKY_POINTS);
  }

  // ---------------------------------------------------------------------
  // Hen party contact — replaces the old hold-alongside chat. Standard
  // hens stumble you like any hazard; the bride variant (or any hen
  // party met while carrying a rose) is a bonus instead, and delivering
  // the rose to the bride herself is the jackpot.
  // ---------------------------------------------------------------------
  function henBonus(h) {
    h.harmless = true; // one outcome per group, and no stumble after
    var delivered = h.bride && roses > 0;
    if (delivered) roses -= 1; // the bride keeps her bouquet

    if (SQUAD_HAS_ADAM) {
      // TEMP Adam flavour until Phase 4 character select: invincibility
      // replaces the points bonus for any positive hen contact
      invulnUntil = frameNow + ADAM_INVULN_MS;
      notify('The shark has fed, all the little fish are happy');
      if (delivered) unlockAchievement('bridesBouquet', "Bride's Bouquet");
      return;
    }

    if (delivered) {
      // SECRET: rose delivered to the bride — the jackpot outcome
      addScore(BRIDE_POINTS);
      drunk = Math.max(0, drunk - SWAGGER_SUPER);
      multUntil = frameNow + CHAT_MULT_MS;
      showPhotoOverlay({
        caption: 'The bride gets her bouquet — the whole hen do erupts! ' +
                 '+' + BRIDE_POINTS,
        colour: '#d81159', // placeholder — comic strip art comes later
      });
      unlockAchievement('bridesBouquet', "Bride's Bouquet");
      return;
    }

    multUntil = frameNow + CHAT_MULT_MS;
    drunk = Math.max(0, drunk - SWAGGER_CHAT);
    notify('Hen party! x' + CHAT_MULT + ' points');
  }

  // SECRET: carrying a rose into the drunk lads — every lad gets one
  function shareRoses(h) {
    h.harmless = true;
    h.ladsHaveRoses = true;
    roses -= 1;
    unlockAchievement('sharingTheLove', 'Sharing the Love');
  }

  // ---------------------------------------------------------------------
  // Near-miss and dodge streak — scored the moment a hazard passes the
  // avatar's depth. Ground puke and disarmed vendors don't count.
  // ---------------------------------------------------------------------
  function checkPassed(h, mA) {
    if (h.passed || h.cfg.ground || h.harmless) return;
    if (mA >= 0) return;
    h.passed = true;
    if (h.hitPlayer) return; // they got you — no bonus, streak already reset

    streak += 1;
    var streakMult = 1 + Math.min(streak, 20) * 0.1;
    addScore(DODGE_POINTS * streakMult);

    // Closest clearance across the group decides a close shave
    var gap;
    if (h.members) {
      gap = Infinity;
      for (var j = 0; j < h.members.length; j++) {
        gap = Math.min(gap, playerGapTo(h.u + h.members[j].du, h.cfg.width));
      }
    } else {
      gap = playerGapTo(h.u, h.cfg.width);
    }
    if (gap > 0 && gap < NEAR_MISS_PX) {
      addScore(NEAR_MISS_POINTS);
      notify('Close shave! +' + NEAR_MISS_POINTS);
    }
  }

  // ---------------------------------------------------------------------
  // Pickup spawning and collection — separate from hazards: walking
  // into a pickup collects it (applies its `drunk` delta to the meter)
  // and removes it from the world. No penalty, no invulnerability.
  // ---------------------------------------------------------------------
  function spawnPickup() {
    var key = weightedPick(PICKUP_TYPES);
    var cfg = PICKUP_TYPES[key];
    pickups.push({
      key: key,
      cfg: cfg,
      pickup: true,
      worldZ: distance + cfg.spawn[0] + Math.random() * (cfg.spawn[1] - cfg.spawn[0]),
      u: 0.1 + Math.random() * 0.8,
    });
  }

  function updatePickups(dt) {
    pickupTimer -= dt;
    if (pickupTimer <= 0) {
      spawnPickup();
      pickupTimer = PICKUP_INTERVAL_MIN +
        Math.random() * (PICKUP_INTERVAL_MAX - PICKUP_INTERVAL_MIN);
    }

    for (var i = pickups.length - 1; i >= 0; i--) {
      var p = pickups[i];
      var m = p.worldZ - distance;
      if (m < bottomMetres() - 2) {
        pickups.splice(i, 1); // missed it — gone below the screen
      } else if (Math.abs(m - playerM()) < 0.7 &&
                 overlapsPlayer(p.u, p.cfg.width)) {
        drunk = Math.max(0, drunk + p.cfg.drunk);
        pickups.splice(i, 1); // collected
      }
    }
  }

  // ---------------------------------------------------------------------
  // Selfie spots + the photo overlay — a reusable pause-and-show system.
  // Selfie spots are individually placed (not interval-repeated like
  // palms/benches); future stop-offs (ice cream shop, the island...)
  // trigger the same showPhotoOverlay() with their own image/caption.
  // Real photos land later as files in images/ — set `image` to a path
  // and it replaces the placeholder colour block.
  // ---------------------------------------------------------------------
  var SELFIE_SPOTS = [
    { z: 90,  u: 0.30, caption: 'Selfie: Tiki Beach sunset',  colour: '#e76f51' },
    { z: 210, u: 0.65, caption: 'Selfie: the neon strip',     colour: '#457b9d' },
    { z: 330, u: 0.25, caption: 'Selfie: nearly Daytona',     colour: '#8e6bbf' },
  ];
  var selfieUsed = {};

  var photoOverlay = document.getElementById('photo-overlay');
  var photoFrame = document.getElementById('photo-frame');
  var photoCaption = document.getElementById('photo-caption');

  function showPhotoOverlay(opts) {
    photoFrame.style.background = opts.image
      ? 'center / cover no-repeat url("' + opts.image + '")'
      : (opts.colour || '#333');
    photoCaption.textContent = opts.caption || '';
    photoOverlay.classList.remove('hidden');
    paused = true;
  }

  function hidePhotoOverlay() {
    if (photoOverlay) photoOverlay.classList.add('hidden');
    paused = false;
  }

  if (photoOverlay) {
    photoOverlay.addEventListener('click', hidePhotoOverlay);
  }

  function updateSelfieSpots() {
    for (var i = 0; i < SELFIE_SPOTS.length; i++) {
      if (selfieUsed[i]) continue;
      var spot = SELFIE_SPOTS[i];
      var mA = spot.z - distance - playerM();
      if (Math.abs(mA) < 1.2 && overlapsPlayer(spot.u, 56)) {
        selfieUsed[i] = true;
        showPhotoOverlay(spot);
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
    ctx.lineTo(depthToX(xb, dMax), gameBottom());
    ctx.lineTo(depthToX(xa, dMax), gameBottom());
    ctx.closePath();
    ctx.fill();
  }

  // Stroke the line a longitudinal edge at x (at player depth) makes.
  function strokeEdge(x, colour, width) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(depthToX(x, 0), horizonY());
    ctx.lineTo(depthToX(x, bottomDepth()), gameBottom());
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
    ctx.lineTo(0, gameBottom());
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
      ctx.lineTo(depthToX(x, dMax), gameBottom());
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
    var y = avatarY();
    // Scale with the avatar's depth so stepping forward/back reads true
    var dA = (y - horizonY()) / (playerY() - horizonY());
    var sc = spreadOf(dA);
    // Project the avatar's x through its actual depth so u = 0..1 always
    // spans wall-to-kerb AT that depth — stepping forward can no longer
    // carry the sprite outside the narrowing promenade into the
    // buildings, and u = 0 stays exactly on the Tiki Tumble edge at
    // every depth
    var x = depthToX(playerScreenX(), dA);
    var bodyW = playerBodyW() * sc;
    var bodyH = bodyW * 1.5;
    var headR = bodyW * 0.42;

    // Linked mates flank the player, alternating sides — drawn first so
    // the player fronts the group. Lost mates simply aren't here.
    var slot = 0;
    for (var i = 0; i < squad.length; i++) {
      if (squad[i].lost) continue;
      var side = (slot % 2 === 0) ? 1 : -1;
      var rank = Math.floor(slot / 2) + 1;
      var mx2 = x + side * rank * bodyW * 0.95;
      drawFigure(mx2, y, bodyW * 0.72, bodyW * 1.05, squad[i].colour);
      slot++;
    }

    // Walking bob while moving
    var bob = 0;
    if (state === STATE_WALKING) {
      bob = Math.sin(time / 90) * 2;
    }

    // Tiki Tumble: the comedy fall — the sprite pitches over the edge,
    // drops the ledge's height, and clambers back
    var tumbling = time < tumbleUntil;
    if (tumbling) {
      var p = 1 - (tumbleUntil - time) / TUMBLE_MS;
      var arc = Math.sin(p * Math.PI);
      ctx.save();
      ctx.translate(x - arc * bodyW * 1.3, y + arc * dropHeight());
      ctx.rotate(-arc * 2.2);
      x = 0;
      y = 0;
      bob = 0;
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

    // Head circle (wares bought from vendors show on the squad row,
    // not here — we only ever see the back of the player's head)
    ctx.fillStyle = '#f4d1ae';
    ctx.beginPath();
    ctx.arc(x, y - bodyH / 2 - headR * 0.7 + bob, headR, 0, Math.PI * 2);
    ctx.fill();

    if (tumbling) ctx.restore();
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
          if (h.bride && i === 0) {
            // The bride: white veil over the lead hen
            var headY2 = yy - bob - ww * 1.35 - ww * 0.24;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
            ctx.beginPath();
            ctx.arc(xx, headY2 - ww * 0.08, ww * 0.55, Math.PI, 0);
            ctx.fill();
            ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
            ctx.fillRect(xx - ww * 0.55, headY2 - ww * 0.08, ww * 1.1, ww * 0.5);
          }
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
          if (h.ladsHaveRoses) {
            // Sharing the love: each lad shows off his rose
            ctx.strokeStyle = '#2c7a49';
            ctx.lineWidth = Math.max(1, ww * 0.08);
            ctx.beginPath();
            ctx.moveTo(-ww * 0.62, -ww * 0.6);
            ctx.lineTo(-ww * 0.62, -ww * 1.1);
            ctx.stroke();
            ctx.fillStyle = '#ff4d6d';
            ctx.beginPath();
            ctx.arc(-ww * 0.62, -ww * 1.18, ww * 0.14, 0, Math.PI * 2);
            ctx.fill();
          }
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

    if (h.key === 'performer' && h.variant === 'roseSeller') {
      // Rose seller: red-dressed figure with a basket of roses
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.beginPath();
      ctx.ellipse(x2, y2, w2 * 0.7, w2 * 0.26, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#c1121f'; // flared dress
      ctx.beginPath();
      ctx.moveTo(x2, y2 - w2 * 1.5);
      ctx.lineTo(x2 + w2 * 0.6, y2);
      ctx.lineTo(x2 - w2 * 0.6, y2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#f4d1ae'; // head
      ctx.beginPath();
      ctx.arc(x2, y2 - w2 * 1.5 - w2 * 0.35, w2 * 0.38, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#8b5a2b'; // basket at her side
      ctx.beginPath();
      ctx.ellipse(x2 + w2 * 0.85, y2 - w2 * 0.5, w2 * 0.42, w2 * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ff4d6d'; // the roses on top
      for (var r2 = -1; r2 <= 1; r2++) {
        ctx.beginPath();
        ctx.arc(x2 + w2 * 0.85 + r2 * w2 * 0.2, y2 - w2 * 0.72, w2 * 0.1, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    if (h.key === 'performer' && h.variant === 'lookyMan') {
      // Looky looky man — a Black street vendor (placeholder shapes;
      // PHASE 2 ART BRIEF: real sprite should depict a Black man with
      // his wares tray). Three wares variants share the silhouette,
      // the tray contents differ.
      var bodyC = '#e09f3e';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.beginPath();
      ctx.ellipse(x2, y2, w2 * 0.7, w2 * 0.26, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = bodyC;
      roundRect(x2 - w2 / 2, y2 - w2 * 1.6, w2, w2 * 1.6, w2 * 0.35);
      ctx.fill();
      ctx.fillStyle = '#5a3825'; // placeholder skin tone
      ctx.beginPath();
      ctx.arc(x2, y2 - w2 * 1.6 - w2 * 0.24, w2 * 0.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#4a3728'; // tray held out front
      ctx.fillRect(x2 - w2 * 0.75, y2 - w2 * 0.95, w2 * 1.5, w2 * 0.22);

      var ty = y2 - w2 * 1.02;
      var g2;
      if (h.wares === 'hat') {
        ctx.fillStyle = '#8b5a2b'; // little hats on the tray
        for (g2 = -1; g2 <= 1; g2++) {
          ctx.fillRect(x2 + g2 * w2 * 0.42 - w2 * 0.14, ty - w2 * 0.06, w2 * 0.28, w2 * 0.1);
          ctx.fillRect(x2 + g2 * w2 * 0.42 - w2 * 0.08, ty - w2 * 0.16, w2 * 0.16, w2 * 0.1);
        }
      } else if (h.wares === 'chain') {
        ctx.strokeStyle = '#ffd700'; // chains draped over the tray
        ctx.lineWidth = Math.max(1.5, w2 * 0.07);
        for (g2 = -1; g2 <= 1; g2++) {
          ctx.beginPath();
          ctx.arc(x2 + g2 * w2 * 0.42, ty - w2 * 0.04, w2 * 0.13, 0.15 * Math.PI, 0.85 * Math.PI);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = '#1d1d2b'; // pairs of shades on the tray
        for (g2 = -1; g2 <= 1; g2++) {
          ctx.beginPath();
          ctx.arc(x2 + g2 * w2 * 0.42 - w2 * 0.09, ty, w2 * 0.08, 0, Math.PI * 2);
          ctx.arc(x2 + g2 * w2 * 0.42 + w2 * 0.09, ty, w2 * 0.08, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Speech bubble, always visible while he's on screen
      var bw2 = Math.max(52, w2 * 2.4);
      var bh2 = Math.max(16, w2 * 0.62);
      var by2 = y2 - w2 * 2.6 - bh2;
      ctx.fillStyle = '#ffffff';
      roundRect(x2 - bw2 / 2, by2, bw2, bh2, bh2 * 0.4);
      ctx.fill();
      ctx.beginPath(); // bubble tail
      ctx.moveTo(x2 - bh2 * 0.3, by2 + bh2);
      ctx.lineTo(x2 + bh2 * 0.3, by2 + bh2);
      ctx.lineTo(x2, by2 + bh2 + bh2 * 0.45);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#0a1628';
      ctx.font = Math.max(9, Math.round(w2 * 0.42)) + 'px "DM Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Looky looky', x2, by2 + bh2 / 2);
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

  // A pint on the promenade: glass of amber with a foam head and a
  // little handle — nothing else in the world is this shape or colour.
  function drawPickup(p, m) {
    var cfg = p.cfg;
    var d = depthOf(m);
    var s = spreadOf(d);
    var x = depthToX(promenadeLeft() + promenadeWidth() * p.u, d);
    var y = depthToY(d);
    var w = cfg.width * s;
    var gh = w * 1.15; // glass height

    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.beginPath();
    ctx.ellipse(x, y, w * 0.5, w * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = cfg.colour; // the beer
    roundRect(x - w * 0.4, y - gh, w * 0.8, gh, w * 0.12);
    ctx.fill();

    ctx.strokeStyle = cfg.colour; // handle
    ctx.lineWidth = Math.max(1.5, w * 0.14);
    ctx.beginPath();
    ctx.arc(x + w * 0.48, y - gh * 0.5, gh * 0.26, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();

    ctx.fillStyle = '#fff6e0'; // foam head
    ctx.beginPath();
    ctx.ellipse(x, y - gh, w * 0.46, w * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // A selfie spot: phone on a selfie stick, planted in the deck
  function drawSelfie(it, m) {
    var d = depthOf(m);
    var s = spreadOf(d);
    var x = depthToX(promenadeLeft() + promenadeWidth() * it.u, d);
    var y = depthToY(d);
    var w = 22 * s;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.beginPath();
    ctx.ellipse(x, y, w * 0.5, w * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#9aa0a6'; // the stick
    ctx.lineWidth = Math.max(1.5, w * 0.12);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - w * 1.9);
    ctx.stroke();

    ctx.fillStyle = '#ff4d9d'; // the phone
    roundRect(x - w * 0.42, y - w * 2.6, w * 0.84, w * 1.3, w * 0.14);
    ctx.fill();
    ctx.fillStyle = '#ffffff'; // lens
    ctx.beginPath();
    ctx.arc(x, y - w * 1.95, w * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }

  // The chip shop doorway past Daytona: warm light spilling out of a
  // frame on the building side. Present in the world, never explained.
  function drawChipDoor(it, m) {
    var d = depthOf(m);
    var s = spreadOf(d);
    var x = depthToX(promenadeLeft() + promenadeWidth() * it.u, d);
    var y = depthToY(d);
    var w = 46 * s;
    var h2 = w * 1.9;

    ctx.fillStyle = 'rgba(255, 209, 102, 0.25)'; // light on the pavement
    ctx.beginPath();
    ctx.ellipse(x, y, w * 0.9, w * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#4a3728'; // door frame
    ctx.fillRect(x - w * 0.62, y - h2 - w * 0.12, w * 1.24, h2 + w * 0.12);
    ctx.fillStyle = '#ffd166'; // the glow inside
    ctx.fillRect(x - w * 0.5, y - h2, w, h2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)'; // steam curls
    ctx.beginPath();
    ctx.arc(x - w * 0.15, y - h2 - w * 0.28, w * 0.13, 0, Math.PI * 2);
    ctx.arc(x + w * 0.18, y - h2 - w * 0.42, w * 0.1, 0, Math.PI * 2);
    ctx.fill();
  }

  // Hazards, scenery, pickups, selfie spots, and the chip shop drawn
  // together, far-to-near so overlaps stack correctly; split around the
  // player's depth so passed objects draw over them.
  function drawWorldObjects(behindPlayer) {
    var items = sceneryItems();
    var i;
    for (i = 0; i < hazards.length; i++) items.push(hazards[i]);
    for (i = 0; i < pickups.length; i++) items.push(pickups[i]);
    for (i = 0; i < SELFIE_SPOTS.length; i++) {
      if (!selfieUsed[i]) {
        items.push({ selfie: true, worldZ: SELFIE_SPOTS[i].z, u: SELFIE_SPOTS[i].u });
      }
    }
    items.push({ chipDoor: true, worldZ: chipShopZ(), u: CHIP_DOOR_U });
    items.sort(function (a, b) { return b.worldZ - a.worldZ; });

    for (var j = 0; j < items.length; j++) {
      var m = items[j].worldZ - distance;
      if (m > DRAW_DISTANCE) continue;
      if (behindPlayer ? m >= 0 : m < 0) continue;
      if (items[j].scenery) drawScenery(items[j], m);
      else if (items[j].pickup) drawPickup(items[j], m);
      else if (items[j].selfie) drawSelfie(items[j], m);
      else if (items[j].chipDoor) drawChipDoor(items[j], m);
      else drawHazard(items[j], m);
    }
  }

  function drawHUD() {
    var stripH = 44;
    var rowH = 16;     // second row: score and dodge streak
    var top = safeTop; // clear of the phone's own status bar / notch
    var mid = top + stripH / 2;

    // Translucent dark strip, extended up behind the status bar area so
    // the inset doesn't read as a floating gap
    ctx.fillStyle = 'rgba(10, 22, 40, 0.72)';
    ctx.fillRect(0, 0, W, top + stripH + rowH);

    ctx.textBaseline = 'middle';
    ctx.font = '16px "DM Mono", monospace';

    // Distance top left
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(Math.floor(distance) + 'm / ' + RUN_DISTANCE + 'm', 14, mid);

    // Timer top right
    ctx.fillStyle = '#ffd166';
    ctx.textAlign = 'right';
    ctx.fillText(elapsed.toFixed(1) + 's', W - 14, mid);

    // Drunk meter, centre of the strip
    var mw = 80;
    var mh = 8;
    var mx = W / 2 - mw / 2;
    var my = mid + 3;

    ctx.font = '9px "DM Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.fillText('DRUNK', W / 2, mid - 8);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(mx, my, mw, mh);
    if (drunk > 0) {
      ctx.fillStyle = '#ffc233';
      ctx.fillRect(mx + 1, my + 1,
        (mw - 2) * Math.min(drunk / DRUNK_METER_MAX, 1), mh - 2);
    }

    // Carried-item icons beside the meter: roses left, shades right
    if (roses > 0) {
      var rx2 = mx - 16;
      ctx.strokeStyle = '#2c7a49';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(rx2, my + mh);
      ctx.lineTo(rx2, my - 2);
      ctx.stroke();
      ctx.fillStyle = '#ff4d6d';
      ctx.beginPath();
      ctx.arc(rx2, my - 4, 4, 0, Math.PI * 2);
      ctx.fill();
      if (roses > 1) {
        ctx.font = '9px "DM Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#ffffff';
        ctx.fillText('x' + roses, rx2 + 6, my + 3);
      }
    }
    // Second row: points (with the hen bonus multiplier) and dodge streak
    var rowMid = top + stripH + rowH / 2 - 2;
    ctx.font = '11px "DM Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillText('PTS ' + score + (scoreMult() > 1 ? '  x' + CHAT_MULT : ''),
      14, rowMid);
    ctx.textAlign = 'right';
    ctx.fillStyle = streak > 0 ? '#7fd069' : 'rgba(255, 255, 255, 0.45)';
    ctx.fillText('STREAK ' + streak, W - 14, rowMid);

    // Carrying a rose: an unmissable chip in the middle of the row
    if (roses > 0) {
      ctx.fillStyle = '#ff4d6d';
      roundRect(W / 2 - 38, rowMid - 8, 76, 15, 7);
      ctx.fill();
      ctx.font = 'bold 10px "DM Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.fillText('ROSE' + (roses > 1 ? ' x' + roses : ''), W / 2, rowMid);
    }

    // Transient notice line under the HUD
    if (frameNow < noticeUntil) {
      ctx.font = '13px "DM Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd166';
      ctx.fillText(noticeText, W / 2, top + stripH + rowH + 14);
    }
  }

  // The joystick: translucent base ring plus a nub that tracks the thumb
  function drawJoystick() {
    var c = joyCentre();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, JOY_BASE_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();

    var reach = JOY_BASE_R - JOY_NUB_R;
    ctx.fillStyle = joyId !== null
      ? 'rgba(255, 209, 102, 0.9)'
      : 'rgba(255, 255, 255, 0.55)';
    ctx.beginPath();
    ctx.arc(c.x + joyDX * reach, c.y + joyDY * reach, JOY_NUB_R, 0, Math.PI * 2);
    ctx.fill();
  }

  // One squad avatar with everything the group has bought so far —
  // wares from the looky looky men appear on EVERY avatar, the shared
  // haul being the reward. The player's own avatar is the big one and
  // also shows the carried rose. Lost mates grey out where they stand.
  function drawAvatar(x, y, r, isPlayer, colour, lost) {
    if (lost) {
      // Benched: dimmed shell, no wares, no colour
      ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      return;
    }

    ctx.fillStyle = isPlayer ? '#e63946' : (colour || 'rgba(255, 255, 255, 0.10)');
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (squadItems.shades) {
      ctx.fillStyle = '#1d1d2b';
      ctx.fillRect(x - r * 0.75, y - r * 0.35, r * 1.5, r * 0.34);
    }
    if (squadItems.hat) {
      ctx.fillStyle = '#8b5a2b';
      ctx.fillRect(x - r * 0.85, y - r * 1.05, r * 1.7, r * 0.22);
      ctx.fillRect(x - r * 0.5, y - r * 1.45, r, r * 0.45);
    }
    if (squadItems.chain) {
      ctx.strokeStyle = '#ffd700';
      ctx.lineWidth = Math.max(1.5, r * 0.12);
      ctx.beginPath();
      ctx.arc(x, y + r * 0.15, r * 0.62, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }
    if (isPlayer && roses > 0) {
      ctx.strokeStyle = '#2c7a49';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + r * 0.95, y + r * 0.5);
      ctx.lineTo(x + r * 0.95, y - r * 0.5);
      ctx.stroke();
      ctx.fillStyle = '#ff4d6d';
      ctx.beginPath();
      ctx.arc(x + r * 0.95, y - r * 0.7, r * 0.22, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // The control footer: a dedicated zone below the gameplay view holding
  // the joystick and the squad avatar row (the group's outfit display).
  // PLACEHOLDER: the three smaller circles await Phase 3's squad size /
  // lives system for real member avatars and greyed-out states — only
  // the layout and shared-wares display live here for now.
  function drawFooter() {
    var gb = gameBottom();

    ctx.fillStyle = '#0a1628';
    ctx.fillRect(0, gb, W, FOOTER_H);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(0, gb, W, 2);

    // Squad row centred in the space the joystick doesn't use — the
    // real roster now, greying out as mates get benched
    var stickReserve = 160;
    var areaStart = joySide === 'left' ? stickReserve : 0;
    var cx = areaStart + (W - stickReserve) / 2;
    var cy = gb + FOOTER_H / 2;

    drawAvatar(cx - 56, cy, 22, true, null, false); // the player, larger
    for (var i = 0; i < squad.length; i++) {
      drawAvatar(cx + i * 34, cy, 12, false, squad[i].colour, squad[i].lost);
    }
  }

  // ---------------------------------------------------------------------
  // Main loop — requestAnimationFrame
  // ---------------------------------------------------------------------
  function frame(time) {
    var dt = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 0;
    lastTime = time;
    frameNow = time;

    if (state === STATE_WALKING && !paused) {
      // walkRate() goes negative when the avatar pulls back down the band
      distance = Math.max(0, Math.min(chipShopZ(), distance + walkRate() * dt));
      elapsed += dt;
      updateHazards(dt);
      updatePickups(dt);
      updateSelfieSpots();
      checkFinish();
    }

    updatePlayer(dt);

    // Screen shake after a stumble or tumble — tumbles jolt much harder
    var shaking = time < shakeUntil;
    if (shaking) {
      ctx.save();
      ctx.translate((Math.random() - 0.5) * shakeAmp,
                    (Math.random() - 0.5) * shakeAmp);
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
      drawFooter(); // covers any world overdraw below the gameplay view
      drawHUD();
      if (state === STATE_READY || state === STATE_WALKING) drawJoystick();
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
