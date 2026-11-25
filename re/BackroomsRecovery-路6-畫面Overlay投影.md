# 路 6：畫面 Overlay — 3D 世界點投影到螢幕標記（2026-11-25）

把 BRLive 讀到的即時世界座標（目標碎片、怪物）投影成螢幕上的 2D 標記，
獨立 canvas 疊層、可開關；不修改 Build/ 成品。

## 資料來源（`live-probe.js`）

- `BRLive.getState().camera` 原本只有 `pos`；本輪補上 `forward`、`euler`（同玩家姿態，經 Transform `get_forward` / `get_eulerAngles` invoker 讀回）。
- 目標點取自 bot 目前 `live.goal.pos`；怪物取自 `live.monster.pos`。

## 投影方式（`auto-bot.js`）

- 不呼叫引擎 view/projection 矩陣：由攝影機 yaw／pitch 重建 forward／right／up 單位向量，
  對目標方向向量做深度（forward 分量）、右側（right 分量）、高度（up 分量）分解，再以 FOV 常數換算螢幕 2D。
- 前方遮擋：深度 < 0.5 視為在身後，不畫標記。
- 超出畫面的標記夾持到螢幕邊緣（24px 邊距），半透明並加 `↺` 標記，表示離屏。
- 顏色：目標青色 `#37e6ff`、怪物紅色 `#ff4d5e`；標記為圓環＋中心點，附名稱標籤。

## 開關與介面

- 右上角 `OVERLAY: ON/OFF` 按鈕；快捷鍵 `O` 切換（`B` 仍是 AUTO 開關）。
- 疊層 canvas `position:fixed; inset:0; z-index:99998; pointer-events:none`，不擋滑鼠事件；
  視窗縮放時重設尺寸。
- overlay 輪詢與繪製不依賴 AUTO 開關：即使 bot 自動操控關閉，標記仍隨即時座標更新。

## 驗證（headless SwiftShader）

- 攝影機姿態讀回正常：yaw 86.6°、forward (0.998, 0, 0.060)。
- 怪物紅標記繪製於畫面左側；跨層目標（垂直落差約 26m）投影到螢幕外，夾持到底部邊緣顯示 `Memory drop (13) ↺`。
- 無 JS 例外（僅良性 404 資源訊息）。

## 限制與待辦

- **FOV 為預設常數 60°**：實際主鏡頭 FOV 尚未經 Camera `get_fieldOfView` 讀回；標記水平位置方向正確，絕對角度可能有偏差。
- 尚無路徑角點標記：NavMesh 角點通道不可讀（見路 5 文件），未來若取得角點可沿用同一投影函式。
- 垂直投影只取 pitch；滾轉（roll）未納入。
