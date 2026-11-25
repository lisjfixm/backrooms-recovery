# 路 4：Windows 真機驗證紀錄（2026-11-25）

對 IL2CPP WebGL 成品在 Windows 本機以真 GPU 實跑，驗證輸入通道、轉向手感與座標導閉環；
路 3 即時狀態橋接（`live-probe.js` / `window.BRLive`）已生效，本紀錄只記真機觀測結果。

## 環境

- 成品經本機靜態伺服器 `127.0.0.1:8879` 服務；Chrome 獨立 `user-data-dir`，`--remote-debugging-port=9222`。
- GPU：ANGLE Intel UHD Graphics 630（0x3E9B）Direct3D11 vs_5_0 ps_5_0（真 GPU，非 SwiftShader 頭less 軟渲）。
- CDP 驅動：node 22 內建 WebSocket/fetch 直連，無 Playwright；命令走 `Runtime.evaluate`、`Input.dispatchKeyEvent/MouseEvent`、`Page.captureScreenshot`。

## 輸入通道驗證

- **選單閘門**：主選單開啟期間控制器忽略所有輸入。先前「合成事件無效」的誤判來自選單閘門，不是事件通道本身的問題；選單經 CDP 點擊 `/START>` 關閉後輸入才接通。
- 選單關閉後兩條通道皆實測有效：
  - CDP `Input.dispatchKeyEvent`：KeyW 按住 1.5s，座標 −107.0 → −105.0（前移約 2m）。
  - CDP `Input.dispatchMouseEvent`：mouseMoved 共 72px，yaw 91.2 → 341.2（約 −110°）。
  - 頁面合成 DOM 事件：MouseEvent 150px → yaw +48.9°；KeyboardEvent 按住 W 1.5s 前移約 1m。
- 手感基線：DOM 合成事件約 **0.33°/px**；CDP 真實事件約 **1.53°/px**。兩通道靈敏度不一致，bot 閉環增益（`steer.gain`）線上以實際偏航變化估計收斂。

## 60 秒真機長取樣（run-win-3，117 筆）

- 路徑 2D 長度 42.0m；起點 (−103.0, 27.0, −34.1) → 終點 (−72.3, 1.5, −28.7)，由上層下坡抵達黃層走廊。
- 前段開闊路徑：朝向收斂良好，yaw 穩定 81°，目標距離 31.2 → 3.1m。
- 拾取後新目標 2–3.7m，bot 在混凝土柱附近打轉約 28 秒未能貼近；直線朝向被柱/牆阻擋。此為導航規劃問題（無繞行路徑），交 #27 NavMesh 尋路處理。
- yawErr 統計：均值 −0.3°，p90 82.6°，max 173°；|err| > 15° 佔 40%，集中在卡住段，開闊段誤差很小。
- 怪物全程距離 134.7–160.6m，未進入 9m 逃跑分支；flee 分支僅完成程式碼審查（背向怪物 +180° 朝向、按住 W），尚未實機觸發驗證。
- 電池 89.5% → 85.6%（長跑持續消耗），愛心 4，`isSeen` / `isCatching` 皆 0。

## 本輪已修復

- 主迴圈 `requestAnimationFrame(tick)` → `setInterval(tick, 16)`：分頁被遮蔽/隱藏時 Chrome 會暫停 RAF，但 interval 仍可觸發；一般可見場景兩者等價。避免 hidden 分頁下 bot 主迴圈停擺。

## 已知缺口

- `MemoryProgression` 活例錨點未解出：現行交叉驗證（refOffset 0x50 → MainMenuManager）名稱解碼失敗，`scalars.memory` 缺席。不影響座標導航，僅停用「拾取後封鎖鄰近碎片」的最佳化；待 #27 前置探測時於 vm heap 重解析。
- 怪物近距離遭遇時的逃跑分支待實機觀測。
- 手機 ultra、實機音訊 / TTS / GPU 仍未測。

## 下一步（對應待辦）

- **#27 NavMesh 尋路**：優先複用 `TargetIndicator.navPath`（偏移 0x38）讀角點，避免直接呼叫靜態 `NavMesh.CalculatePath` 的 struct/out 參數 ABI 風險。
- **#28 畫面 overlay**：取得攝影機 view/projection 矩陣（或由 pos/forward/up 重建 view），把目標點、怪物、路徑角點投影到獨立 2D canvas 疊層，可開關。
