/*
 * Backrooms Recovery — 頁面層自動游玩 Bot（路線 A：視覺規則型）
 *
 * 邊界說明（成品為 IL2CPP wasm，未對 JS 開放內部狀態）：
 * - 本檔只讀 canvas 畫素與 HUD 區域亮度/顏色，合成鍵盤與滑鼠事件。
 * - 讀不到玩家座標、記憶值內部數值、實體/碎片位置、NavMesh；決策為反應式規則，
 *   不是全知規劃。迷宮中可能繞圈或卡死，遇卡死有原地迴轉保護。
 * - 不修改 Build/ 內 wasm、data、framework、loader。
 *
 * 操作：B 鍵或右上角按鈕切換 AUTO；玩家手動按鍵/觸控會自動關閉 bot 收回控制權。
 * 開關狀態存 localStorage（br_auto）。
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
  var mode = "explore";       // explore | avoid | stuck
  var injected = false;       // 過濾自身注入事件，避免被誤判為玩家接管
  var lastTurnAt = 0;
  var lastModeAt = 0;
  var prevHash = "";
  var stuckFrames = 0;
  var turnDir = 1;
  var button = null;
  var sense = { mode: mode, centerLum: 0, leftLum: 0, rightLum: 0, pink: 0, frameOK: false };

  var KEYMAP = {
    KeyW: { key: "w", code: "KeyW", keyCode: 87 },
    KeyA: { key: "a", code: "KeyA", keyCode: 65 },
    KeyS: { key: "s", code: "KeyS", keyCode: 83 },
    KeyD: { key: "d", code: "KeyD", keyCode: 68 }
  };

  // ---------- 事件注入 ----------

  function fireKey(code, down) {
    var k = KEYMAP[code];
    if (!k || !canvas) return;
    var type = down ? "keydown" : "keyup";
    var ev = new KeyboardEvent(type, {
      key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode,
      location: 0, repeat: false, bubbles: true, cancelable: true
    });
    Object.defineProperty(ev, "keyCode", { value: k.keyCode });
    Object.defineProperty(ev, "which", { value: k.keyCode });
    injected = true;
    [window, canvas].forEach(function (t) { try { t.dispatchEvent(ev); } catch (e) {} });
    injected = false;
  }

  function hold(code) { if (!held[code]) { held[code] = true; fireKey(code, true); } }
  function release(code) { if (held[code]) { held[code] = false; fireKey(code, false); } }
  function releaseAll() { Object.keys(held).forEach(release); }

  function look(dx, dy) {
    if (!canvas) return;
    var ev = new MouseEvent("mousemove", {
      bubbles: true, cancelable: true, clientX: 0, clientY: 0,
      movementX: dx, movementY: dy
    });
    Object.defineProperty(ev, "movementX", { value: dx });
    Object.defineProperty(ev, "movementY", { value: dy });
    injected = true;
    [window, canvas].forEach(function (t) { try { t.dispatchEvent(ev); } catch (e) {} });
    injected = false;
  }

  // ---------- 畫素感知 ----------

  function regionStats(x0, y0, x1, y1) {
    var r = 0, g = 0, b = 0, n = 0, pink = 0;
    for (var y = y0; y < y1; y += 2) {
      for (var x = x0; x < x1; x += 2) {
        var i = (y * W + x) * 4;
        var pr = buf[i], pg = buf[i + 1], pb = buf[i + 2];
        r += pr; g += pg; b += pb; n++;
        if (pr > 170 && pr - pg > 50 && pr - pb > 30 && pg < 150) pink++;
      }
    }
    var lum = n ? (0.2126 * r + 0.7152 * g + 0.0722 * b) / n : 0;
    return { lum: lum, pink: n ? pink / n : 0 };
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
    turnMs: 2600
  };

  function decide(now) {
    var c = regionStats(38, 22, 58, 38);
    var l = regionStats(14, 24, 32, 36);
    var r = regionStats(64, 24, 84, 36);
    sense.centerLum = c.lum | 0; sense.leftLum = l.lum | 0;
    sense.rightLum = r.lum | 0; sense.pink = +c.pink.toFixed(3);

    // 卡死偵測：連續多幀畫面幾乎不變
    var hash = frameHash();
    if (hash === prevHash) stuckFrames++; else stuckFrames = 0;
    prevHash = hash;

    if (stuckFrames > T.stuckFrames && mode !== "stuck") {
      mode = "stuck"; lastModeAt = now; turnDir = -turnDir;
    }

    if (mode === "avoid") {
      release("KeyW"); hold("KeyS");
      // 實體偏哪側就往反方向轉
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
      // 前方偏暗：停下，朝較亮的一邊轉
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

  // ---------- 主迴圈 ----------

  function tick(now) {
    requestAnimationFrame(tick);
    if (!enabled || !canvas) return;
    sense.frameOK = grabFrame();
    if (!sense.frameOK) return;
    decide(now);
    sense.mode = mode;
  }

  // ---------- 開關與 UI ----------

  function setEnabled(v) {
    enabled = !!v;
    if (!enabled) releaseAll();
    try { localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0"); } catch (e) {}
    if (button) button.textContent = enabled ? "AUTO: ON" : "AUTO: OFF";
    if (window.console) console.log("[AutoBot]", enabled ? "enabled" : "disabled", sense);
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

    window.addEventListener("keydown", function (e) {
      if (injected) return;
      if (e.code === "KeyB") { setEnabled(!enabled); return; }
      // 玩家實際操作：收回控制權
      if (enabled) setEnabled(false);
    }, true);
    ["pointerdown", "touchstart"].forEach(function (type) {
      window.addEventListener(type, function () {
        if (injected && enabled) return;
        if (enabled) setEnabled(false);
      }, true);
    });
  }

  function init() {
    canvas = document.getElementById("game");
    if (!canvas) { requestAnimationFrame(init); return; }
    try { gl = canvas.getContext("webgl2") || canvas.getContext("webgl"); } catch (e) { gl = null; }
    buildUI();
    requestAnimationFrame(tick);
  }

  window.BackroomsAutoBot = {
    setEnabled: setEnabled,
    isEnabled: function () { return enabled; },
    sense: sense
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
