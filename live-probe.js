/*
 * Backrooms Recovery — 路線 3 即時狀態橋接（唯讀）
 *
 * 經 IL2CPP invoker（dynCall_viiiii）呼叫引擎 Transform.get_position / get_forward /
 * get_eulerAngles，從 wasm 線性記憶體讀回執行期即時世界座標與姿態；另沿參考鏈
 * 讀取指令碼標量（記憶%、電池、愛心、怪物狀態）。
 *
 * 邊界：
 * - 唯讀：不寫入記憶體、不呼叫會變更遊戲狀態的方法；invoker 僅用於 getter。
 * - 鏈上參考位址每次 reload 可能漂移，本檔快取後於取樣時驗證 klass，失效自動重解析。
 *
 * 公開介面：window.BRLive
 *   ready()                 模組/heap 是否就緒
 *   resolve()               （重新）解析單例鏈與方法表，回傳快取摘要
 *   getState()              完整即時狀態 { player, camera, monster, scalars, resolved }
 *   getPlayer() / getMonster() / getCamera()
 */
(function () {
  "use strict";
  if (window.BRLive) return;

  var cache = {
    ff: 0, death: 0, batt: 0, mem: 0, mon: 0,
    dp: 0, cam: 0, monTr: 0,
    mTransform: null, mComponent: null,
    resolved: false
  };

  function mod() { return window.unityGame && window.unityGame.Module; }

  function heaps() {
    var M = mod();
    if (!M) return null;
    return { M: M, asm: M.asm, u8: M.HEAPU8, u32: M.HEAPU32, f32: M.HEAPF32, heap: M.HEAPU8.length };
  }

  function readStr(H, v) {
    if (v < 0 || v >= H.heap) return null;
    var e = v;
    while (e < H.heap && H.u8[e] !== 0 && e - v < 64) e++;
    var s = "";
    for (var i = v; i < e; i++) s += String.fromCharCode(H.u8[i]);
    return s;
  }

  function klassName(H, p) {
    if (p < 0x10000 || p >= H.heap) return null;
    var k = H.u32[p >> 2];
    if (k > 0x10000 && k < H.heap) return readStr(H, H.u32[(k + 8) >> 2]);
    return null;
  }

  function findKlass(H, name) {
    var seen = {};
    for (var k = 0; k < H.u32.length; k++) {
      var kp = H.u32[k];
      if (kp < 0x10000 || kp >= H.heap || seen[kp]) continue;
      seen[kp] = 1;
      var np = H.u32[(kp + 8) >> 2];
      if (np > 0x10000 && np < H.heap && readStr(H, np) === name) return kp;
    }
    return null;
  }

  // 找某 klass 的活實例；opt.refOffset + opt.refKlass 做交叉驗證
  function findInstance(H, klass, opt) {
    for (var k = 0; k < H.u32.length; k++) {
      if (H.u32[k] !== klass) continue;
      var a = k * 4;
      if (opt && opt.refOffset !== undefined) {
        var ref = H.u32[(a + opt.refOffset) >> 2];
        if (klassName(H, ref) !== opt.refKlass) continue;
      }
      return a;
    }
    return null;
  }

  function enumMethods(H, klass) {
    var out = {}, tbl = H.u32[(klass + 0x4C) >> 2];
    if (tbl < 0x10000 || tbl >= H.heap) return out;
    for (var i = 0; i < 120; i++) {
      var mi = H.u32[(tbl + i * 4) >> 2];
      if (mi < 0x10000 || mi >= H.heap) break;
      var nm = readStr(H, H.u32[(mi + 0x0C) >> 2]);
      if (nm) out[nm] = { mi: mi, mp: H.u32[mi >> 2], inv: H.u32[(mi + 8) >> 2] };
    }
    return out;
  }

  function invokeVec(H, miObj, obj) {
    var buf = H.asm.malloc(16);
    for (var i = 0; i < 4; i++) H.u32[(buf + i) >> 2] = 0;
    H.asm.dynCall_viiiii(miObj.inv, miObj.mp, miObj.mi, obj, 0, buf);
    var v = { x: H.f32[buf >> 2], y: H.f32[(buf + 4) >> 2], z: H.f32[(buf + 8) >> 2] };
    H.asm.free(buf);
    return v;
  }

  function invokeObj(H, miObj, obj) {
    var buf = H.asm.malloc(16);
    for (var i = 0; i < 4; i++) H.u32[(buf + i) >> 2] = 0;
    H.asm.dynCall_viiiii(miObj.inv, miObj.mp, miObj.mi, obj, 0, buf);
    var r = H.u32[buf >> 2];
    H.asm.free(buf);
    return r;
  }

  function resolve() {
    var H = heaps();
    if (!H) return { resolved: false, reason: "module not ready" };

    var ffK = findKlass(H, "FreeFPSControllerStable");
    var menuK = findKlass(H, "MainMenuManager");
    var ff = ffK ? findInstance(H, ffK, { refOffset: 0x10, refKlass: "MainMenuManager" }) : null;
    if (ff === null) { cache.resolved = false; return { resolved: false, reason: "FreeFPS instance not found" }; }

    var menu = H.u32[(ff + 0x10) >> 2];

    var deathK = findKlass(H, "DeathManager");
    var battK = findKlass(H, "BatterySystem");
    var memK = findKlass(H, "MemoryProgression");
    var monK = findKlass(H, "MonsterController");

    var death = deathK ? findInstance(H, deathK, { refOffset: 0x4C, refKlass: "BatterySystem" }) : null;
    var batt = battK ? findInstance(H, battK, { refOffset: 0x30, refKlass: "DeathManager" }) : null;
    var mem = memK ? findInstance(H, memK, { refOffset: 0x50, refKlass: "MainMenuManager" }) : null;
    var mon = monK ? findInstance(H, monK, { refOffset: 0x3C, refKlass: "MemoryProgression" }) : null;

    var dp = death ? H.u32[(death + 0x10) >> 2] : 0;
    var cam = H.u32[(ff + 0x4C) >> 2];

    // Transform 包裝 klass → 方法表；Component klass = +0x2C
    var dk = dp ? H.u32[dp >> 2] : 0;
    var mTransform = dk ? enumMethods(H, dk) : {};
    var compK = dk ? H.u32[(dk + 0x2C) >> 2] : 0;
    var mComponent = compK ? enumMethods(H, compK) : {};

    var monTr = 0;
    if (mon && mComponent["get_transform"]) monTr = invokeObj(H, mComponent["get_transform"], mon);

    cache = {
      ff: ff, menu: menu, death: death, batt: batt, mem: mem, mon: mon,
      dp: dp, cam: cam, monTr: monTr,
      mTransform: mTransform, mComponent: mComponent,
      resolved: true
    };
    return { resolved: true, ff: ff, death: death, mon: mon, dp: dp, cam: cam, monTr: monTr };
  }

  function validRef(H, p, name) {
    return p > 0x10000 && p < H.heap && klassName(H, p) === name;
  }

  function getState() {
    var H = heaps();
    if (!H) return { resolved: false, reason: "module not ready" };

    if (!cache.resolved || !validRef(H, cache.dp, "Transform") || !validRef(H, cache.cam, "Transform")) {
      var r = resolve();
      if (!r.resolved) return { resolved: false, reason: r.reason };
    }

    var T = cache.mTransform, C = cache.mComponent, out = { resolved: true, player: null, camera: null, monster: null, scalars: {} };

    if (T["get_position"] && cache.dp) {
      out.player = {
        pos: invokeVec(H, T["get_position"], cache.dp),
        forward: T["get_forward"] ? invokeVec(H, T["get_forward"], cache.dp) : null,
        euler: T["get_eulerAngles"] ? invokeVec(H, T["get_eulerAngles"], cache.dp) : null
      };
    }
    if (T["get_position"] && cache.cam) {
      out.camera = { pos: invokeVec(H, T["get_position"], cache.cam) };
    }
    if (cache.monTr && validRef(H, cache.monTr, "Transform") && T["get_position"]) {
      out.monster = { pos: invokeVec(H, T["get_position"], cache.monTr) };
    } else if (cache.mon && C["get_transform"] && T["get_position"]) {
      var tr = invokeObj(H, C["get_transform"], cache.mon);
      if (tr > 0x10000 && tr < H.heap) {
        cache.monTr = tr;
        out.monster = { pos: invokeVec(H, T["get_position"], tr) };
      }
    }

    var s = out.scalars;
    if (cache.ff) s.speed = H.f32[(cache.ff + 0x9C) >> 2];
    if (cache.death) s.hearts = H.u32[(cache.death + 0x64) >> 2];
    if (cache.mem) s.memory = H.f32[(cache.mem + 0x44) >> 2];
    if (cache.batt) {
      s.batteryPercent = H.f32[(cache.batt + 0x18) >> 2];
      s.batteryCharge = H.f32[(cache.batt + 0x1C) >> 2];
      s.batteryDead = H.u32[(cache.batt + 0x38) >> 2];
    }
    if (cache.mon) {
      s.isSeen = H.u8[cache.mon + 0x54];
      s.isCatching = H.u8[cache.mon + 0x55];
      s.catchDistance = H.f32[(cache.mon + 0x2C) >> 2];
    }
    return out;
  }

  window.BRLive = {
    ready: function () { var H = heaps(); return !!H; },
    resolve: resolve,
    getState: getState,
    getPlayer: function () { var g = getState(); return g.player; },
    getCamera: function () { var g = getState(); return g.camera; },
    getMonster: function () { var g = getState(); return g.monster; }
  };
})();
