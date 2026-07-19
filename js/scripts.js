(function () {
  'use strict';

  var VERSION = '0.29.0';

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

  var MODE_CLASSIC = 0;  // Tiki Beach to Daytona, the 400m route + endings
  var MODE_ENDLESS = 1;  // no finish, 5 beers for lives, go as far as you can
  var gameMode = MODE_CLASSIC;
  var ENDLESS_LIVES = 5;
  var lives = 0;             // remaining beers in Endless

  var state = STATE_TITLE;
  var distance = 0;          // metres walked
  var elapsed = 0;           // run clock in seconds (collisions add penalties)
  var playerU = 0.5;         // player position across the promenade, 0..1
  var targetU = 0.5;         // where the player is easing toward, 0..1
  var playerV = 0.5;         // vertical position in the movement band, 0..1
  var targetV = 0.5;         // where vertical input wants the player
  var playerSweepLo = 0.5;   // horizontal span the player covered this frame,
  var playerSweepHi = 0.5;   // so fast dodges are swept-tested, not point-tested
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
  var SQUAD_HAS_ADAM = false;  // true when Adam is the lead OR walking along
  var PLAYING_AS_LEE = false;  // true only when Lee is the chosen lead

  // The full roster. The player is always ONE of these (the lead), and any
  // of the others can be picked to walk alongside.
  var ROSTER = {
    robby:   { name: 'Robby',   colour: '#f77f00' },
    lee:     { name: 'Lee',     colour: '#7fd069' },
    al:      { name: 'Al',      colour: '#4d96ff' },
    keith:   { name: 'Keith',   colour: '#ff70a6' },
    skidz:   { name: 'Skidz',   colour: '#25ced1' },
    phil:    { name: 'Phil',    colour: '#ffd166' },
    adam:    { name: 'Adam',    colour: '#9d4edd' },
    churchy: { name: 'Churchy', colour: '#e63946' },
    shippy:  { name: 'Shippy',  colour: '#2a9d8f' },
    steve:   { name: 'Steve',   colour: '#e09f3e' },
  };
  var ROSTER_ORDER = ['robby', 'lee', 'al', 'keith', 'skidz', 'phil',
                      'adam', 'churchy', 'shippy', 'steve'];

  // Real avatar photos — oval cameo portraits with transparent corners,
  // faces sitting in the upper-middle of the frame. Filenames are tried
  // lowercase then Capitalised (uploads vary), and a character whose
  // photo is missing simply keeps the placeholder circle everywhere, so
  // new photos drop into images/avatars/ with no code changes.
  var AVATAR_FACE_Y = 0.35;  // face centre as a fraction of image height
  var avatarImgs = {};       // key -> loaded Image, present only on success
  var avatarFaceEls = {};    // key -> [<img>] chips waiting for a photo

  ROSTER_ORDER.forEach(function (k) {
    avatarFaceEls[k] = [];
    var tries = ['images/avatars/' + k + '.png',
                 'images/avatars/' + k.charAt(0).toUpperCase() + k.slice(1) + '.png'];
    (function attempt(i) {
      if (i >= tries.length) return; // stays a placeholder
      var img = new Image();
      img.onload = function () {
        avatarImgs[k] = img;
        avatarFaceEls[k].forEach(function (el) {
          el.src = img.src;
          el.hidden = false;
        });
      };
      img.onerror = function () { attempt(i + 1); };
      img.src = tries[i];
    })(0);
  });

  // Cover-crop a photo into a circle: a full-width square window centred
  // on the face, clipped round. The roster colour fills behind it so any
  // transparent corner of the oval reads as the character's colour.
  function drawAvatarPhoto(img, x, y, r) {
    var iw = img.naturalWidth, ih = img.naturalHeight;
    var side = Math.min(iw, ih);
    var sy = Math.min(Math.max(0, ih * AVATAR_FACE_Y - side / 2), ih - side);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, (iw - side) / 2, sy, side, side, x - r, y - r, r * 2, r * 2);
    ctx.restore();
  }

  var leadChar = 'robby';      // who you're playing as this run
  var mateSel = {};            // supporters walking with you, keyed by name
  var squad = [];              // this run's mates: {key, name, colour, lost}

  function leadColour() {
    return (ROSTER[leadChar] && ROSTER[leadChar].colour) || '#e63946';
  }
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

  // ---------------------------------------------------------------------
  // Achievements. The catalogue below is the single source of truth for
  // the achievements page (names, descriptions, secret flags). Unlocks are
  // persisted to localStorage keyed by the device owner, in a shape that
  // maps straight onto a future Firestore doc
  // (users/<owner>/achievements/<id> = { unlocked, unlockedAt }) so the
  // sync can be added later without rebuilding any of this tracking.
  //
  // `secret` achievements hide their name/description on the page until
  // earned (they line up with the important=true story-beat unlocks).
  // ---------------------------------------------------------------------
  var ACHIEVEMENT_DEFS = [
    { id: 'shadyBusiness', name: 'Shady Business',
      desc: 'Grab a pair of shades off a looky looky man.', secret: false },
    { id: 'hatsOff', name: 'Hats Off',
      desc: 'Pick up a knock-off hat from a street seller.', secret: false },
    { id: 'chainReaction', name: 'Chain Reaction',
      desc: 'Bag some gold bling from a chain seller.', secret: false },
    { id: 'nobodyLeftBehind', name: 'Nobody Left Behind',
      desc: 'Reach the finish with your whole squad still standing.', secret: false },
    { id: 'tikiTumbleSurvivor', name: 'Tiki Tumble Survivor',
      desc: 'Take a Tiki Tumble and still make it to the end.', secret: false },
    { id: 'tatTrifecta', name: 'Tat Trifecta',
      desc: 'Deck the squad in shades, hat AND chain in a single walk.', secret: true },
    { id: 'closeCall', name: 'Close Call',
      desc: 'Get Skidz to the portaloo in the nick of time.', secret: true },
    { id: 'sharingTheLove', name: 'Sharing the Love',
      desc: 'Carry a rose into the drunk lads and share it round.', secret: true },
    { id: 'bridesBouquet', name: "Bride's Bouquet",
      desc: 'Deliver a rose to the bride on her hen do.', secret: true,
      image: 'images/achievements/brides-bouquet.png' },
    { id: 'sharkFed', name: 'The Shark Has Fed',
      desc: 'Meet a hen party with Adam along — the shark has fed, all the little fish are happy.',
      secret: true, image: 'images/achievements/shark-fed.png' },
  ];
  var ACHIEVEMENT_MAP = {};
  ACHIEVEMENT_DEFS.forEach(function (d) { ACHIEVEMENT_MAP[d.id] = d; });

  var ACHIEVEMENTS_STORE_KEY = 'deathMarchAchievements';

  // In-memory mirror of the current owner's unlocks (for run-time dedup so
  // an already-earned achievement doesn't re-toast). Loaded from storage
  // on boot / owner change; never wiped by resetRun.
  var achievements = {};

  // The whole store, shape: { <ownerKey>: { <id>: { unlocked, unlockedAt } } }
  function loadAchievementStoreAll() {
    try { return JSON.parse(localStorage.getItem(ACHIEVEMENTS_STORE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  // Just the current owner's records.
  function ownerAchievements() {
    if (!deviceOwner) return {};
    return loadAchievementStoreAll()[deviceOwner.key] || {};
  }
  // Pull the owner's persisted unlocks into the in-memory mirror.
  function loadOwnerAchievements() {
    achievements = {};
    var mine = ownerAchievements();
    for (var id in mine) {
      if (mine[id] && mine[id].unlocked) achievements[id] = true;
    }
  }
  // Persist one unlock against the current owner (timestamped).
  function recordAchievement(id) {
    if (!deviceOwner) return;
    try {
      var all = loadAchievementStoreAll();
      var mine = all[deviceOwner.key] || {};
      if (!mine[id] || !mine[id].unlocked) {
        mine[id] = { unlocked: true, unlockedAt: Date.now() };
        all[deviceOwner.key] = mine;
        localStorage.setItem(ACHIEVEMENTS_STORE_KEY, JSON.stringify(all));
      }
    } catch (e) {}
  }

  var noticeText = '';
  var noticeUntil = 0;

  function notify(text, ms) {
    noticeText = text;
    noticeUntil = frameNow + (ms || 2600);
  }

  // `important` routes the unlock through the pause overlay — used for
  // the secret story-beat achievements; ordinary ones stay ambient. The
  // unlock is persisted against the device owner either way.
  function unlockAchievement(id, label, important) {
    if (achievements[id]) return;
    achievements[id] = true;
    recordAchievement(id);
    if (important) showMessage('ACHIEVEMENT UNLOCKED: ' + label);
    else notify('ACHIEVEMENT: ' + label);
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
  var endMsgEl = document.getElementById('end-msg');
  var endTimeEl = document.getElementById('end-time');
  var endScoreEl = document.getElementById('end-score');
  var endBestEl = document.getElementById('end-best');
  var copyScoreBtn = document.getElementById('copy-score');
  var endlessBestEl = document.getElementById('endless-best');

  // ---------------------------------------------------------------------
  // Endless best — persisted locally so it survives between sessions.
  // Distance is the headline stat (it's what Endless is about); the score
  // rides along for the share text. localStorage can be unavailable
  // (private browsing) so every touch is wrapped.
  // ---------------------------------------------------------------------
  var BEST_KEY = 'deathMarchEndlessBest';

  function loadBest() {
    try {
      var v = JSON.parse(localStorage.getItem(BEST_KEY));
      return (v && typeof v.dist === 'number') ? v : null;
    } catch (e) { return null; }
  }

  function saveBest(v) {
    try { localStorage.setItem(BEST_KEY, JSON.stringify(v)); } catch (e) {}
  }

  function refreshBestOnTitle() {
    if (!endlessBestEl) return;
    var best = loadBest();
    endlessBestEl.textContent = best
      ? 'ENDLESS BEST: ' + best.dist + 'M'
      : '';
  }
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
    playerSweepLo = 0.5;
    playerSweepHi = 0.5;
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
    portalooUsed = false;
    steveUsed = false;
    islandUsed = false;
    skidzSoiled = false;
    closeAllOverlays();
    noticeUntil = 0;
    roseSellerSpawned = false;
    joyId = null;
    joyDX = 0;
    joyDY = 0;
    tumbleUntil = 0;
    tumbleCount = 0;
    wallPressT = 0;
    shakeAmp = 6;
    pendingEnding = null;
    enteredEndZone = false;
    lives = ENDLESS_LIVES; // only used/shown in Endless

    // Build this run's squad from the start-screen selection and drive
    // the character flags from the actual composition. The lead is the
    // player themself, so they never appear as a supporter.
    squad = [];
    for (var si = 0; si < ROSTER_ORDER.length; si++) {
      var mk = ROSTER_ORDER[si];
      if (mk !== leadChar && mateSel[mk]) {
        squad.push({
          key: mk,
          name: ROSTER[mk].name,
          colour: ROSTER[mk].colour,
          lost: false,
        });
      }
    }
    // Playing AS Lee needs Lee as the lead; Adam counts whether he's the
    // lead or just walking along.
    PLAYING_AS_LEE = (leadChar === 'lee');
    SQUAD_HAS_ADAM = (leadChar === 'adam') || !!mateSel.adam;


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
  // The finish — and the chip shop just past it. Daytona is a real,
  // visible entrance with its own depth window, NOT a full-width
  // tripwire at 400m: you finish by actually walking into it, and you
  // walk past it by simply not being in it. (The old gate auto-finished
  // the run on the frame 400m was crossed unless the player was already
  // hugging the far right — which made walking past impossible in
  // practice.)
  // ---------------------------------------------------------------------
  var DAYTONA_ARCH_LEFT_U = 0.38; // the archway hugs the building side, from
  var DAYTONA_DOOR_MIN_U = 0.42;  // here rightward — enter by being right of
                                  // this, bypass by committing hard left
  var DAYTONA_DEPTH_M = 3;        // and it's this deep front-to-back
  var CHIP_EXTRA_M = 12;          // the chip shop sits this far past Daytona
  var CHIP_DOOR_U = 0.9;          // where the chip doorway is drawn
  var CHIP_DOOR_MIN_U = 0.82;     // how far right you must be to enter it
  var CHIP_POINTS = 750;
  var END_ZONE_M = 26;            // desolate tumbleweed stretch past the shop
  var OLD_TOWN_MSG =
    'Uh oh, you have ended up in old town and missed the Daytona party.';

  function chipShopZ() {
    return RUN_DISTANCE + CHIP_EXTRA_M;
  }

  function endOfRoute() {
    return chipShopZ() + END_ZONE_M;
  }

  var pendingEnding = null;   // locked in when a doorway is entered
  var enteredEndZone = false; // past the chip shop, into the tumbleweeds

  // Classic outcomes, judged where the avatar actually stands. Daytona is
  // a right-aligned archway at the line: step into it (right side) for the
  // normal finish, or skirt hard down the left to bypass it. Past it, the
  // chip shop door is the secret ending; miss both and you drift on into
  // the desolate end zone and, eventually, old town. Endless never ends
  // here — only when the beers run out.
  function checkFinish() {
    if (gameMode === MODE_ENDLESS) return;
    var eff = distance + playerM(); // the avatar's true depth position
    if (eff < RUN_DISTANCE) return;

    // Into the Daytona archway on the building side = the party
    if (pendingEnding === null && !enteredEndZone &&
        eff <= RUN_DISTANCE + DAYTONA_DEPTH_M && playerU >= DAYTONA_DOOR_MIN_U) {
      finishRun('daytona');
      return;
    }
    // Through the chip shop door further along = chips (locked, not ended
    // yet — you still walk it out through the end zone)
    if (pendingEnding === null &&
        eff >= chipShopZ() && eff <= chipShopZ() + DAYTONA_DEPTH_M &&
        playerU >= CHIP_DOOR_MIN_U) {
      pendingEnding = 'chips';
    }
    // Crossing into the end zone: clear the busy promenade ahead so it
    // reads as the empty edge of town — tumbleweeds only from here
    if (!enteredEndZone && eff > chipShopZ()) {
      enteredEndZone = true;
      for (var i = hazards.length - 1; i >= 0; i--) {
        if (hazards[i].worldZ > distance && !hazards[i].harmless) {
          hazards.splice(i, 1);
        }
      }
    }
    // The route properly concludes a short way into the end zone
    if (eff >= endOfRoute()) {
      finishRun(pendingEnding || 'oldtown');
    }
  }

  function finishRun(ending) {
    state = STATE_DONE;

    if (ending === 'chips') addScore(CHIP_POINTS);
    // Endless scores by how far you got, on top of what you collected
    if (ending === 'endless') score += Math.floor(distance);

    // Squad payout: bigger starting squads score more, and bringing
    // every mate home intact is worth celebrating — no such glory if
    // you led the whole squad into old town (or got wiped out endless)
    if (squad.length > 0) {
      score = Math.round(score * (1 + 0.15 * squad.length));
      if (ending !== 'oldtown' && ending !== 'endless' &&
          matesAlive() === squad.length) {
        score += 250 * squad.length;
        unlockAchievement('nobodyLeftBehind', 'Nobody Left Behind');
      }
    }

    if (tumbleCount > 0) {
      unlockAchievement('tikiTumbleSurvivor', 'Tiki Tumble Survivor');
    }

    endTitleEl.innerHTML =
      ending === 'chips' ? 'BOUGHT EVERYONE<br>CHIPS' :
      ending === 'oldtown' ? 'OLD TOWN' :
      ending === 'endless' ? 'OUT OF BEERS' :
      'YOU MADE IT<br>TO DAYTONA';
    endMsgEl.textContent =
      ending === 'oldtown' ? OLD_TOWN_MSG :
      ending === 'endless' ? (Math.floor(distance) + 'm before the beers ran out') :
      '';
    endTimeEl.textContent = elapsed.toFixed(1) + 's';
    endScoreEl.textContent = score + ' PTS';

    // Endless extras: the persistent best and the share button. Classic
    // endings show neither.
    if (ending === 'endless') {
      var dist = Math.floor(distance);
      var best = loadBest();
      var isNewBest = !best || dist > best.dist;
      if (isNewBest) saveBest({ dist: dist, score: score });
      if (endBestEl) {
        endBestEl.textContent = isNewBest
          ? 'NEW BEST!'
          : 'YOUR BEST: ' + best.dist + 'm';
      }
      lastShare = buildShareText(dist, score, isNewBest);
      if (copyScoreBtn) {
        copyScoreBtn.style.display = '';
        copyScoreBtn.textContent = 'COPY SCORE';
      }
    } else {
      if (endBestEl) endBestEl.textContent = '';
      if (copyScoreBtn) copyScoreBtn.style.display = 'none';
    }

    endScreen.classList.remove('hidden');
  }

  // ---------------------------------------------------------------------
  // Shareable run summary — built at finish, copied on demand. Written
  // to paste straight into the group chat.
  // ---------------------------------------------------------------------
  var lastShare = '';

  function buildShareText(dist, pts, isNewBest) {
    var lead = (ROSTER[leadChar] && ROSTER[leadChar].name) || 'someone';
    var lines = [
      '🍺💀 DEATH MARCH — ENDLESS',
      'Made it ' + dist + 'm down the prom as ' + lead +
        ' before the beers ran out.',
    ];
    if (squad.length === 1) {
      lines.push(matesAlive() === 1
        ? squad[0].name + ' still standing. Miracle.'
        : squad[0].name + ' is on a bench somewhere.');
    } else if (squad.length > 1) {
      var standing = matesAlive();
      lines.push(standing === squad.length
        ? 'All ' + squad.length + ' mates still standing. Miracle.'
        : standing + ' of ' + squad.length +
          ' mates still standing. The rest are on benches.');
    }
    lines.push(pts + ' PTS.' + (isNewBest ? ' New personal best.' : ''));
    lines.push('Reckon you’d get further?');
    return lines.join('\n');
  }

  function flashCopied(ok) {
    if (!copyScoreBtn) return;
    copyScoreBtn.textContent = ok ? 'COPIED!' : 'COPY FAILED';
    setTimeout(function () { copyScoreBtn.textContent = 'COPY SCORE'; }, 1600);
  }

  if (copyScoreBtn) {
    copyScoreBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!lastShare) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(lastShare).then(
          function () { flashCopied(true); },
          function () { flashCopied(legacyCopy(lastShare)); }
        );
      } else {
        flashCopied(legacyCopy(lastShare));
      }
    });
  }

  // Fallback for contexts without the async Clipboard API
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
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
      // A tap on the island out at sea sets off the Robby moment
      if (!islandUsed && state === STATE_WALKING) {
        var ip = islandScreenPos();
        if (ip) {
          var idx = t.clientX - ip.x;
          var idy = t.clientY - (ip.y - 20 * ip.s);
          var ir = Math.max(34, 70 * ip.s);
          if (idx * idx + idy * idy <= ir * ir) {
            triggerIsland();
            continue;
          }
        }
      }
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

  // Mode toggle — Classic (the 400m route) vs Endless (survive on beers)
  var modeClassicBtn = document.getElementById('mode-classic');
  var modeEndlessBtn = document.getElementById('mode-endless');
  function syncModeUI() {
    if (modeClassicBtn) {
      modeClassicBtn.classList.toggle('lead', gameMode === MODE_CLASSIC);
    }
    if (modeEndlessBtn) {
      modeEndlessBtn.classList.toggle('lead', gameMode === MODE_ENDLESS);
    }
    refreshBestOnTitle();
  }
  if (modeClassicBtn) {
    modeClassicBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      gameMode = MODE_CLASSIC;
      syncModeUI();
    });
  }
  if (modeEndlessBtn) {
    modeEndlessBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      gameMode = MODE_ENDLESS;
      syncModeUI();
    });
  }
  syncModeUI();

  // Character selection — two DMCarousel coverflow pickers plus the team
  // box, all driving the same state as before: leadChar (who you play as)
  // and mateSel (who walks with you). The lead carousel's centred cameo IS
  // the lead; the squad carousel below excludes that lead and toggles a
  // mate when its centred cameo is tapped; the team box lists the squad
  // and drops a member when its thumb is tapped. Nothing downstream
  // changes — resetRun still reads leadChar + mateSel, and SQUAD_HAS_ADAM
  // / PLAYING_AS_LEE still derive from them at run start.
  var leadMount = document.getElementById('lead-carousel');
  var squadMount = document.getElementById('squad-carousel');
  var teamBox = document.getElementById('team-box');
  var leadCarousel = null;
  var squadCarousel = null;

  // On-disk avatar filenames — all lowercase to match the naming
  // convention. Focal point defaults to [50, 30] for every avatar;
  // per-character focal tuning is a planned follow-up.
  var AVATAR_FILE = {
    robby: 'robby.png', lee: 'lee.png', al: 'al.png', keith: 'keith.png',
    skidz: 'skidz.png', phil: 'phil.png', adam: 'adam.png',
    churchy: 'churchy.png', shippy: 'shippy.png', steve: 'steve.png'
  };
  function avatarSpec(k) {
    var spec = { name: ROSTER[k].name, key: k, focus: [50, 30] };
    if (AVATAR_FILE[k]) spec.src = 'images/avatars/' + AVATAR_FILE[k];
    return spec;
  }

  // Fill a circular container with a character's photo over a coloured
  // fallback disc + initial (used by the team-box thumbnails).
  function fillFace(container, k, register) {
    container.style.background = ROSTER[k].colour;
    var initial = document.createElement('span');
    initial.className = 'initial';
    initial.textContent = ROSTER[k].name.charAt(0);
    container.appendChild(initial);
    var img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.hidden = true;
    if (avatarImgs[k]) {
      img.src = avatarImgs[k].src;
      img.hidden = false;
    } else if (register) {
      avatarFaceEls[k].push(img);
    }
    container.appendChild(img);
  }

  // Rebuild the team box from the current squad selection.
  function renderTeam() {
    if (!teamBox) return;
    teamBox.textContent = '';
    var any = false;
    ROSTER_ORDER.forEach(function (k) {
      if (k === leadChar || !mateSel[k]) return;
      any = true;
      var thumb = document.createElement('button');
      thumb.className = 'team-thumb';
      thumb.type = 'button';
      thumb.title = ROSTER[k].name;
      fillFace(thumb, k, false);
      var rm = document.createElement('span');
      rm.className = 'rm';
      rm.textContent = '×';
      thumb.appendChild(rm);
      thumb.addEventListener('click', function (e) {
        e.stopPropagation();
        mateSel[k] = false;
        refreshSelection();
      });
      teamBox.appendChild(thumb);
    });
    if (!any) {
      var empty = document.createElement('span');
      empty.className = 'team-empty';
      empty.textContent = 'TAP MATES ABOVE TO ADD THEM';
      teamBox.appendChild(empty);
    }
  }

  // Mark confirmed squad-carousel cards with the "locked in" visual so a
  // chosen mate reads as locked whether or not it's the centred card.
  function markPicked() {
    if (!squadCarousel) return;
    squadCarousel.cards.forEach(function (card, i) {
      var a = squadCarousel.avatars[i];
      card.classList.toggle('dm-locked', !!(a && mateSel[a.key]));
    });
  }

  // Mark the confirmed lead's card with the same "locked in" visual. The
  // lead carousel isn't rebuilt on selection, so this class simply sticks
  // to whichever card is the current leadChar across swipes.
  function markLeadLocked() {
    if (!leadCarousel) return;
    leadCarousel.cards.forEach(function (card, i) {
      var a = leadCarousel.avatars[i];
      card.classList.toggle('dm-locked', !!(a && a.key === leadChar));
    });
  }

  function refreshSelection() {
    markPicked();
    renderTeam();
  }

  // ---- Selection confirmation modal -----------------------------------
  // Tapping a centred cameo no longer changes state directly — it raises a
  // CONFIRM/BACK prompt, and only CONFIRM commits. pendingConfirm holds
  // what's awaiting the decision.
  var selectConfirm = document.getElementById('select-confirm');
  var confirmTextEl = document.getElementById('confirm-text');
  var confirmOkBtn = document.getElementById('confirm-ok');
  var confirmBackBtn = document.getElementById('confirm-back');
  var pendingConfirm = null; // { kind: 'lead'|'squad', key, action }

  function showSelectConfirm(text) {
    if (confirmTextEl) confirmTextEl.textContent = text;
    if (selectConfirm) selectConfirm.classList.remove('hidden');
  }
  function hideSelectConfirm() {
    pendingConfirm = null;
    if (selectConfirm) selectConfirm.classList.add('hidden');
  }

  function askLeadConfirm(key) {
    pendingConfirm = { kind: 'lead', key: key };
    showSelectConfirm('Play as ' + ROSTER[key].name + '?');
  }
  function askSquadConfirm(key) {
    var adding = !mateSel[key];
    pendingConfirm = { kind: 'squad', key: key, action: adding ? 'add' : 'remove' };
    showSelectConfirm((adding ? 'Add ' : 'Remove ') + ROSTER[key].name +
      (adding ? ' to your squad?' : ' from your squad?'));
  }

  if (selectConfirm) {
    // Never let a tap in here reach the tap-anywhere-to-start handler.
    selectConfirm.addEventListener('click', function (e) { e.stopPropagation(); });
  }
  if (confirmOkBtn) {
    confirmOkBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var pc = pendingConfirm;
      if (!pc) { hideSelectConfirm(); return; }
      if (pc.kind === 'lead') {
        leadChar = pc.key;
        if (mateSel[pc.key]) mateSel[pc.key] = false; // can't walk with yourself
        rebuildSquad(true);   // squad carousel now excludes the new lead
        markLeadLocked();
        renderTeam();
      } else {
        mateSel[pc.key] = (pc.action === 'add');
        refreshSelection();
      }
      hideSelectConfirm();
    });
  }
  if (confirmBackBtn) {
    confirmBackBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      hideSelectConfirm();
    });
  }

  // A photo that 404s (casing drift, a not-yet-uploaded file) is swapped
  // for the coloured initial placeholder the component uses when a card
  // has no src — a missing avatar degrades gracefully, never a broken icon.
  function guardPhotos(carousel) {
    if (!carousel || !carousel.track) return;
    var imgs = carousel.track.querySelectorAll('img.dm-photo');
    Array.prototype.forEach.call(imgs, function (img) {
      img.addEventListener('error', function handler() {
        img.removeEventListener('error', handler);
        var ph = document.createElement('span');
        ph.className = 'dm-photo dm-photo--placeholder';
        ph.textContent = (img.alt || '?').charAt(0).toUpperCase();
        if (img.parentNode) img.parentNode.replaceChild(ph, img);
      });
    });
  }

  // The squad carousel excludes the current lead, so it is rebuilt whenever
  // the lead changes. quiet=true skips the entry animation on those
  // rebuilds so only the very first appearance animates in.
  function rebuildSquad(quiet) {
    if (!squadMount) return;
    var keepName = (squadCarousel && squadCarousel.current()) ? squadCarousel.current().name : null;
    var specs = ROSTER_ORDER
      .filter(function (k) { return k !== leadChar; })
      .map(avatarSpec);
    squadCarousel = new DMCarousel({
      mount: squadMount,
      avatars: specs,
      startName: keepName || undefined,
      sizes: { active: 92, near: 62, far: 46 },
      offsets: { near: 98, far: 124 },
      onChange: function () { /* browsing only — no state change */ },
      onSelect: function (a) {
        if (!a || !a.key) return;
        askSquadConfirm(a.key); // add/remove needs confirming
      }
    });
    if (quiet) {
      squadCarousel.cards.forEach(function (card) {
        if (card.firstChild) card.firstChild.style.animation = 'none';
      });
    }
    guardPhotos(squadCarousel);
    markPicked();
  }

  if (leadMount && squadMount && teamBox && typeof DMCarousel === 'function') {
    // Taps and swipes inside the pickers must not bubble to the start
    // screen's tap-anywhere-to-begin handler, or interacting with a
    // carousel would launch the run. The mount elements survive the
    // component's innerHTML rebuilds, so one guard each is enough.
    [leadMount, squadMount, teamBox].forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); });
    });

    leadCarousel = new DMCarousel({
      mount: leadMount,
      avatars: ROSTER_ORDER.map(avatarSpec),
      startName: ROSTER[leadChar].name,
      // Browsing (swiping) no longer picks the lead — the centred card just
      // shows the browsing laser ring. Tapping the centred cameo raises a
      // confirm; only that commits leadChar.
      onChange: function () { /* browsing only — no state change */ },
      onSelect: function (a) {
        if (!a || !a.key) return;
        askLeadConfirm(a.key);
      }
    });
    guardPhotos(leadCarousel);

    rebuildSquad(false);
    markLeadLocked(); // the default lead starts locked in
    renderTeam();
  }

  walkAgainBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    endScreen.classList.add('hidden');
    resetRun();
  });

  // ---------------------------------------------------------------------
  // Device owner — a persistent "whose phone is this" identity, distinct
  // from the per-run character you play as. Established once via its own
  // coverflow picker (reusing DMCarousel) with a confirm step, then
  // remembered in localStorage forever. This is the identity future score
  // /achievement persistence (Firestore) will attribute records to; here
  // we only establish and store it. It does NOT touch leadChar/mateSel.
  // ---------------------------------------------------------------------
  var OWNER_STORE_KEY = 'deathMarchDeviceOwner';
  var deviceOwner = null; // { key, name } once known

  function loadOwner() {
    try {
      var v = JSON.parse(localStorage.getItem(OWNER_STORE_KEY));
      return (v && v.key && ROSTER[v.key]) ? v : null;
    } catch (e) { return null; }
  }
  function saveOwner(key) {
    try {
      localStorage.setItem(OWNER_STORE_KEY,
        JSON.stringify({ key: key, name: ROSTER[key].name }));
    } catch (e) {}
  }

  var ownerScreen = document.getElementById('owner-screen');
  var ownerPickView = document.getElementById('owner-pick');
  var ownerConfirmView = document.getElementById('owner-confirm');
  var ownerConfirmName = document.getElementById('owner-confirm-name');
  var ownerConfirmBtn = document.getElementById('owner-confirm-btn');
  var ownerBackBtn = document.getElementById('owner-back-btn');
  var ownerChangeBtn = document.getElementById('owner-change');
  var ownerMount = document.getElementById('owner-carousel');
  var ownerCarousel = null;
  var pendingOwner = null; // key awaiting CONFIRM

  // The small start-screen link that lets someone deliberately reset the
  // owner — deliberately low-key so it isn't tripped into by accident.
  function refreshOwnerLine() {
    if (!ownerChangeBtn) return;
    ownerChangeBtn.textContent = deviceOwner
      ? 'This is ' + deviceOwner.name + '’s phone · change'
      : '';
    ownerChangeBtn.style.display = deviceOwner ? '' : 'none';
  }

  function buildOwnerCarousel() {
    if (ownerCarousel || !ownerMount || typeof DMCarousel !== 'function') return;
    // Keep taps inside the picker from doing anything unexpected.
    ownerMount.addEventListener('click', function (e) { e.stopPropagation(); });
    ownerCarousel = new DMCarousel({
      mount: ownerMount,
      avatars: ROSTER_ORDER.map(avatarSpec),
      startName: ROSTER[(deviceOwner && deviceOwner.key) || ROSTER_ORDER[0]].name,
      onChange: function () { /* browsing only */ },
      onSelect: function (a) {
        if (!a || !a.key) return;
        pendingOwner = a.key;
        showOwnerConfirm();
      }
    });
    guardPhotos(ownerCarousel);
  }

  function showOwnerConfirm() {
    if (ownerConfirmName) {
      ownerConfirmName.textContent = 'You are ' + ROSTER[pendingOwner].name;
    }
    if (ownerPickView) ownerPickView.classList.add('hidden');
    if (ownerConfirmView) ownerConfirmView.classList.remove('hidden');
  }
  function showOwnerPick() {
    pendingOwner = null;
    if (ownerConfirmView) ownerConfirmView.classList.add('hidden');
    if (ownerPickView) ownerPickView.classList.remove('hidden');
  }

  function openOwnerSetup() {
    buildOwnerCarousel();
    // Point the picker at the current owner when changing, if any.
    if (ownerCarousel && deviceOwner) {
      ownerCarousel.setIndexByName(deviceOwner.name);
    }
    showOwnerPick();
    if (startScreen) startScreen.classList.add('hidden');
    if (ownerScreen) ownerScreen.classList.remove('hidden');
  }
  function closeOwnerSetup() {
    if (ownerScreen) ownerScreen.classList.add('hidden');
    if (startScreen) startScreen.classList.remove('hidden');
  }

  if (ownerConfirmBtn) {
    ownerConfirmBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!pendingOwner) return;
      saveOwner(pendingOwner);
      deviceOwner = loadOwner();
      loadOwnerAchievements(); // switch to the new owner's records
      refreshOwnerLine();
      closeOwnerSetup();
    });
  }
  if (ownerBackBtn) {
    ownerBackBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      showOwnerPick();
    });
  }
  if (ownerChangeBtn) {
    ownerChangeBtn.addEventListener('click', function (e) {
      e.stopPropagation(); // must not bubble to the tap-to-start handler
      openOwnerSetup();
    });
  }

  // Boot: known owner → straight to the start screen; unknown → set it up.
  deviceOwner = loadOwner();
  loadOwnerAchievements();
  refreshOwnerLine();
  if (!deviceOwner) openOwnerSetup();

  // ---------------------------------------------------------------------
  // Achievements page — a browsable list of every achievement with its
  // locked/unlocked state, built from ACHIEVEMENT_DEFS + the owner's
  // persisted records. Reachable from a low-key start-screen link.
  // ---------------------------------------------------------------------
  var achScreen = document.getElementById('achievements-screen');
  var achListEl = document.getElementById('ach-list');
  var achCountEl = document.getElementById('ach-count');
  var achBackBtn = document.getElementById('ach-back');
  var openAchBtn = document.getElementById('open-achievements');

  function formatAchDate(ms) {
    try {
      var d = new Date(ms);
      var mons = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      return d.getDate() + ' ' + mons[d.getMonth()] + ' ' + d.getFullYear();
    } catch (e) { return ''; }
  }

  function buildAchievementsPage() {
    if (!achListEl) return;
    var mine = ownerAchievements();
    achListEl.textContent = '';
    var unlocked = 0;

    ACHIEVEMENT_DEFS.forEach(function (def) {
      var rec = mine[def.id];
      var isUnlocked = !!(rec && rec.unlocked) || !!achievements[def.id];
      if (isUnlocked) unlocked++;
      var secretLocked = def.secret && !isUnlocked;

      var card = document.createElement('div');
      card.className = 'ach-card ' + (isUnlocked ? 'unlocked' : 'locked') +
        (def.secret ? ' secret' : '');

      // Unlocked achievements with their own art show a small thumbnail
      // (with a ✓ corner) in place of the plain badge; a locked secret
      // never reveals its image — it stays the "?" mystery badge.
      if (isUnlocked && def.image) {
        var thumbWrap = document.createElement('span');
        thumbWrap.className = 'ach-thumb-wrap';
        var thumb = document.createElement('img');
        thumb.className = 'ach-thumb';
        thumb.src = def.image;
        thumb.alt = def.name;
        thumb.draggable = false;
        thumbWrap.appendChild(thumb);
        var tick = document.createElement('span');
        tick.className = 'ach-thumb-tick';
        tick.textContent = '✓';
        thumbWrap.appendChild(tick);
        card.appendChild(thumbWrap);
      } else {
        var badge = document.createElement('div');
        badge.className = 'ach-badge';
        badge.textContent = isUnlocked ? '✓' : (def.secret ? '?' : '🔒');
        card.appendChild(badge);
      }

      var body = document.createElement('div');
      body.className = 'ach-body';

      var name = document.createElement('div');
      name.className = 'ach-name';
      name.textContent = secretLocked ? '???' : def.name;
      body.appendChild(name);

      var desc = document.createElement('div');
      desc.className = 'ach-desc';
      desc.textContent = secretLocked
        ? 'Secret achievement — keep walking to uncover it.'
        : def.desc;
      body.appendChild(desc);

      if (isUnlocked && rec && rec.unlockedAt) {
        var date = document.createElement('div');
        date.className = 'ach-date';
        date.textContent = 'UNLOCKED ' + formatAchDate(rec.unlockedAt);
        body.appendChild(date);
      }

      card.appendChild(body);
      achListEl.appendChild(card);
    });

    if (achCountEl) {
      achCountEl.textContent = unlocked + ' / ' + ACHIEVEMENT_DEFS.length + ' UNLOCKED';
    }
  }

  function openAchievements() {
    buildAchievementsPage();
    if (startScreen) startScreen.classList.add('hidden');
    if (achScreen) achScreen.classList.remove('hidden');
  }
  function closeAchievements() {
    if (achScreen) achScreen.classList.add('hidden');
    if (startScreen) startScreen.classList.remove('hidden');
  }

  if (openAchBtn) {
    openAchBtn.addEventListener('click', function (e) {
      e.stopPropagation(); // must not bubble to the tap-to-start handler
      openAchievements();
    });
  }
  if (achBackBtn) {
    achBackBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeAchievements();
    });
  }

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
    // Weight 0 — never in the normal mix; force-spawned in the end zone
    tumbleweed: { speed: 1.0, spawn: [14, 26], width: 30, drift: 0.06,
                  effect: 'stumble', penalty: 2, weight: 0, colour: '#b8895a' },
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
    // Palms line the very edges of the promenade — left lane hugs the
    // sea-wall/drop, right lane sits against the building kerb — so the
    // central walking corridor stays clear for wide, arm-in-arm squads.
    // Only the fixed scenery moved; the trapezoid/perspective is untouched.
    palm:  { interval: 18, offset: 10, lanes: [0.10, 0.90], jitter: 0.03,
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
  //   endless  only ever spawns in Endless mode (Classic never sees it)
  //   laneU    fixed lane instead of a random one (the loo hugs the kerb)
  //   spawnChance  probability the pick actually materialises (missing
  //            values = always). Thins a type out WITHOUT touching the
  //            weighted pick, so other types' rates are provably unchanged
  //            — a skipped roll just yields an empty spawn cycle.
  // The loo's sober-up amount isn't in its config: it reuses the portaloo
  // stop's PORTALOO_SOBER / _SOBER_SKIDZ values at collection time.
  var PICKUP_TYPES = {
    beer:     { spawn: [45, 80], width: 20, drunk: 1, weight: 1, colour: '#ffc233' },
    // Endless survival set — three sobering tiers. water/iceCream are
    // deliberately thinned via spawnChance (~half as often) so staying
    // sober takes real care; beer and the portaloo are left untouched.
    water:    { spawn: [45, 80], width: 18, drunk: -0.8, weight: 0.85,
                spawnChance: 0.5, colour: '#5bc8f5', endless: true },
    iceCream: { spawn: [45, 80], width: 18, drunk: -1.6, weight: 0.4,
                spawnChance: 0.5, colour: '#ffd9e8', endless: true },
    loo:      { spawn: [50, 85], width: 26, drunk: 0, weight: 0.2,
                colour: '#2d7dd2', laneU: 0.9, endless: true },
  };

  var PICKUP_INTERVAL_MIN = 5.5;  // seconds between pickup spawns
  var PICKUP_INTERVAL_MAX = 8.5;
  // Endless spawns pickups faster — with four types sharing the stream,
  // beers (the lives) still need to arrive often enough to sustain a run
  var PICKUP_INTERVAL_MIN_ENDLESS = 4.0;
  var PICKUP_INTERVAL_MAX_ENDLESS = 6.5;

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

  var SPAWN_INTERVAL_FLOOR = 0.35; // busiest it ever gets (Endless keeps ramping)

  function spawnInterval() {
    var t = distance / RUN_DISTANCE; // keeps climbing past 1 in Endless
    var v = SPAWN_INTERVAL_START + (SPAWN_INTERVAL_END - SPAWN_INTERVAL_START) * t;
    return Math.max(SPAWN_INTERVAL_FLOOR, v);
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

  // Swept overlap: the player's horizontal travel span [playerSweepLo,
  // playerSweepHi] this frame against a hazard's horizontal span [uLo, uHi]
  // (a single point when uLo === uHi). Sweeping BOTH sides means neither a
  // fast dodge nor a wide wandering group can slip through a per-point,
  // per-frame sample.
  function hitsPlayer(uLo, uHi, widthPx) {
    var reach = (playerWidth() + widthPx) * 0.5 * 0.8; // slight forgiveness
    var HL = promenadeLeft() + promenadeWidth() * uLo;
    var HH = promenadeLeft() + promenadeWidth() * uHi;
    var PL = promenadeLeft() + promenadeWidth() * playerSweepLo;
    var PH = promenadeLeft() + promenadeWidth() * playerSweepHi;
    var gap = Math.max(0, PL - HH, HL - PH); // interval distance, 0 if overlapping
    return gap < reach;
  }

  var DEPTH_BAND = 0.6; // metres either side of the avatar counted as level

  // Level with the avatar this frame: inside the depth band, OR the point
  // crossed the avatar's plane since last frame. The crossing test means a
  // fast closing speed (fast hazard + fast forward walk, or a frame hitch)
  // can never tunnel a hazard straight through the player between frames.
  function depthLevel(eff, prevEff) {
    return Math.abs(eff) < DEPTH_BAND || (eff <= 0) !== (prevEff <= 0);
  }

  function triggerStumble(cfg) {
    invulnUntil = frameNow + STUMBLE_INVULN_MS;
    shakeUntil = frameNow + STUMBLE_SHAKE_MS;
    shakeAmp = 6;
    flashUntil = frameNow + STUMBLE_FLASH_MS;
    streak = 0;             // a real collision breaks the dodge streak

    if (gameMode === MODE_ENDLESS) {
      // A beer down instead of a time penalty; out of beers = out of run
      lives -= 1;
      if (lives <= 0) {
        lives = 0;
        finishRun('endless');
      }
    } else {
      elapsed += cfg.penalty; // time penalty straight onto the run clock
    }

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
      if (enteredEndZone) {
        // Desolate edge of town: only the odd tumbleweed rolls through
        spawnHazard(undefined, 'tumbleweed');
        spawnTimer = 1.4 + Math.random() * 1.4;
      } else {
        spawnHazard();
        spawnTimer = spawnInterval();
      }
    }
    ensureRoseSeller();

    for (var i = hazards.length - 1; i >= 0; i--) {
      var h = hazards[i];
      var cfg = h.cfg;
      h.age += dt;
      h.worldZ -= cfg.speed * dt;

      if (skidzSoiled && !cfg.ground && !h.harmless) {
        // Everyone can smell it: hazards abandon their own patterns and
        // home in on the player for the rest of the run
        if (!h.soilLine) {
          h.soilLine = SOIL_LINES[Math.floor(Math.random() * SOIL_LINES.length)];
        }
        var pull = playerU - h.u;
        h.u += Math.max(-1, Math.min(1, pull * 6)) * HOMING_RATE * dt;
      } else if (h.wanderAmp) {
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
      if (h.prevMA === undefined) h.prevMA = mA;

      // Cleanup: fully past the player, or drifted off the promenade
      if (m < bottomMetres() - 2 || h.u < -0.05 || h.u > 1.05) {
        hazards.splice(i, 1);
        continue;
      }

      // Collisions, checked at the avatar's actual depth (swept so nothing
      // tunnels through, and groups collide as one solid footprint)
      if (cfg.ground) {
        if (!h.hit && frameNow >= skidUntil &&
            depthLevel(mA, h.prevMA) && overlapsPlayer(h.u, cfg.width)) {
          triggerSkid(h);
        }
      } else if (!h.harmless) {
        var collided = false;
        if (h.members) {
          var levelNow = false, lo = Infinity, hi = -Infinity;
          for (var j = 0; j < h.members.length; j++) {
            var mem = h.members[j];
            if (depthLevel(mA + mem.dz, h.prevMA + mem.dz)) levelNow = true;
            var mu = h.u + mem.du;
            if (mu < lo) lo = mu;
            if (mu > hi) hi = mu;
          }
          // While any of the group is level with us, the whole group span
          // is the obstacle — matches the blob you see, not phantom gaps
          if (levelNow && hitsPlayer(lo, hi, cfg.width)) {
            collided = true;
          }
        } else {
          var mult = (h.variant === 'roseSeller' || h.variant === 'lookyMan')
            ? 1.6 : 1; // vendors get a friendlier catch radius
          if (depthLevel(mA, h.prevMA) && hitsPlayer(h.u, h.u, cfg.width * mult)) {
            collided = true;
          }
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
      h.prevMA = mA;
    }

    // Fixed scenery collides like any stationary hazard: a stumble
    if (frameNow >= invulnUntil) {
      var items = sceneryItems();
      for (var si = 0; si < items.length; si++) {
        var it = items[si];
        var sm = it.worldZ - distance - playerM();
        if (Math.abs(sm) < 0.7 &&
            hitsPlayer(it.u, it.u, it.cfg.width * it.cfg.hit)) {
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
      // Lee's two-panel cutscene (tap to advance), timer frozen like the
      // other comics. The carried-rose grant below is unchanged.
      queueLeeRoseComic();
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
      unlockAchievement('tatTrifecta', 'Tat Trifecta', true);
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
      queuePhotoOverlay({
        image: 'images/achievements/shark-fed.png',
        caption: 'The shark has fed, all the little fish are happy',
      });
      unlockAchievement('sharkFed', 'The Shark Has Fed', true);
      if (delivered) unlockAchievement('bridesBouquet', "Bride's Bouquet", true);
      return;
    }

    if (delivered) {
      // SECRET: rose delivered to the bride — the jackpot outcome
      addScore(BRIDE_POINTS);
      drunk = Math.max(0, drunk - SWAGGER_SUPER);
      multUntil = frameNow + CHAT_MULT_MS;
      queuePhotoOverlay({
        image: 'images/achievements/brides-bouquet.png',
        caption: 'The bride gets her bouquet — the whole hen do erupts! ' +
                 '+' + BRIDE_POINTS,
      });
      unlockAchievement('bridesBouquet', "Bride's Bouquet", true);
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
    unlockAchievement('sharingTheLove', 'Sharing the Love', true);
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
  // The pickup pool for the current mode: Classic sees only the beer;
  // Endless adds the three sobering tiers.
  function activePickupTypes() {
    if (gameMode === MODE_ENDLESS) return PICKUP_TYPES;
    var out = {};
    for (var key in PICKUP_TYPES) {
      if (!PICKUP_TYPES[key].endless) out[key] = PICKUP_TYPES[key];
    }
    return out;
  }

  function spawnPickup() {
    var types = activePickupTypes();
    var key = weightedPick(types);
    var cfg = types[key];
    // A thinned type (water/iceCream) sometimes doesn't materialise — an
    // empty cycle. Beer and the loo have no spawnChance, so their rates
    // are unchanged by this.
    if (cfg.spawnChance !== undefined && Math.random() >= cfg.spawnChance) return;
    pickups.push({
      key: key,
      cfg: cfg,
      pickup: true,
      worldZ: distance + cfg.spawn[0] + Math.random() * (cfg.spawn[1] - cfg.spawn[0]),
      u: cfg.laneU !== undefined ? cfg.laneU : 0.1 + Math.random() * 0.8,
    });
  }

  function collectPickup(p) {
    if (p.key === 'loo') {
      // The portaloo pickup reuses the portaloo stop's mechanic wholesale,
      // Skidz bonus included — the biggest sober-up of the three tiers
      var relief = squadIncludes('skidz') ? PORTALOO_SOBER_SKIDZ : PORTALOO_SOBER;
      drunk = Math.max(0, drunk - relief);
      notify('PORTALOO — sweet relief');
      return;
    }
    drunk = Math.max(0, drunk + p.cfg.drunk);
    if (p.key === 'beer' && gameMode === MODE_ENDLESS && lives < ENDLESS_LIVES) {
      lives += 1; // a beer back in the hand — one life refilled
      notify('BEER — back up to ' + lives + (lives === 1 ? ' life' : ' lives'));
    } else if (p.key === 'water') {
      notify('WATER — sobering up a touch');
    } else if (p.key === 'iceCream') {
      notify('ICE CREAM — head clearing');
    }
  }

  function updatePickups(dt) {
    pickupTimer -= dt;
    if (pickupTimer <= 0) {
      spawnPickup();
      pickupTimer = gameMode === MODE_ENDLESS
        ? PICKUP_INTERVAL_MIN_ENDLESS +
          Math.random() * (PICKUP_INTERVAL_MAX_ENDLESS - PICKUP_INTERVAL_MIN_ENDLESS)
        : PICKUP_INTERVAL_MIN +
          Math.random() * (PICKUP_INTERVAL_MAX - PICKUP_INTERVAL_MIN);
    }

    for (var i = pickups.length - 1; i >= 0; i--) {
      var p = pickups[i];
      var m = p.worldZ - distance;
      if (m < bottomMetres() - 2) {
        pickups.splice(i, 1); // missed it — gone below the screen
      } else if (Math.abs(m - playerM()) < 0.7 &&
                 overlapsPlayer(p.u, p.cfg.width)) {
        collectPickup(p);
        pickups.splice(i, 1); // collected
      }
    }
  }

  // ---------------------------------------------------------------------
  // Selfie spots + the photo overlay — a reusable pause-and-show system.
  // Selfie spots are individually placed (not interval-repeated like
  // palms/benches); future stop-offs (ice cream shop, the island...)
  // trigger the same queuePhotoOverlay() with their own image/caption.
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

  // ---------------------------------------------------------------------
  // The single pause-overlay queue. EVERYTHING that pauses the game for
  // the player's attention — narrative message cards (portaloo, shark,
  // secret achievements), photo/comic overlays (selfies, cutscenes,
  // interludes) — goes through this one ordered queue. Only one thing
  // shows at a time; anything triggered while something is up waits its
  // turn, so simultaneous events (a selfie spot mid-soiling, an island
  // interlude on top of an achievement) resolve cleanly one after
  // another instead of stacking pause states.
  // Lightweight ambient feedback (rose pill, points, close shaves)
  // stays on the non-pausing HUD notify() path.
  // ---------------------------------------------------------------------
  var msgOverlay = document.getElementById('msg-overlay');
  var msgCard = document.getElementById('msg-card');
  var overlayQueue = []; // entries: {msg: text} or {photo: opts}
  var msgOpen = false;
  var photoOpen = false;

  function pumpOverlays() {
    if (msgOpen || photoOpen || !overlayQueue.length) return;
    var next = overlayQueue.shift();
    if (next.msg !== undefined) {
      if (!msgOverlay) return;
      msgCard.textContent = next.msg;
      msgOverlay.classList.remove('hidden');
      msgOpen = true;
    } else {
      if (!photoOverlay) return;
      var opts = next.photo;
      photoFrame.style.background = opts.image
        ? 'center / cover no-repeat url("' + opts.image + '")'
        : (opts.colour || '#333');
      photoCaption.textContent = opts.caption || '';
      photoOverlay.classList.remove('hidden');
      photoOpen = true;
    }
    paused = true;
  }

  function showMessage(text) {
    overlayQueue.push({ msg: text });
    pumpOverlays();
  }

  function queuePhotoOverlay(opts) {
    overlayQueue.push({ photo: opts });
    pumpOverlays();
  }

  function overlayDismissed() {
    pumpOverlays();
    if (!msgOpen && !photoOpen && !overlayQueue.length) paused = false;
  }

  // Close everything immediately (run reset)
  function closeAllOverlays() {
    overlayQueue.length = 0;
    msgOpen = false;
    photoOpen = false;
    if (msgOverlay) msgOverlay.classList.add('hidden');
    if (photoOverlay) photoOverlay.classList.add('hidden');
    paused = false;
  }

  if (photoOverlay) {
    photoOverlay.addEventListener('click', function () {
      photoOverlay.classList.add('hidden');
      photoOpen = false;
      overlayDismissed();
    });
  }

  if (msgOverlay) {
    msgOverlay.addEventListener('click', function () {
      msgOverlay.classList.add('hidden');
      msgOpen = false;
      overlayDismissed();
    });
  }

  function updateSelfieSpots() {
    for (var i = 0; i < SELFIE_SPOTS.length; i++) {
      if (selfieUsed[i]) continue;
      var spot = SELFIE_SPOTS[i];
      var mA = spot.z - distance - playerM();
      if (Math.abs(mA) < 1.2 && overlapsPlayer(spot.u, 56)) {
        selfieUsed[i] = true;
        queuePhotoOverlay(spot); // queues politely behind anything showing
      }
    }
  }

  // ---------------------------------------------------------------------
  // One-off stops — the portaloo on a side street and Steve's Ice Cream
  // Stop. Both singletons per run, both driven directly by the character
  // selection state (leadChar + squad), no separate flags.
  // ---------------------------------------------------------------------
  var PORTALOO_SOBER = 2.5;      // standard sober-up relief
  var PORTALOO_SOBER_SKIDZ = 4;  // when Skidz is playing or walking along
  var STEVE_BOOST = 3;           // full ice cream interlude with Steve there
  var STEVE_BOOST_SMALL = 1.5;   // quick pass-over without him
  var PORTALOO_U = 0.93;         // parked right on the kerb at its opening
  var ICE_SHOP_U = 0.92;

  var portalooUsed = false;
  var steveUsed = false;

  // The portaloo sits on the side street in window 2 (~150-210m); the
  // ice cream shop is a doorway in the frontage a couple of blocks
  // before window 3's opening (~215-260m). Both derive from the same
  // deterministic road layout, so they're identical every run.
  function portalooZ() {
    return (roadStartBlock(2) + 0.5) * BUILDING_METRES;
  }

  function steveShopZ() {
    return (roadStartBlock(3) - 2) * BUILDING_METRES + 3;
  }

  function squadIncludes(key) {
    if (leadChar === key) return true;
    for (var i = 0; i < squad.length; i++) {
      if (squad[i].key === key && !squad[i].lost) return true;
    }
    return false;
  }

  // Skidz and the portaloo: use it and the accident is averted; pass it
  // by with him along and he goes for the rest of the run — and every
  // hazard on the promenade homes in on the smell, heckling as they come.
  var skidzSoiled = false;
  var HOMING_RATE = 0.22; // widths/sec hazards close on the player when soiled
  var SOIL_LINES = ['Dirty bastard!', 'He stinks!', 'Filthy bastard!'];

  // ---------------------------------------------------------------------
  // THE ISLAND — a distant landmark out in the sea at a fixed point on
  // the route. Not a doorway: tap it, or drift close along the sea wall,
  // to set off the Robby three-way (driven by leadChar + squad). The
  // comic-strip is three panels queued through the shared photo overlay,
  // so it's tap-to-advance like any other queued overlay.
  // ---------------------------------------------------------------------
  var ISLAND_Z = 185;            // fixed position along the route
  var ISLAND_SEA_X = -0.55;      // how far out to sea, as a fraction of W
  var islandUsed = false;

  // Three-panel gag, shown in narrative order for the Robby variants.
  var ISLAND_COMIC = [
    { image: 'images/comics/island-1.png',
      caption: 'Robby charges into the surf. Strong start.' },
    { image: 'images/comics/island-2.png',
      caption: 'Twenty metres out... arms windmilling... glug... glug.' },
    { image: 'images/comics/island-3.png',
      caption: 'A passing pedalo hauls him out by the trunks. The island remains unconquered.' },
  ];

  function queueIslandComic() {
    ISLAND_COMIC.forEach(function (panel) { queuePhotoOverlay(panel); });
  }

  // Steve's Ice Cream Stop — the full three-panel interlude, shown only
  // when Steve is actually along. Same tap-to-advance queue as the island.
  var STEVE_COMIC = [
    { image: 'images/comics/icecream-1.png',
      caption: 'Steve strides up. “Hola amigo! Diez helados, por fa-vor!” Confident. Wrong, but confident.' },
    { image: 'images/comics/icecream-2.png',
      caption: 'The vendor just laughs. A queue builds behind him. Steve doubles down, gesturing wildly.' },
    { image: 'images/comics/icecream-3.png',
      caption: 'Somehow — a mountain of ice cream. Steve strolls off, vendor waving. Sugar-steadied, the squad marches on.' },
  ];

  function queueSteveComic() {
    STEVE_COMIC.forEach(function (panel) { queuePhotoOverlay(panel); });
  }

  // Lee's rose-seller cutscene — two panels, shown only when playing as
  // Lee. Same tap-to-advance queue as the island/ice cream. (Files are
  // roses-1/2.png, the actual on-disk names of the Lee rose art.)
  var LEE_ROSE_COMIC = [
    { image: 'images/comics/roses-1.png',
      caption: 'Lee bites clean into a rose — just for the bants. The vendor stares, horrified.' },
    { image: 'images/comics/roses-2.png',
      caption: 'Fair’s fair. Lee sheepishly buys the whole bunch — the vendor is delighted.' },
  ];

  function queueLeeRoseComic() {
    LEE_ROSE_COMIC.forEach(function (panel) { queuePhotoOverlay(panel); });
  }

  // The island's centre in screen space, or null when not in view
  function islandScreenPos() {
    var m = ISLAND_Z - distance;
    if (m < 2 || m > DRAW_DISTANCE) return null;
    var d = depthOf(m);
    var s = spreadOf(d);
    var seaLevel = depthToY(d) + (dropHeight() + H * 0.075) * d;
    return {
      x: depthToX(wallX() + W * ISLAND_SEA_X, d),
      y: seaLevel,
      s: s,
    };
  }

  function triggerIsland() {
    if (islandUsed) return;
    islandUsed = true;
    if (leadChar === 'robby') {
      showMessage('I think I can swim that');
      queueIslandComic();
    } else if (squadIncludes('robby')) {
      showMessage('Robby, I think you could swim that');
      queueIslandComic();
    } else {
      // No Robby, no swim — just the banter, no comic panels
      showMessage("I think Robby could swim that, shame he isn't here");
    }
  }

  function updateIsland() {
    if (islandUsed) return;
    // Drifting close along the sea wall, level with the island, counts
    // as taking an interest
    var mA = ISLAND_Z - distance - playerM();
    if (Math.abs(mA) < 3 && playerU < 0.15) triggerIsland();
  }

  function updateStops() {
    if (!portalooUsed) {
      var mp = portalooZ() - distance - playerM();
      // (no doubling back once the damage is done)
      if (!skidzSoiled && Math.abs(mp) < 1.0 &&
          hitsPlayer(PORTALOO_U, PORTALOO_U, 44)) {
        portalooUsed = true;
        if (squadIncludes('skidz')) {
          drunk = Math.max(0, drunk - PORTALOO_SOBER_SKIDZ);
          showMessage(leadChar === 'skidz'
            ? "I shouldn't shit myself before Daytona now."
            : 'Skidz you better use the loo before we go any further.');
          unlockAchievement('closeCall', 'Close Call', true);
        } else {
          drunk = Math.max(0, drunk - PORTALOO_SOBER);
          showMessage('Sweet relief — sobering up.');
        }
      } else if (!skidzSoiled && squadIncludes('skidz') &&
                 distance - playerM() > portalooZ() + 2) {
        // Walked straight past it with Skidz along — too late now
        skidzSoiled = true;
        showMessage('Skidz couldn’t hold it. He’s gone and shit ' +
          'himself. The squad edges away… “You dirty bastard.”');
      }
    }

    if (!steveUsed) {
      var ms2 = steveShopZ() - distance - playerM();
      if (Math.abs(ms2) < 1.0 && hitsPlayer(ICE_SHOP_U, ICE_SHOP_U, 52)) {
        steveUsed = true;
        if (squadIncludes('steve')) {
          // Steve's here — the full three-panel interlude (tap to advance),
          // timer frozen while it plays, like the island comic.
          drunk = Math.max(0, drunk - STEVE_BOOST);
          queueSteveComic();
        } else {
          // Steve's not with you — you bump into him outside, ordering
          drunk = Math.max(0, drunk - STEVE_BOOST_SMALL);
          showMessage('You meet Steve talking rubbish Spanish, but ' +
            'somehow he manages to order you an ice cream.');
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

  // ---------------------------------------------------------------------
  // Side streets — deterministic gaps in the building frontage, one per
  // ~72m window at an irregular offset within it (same fixed-placement
  // idea as palms/benches, so every run looks identical).
  // ---------------------------------------------------------------------
  var ROAD_EVERY_BLOCKS = 12;  // one opening per this many building blocks
  var ROAD_WIDTH_BLOCKS = 2;   // openings are two blocks (~12m) wide

  function roadStartBlock(windowIdx) {
    return windowIdx * ROAD_EVERY_BLOCKS + 1 +
      Math.floor(rand(windowIdx * 13.7) * (ROAD_EVERY_BLOCKS - ROAD_WIDTH_BLOCKS - 2));
  }

  function isRoadBlock(b) {
    if (b < 0) return false;
    var w = Math.floor(b / ROAD_EVERY_BLOCKS);
    var start = roadStartBlock(w);
    return b >= start && b < start + ROAD_WIDTH_BLOCKS;
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

      if (isRoadBlock(b)) {
        // A side street: tarmac running off to the right instead of a
        // facade — only drawn on the opening's near block so the two-
        // block gap reads as one road
        if (!isRoadBlock(b - 1)) {
          var mFar = Math.max((b + ROAD_WIDTH_BLOCKS) * BUILDING_METRES - distance, mBottom);
          var dFar = depthOf(mFar);
          var yFar = depthToY(dFar);
          var xNear = depthToX(right, d);
          var xFar = depthToX(right, dFar);
          ctx.fillStyle = '#2f3542';
          ctx.beginPath();
          ctx.moveTo(xNear, y);
          ctx.lineTo(W + 12, y);
          ctx.lineTo(W + 12, yFar);
          ctx.lineTo(xFar, yFar);
          ctx.closePath();
          ctx.fill();
          // faded centre line heading away down the street
          var yMid = (y + yFar) / 2;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
          ctx.lineWidth = Math.max(1, 2 * s);
          ctx.setLineDash([6 * s, 6 * s]);
          ctx.beginPath();
          ctx.moveTo((xNear + xFar) / 2, yMid);
          ctx.lineTo(W + 12, yMid);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        continue; // no facade on road blocks
      }

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

    // Body — rounded rectangle in the lead character's colour, flickering
    // white during a stumble
    var flashing = time < flashUntil && Math.floor(time / 70) % 2 === 0;
    ctx.fillStyle = flashing ? '#ffffff' : leadColour();
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

  // A white speech bubble with a tail, anchored above a figure. Shared
  // by the looky looky man's pitch and the soiled-state heckling. The
  // box sizes itself to the text so any line fits cleanly whatever its
  // length.
  function drawBubble(x, tailY, text, w) {
    var fontPx = Math.max(10, Math.round(w * 0.42));
    ctx.font = fontPx + 'px "DM Sans", sans-serif';
    var padX = fontPx * 0.7;
    var bw = ctx.measureText(text).width + padX * 2;
    var bh = fontPx + fontPx * 0.7;
    var by = tailY - bh;
    ctx.fillStyle = '#ffffff';
    roundRect(x - bw / 2, by, bw, bh, bh * 0.4);
    ctx.fill();
    ctx.beginPath(); // bubble tail
    ctx.moveTo(x - bh * 0.3, by + bh);
    ctx.lineTo(x + bh * 0.3, by + bh);
    ctx.lineTo(x, by + bh + bh * 0.45);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#0a1628';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, by + bh / 2);
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

    if (h.key === 'tumbleweed') {
      // A dry tangle rolling through the empty edge of town
      var rr = w2 * 0.5;
      var spin = h.age * 3;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.beginPath();
      ctx.ellipse(x2, y2, rr * 0.9, rr * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = cfg.colour;
      ctx.lineWidth = Math.max(1, w2 * 0.06);
      ctx.beginPath();
      ctx.arc(x2, y2 - rr, rr, 0, Math.PI * 2);
      for (var tw = 0; tw < 6; tw++) {
        var a = spin + tw * (Math.PI / 3);
        ctx.moveTo(x2, y2 - rr);
        ctx.lineTo(x2 + Math.cos(a) * rr, y2 - rr + Math.sin(a) * rr);
      }
      ctx.stroke();
      return;
    }

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
      drawBubble(x2, y2 - w2 * 2.6, 'Looky looky', w2);
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

    if (p.key === 'water') {
      // A clear bottle: slim body, darker cap
      var bh = w * 1.3;
      ctx.fillStyle = cfg.colour;
      roundRect(x - w * 0.28, y - bh, w * 0.56, bh, w * 0.16);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'; // label band
      ctx.fillRect(x - w * 0.28, y - bh * 0.62, w * 0.56, bh * 0.26);
      ctx.fillStyle = '#1d5fa8'; // cap
      ctx.fillRect(x - w * 0.14, y - bh - w * 0.18, w * 0.28, w * 0.18);
      return;
    }

    if (p.key === 'iceCream') {
      // A cone with a pink scoop and a flake
      var ch = w * 0.9;
      ctx.fillStyle = '#d9a066'; // cone
      ctx.beginPath();
      ctx.moveTo(x - w * 0.34, y - ch);
      ctx.lineTo(x + w * 0.34, y - ch);
      ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = cfg.colour; // scoop
      ctx.beginPath();
      ctx.arc(x, y - ch, w * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#8b5a2b'; // the flake
      ctx.lineWidth = Math.max(1.5, w * 0.12);
      ctx.beginPath();
      ctx.moveTo(x + w * 0.12, y - ch - w * 0.3);
      ctx.lineTo(x + w * 0.3, y - ch - w * 0.72);
      ctx.stroke();
      return;
    }

    if (p.key === 'loo') {
      // A portaloo, same box as the side-street one, pickup-sized
      var lh = w * 1.7;
      ctx.fillStyle = cfg.colour; // cabin
      roundRect(x - w / 2, y - lh, w, lh, w * 0.08);
      ctx.fill();
      ctx.fillStyle = '#1d5fa8'; // roof cap
      ctx.fillRect(x - w * 0.56, y - lh - w * 0.14, w * 1.12, w * 0.18);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'; // door outline
      ctx.lineWidth = Math.max(1, w * 0.05);
      ctx.strokeRect(x - w * 0.32, y - lh * 0.88, w * 0.64, lh * 0.82);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x + w * 0.2, y - lh * 0.45, w * 0.05, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

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

  // The Daytona entrance at the 400m line: a glowing archway hugging the
  // building side, so the only way past is a committed skirt down the
  // left. Walk into it (right side) to finish.
  function drawDaytona(it, m) {
    var d = depthOf(m);
    var s = spreadOf(d);
    var y = depthToY(d);
    var xL = depthToX(promenadeLeft() + promenadeWidth() * DAYTONA_ARCH_LEFT_U, d);
    var xR = depthToX(promenadeLeft() + promenadeWidth() * 1.0, d);
    var ph = 150 * s; // pillar height

    ctx.fillStyle = 'rgba(255, 77, 157, 0.18)'; // spill on the pavement
    ctx.beginPath();
    ctx.ellipse((xL + xR) / 2, y, (xR - xL) * 0.55, 16 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ff4d9d'; // pillars
    ctx.fillRect(xL, y - ph, 10 * s, ph);
    ctx.fillRect(xR - 10 * s, y - ph, 10 * s, ph);

    ctx.fillStyle = '#1d1d2b'; // marquee header
    ctx.fillRect(xL - 6 * s, y - ph - 26 * s, (xR - xL) + 12 * s, 26 * s);
    ctx.fillStyle = '#ffd166';
    ctx.font = Math.max(8, Math.round(15 * s)) + 'px "Bebas Neue", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('DAYTONA', (xL + xR) / 2, y - ph - 13 * s);

    // dotted light bulbs along the header
    ctx.fillStyle = '#ff4d9d';
    for (var i = 0; i <= 6; i++) {
      ctx.beginPath();
      ctx.arc(xL + ((xR - xL) / 6) * i, y - ph - 26 * s, 2.5 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // The Island: a hazy silhouette out in the sea — a mound, a lone palm,
  // and a shimmer of moonlight on the water beneath it
  function drawIsland(it, m) {
    var p = islandScreenPos();
    if (!p) return;
    var r = 55 * p.s;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)'; // moonlit shimmer
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + r * 0.18, r * 1.15, r * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#1d3b2f'; // the mound
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r, r * 0.38, 0, Math.PI, 0);
    ctx.fill();

    ctx.strokeStyle = '#173125'; // lone palm silhouette
    ctx.lineWidth = Math.max(1.5, r * 0.07);
    ctx.beginPath();
    ctx.moveTo(p.x + r * 0.25, p.y - r * 0.3);
    ctx.lineTo(p.x + r * 0.32, p.y - r * 0.85);
    ctx.stroke();
    ctx.fillStyle = '#173125';
    ctx.beginPath();
    ctx.ellipse(p.x + r * 0.32, p.y - r * 0.9, r * 0.3, r * 0.11, -0.3, 0, Math.PI * 2);
    ctx.ellipse(p.x + r * 0.28, p.y - r * 0.92, r * 0.26, r * 0.1, 0.5, 0, Math.PI * 2);
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

  // The portaloo: a blue plastic box parked on its side street
  function drawPortaloo(it, m) {
    var d = depthOf(m);
    var s = spreadOf(d);
    var x = depthToX(promenadeLeft() + promenadeWidth() * it.u, d);
    var y = depthToY(d);
    var w = 40 * s;
    var h2 = w * 1.7;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.beginPath();
    ctx.ellipse(x, y, w * 0.6, w * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#2d7dd2'; // the cabin
    roundRect(x - w / 2, y - h2, w, h2, w * 0.08);
    ctx.fill();
    ctx.fillStyle = '#1d5fa8'; // roof cap
    ctx.fillRect(x - w * 0.56, y - h2 - w * 0.14, w * 1.12, w * 0.18);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'; // door outline + vents
    ctx.lineWidth = Math.max(1, w * 0.05);
    ctx.strokeRect(x - w * 0.32, y - h2 * 0.88, w * 0.64, h2 * 0.82);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x + w * 0.2, y - h2 * 0.45, w * 0.05, 0, Math.PI * 2);
    ctx.fill();
  }

  // Steve's Ice Cream Stop: a cream-lit doorway with a cone on the sign
  function drawIceShop(it, m) {
    var d = depthOf(m);
    var s = spreadOf(d);
    var x = depthToX(promenadeLeft() + promenadeWidth() * it.u, d);
    var y = depthToY(d);
    var w = 48 * s;
    var h2 = w * 1.8;

    ctx.fillStyle = 'rgba(255, 214, 232, 0.25)'; // light on the pavement
    ctx.beginPath();
    ctx.ellipse(x, y, w * 0.9, w * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#8a4a5e'; // frame
    ctx.fillRect(x - w * 0.62, y - h2 - w * 0.12, w * 1.24, h2 + w * 0.12);
    ctx.fillStyle = '#ffe3ec'; // the glow inside
    ctx.fillRect(x - w * 0.5, y - h2, w, h2);
    // the cone on the sign
    ctx.fillStyle = '#e0a458';
    ctx.beginPath();
    ctx.moveTo(x - w * 0.14, y - h2 - w * 0.16);
    ctx.lineTo(x + w * 0.14, y - h2 - w * 0.16);
    ctx.lineTo(x, y - h2 - w * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ff8fab';
    ctx.beginPath();
    ctx.arc(x, y - h2 - w * 0.16, w * 0.16, Math.PI, 0);
    ctx.fill();
  }

  // Hazards, scenery, pickups, selfie spots, the stops, and the chip
  // shop drawn together, far-to-near so overlaps stack correctly; split
  // around the player's depth so passed objects draw over them.
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
    if (gameMode === MODE_CLASSIC) {
      items.push({ daytona: true, worldZ: RUN_DISTANCE, u: 0.7 });
      items.push({ chipDoor: true, worldZ: chipShopZ(), u: CHIP_DOOR_U });
    }
    items.push({ island: true, worldZ: ISLAND_Z, u: 0 });
    items.push({ loo: true, worldZ: portalooZ(), u: PORTALOO_U });
    items.push({ ice: true, worldZ: steveShopZ(), u: ICE_SHOP_U });
    items.sort(function (a, b) { return b.worldZ - a.worldZ; });

    for (var j = 0; j < items.length; j++) {
      var m = items[j].worldZ - distance;
      if (m > DRAW_DISTANCE) continue;
      if (behindPlayer ? m >= 0 : m < 0) continue;
      if (items[j].scenery) drawScenery(items[j], m);
      else if (items[j].pickup) drawPickup(items[j], m);
      else if (items[j].selfie) drawSelfie(items[j], m);
      else if (items[j].daytona) drawDaytona(items[j], m);
      else if (items[j].chipDoor) drawChipDoor(items[j], m);
      else if (items[j].loo) drawPortaloo(items[j], m);
      else if (items[j].ice) drawIceShop(items[j], m);
      else if (items[j].island) drawIsland(items[j], m);
      else {
        drawHazard(items[j], m);
        // Soiled state: the whole promenade heckles as it closes in
        if (items[j].soilLine && !items[j].harmless) {
          var hd = depthOf(m);
          var hs = spreadOf(hd);
          var hw = items[j].cfg.width * hs;
          drawBubble(
            depthToX(promenadeLeft() + promenadeWidth() * items[j].u, hd),
            depthToY(hd) - hw * 2.2,
            items[j].soilLine,
            hw
          );
        }
      }
    }
  }

  // A tiny pint icon for the Endless lives row — full amber when the
  // life remains, hollow once it's spent.
  function drawBeerIcon(x, y, filled) {
    var w = 8, h = 11;
    if (filled) {
      ctx.fillStyle = '#ffc233';
      roundRect(x - w / 2, y - h / 2, w, h, 1.5);
      ctx.fill();
      ctx.fillStyle = '#fff6e0'; // foam head
      ctx.fillRect(x - w / 2, y - h / 2, w, 2.5);
    } else {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 1;
      roundRect(x - w / 2, y - h / 2, w, h, 1.5);
      ctx.stroke();
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

    // Distance top left — Endless has no finish line to count toward
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    var distText = gameMode === MODE_ENDLESS
      ? Math.floor(distance) + 'm'
      : Math.floor(distance) + 'm / ' + RUN_DISTANCE + 'm';
    ctx.fillText(distText, 14, mid);

    // Timer top right
    ctx.fillStyle = '#ffd166';
    ctx.textAlign = 'right';
    ctx.fillText(elapsed.toFixed(1) + 's', W - 14, mid);

    // Endless lives — beers left, drawn just after the distance readout
    if (gameMode === MODE_ENDLESS) {
      var bx = 14 + ctx.measureText(distText).width + 14;
      for (var li = 0; li < ENDLESS_LIVES; li++) {
        drawBeerIcon(bx + li * 15, mid, li < lives);
      }
    }

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
  function drawAvatar(x, y, r, isPlayer, colour, lost, key) {
    var photo = key && avatarImgs[key];
    if (lost) {
      // Benched: dimmed shell, no wares, no colour — a ghost of the
      // photo stays visible so you can tell who you lost
      ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (photo) {
        ctx.save();
        ctx.globalAlpha = 0.18;
        drawAvatarPhoto(photo, x, y, r);
        ctx.restore();
      }
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }

    ctx.fillStyle = colour || 'rgba(255, 255, 255, 0.10)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (photo) drawAvatarPhoto(photo, x, y, r);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
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

    drawAvatar(cx - 56, cy, 22, true, leadColour(), false, leadChar); // the player, larger
    for (var i = 0; i < squad.length; i++) {
      drawAvatar(cx + i * 34, cy, 12, false, squad[i].colour, squad[i].lost, squad[i].key);
    }
  }

  // ---------------------------------------------------------------------
  // Main loop — requestAnimationFrame
  // ---------------------------------------------------------------------
  function frame(time) {
    var dt = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 0;
    lastTime = time;
    frameNow = time;

    // Move the player first and record the horizontal span they covered
    // this frame, so hazard collisions can swept-test against that span
    // (a fast dodge on a frame hitch can't tunnel through).
    var u0 = playerU;
    updatePlayer(dt);
    playerSweepLo = Math.min(u0, playerU);
    playerSweepHi = Math.max(u0, playerU);

    if (state === STATE_WALKING && !paused) {
      // walkRate() goes negative when the avatar pulls back down the band.
      // Classic clamps just past the end of the route; Endless never stops.
      var topZ = gameMode === MODE_ENDLESS ? Infinity : endOfRoute() + 3;
      distance = Math.max(0, Math.min(topZ, distance + walkRate() * dt));
      elapsed += dt;
      updateHazards(dt);
      updatePickups(dt);
      updateSelfieSpots();
      updateStops();
      updateIsland();
      checkFinish();
    }

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
