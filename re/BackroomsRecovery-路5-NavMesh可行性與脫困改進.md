# 路 5：NavMesh 尋路可行性評估與脫困改進（2026-11-25）

對「以 NavMesh 路徑角點取代直線滑牆摸索」做執行期 heap 探測與離線圖模擬；
結論是 **wasm 執行期讀不到可用的 NavMesh 角點**，本輪先交付不依賴 NavMesh 的頁面層脫困改進。

## 執行期 heap 探測結果

探測環境：vm headless SwiftShader、成品 `probe/br/`、BRLive 已解析。

| 目標 | klass | 探測結論 |
|---|---|---|
| `TargetIndicator` | 0x183bdc0，vtable 方法 Awake/Update/GetAimPoint/FindNearestTarget/UpdateParticle/.ctor 比對正確 | heap 唯一資料堆匹配欄位存的是 klass 指標而非物件參考，判斷為假例；場景中未確認到真實 TI 活例，`navPath`（0x38）無有效參考可讀 |
| `NavMeshPath` | 0x1ceec80 | 唯一資料堆候選 0x133c480；`m_Corners`（0xC）指向位址解不出陣列 klass，length 欄位為垃圾值；0x8 `m_Ptr` 為原生指標 |
| `NavMeshAgent` | — | `MonsterController.agent`（0x48）指向 agent 物件，但其 klass 名稱解碼失敗；agent 未暴露 managed `path` 屬性 |

### 為什麼不能從 JS 主動算路

- `NavMesh.CalculatePath(source, target, areaMask, path)` 需要一個 **managed `NavMeshPath` 物件**；JS 無法配置 IL2CPP 受管理物件（無 Object::New 入口）。
- `CalculatePathInternal_Injected(in Vector3, in Vector3, int, IntPtr path)` 吃原生 path 句柄；角點只能經由 managed `get_corners()` 回傳，繞過物件仍讀不到 corners。
- 怪物側 `NavMeshAgent` 內部原生路徑未對 JS 暴露讀取接口。

## 離線可視圖模擬（無 NavMesh 可行走資訊）

以世界模型 94 個目標節點（記憶碎片/門/電池/線索/航點）做距離閾值 14m、落差 4m 連邊：

- 邊數 314，但分成 **8 個連通分量**（最大 54、其餘 20/9/5/3/1）；走廊缺口無法靠相鄰目標直連橋接。
- 結論：純離線目標點 A* 會在牆體間斷線，不能取代 NavMesh。

## 本輪交付的脫困改進（`auto-bot.js`，頁面層）

不讀 NavMesh，針對真機觀測到的「柱體/牆角原地打轉」加強反應式脫困：

- **軌跡倒退（backtrack）**：保留 1.2 秒近期座標軌跡；連續兩次脫困失敗後，倒退 0.8 秒回到軌跡起點（最近的開闊點），再換邊重試。
- **斜向側繞（unstuck strafe）**：脫困段不再只原地轉向，按住 W 的同時壓側移鍵（escapeDir 正→D、負→A）貼障礙繞行。
- 一般導航/漫遊/逃跑分支釋放側移鍵，避免殘留橫向輸入。
- 新增常數：`NAV.trailMs` 1200、`NAV.backtrackMs` 800；`guard.backtrackUntil` 紀錄倒退期限。

## 驗證

- `node --check auto-bot.js` 通過；headless 45 秒取樣無 JS 例外（僅良性 404 資源訊息）。
- 開闊段前進正常（31.7→7.2m 收斂）；卡住時 nav/unstuck/backtrack 分支依序觸發。
- 限制：無 NavMesh 可行走圖時，柱體包圍口袋仍可能反覆脫困—倒退與側繞只能降低停留時間，不能繞出牆體。

## 後續可行路線（待評估）

- 取得 Unity 原始專案重新構建（路 C），直接在專案內讀/寫 NavMesh 資料。
- 更深的原生 RE：反組譯 `NavMesh.CalculatePathInternal_Injected` 與 `NavMeshPath.get_corners` 主體，確認原生句柄能否直接取角點緩衝區。
- 若未來能讀到 `TargetIndicator.navPath` 真實活例，可直接沿用其 corners 陣列（偏移 0x38 → 0xC，陣列 length 0xC、元素 0x10，Vector3 12 bytes）。
