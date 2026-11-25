/*
 * Backrooms Recovery — 頁面層自動游玩 Bot（路線 A：視覺規則型）
 *
 * 邊界說明（成品為 IL2CPP wasm，未對 JS 開放內部狀態）：
 * - 本檔只讀 canvas 畫素與 HUD 區域亮度/顏色，合成鍵盤與滑鼠事件。
 * - 讀不到玩家座標、記憶值內部數值、實體/碎片位置、NavMesh；決策為反應式規則，
 *   不是全知規劃。怪物在側邊/背後/牆後偵測不到；迷宮中可能繞圈或卡死。
 * - 靜態世界模型（re/world-model.json、re/agents.json）為路 2 離線解包產出：載入目標點座標、
 *   NavMesh 參數、怪物速度表與目標優先序。
 * - 路線 3 已可用：live-probe.js（window.BRLive）經 IL2CPP invoker 呼叫 Transform getter，
 *   讀回玩家/攝影機/怪獸即時世界座標與姿態，以及記憶%、電池、愛心、怪物感知狀態。
 *   規劃層因此以「座標朝向 + 最近目標」導航；視覺規則作為無 live 時的後備。
 * - 不修改 Build/ 內 wasm、data、framework、loader；live-probe 為唯讀（不寫記憶體）。
 * - 陷阱：WebGL 預設幀緩衝未開 preserveDrawingBuffer，`gl.readPixels` 會使畫面全黑；
 *   因此有即時座標時完全不讀像素，僅在無座標的後備模式以 3Hz 節流讀取。
 *
 * 操作：B 鍵或右上角按鈕切換 AUTO；玩家手動按鍵/觸控會自動關閉 bot 收回控制權。
 * 開關狀態存 localStorage（br_auto）。除錯資訊顯示在按鈕下方。
 */
(function () {
  "use strict";
  if (window.BackroomsAutoBot) return;

  var STORAGE_KEY = "br_auto";
  var W = 96, H = 60; // 取幀縮取解析度
  var buf = new Uint8Array(W * H * 4);

  var canvas = null, gl = null;
  var enabled = false;
  try { enabled = localStorage.getItem(STORAGE_KEY) === "1"; } catch (e) {}

  var held = {};              // 目前按住的虛擬按鍵
  var mode = "explore";       // explore | avoid | stuck | fallback
  var injected = false;       // 過濾自身注入事件，避免被誤判為玩家接管
  var lastTurnAt = 0;
  var lastModeAt = 0;
  var prevHash = "";
  var stuckFrames = 0;
  var turnDir = 1;
  var button = null, overlayButton = null, debugEl = null;
  var sense = {
    mode: mode, frameOK: false, frameBlank: false,
    centerLum: 0, leftLum: 0, rightLum: 0, pink: 0
  };

  // ---------- 畫面 overlay：3D 世界點投影到螢幕標記 ----------

  var OVERLAY_FOV_DEG = 60;   // 主鏡頭垂直 FOV（無處可讀時的預設值）
  var overlay = { canvas: null, ctx: null, visible: true };

  // ---------- 路線 3 即時狀態（window.BRLive，唯讀） ----------

  var LIVE_POLL_MS = 160;
  var lastLiveAt = 0;
  var live = {
    ok: false, reason: "",
    player: null, monster: null, camera: null, scalars: {},
    goal: null, goalDist: 0, monsterDist: 0, yawErr: 0
  };
  var spawnAnchor = null;
  var lastMem = null;
  var NAV = {
    goalRadius: 1.5,      // 抵達判定（公尺）
    approachRadius: 3.2,  // 進入貼近段（小步慢轉）
    approachAlign: 7,     // 貼近段對準容差
    alignDeg: 12,         // 對準容差（度）
    walkAlignDeg: 35,     // 誤差超過此值就停下轉向
    steerInterval: 230,   // 轉向注入最小間隔（毫秒）
    escapeMs: 2000,       // 脫困持續時間
    escapeDeg: 70,        // 脫困斜向角度（度）
    spawnIgnore: 6,       // 出生點附近預製件排除半徑
    staleMs: 1500,        // 讀取失敗仍沿用舊資料的容忍時間
    stallMs: 3800,        // 目標距離無進展判定卡住
    stallMsSlow: 6500,    // 慢速前進時放寬
    fleeDist: 9.0,        // 怪物靠近至此即逃離
    searchMax: 220,       // 目標搜尋上限距離
    trailMs: 1200,        // 軌跡保留視窗（毫秒）
    backtrackMs: 800      // 連續脫困失敗後倒退時長（毫秒）
  };

  // ---------- 靜態世界模型（唯讀參考，不參與即時致動） ----------

  var WORLD_URL = "re/world-model.json";
  var AGENTS_URL = "re/agents.json";

  // 目標優先序：未來取得玩家姿態後，規劃層依此排序；hazard 為規避類別。
  var WORLD_PRIORITY = [
    { category: "memory_pickups", label: "記憶碎片", weight: 3, kind: "goal" },
    { category: "doors",          label: "出口門",   weight: 3, kind: "goal" },
    { category: "batteries",      label: "電池",     weight: 2, kind: "goal" },
    { category: "polaroids",      label: "線索照片", weight: 1, kind: "goal" },
    { category: "monster_spawns", label: "怪物生成點", weight: 0, kind: "hazard" },
    { category: "monster_agents", label: "巡邏實體",   weight: 0, kind: "hazard" }
  ];

  var world = {
    loaded: false, source: "degraded",
    scene: "", navmesh: null, layers: null,
    counts: {}, categories: {}, agents: []
  };

  var KEYMAP = {
    KeyW: { key: "w", code: "KeyW", keyCode: 87 },
    KeyA: { key: "a", code: "KeyA", keyCode: 65 },
    KeyS: { key: "s", code: "KeyS", keyCode: 83 },
    KeyD: { key: "d", code: "KeyD", keyCode: 68 }
  };

  function targets() {
    var t = [window, document];
    if (canvas) t.push(canvas);
    return t;
  }

  // ---------- 事件注入 ----------

  function fireKey(code, down) {
    var k = KEYMAP[code];
    if (!k) return;
    var type = down ? "keydown" : "keyup";
    var ev = new KeyboardEvent(type, {
      key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode,
      location: 0, repeat: false, bubbles: true, cancelable: true,
      ctrlKey: false, shiftKey: false, altKey: false, metaKey: false
    });
    Object.defineProperty(ev, "keyCode", { value: k.keyCode });
    Object.defineProperty(ev, "which", { value: k.keyCode });
    injected = true;
    targets().forEach(function (t) { try { t.dispatchEvent(ev); } catch (e) {} });
    injected = false;
  }

  function hold(code) { if (!held[code]) { held[code] = true; fireKey(code, true); } }
  function release(code) { if (held[code]) { held[code] = false; fireKey(code, false); } }
  function releaseAll() { Object.keys(held).forEach(release); }

  function look(dx, dy) {
    var ev = new MouseEvent("mousemove", {
      bubbles: true, cancelable: true, clientX: 0, clientY: 0,
      movementX: dx, movementY: dy
    });
    Object.defineProperty(ev, "movementX", { value: dx });
    Object.defineProperty(ev, "movementY", { value: dy });
    injected = true;
    targets().forEach(function (t) { try { t.dispatchEvent(ev); } catch (e) {} });
    injected = false;
  }

  // ---------- 畫素感知 ----------

  function regionStats(x0, y0, x1, y1) {
    var r = 0, g = 0, b = 0, n = 0, pink = 0, bright = 0;
    for (var y = y0; y < y1; y += 2) {
      for (var x = x0; x < x1; x += 2) {
        var i = (y * W + x) * 4;
        var pr = buf[i], pg = buf[i + 1], pb = buf[i + 2];
        r += pr; g += pg; b += pb; n++;
        var lum = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
        if (lum > 20) bright++;
        if (pr > 170 && pr - pg > 50 && pr - pb > 30 && pg < 150) pink++;
      }
    }
    return {
      lum: n ? (0.2126 * r + 0.7152 * g + 0.0722 * b) / n : 0,
      pink: n ? pink / n : 0,
      brightRatio: n ? bright / n : 0
    };
  }

  // 注意：WebGL 預設幀緩衝未開 preserveDrawingBuffer，readPixels 會使該緩衝失效，
  // 每幀讀取會導致整個畫面變黑。因此只在真的需要像素（無即時座標）時讀，且低頻節流。
  var lastFrameAt = 0;
  var FRAME_MS = 320;

  function grabFrame(now) {
    if (live.ok) { sense.frameOK = true; return true; }   // 有座標就不需要畫面
    if (now - lastFrameAt < FRAME_MS) return sense.frameOK;
    lastFrameAt = now;
    if (!gl) return false;
    try {
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return true;
    } catch (e) { return false; }
  }

  function frameHash() {
    var bins = [0, 0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < buf.length; i += 16) {
      var lum = (0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2]) | 0;
      bins[Math.min(7, lum >> 5)]++;
    }
    return bins.join(",");
  }

  // ---------- 決策 ----------

  var T = {
    centerDark: 42,      // 中央亮度低於此值視為前方受阻
    pinkNear: 0.12,      // 中央粉色像素比例超過此值視為實體接近
    avoidMs: 750,
    stuckFrames: 35,
    turnMs: 2600,
    blankBright: 0.02    // 亮像素低於此比例視為黑幀/取幀失敗
  };

  function decide(now, frameOK) {
    var c = regionStats(38, 22, 58, 38);
    var l = regionStats(14, 24, 32, 36);
    var r = regionStats(64, 24, 84, 36);
    sense.centerLum = c.lum | 0; sense.leftLum = l.lum | 0;
    sense.rightLum = r.lum | 0; sense.pink = +c.pink.toFixed(3);
    sense.frameBlank = !frameOK || c.brightRatio < T.blankBright;

    // 卡死偵測：連續多幀畫面幾乎不變
    var hash = frameHash();
    if (hash === prevHash) stuckFrames++; else stuckFrames = 0;
    prevHash = hash;

    // 取幀失敗或黑幀：看不到畫面，走後備探索（仍前行＋定時轉向），不要把 W 放掉
    if (sense.frameBlank) {
      mode = "fallback";
      release("KeyS");
      hold("KeyW");
      if (now - lastTurnAt > T.turnMs) {
        lastTurnAt = now;
        turnDir = Math.random() < 0.5 ? -1 : 1;
        look(turnDir * 4, 0);
      }
      return;
    }

    if (stuckFrames > T.stuckFrames && mode !== "stuck") {
      mode = "stuck"; lastModeAt = now; turnDir = -turnDir;
    }

    if (mode === "avoid") {
      release("KeyW"); hold("KeyS");
      var away = (l.pink > r.pink) ? 1 : -1;
      look(away * turnDir * 6, 0);
      if (now - lastModeAt > T.avoidMs) {
        mode = "explore"; lastModeAt = now;
        release("KeyS");
      }
      return;
    }

    if (mode === "stuck") {
      release("KeyW"); release("KeyS");
      look(turnDir * 7, 0);
      if (now - lastModeAt > 600) { mode = "explore"; lastModeAt = now; stuckFrames = 0; }
      return;
    }

    // explore
    if (c.pink > T.pinkNear) {
      mode = "avoid"; lastModeAt = now; return;
    }

    if (c.lum < T.centerDark) {
      release("KeyW");
      look((l.lum >= r.lum ? -1 : 1) * 5, 0);
      return;
    }

    hold("KeyW");
    if (now - lastTurnAt > T.turnMs) {
      lastTurnAt = now;
      turnDir = Math.random() < 0.5 ? -1 : 1;
      look(turnDir * 4, 0);
    }
  }

  // ---------- 世界模型載入 ----------

  function summarizeCategories(cats) {
    var counts = {};
    Object.keys(cats).forEach(function (k) { counts[k] = cats[k].length; });
    return counts;
  }

  function loadWorldModel() {
    fetch(WORLD_URL)
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (wm) {
        world.scene = wm.scene || "";
        world.navmesh = wm.navmesh || null;
        world.layers = wm.layers || null;
        world.categories = wm.categories || {};
        world.counts = summarizeCategories(world.categories);
        return fetch(AGENTS_URL)
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (ag) { if (ag) world.agents = ag; });
      })
      .then(function () {
        world.loaded = true;
        world.source = WORLD_URL;
        if (window.console) console.log("[AutoBot] world model loaded", world.counts);
        updateDebug();
      })
      .catch(function (e) {
        world.loaded = false;
        world.source = "degraded";
        if (window.console) console.warn("[AutoBot] world model unavailable, vision-only", e && e.message);
        updateDebug();
      });
  }

  function worldSummary() {
    if (!world.loaded) return "WM:off";
    var c = world.counts;
    var mobs = (c.monster_spawns || 0) + (c.monster_agents || 0);
    return "WM:mem" + (c.memory_pickups || 0) + " bat" + (c.batteries || 0) +
      " door" + (c.doors || 0) + " mob" + mobs;
  }

  // ---------- 即時狀態輪詢 ----------

  function normDeg(a) {
    a = (a + 540) % 360 - 180;
    return a;
  }

  function dist2(a, b) {
    var dx = a[0] - b[0], dz = a[2] - b[2];
    return Math.sqrt(dx * dx + dz * dz);
  }

  // 最近的可達目標：
  // - 排除 layer=Player 的掛載件（如 restored memory / polaroid，隨玩家移動，非地面物件）
  // - 垂直落差大的（不同樓層）以罰分降權，仍可作為跨層導引
  function pickGoal(p) {
    if (!world.loaded || !p) return null;
    var best = null, bestScore = 0;
    WORLD_PRIORITY.forEach(function (w) {
      if (w.kind !== "goal") return;
      var list = world.categories[w.category] || [];
      for (var i = 0; i < list.length; i++) {
        var pt = list[i];
        if (!pt || !pt.pos) continue;
        if (pt.layer === "Player") continue;
        // 出生點附近的預製件（restored memory / polaroid 等 UI/道具模型）非地面目標
        if (spawnAnchor && dist2(pt.pos, spawnAnchor) < NAV.spawnIgnore) continue;
        var d = dist2(pt.pos, p);
        if (d < NAV.goalRadius) continue;
        if (d > NAV.searchMax) continue;
        var dy = Math.abs(pt.pos[1] - p[1]);
        var cand = { category: w.category, label: w.label, pos: pt.pos, name: pt.name, dist: d, dy: dy };
        if (isBlocked(cand)) continue;
        var score = w.weight / (d + 5) / (1 + 0.18 * dy);
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }
    });
    return best;
  }

  // 目標黏著：達標、失效或超時才重選，避免相鄰目標來回切換
  var goalStick = { key: "", pickedAt: 0 };
  var blocked = {};   // 目標 key → 失效期限（跨層/繞不進去）

  function isBlocked(g) {
    if (!g) return false;
    var k = g.category + ":" + g.name;
    var t = blocked[k];
    if (!t) return false;
    if (performance.now() > t) { delete blocked[k]; return false; }
    return true;
  }

  function blockGoal(g, ms, why) {
    if (!g) return;
    var k = g.category + ":" + g.name;
    blocked[k] = performance.now() + ms;
    if (window.console) console.log("[AutoBot] block goal", k, why, "dist", g.dist.toFixed(1), "dy", g.dy);
  }

  function pickGoalSticky(p, now) {
    var cur = live.goal;
    if (cur && goalStick.key && !isBlocked(cur)) {
      var d = dist2(cur.pos, p);
      if (d > NAV.goalRadius && d <= NAV.searchMax && now - goalStick.pickedAt < 6000) {
        cur.dist = d;
        return cur;
      }
    }
    var g = pickGoal(p);
    live.goal = g;
    goalStick.key = g ? (g.category + ":" + g.name) : "";
    goalStick.pickedAt = now;
    return g;
  }

  function pollLive(now) {
    if (now - lastLiveAt < LIVE_POLL_MS) return;
    lastLiveAt = now;
    if (!window.BRLive) { live.ok = false; live.reason = "BRLive missing"; return; }
    try {
      var st = window.BRLive.getState();
      if (!st || !st.resolved || !st.player) { live.ok = false; live.reason = (st && st.reason) || "unresolved"; return; }
      live.ok = true; live.reason = "";
      live.lastOkAt = now;
      live.player = st.player;
      live.camera = st.camera;
      live.monster = st.monster;
      live.scalars = st.scalars || {};
      var pos = [st.player.pos.x, st.player.pos.y, st.player.pos.z];
      if (!spawnAnchor) spawnAnchor = [pos[0], pos[1], pos[2]];
      var prevYaw = live.yaw;
      live.yaw = st.player.euler ? st.player.euler.y : 0;
      if (prevYaw !== undefined) updateGain();
      live.goal = pickGoalSticky(pos, now);
      // 記憶值上升＝剛撿到碎片：把附近目標封鎖一段時間
      var memNow = (live.scalars && live.scalars.memory !== undefined) ? live.scalars.memory : null;
      if (memNow !== null && lastMem !== null && memNow > lastMem + 0.4) {
        var pArr = [st.player.pos.x, st.player.pos.y, st.player.pos.z];
        (world.categories.memory_pickups || []).forEach(function (pt) {
          if (pt && pt.pos && dist2(pt.pos, pArr) < 6) blockGoal({ category: "memory_pickups", name: pt.name }, 45000, "picked");
        });
        live.goal = null;
      }
      lastMem = memNow;
      live.goalDist = live.goal ? live.goal.dist : 0;
      live.monsterDist = st.monster && st.monster.pos
        ? dist2([st.monster.pos.x, st.monster.pos.y, st.monster.pos.z], [st.player.pos.x, st.player.pos.y, st.player.pos.z])
        : 999;
    } catch (e) {
      // 暫時性讀取失敗（記憶體成長/GC）時沿用上一筆資料，避免整段退回盲目視覺模式
      if (live.player && now - (live.lastOkAt || 0) < NAV.staleMs) {
        live.ok = true; live.reason = "stale";
      } else {
        live.ok = false; live.reason = "err:" + (e && e.message || e);
      }
    }
  }

  // 朝目標偏航誤差（度）；正＝需往正方向轉（實測 dx>0 使 yaw 增大）
  function yawTo(from, target) {
    var dx = target[0] - from[0], dz = target[2] - from[2];
    return Math.atan2(dx, dz) * 180 / Math.PI;
  }

  // 閉環轉向：節流注入 + 線上估計「每像素多少度」，把誤差直接換算成注入量
  var steer = { lastAt: 0, gain: 5.0, pending: null };

  function steerTo(aimYawDeg, now) {
    var err = normDeg(aimYawDeg - live.yaw);
    live.yawErr = err;
    if (Math.abs(err) <= NAV.alignDeg) return true;
    if (now - steer.lastAt < NAV.steerInterval) return false;

    var near = live.goal && live.goal.dist < NAV.approachRadius;
    var tol = near ? NAV.approachAlign : NAV.alignDeg;
    if (Math.abs(err) <= tol) return true;
    var step = Math.abs(err) / Math.max(1, steer.gain);
    step = Math.min(near ? 1.6 : 6, Math.max(0.35, step));
    steer.lastAt = now;
    steer.pending = { step: step, yaw: live.yaw };
    look(err > 0 ? step : -step, 0);
    return false;
  }

  // 上一輪注入後，用實際偏航變化校正增益（度/像素）
  function updateGain() {
    var p = steer.pending;
    if (!p) return;
    var dyaw = Math.abs(normDeg(live.yaw - p.yaw));
    if (dyaw > 1.5 && p.step > 0.3) {
      var g = dyaw / p.step;
      if (g > 0.2 && g < 60) steer.gain = steer.gain * 0.55 + g * 0.45;
    }
    steer.pending = null;
  }

  // 進度看門狗：距離長時間沒有下降 → 貼牆/卡門，改用「斜向滑牆」脫困
  var guard = { best: 1e9, bestAt: 0, escapeUntil: 0, escapeDir: 1, fails: 0, lastEscapeAt: 0, goalKey: "", backtrackUntil: 0 };
  var trail = [];   // 近期軌跡 {x,y,z,t}，供卡住時倒退回到開闊點

  function navProgress(now, dist, goal) {
    var key = goal ? (goal.category + ":" + goal.name) : "";
    if (key !== guard.goalKey) { guard.goalKey = key; guard.best = dist; guard.bestAt = now; guard.fails = 0; }
    if (dist < guard.best - 0.4) { guard.best = dist; guard.bestAt = now; }
    if (dist <= 2.6) { guard.bestAt = now; guard.best = dist; return false; }

    var lim = dist > 25 ? NAV.stallMsSlow : NAV.stallMs;
    if (now - guard.bestAt > lim) {
      guard.fails++;
      guard.escapeUntil = now + NAV.escapeMs;
      if (guard.fails >= 2) guard.backtrackUntil = now + NAV.backtrackMs;
      // 連續失敗：換個側向；兩次以上就放棄這個目標
      if (now - guard.lastEscapeAt < NAV.escapeMs * 2) guard.escapeDir = -guard.escapeDir;
      guard.lastEscapeAt = now;
      guard.bestAt = now;
      guard.best = dist;
      if (guard.fails >= 3 && goal) { blockGoal(goal, 45000, "unreachable"); live.goal = null; guard.fails = 0; }
      return true;
    }
    return false;
  }

  function alignedEnough() {
    return Math.abs(live.yawErr) <= NAV.walkAlignDeg;
  }

  // 以座標/姿態導航（路線 3 生效時；視覺規則作後備）
  function liveDecide(now) {
    var p = [live.player.pos.x, live.player.pos.y, live.player.pos.z];
    trail.push({ x: p[0], y: p[1], z: p[2], t: now });
    while (trail.length && now - trail[0].t > NAV.trailMs) trail.shift();

    // 怪物逼近 → 背向牠跑
    if (live.monsterDist < NAV.fleeDist && live.monster && live.monster.pos) {
      mode = "flee";
      var away = yawTo(p, [live.monster.pos.x, live.monster.pos.y, live.monster.pos.z]) + 180;
      steerTo(away, now);
      hold("KeyW");
      release("KeyS"); release("KeyA"); release("KeyD");
      return;
    }

    var goal = live.goal;

    // 抵達：短期封鎖該目標，換下一個
    if (goal && goal.dist <= NAV.goalRadius) {
      blockGoal(goal, 30000, "arrived");
      live.goal = null;
      goal = null;
    }

    // 二維很近但垂直落差大：目標在別的樓層
    if (goal && goal.dist < 5 && goal.dy > 4) {
      blockGoal(goal, 60000, "cross-floor");
      live.goal = null;
      goal = null;
    }

    if (!goal) {
      mode = "roam";
      release("KeyS"); release("KeyA"); release("KeyD");
      hold("KeyW");
      if (now - lastTurnAt > T.turnMs) {
        lastTurnAt = now;
        turnDir = Math.random() < 0.5 ? -1 : 1;
        look(turnDir * 4, 0);
      }
      return;
    }

    // 在近距離繞太久還沒到：判定繞不進去
    if (goal.dist < 4.5 && now - goalStick.pickedAt > 8000) {
      blockGoal(goal, 60000, "orbit-timeout");
      live.goal = null;
      return;
    }

    // 連續脫困失敗：先倒退回到最近的開闊點，再換邊重試
    if (guard.backtrackUntil > now) {
      mode = "backtrack";
      release("KeyW"); release("KeyA"); release("KeyD");
      hold("KeyS");
      if (trail.length > 1) steerTo(yawTo(p, [trail[0].x, trail[0].y, trail[0].z]), now);
      return;
    }

    // 卡住脫困：朝目標方位偏移一個角度斜著走，像沿牆滑行
    if (guard.escapeUntil > now) {
      mode = "unstuck";
      release("KeyS");
      var escAim = yawTo(p, goal.pos) + guard.escapeDir * NAV.escapeDeg;
      if (steerTo(escAim, now)) hold("KeyW");
      else if (Math.abs(live.yawErr) > NAV.walkAlignDeg) release("KeyW");
      // 貼柱／貼牆時斜向側移繞行，不要只在原地轉向
      if (guard.escapeDir > 0) hold("KeyD"); else hold("KeyA");
      return;
    }

    var stuck = navProgress(now, goal.dist, goal);
    mode = stuck ? "unstuck" : "nav";
    var aim = yawTo(p, goal.pos);
    var align = steerTo(aim, now);
    release("KeyS"); release("KeyA"); release("KeyD");
    if (alignedEnough()) hold("KeyW");
    else release("KeyW");   // 誤差太大先原地轉向
  }

  // ---------- 主迴圈 ----------

  // 主迴圈用 setInterval 而非 RAF：分頁被遮蔽/隱藏時 Chrome 會暫停 RAF，
  // 但 interval 仍可運作；一般可見場景兩者等價。
  function tick() {
    var now = performance.now();
    if (!canvas) return;
    pollLive(now);
    if (enabled) {
      var ok = grabFrame(now);
      sense.frameOK = ok;
      if (live.ok && live.player && live.player.pos) {
        liveDecide(now);
      } else {
        decide(now, ok);
      }
      sense.mode = mode;
      updateDebug();
    }
    drawOverlay();
  }

  // ---------- 開關與 UI ----------

  function setEnabled(v) {
    enabled = !!v;
    if (!enabled) releaseAll();
    try { localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0"); } catch (e) {}
    if (button) button.textContent = enabled ? "AUTO: ON" : "AUTO: OFF";
    updateDebug();
    if (window.console) console.log("[AutoBot]", enabled ? "enabled" : "disabled", sense);
  }

  function setOverlayVisible(v) {
    overlay.visible = !!v;
    if (overlayButton) overlayButton.textContent = overlay.visible ? "OVERLAY: ON" : "OVERLAY: OFF";
  }

  function liveSummary() {
    if (!live.ok) return "LIVE:off(" + (live.reason || "-") + ")";
    var s = live.scalars || {};
    var out = "LIVE pos(" + live.player.pos.x.toFixed(1) + "," + live.player.pos.z.toFixed(1) + ")" +
      " yaw" + (live.yaw || 0).toFixed(0) + " err" + (live.yawErr || 0).toFixed(0);
    if (live.goal) out += " goal:" + live.goal.category + "@" + live.goal.dist.toFixed(1);
    out += " mob:" + live.monsterDist.toFixed(1);
    if (s.memory !== undefined) out += " mem" + (s.memory | 0);
    if (s.batteryPercent !== undefined) out += " bat" + Math.round(s.batteryPercent);
    if (s.hearts !== undefined) out += " hp" + s.hearts;
    return out;
  }

  function updateDebug() {
    if (!debugEl) return;
    debugEl.textContent = (enabled
      ? sense.mode + " | frame:" + (sense.frameOK ? "ok" : "fail") +
        " blank:" + (sense.frameBlank ? "Y" : "N") +
        (live.ok ? " 像素:略(座標導航)" :
          " L/C/R:" + sense.leftLum + "/" + sense.centerLum + "/" + sense.rightLum + " pink:" + sense.pink)
      : "AUTO off") + " | " + worldSummary() + "\n" + liveSummary();
    debugEl.style.whiteSpace = "pre";
  }

  // 世界座標 → 螢幕 2D（方位／仰角投影，不依賴引擎 view/projection 矩陣）
  function projectPoint(wx, wy, wz) {
    var cam = live.camera;
    if (!cam || !cam.pos) return null;
    var yaw = (cam.euler ? cam.euler.y : 0) * Math.PI / 180;
    var pitch = (cam.euler ? cam.euler.x : 0) * Math.PI / 180;
    var fx = Math.sin(yaw) * Math.cos(pitch);
    var fy = Math.sin(pitch);
    var fz = Math.cos(yaw) * Math.cos(pitch);
    var rx = Math.cos(yaw), rz = -Math.sin(yaw);
    var ux = -Math.sin(pitch) * Math.sin(yaw);
    var uy = Math.cos(pitch);
    var uz = -Math.sin(pitch) * Math.cos(yaw);
    var dx = wx - cam.pos.x, dy = wy - cam.pos.y, dz = wz - cam.pos.z;
    var depth = dx * fx + dy * fy + dz * fz;
    if (depth < 0.5) return { behind: true, depth: depth };
    var right = dx * rx + dz * rz;
    var up = dx * ux + dy * uy + dz * uz;
    var W = overlay.canvas.width, H = overlay.canvas.height;
    var tanY = Math.tan(OVERLAY_FOV_DEG * Math.PI / 360);
    var tanX = tanY * (W / H);
    return {
      x: W / 2 + (right / depth) / tanX * (W / 2),
      y: H / 2 - (up / depth) / tanY * (H / 2),
      depth: depth, behind: false
    };
  }

  function drawMarker(x, y, color, label) {
    var ctx = overlay.ctx;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
    if (label) { ctx.font = "11px monospace"; ctx.fillText(label, x + 12, y + 4); }
  }

  function drawClamped(pr, color, label) {
    var W = overlay.canvas.width, H = overlay.canvas.height, m = 24;
    var off = pr.x < m || pr.x > W - m || pr.y < m || pr.y > H - m;
    var x = Math.max(m, Math.min(W - m, pr.x));
    var y = Math.max(m, Math.min(H - m, pr.y));
    overlay.ctx.globalAlpha = off ? 0.55 : 1;
    drawMarker(x, y, color, off ? label + " ↺" : label);
    overlay.ctx.globalAlpha = 1;
  }

  function drawOverlay() {
    var ctx = overlay.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.canvas.width, overlay.canvas.height);
    if (!overlay.visible) return;
    if (live.goal && live.goal.pos) {
      var g = projectPoint(live.goal.pos[0], live.goal.pos[1], live.goal.pos[2]);
      if (g && !g.behind) drawClamped(g, "#37e6ff", live.goal.name || "GOAL");
    }
    if (live.monster && live.monster.pos) {
      var m = projectPoint(live.monster.pos.x, live.monster.pos.y, live.monster.pos.z);
      if (m && !m.behind) drawClamped(m, "#ff4d5e", "MOB");
    }
  }

  function buildOverlay() {
    overlay.canvas = document.createElement("canvas");
    overlay.canvas.id = "br-overlay";
    overlay.canvas.style.cssText =
      "position:fixed;inset:0;z-index:99998;pointer-events:none;";
    overlay.ctx = overlay.canvas.getContext("2d");
    document.body.appendChild(overlay.canvas);
    resizeOverlay();
    window.addEventListener("resize", resizeOverlay);
  }

  function resizeOverlay() {
    if (!overlay.canvas) return;
    overlay.canvas.width = window.innerWidth;
    overlay.canvas.height = window.innerHeight;
  }

  function buildUI() {
    button = document.createElement("button");
    button.textContent = enabled ? "AUTO: ON" : "AUTO: OFF";
    button.style.cssText =
      "position:fixed;top:10px;right:10px;z-index:99999;padding:6px 12px;" +
      "font:12px/1.4 Torus,Arial,sans-serif;color:#fff;background:rgba(20,20,20,.7);" +
      "border:1px solid #666;border-radius:6px;cursor:pointer;";
    button.addEventListener("click", function () { setEnabled(!enabled); });
    document.body.appendChild(button);

    overlayButton = document.createElement("button");
    overlayButton.textContent = overlay.visible ? "OVERLAY: ON" : "OVERLAY: OFF";
    overlayButton.style.cssText =
      "position:fixed;top:10px;right:120px;z-index:99999;padding:6px 12px;" +
      "font:12px/1.4 Torus,Arial,sans-serif;color:#fff;background:rgba(20,20,20,.7);" +
      "border:1px solid #666;border-radius:6px;cursor:pointer;";
    overlayButton.addEventListener("click", function () { setOverlayVisible(!overlay.visible); });
    document.body.appendChild(overlayButton);

    debugEl = document.createElement("div");
    debugEl.style.cssText =
      "position:fixed;top:42px;right:10px;z-index:99999;padding:4px 8px;" +
      "font:11px/1.3 monospace;color:#9fe;background:rgba(20,20,20,.7);border-radius:4px;";
    document.body.appendChild(debugEl);
    updateDebug();

    window.addEventListener("keydown", function (e) {
      if (injected) return;
      if (e.code === "KeyB") { setEnabled(!enabled); return; }
      if (e.code === "KeyO") { setOverlayVisible(!overlay.visible); return; }
      if (enabled) setEnabled(false); // 玩家實際操作：收回控制權
    }, true);
    ["pointerdown", "touchstart"].forEach(function (type) {
      window.addEventListener(type, function () {
        if (injected) return;
        if (enabled) setEnabled(false);
      }, true);
    });
  }

  function init() {
    canvas = document.getElementById("game");
    if (!canvas) { requestAnimationFrame(init); return; }
    try { gl = canvas.getContext("webgl2") || canvas.getContext("webgl"); } catch (e) { gl = null; }
    buildUI();
    buildOverlay();
    loadWorldModel();
    setInterval(tick, 16);
  }

  window.BackroomsAutoBot = {
    setEnabled: setEnabled,
    isEnabled: function () { return enabled; },
    sense: sense,
    world: world,
    worldPriority: WORLD_PRIORITY,
    live: live,
    queryWorld: function (category) { return world.categories[category] || []; },
    liveSnapshot: function () { pollLive(performance.now()); return live; }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
