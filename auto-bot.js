/*
 * Backrooms Recovery — 頁面層自動游玩 Bot（路線 A：視覺規則型）
 *
 * 邊界說明（成品為 IL2CPP wasm，未對 JS 開放內部狀態）：
 * - 本檔只讀 canvas 畫素與 HUD 區域亮度/顏色，合成鍵盤與滑鼠事件。
 * - 讀不到玩家座標、記憶值內部數值、實體/碎片位置、NavMesh；決策為反應式規則，
 *   不是全知規劃。怪物在側邊/背後/牆後偵測不到；迷宮中可能繞圈或卡死。
 * - 靜態世界模型（re/world-model.json、re/agents.json）為路 2 離線解包產出：僅載入
 *   分類計數、NavMesh 參數、怪物速度表與目標優先序作唯讀參考。目前讀不到玩家世界座標／
 *   相機姿態（路 3 受阻），無法把 3D 點投影到畫面或算距離；致動仍由視覺反應規則主導。
 * - 不修改 Build/ 內 wasm、data、framework、loader。
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
  var button = null, debugEl = null;
  var sense = {
    mode: mode, frameOK: false, frameBlank: false,
    centerLum: 0, leftLum: 0, rightLum: 0, pink: 0
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

  function grabFrame() {
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

  // ---------- 主迴圈 ----------

  function tick(now) {
    requestAnimationFrame(tick);
    if (!enabled || !canvas) return;
    var ok = grabFrame();
    sense.frameOK = ok;
    decide(now, ok);
    sense.mode = mode;
    updateDebug();
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

  function updateDebug() {
    if (!debugEl) return;
    debugEl.textContent = (enabled
      ? sense.mode + " | frame:" + (sense.frameOK ? "ok" : "fail") +
        " blank:" + (sense.frameBlank ? "Y" : "N") +
        " L/C/R:" + sense.leftLum + "/" + sense.centerLum + "/" + sense.rightLum +
        " pink:" + sense.pink
      : "AUTO off") + " | " + worldSummary();
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

    debugEl = document.createElement("div");
    debugEl.style.cssText =
      "position:fixed;top:42px;right:10px;z-index:99999;padding:4px 8px;" +
      "font:11px/1.3 monospace;color:#9fe;background:rgba(20,20,20,.7);border-radius:4px;";
    document.body.appendChild(debugEl);
    updateDebug();

    window.addEventListener("keydown", function (e) {
      if (injected) return;
      if (e.code === "KeyB") { setEnabled(!enabled); return; }
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
    loadWorldModel();
    requestAnimationFrame(tick);
  }

  window.BackroomsAutoBot = {
    setEnabled: setEnabled,
    isEnabled: function () { return enabled; },
    sense: sense,
    world: world,
    worldPriority: WORLD_PRIORITY,
    queryWorld: function (category) { return world.categories[category] || []; }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
