/*
 * Backrooms Recovery — 路線 B 記憶體掃描診斷器（唯讀 PoC）
 *
 * 目的：驗證能否從 JS 讀到 wasm 線性記憶體內的遊戲狀態（玩家座標、記憶值百分比等）。
 *
 * 邊界（成品為 IL2CPP 編譯，未對 JS 開放狀態 API）：
 * - 本檔只讀 Module.HEAP* / wasmMemory.buffer，不寫入任何記憶體，不呼叫會變更狀態的 SendMessage。
 * - 掃到的「候選位址」只是數值符合條件的記憶體位置，未經類別/欄位偏移對應前，
 *   不能斷定就是玩家座標或記憶值；需在可跑 WebGL 的本機瀏覽器配合走動校準。
 * - 雲端環境不支援 WebGL，此檔只能靜態驗證可載入，實際候選值需本機實機觀察。
 *
 * 公開介面：window.BRProbe
 *   state()              回傳模組/堆積就緒狀態與大小
 *   scanPosition()       掃描疑似座標三元組 (x,y,z)，回傳候選清單（位址＋數值）
 *   scanPercent()        掃描疑似記憶值百分比（0..1 或 0..100）候選
 *   track(frames)        連續取樣，回傳變動/穩定位址統計與範例
 *   calibrate(ms)        校準視窗：期間走動，回傳位移最大的座標候選（疑似玩家/攝影機）
 *   panel()              取得除錯面板 DOM 元素
 */
(function () {
  "use strict";
  if (window.BRProbe) return;

  var POLL_MS = 500;
  var WORLD_MIN = -200, WORLD_MAX = 200; // 世界座標合理範圍（原型可能不同，僅過濾用）
  var Y_MIN = -20, Y_MAX = 30;
  var MAX_RESULTS = 60;

  var mod = null;
  var panelEl = null, statusEl = null;
  var pollTimer = null;

  // ---------- 記憶體視圖 ----------

  function getModule() {
    try {
      var g = window.unityGame;
      if (g && g.Module) return g.Module;
    } catch (e) {}
    return null;
  }

  function heap() {
    if (!mod) return null;
    var buf = null;
    try {
      if (mod.asm && mod.asm.memory && mod.asm.memory.buffer) buf = mod.asm.memory.buffer;
      else if (mod.wasmMemory && mod.wasmMemory.buffer) buf = mod.wasmMemory.buffer;
    } catch (e) {}
    var f32 = mod.HEAPF32, u32 = mod.HEAPU32, u8 = mod.HEAPU8;
    if ((!f32 || !u32) && buf) {
      f32 = new Float32Array(buf);
      u32 = new Uint32Array(buf);
      u8 = new Uint8Array(buf);
    }
    if (!f32 || !u32) return null;
    return { f32: f32, u32: u32, u8: u8, byteLen: f32.byteLength * 4 };
  }

  function validFloat(v) {
    return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= WORLD_MAX;
  }

  // ---------- 掃描 ----------

  function scanPosition() {
    var h = heap();
    if (!h) return { ready: false, candidates: [] };
    var f = h.f32, n = f.length, out = [];
    for (var i = 0; i + 2 < n; i++) {
      var x = f[i], y = f[i + 1], z = f[i + 2];
      if (!validFloat(x) || !validFloat(y) || !validFloat(z)) continue;
      if (y < Y_MIN || y > Y_MAX) continue;
      if (Math.abs(x) < 1e-4 && Math.abs(y) < 1e-4 && Math.abs(z) < 1e-4) continue;
      var mag = Math.sqrt(x * x + y * y + z * z);
      if (mag > 120) continue;
      out.push({ addr: i * 4, x: +x.toFixed(3), y: +y.toFixed(3), z: +z.toFixed(3), mag: +mag.toFixed(2) });
      if (out.length >= MAX_RESULTS) break;
    }
    out.sort(function (a, b) { return a.mag - b.mag; });
    return { ready: true, heapBytes: h.byteLen, candidates: out };
  }

  function scanPercent() {
    var h = heap();
    if (!h) return { ready: false, candidates: [] };
    var f = h.f32, u = h.u32, n = f.length, out = [];
    var seen = {};
    for (var i = 0; i < n; i++) {
      var v = f[i];
      if (!Number.isFinite(v)) continue;
      var pct = null;
      if (v >= 0 && v <= 1) pct = +(v * 100).toFixed(2);
      else if (v > 1 && v <= 100) pct = +v.toFixed(2);
      if (pct === null) continue;
      var addr = i * 4;
      if (seen[addr]) continue;
      seen[addr] = 1;
      out.push({ addr: addr, kind: "f32", value: pct });
      if (out.length >= MAX_RESULTS) break;
    }
    // 整數 0..100 候選（記憶值也可能存成整數百分比）
    for (var j = 0; j < u.length && out.length < MAX_RESULTS; j++) {
      var iv = u[j];
      if (iv <= 100) out.push({ addr: j * 4, kind: "u32", value: iv });
    }
    return { ready: true, heapBytes: h.byteLen, candidates: out };
  }

  function snapshotFloats(addrs) {
    var h = heap();
    if (!h) return {};
    var s = {};
    addrs.forEach(function (a) { s[a] = h.f32[a >> 2]; });
    return s;
  }

  function track(frames) {
    frames = frames || 10;
    var h = heap();
    if (!h) return { ready: false };
    var f = h.f32, n = f.length;
    // 先取一輪座標候選位址作為追蹤對象
    var first = scanPosition().candidates.map(function (c) { return c.addr; });
    var prev = snapshotFloats(first);
    var changed = 0, stable = 0, samples = [];
    var round = 0;
    return new Promise(function (resolve) {
      var iv = setInterval(function () {
        round++;
        var cur = snapshotFloats(first);
        var moved = [];
        first.forEach(function (a) {
          var d = Math.abs((cur[a] || 0) - (prev[a] || 0));
          if (d > 1e-3) { changed++; moved.push({ addr: a, delta: +d.toFixed(4) }); }
          else stable++;
        });
        if (moved.length && samples.length < 10) samples.push(moved.slice(0, 5));
        prev = cur;
        if (round >= frames) {
          clearInterval(iv);
          resolve({ ready: true, rounds: round, changed: changed, stable: stable, samples: samples });
        }
      }, 100);
    });
  }

  function calibrate(ms) {
    ms = ms || 5000;
    var h = heap();
    if (!h) return Promise.resolve({ ready: false });
    var cands = scanPosition().candidates;
    var start = snapshotFloats(cands.map(function (c) { return c.addr; }));
    return new Promise(function (resolve) {
      setTimeout(function () {
        var cur = snapshotFloats(cands.map(function (c) { return c.addr; }));
        var rows = cands.map(function (c) {
          var d = Math.abs((cur[c.addr] || 0) - (start[c.addr] || 0));
          return { addr: c.addr, x: c.x, y: c.y, z: c.z, disp: +d.toFixed(4) };
        });
        rows.sort(function (a, b) { return b.disp - a.disp; });
        resolve({ ready: true, windowMs: ms, top: rows.slice(0, 15) });
      }, ms);
    });
  }

  // ---------- 狀態與面板 ----------

  function state() {
    var h = heap();
    return {
      moduleReady: !!mod,
      heapReady: !!h,
      heapBytes: h ? h.byteLen : 0,
      hasHeapViews: !!(mod && mod.HEAPF32 && mod.HEAPU32),
      hasAsmMemory: !!(mod && mod.asm && mod.asm.memory)
    };
  }

  function refreshStatus() {
    if (!statusEl) return;
    var s = state();
    statusEl.textContent = s.moduleReady
      ? ("mem:" + (s.heapBytes / 1024 / 1024).toFixed(1) + "MB views:" + (s.hasHeapViews ? "Y" : "N"))
      : "module: 等待遊戲載入…";
  }

  function buildPanel() {
    panelEl = document.createElement("div");
    panelEl.style.cssText =
      "position:fixed;top:74px;right:10px;z-index:99998;padding:6px 8px;" +
      "font:11px/1.4 monospace;color:#fd9;background:rgba(20,20,20,.7);border-radius:6px;";
    statusEl = document.createElement("div");
    panelEl.appendChild(statusEl);

    var btnRow = document.createElement("div");
    btnRow.style.marginTop = "4px";
    var actions = [
      ["座標", function () { console.log("[BRProbe] position", scanPosition()); }],
      ["記憶值", function () { console.log("[BRProbe] percent", scanPercent()); }],
      ["追蹤", function () { track(10).then(function (r) { console.log("[BRProbe] track", r); }); }],
      ["校準5s", function () { calibrate(5000).then(function (r) { console.log("[BRProbe] calibrate", r); }); }]
    ];
    actions.forEach(function (a) {
      var b = document.createElement("button");
      b.textContent = a[0];
      b.style.cssText = "margin-left:4px;padding:2px 6px;font:11px sans-serif;color:#fff;background:#333;border:1px solid #666;border-radius:4px;cursor:pointer;";
      b.addEventListener("click", a[1]);
      btnRow.appendChild(b);
    });
    panelEl.appendChild(btnRow);
    document.body.appendChild(panelEl);
    refreshStatus();
  }

  function poll() {
    mod = getModule();
    if (mod) { refreshStatus(); return; }
    refreshStatus();
    pollTimer = setTimeout(poll, POLL_MS);
  }

  function init() {
    buildPanel();
    poll();
  }

  window.BRProbe = {
    state: state,
    scanPosition: scanPosition,
    scanPercent: scanPercent,
    track: track,
    calibrate: calibrate,
    panel: function () { return panelEl; }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
