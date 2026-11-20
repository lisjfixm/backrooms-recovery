# Backrooms Recovery — 路 1／2 深逆向成果與路 3 準備狀態

日期：2026-11-20　成品：Unity 6000.3.3f1 WebGL，IL2CPP，metadata v39
範圍：僅本專案離線成品。未從成品觀察到的機制標註「未確認」。

## 一、結論摘要

三條路線現況：

| 路線 | 目標 | 狀態 |
|---|---|---|
| 1 | 重建方法→函式位址、欄位型別與偏移 | **完成（靜態）**。註冊表自動定位成功，欄位型別／位元組偏移／方法函式索引／dummy DLL 皆還原 |
| 2 | 解包場景與預製體，建靜態世界模型 | **完成（靜態）**。場景階層、世界座標、NavMeshAgent 參數、NavMesh 邊界、圖層分類完成；自有序列化預設值仍被剝除 |
| 3 | 執行期 heap 定位活物件、讀即時狀態 | **受阻於本機離線**。目標偏移／參考圖已備妥；唯一未決難點是「首個活物件指標」 |

關鍵突破：先前判定「欄位型別、欄位偏移、方法位址無法從 metadata 還原」，本輪藉由 v39＋WASM 專用 dumper 定位到 wasm 內的 CodeRegistration／MetadataRegistration 後，這三項**靜態皆已還原**。

## 二、路 1：IL2CPP 註冊表重建（完成）

### 2.1 工具與註冊表定位
- 工具：AndnixSH/Il2CppDumper v3.2.1（支援 metadata 16–39、Unity 至 6000.7、WASM），.NET 10 SDK 自建 CLI＋Core（略過 Windows GUI）。
- 輸入：解壓後 `game.wasm`（25,116,621 B）＋ `global-metadata.dat`（4,024,528 B）。
- 自動搜尋結果：
  - CodeRegistration：`0x1a8934`
  - MetadataRegistration：`0x1135dc`
- metadata v39 可變寬度索引模式辨識成功；偵測 Unity 6000.3.0b1+。

### 2.2 還原內容（已驗證）
- **5,201 型別**、**33,681 個方法**進 script.json，**38,433 個位址**（wasm 函式索引，範圍 558–44966，32-bit）。
- **40 個 dummy DLL**（含 `Assembly-CSharp.dll`、`Assembly-CSharp-firstpass.dll`、`Unity.AI.Navigation.dll`、`Unity.InputSystem.dll` 等），為有效 PE/.NET 組件，可用 dnSpy／ILSpy 開啟。
- 自有類別（剔除編譯器產生項）：**95 個實類別**（Assembly-CSharp 91、firstpass 4），**1,009 欄位**、**599 方法**，其中 **536 方法帶函式索引**。
- **欄位型別＋執行期位元組偏移**：例如 `FreeFPSControllerStable` 從 0x10 排到 0xD4；`MonsterController` 從 0x10 排到 0x55。
- **6,901 條字串字面量**還原（多語系劇情旁白、UI 標籤、實體描述）。
- 方法簽名含參數型別；屬性、陣列型別（`RectTransform[]`、`Texture[]`、`List<Transform>`）皆解析。

### 2.3 範例：關鍵類別狀態欄位（型別／偏移）

**FreeFPSControllerStable（玩家控制器，MonoBehaviour）**
| 偏移 | 型別 | 欄位 |
|---|---|---|
| 0x10 | MainMenuManager | menuManager |
| 0x14 | ClueManager | clueManager |
| 0x18 | FilesPanelController | filesPanel |
| 0x1C | MapPanelController | mapPanel |
| 0x20 | MobileJoystick | joystick |
| 0x24 | MobileLook | mobileLook |
| 0x28 | float | walkSpeed |
| 0x2C/0x30/0x34 | float | sprintStartSpeed / sprintMaxSpeed / sprintAccelerationTime |
| 0x38/0x3C | float | mouseSensitivityPC / mouseSensitivityMobile |
| 0x4C | Transform | cameraTransform |
| 0x80 | CharacterController | controller |
| 0x84/0x88 | float | xRotation / yRotation |
| 0x9C | float | currentSpeed |
| 0xA4 | bool | isSprinting |
| 0xBC | float | smoothedSpeed |
| 0xCC | bool | isCursorLocked |

方法函式索引：`Start` 4002、`Update` 4003、`HandleLook` 4011、`HandleSprint` 4012、`HandleMovement` 4013、`ApplyCameraMotion` 4014。

**MonsterController**：`player` Transform 0x10、`playerCamera` 0x14、`monsterCamera` 0x18、`visibleLayers` LayerMask 0x1C、`rayDistance` 0x24、`fov` 0x28、`catchDistance` 0x2C、`catchSequenceDuration` 0x30、`deathManager` 0x38、`memoryProgression` 0x3C、`memoryPenaltyOnCatch` 0x40、`agent` NavMeshAgent 0x48、`animator` 0x4C、`checkTimer` 0x50、`isSeen` 0x54、`isCatching` 0x55。方法：`CheckIfSeen` 3987、`CheckSide` 3990、`CatchSequence` 3991。

**MemoryProgression**：`minValue` 0x10、`maxValue` 0x14、`startValue` 0x18、`currentValue` 0x44、`canTrigger` 0x4C、`firstMemoryHintShown` 0x4D、`menuManager` 0x50、`filesPanel` 0x54。

**BatterySystem**：`maxCharge` 0x10、`drainPerSecond` 0x14、`currentPercent` 0x18、`currentCharge` 0x1C、`batteryQuarters` GameObject[] 0x20、`deathManager` 0x30、`batteryDead` 0x38。

**DeathManager**：`player` Transform 0x10、`respawnPoints` Transform[] 0x14、`batterySystem` 0x4C、`currentHearts` int 0x64、`extraLifeChosen` bool 0x68。

### 2.4 路 1 限制（誠實標註）
- **方法本體空白**：dump.cs 內方法皆是 `{ }`；邏輯仍在 wasm 函式中，位址已給，可進一步反組譯，但本輪未做指令級還原。
- **自有序列化預設值仍讀不到**：場景 bundle 的 MonoBehaviour 型別樹被剝除，Inspector 上預設的速度／距離／生成點陣列值未還原；它們只存在執行期物件上。
- 少數靜態欄位在解析時偏移標記為 0x0／0x4（解析器對 static 欄位處理落差），非執行期實例偏移。
- 字串字面量位址為 wasm 內參考位址；部分引擎框架字串夾雜在 6,901 條中。

## 三、路 2：靜態世界模型（完成）

### 3.1 場景與資產
- 單一場景：`Assets/Backroom map.unity`（BuildSettings 僅此一關）。
- bundle 物件統計：1,337 GameObject、1,183 Transform、351 MonoBehaviour、622 MonoScript、9 NavMeshAgent、1 NavMeshData（33 tile，266,864 B）。
- NavMesh 建置參數：agent 半徑 0.5、高 2.0、坡度 45°、攀爬 0.75；世界邊界中心 (-20.9, -8.6, 20.7)、範圍 (100.2, 42.4, 110.9)，約 x[-121,79]、z[-90,132]。

### 3.2 圖層
Default(0)、TransparentFX(1)、Ignore Raycast(2)、**Player(3)**、Water(4)、UI(5)、**interior(6)**、Billboard(8)、**Monster(30)**、postprocessing(31)。

### 3.3 分類計數（序列化快照座標）
| 分類 | 數量 | 備註 |
|---|---|---|
| memory_pickups（記憶體／Minispawn／Burned／next memory） | 55 | 含 13 個 Memory drop、38 個 Minispawns |
| monster_spawns（Spawn smiller／rabbit） | 13 | 怪物生成點 |
| monster_agents（掛 NavMeshAgent） | 8 | 另 agents.json 記錄 9 筆（含命名為 GameObject 的子實體） |
| respawn_points | 11 | 玩家／怪物重生點 |
| batteries | 8 | 含 UI 按鈕與生成點容器 |
| doors | 4 | door、Child door×2、door sund |
| path_nodes | 8 | PathNode 子節點 |
| polaroids | 20 | 拍立得牆／物件 |
| cameras | 6 | 主相機＋怪物觀測相機 |
| managers_and_triggers | 21 | 各 Manager、面板、觸發區 |
| monster_rig_bones | 44 | mixamo 骨骼（The cleaner） |
| player_controller | 1 | `character`（CharacterController＋SphereCollider＋MB） |

### 3.4 NavMeshAgent 速度／參數（來自序列化元件）
| 物件 | 速度 | 加速度 | 半徑 | 角速 | 備註 |
|---|---|---|---|---|---|
| PimkyWolf (1) | 9.0 | 8.0 | 0.5 | 120 | 最快追擊 |
| PimkyWolf HARD | 9.0 | 8.0 | 0.5 | 120 | 最快追擊（難度版） |
| Drunk Walk | 5.25 | 8.0 | 0.5 | 120 | 遊走 |
| Rabbit | 3.5 | 8.0 | 0.5 | 120 | 巡邏 |
| FourthGreen | 3.5 | 8.0 | 0.1 | 280 | 小型實體 |
| GameObject（子實體） | 3.5 | 8.0 | 0.1 | 280 | 泛名子物件 |
| run monster normal | 3.0 | 8.0 | 0.2 | 120 | 奔跑怪普通 |
| run monster Hard | 3.0 | 8.0 | 0.2 | 120 | 奔跑怪困難 |
| The cleaner | 1.0 | 3.0 | 0.2 | 120 | 緩慢清理者 |

### 3.5 路 2 限制
- 快照座標為**編輯器／初始停放位置**：玩家與主相機停在選單高位 y≈27（-107, 27, -34），進場後傳送到重生點；執行期實際位置可能不同。
- 自有序列化欄位值（生成點陣列內容、距離阈值、FOV 數值）未隨型別樹保存，靜態讀不到；需執行期讀取或反組譯方法本體取得。
- NavMesh tile 二進位（Detour/Recast meshdata）本輪未拆成多邊形；Walkable 區域可在後續解析。

## 四、路 3：執行期活物件定位（本機離線，已備妥）

### 4.1 現況
雲端瀏覽器不支援 WebGL，無法在 vm 實機取 heap；Windows 本機目前離線。執行期掃描須等本機回來再跑。

### 4.2 已備妥的探測基礎
- `probe-targets.json`：12 個 bot 關鍵類別的狀態欄位（型別／偏移／scalar|ref）、方法位址，與自有類別間參考圖。
- 參考圖（由靜態欄位偏移還原）：
  - `MainMenuManager` → deathManager 0x7C、batterySystem 0x80、memoryProgression 0x84、chronoTimer 0x88、filesPanel 0xAC（ root 單例，串起所有管理器）
  - `FreeFPSControllerStable` → menuManager 0x10、clueManager 0x14、filesPanel 0x18、mapPanel 0x1C、joystick 0x20、mobileLook 0x24
  - `MonsterController` → deathManager 0x38、memoryProgression 0x3C
  - `DeathManager` → batterySystem 0x4C；`BatterySystem` → deathManager 0x30
  - `MiniMemoryPickup`／`PickupMemoryDistanceGlobal` → memorySystem 0x10
- IL2CPP 32-bit 物件表頭：klass 指標 @0x0、monitor @0x8，實例欄位自 0x10 起。

### 4.3 待本機回來後的執行步驟（預計）
1. 本機開 **未被占用** 的埠（避開現有 8050／8784／9080／9128／9222；建議 http 8791、CDP 9333），用**獨立暫存 Chrome 設定檔**，不動其他專案瀏覽器。
2. CDP 求值取得 HEAPF32/U32/U8 與 asm.memory。
3. 定位首個活物件（三種候選錨點，依序嘗試）：
   - 靜態陣列錨點：`PickupMemoryDistanceGlobal.globalSpawnPoints`（Transform[]）／`occupiedSpawnPoints`（List）在 BSS／資料段的靜態位置；
   - klass 名稱錨點：以 metadata 類別名字串在 heap 反查 Il2CppClass；
   - 已知純量模式比對（須在隔離靜止場景 A/B 校準）。
4. 找到任一活實例後，依 4.2 參考圖步行管理器；按偏移讀 scalar（currentValue、currentPercent、isSeen、isCatching、currentHearts 等）；玩家世界座標經 `controller`(CharacterController)／`cameraTransform` 再解析引擎 Transform 內部位置。

### 4.4 唯一尚未克服的難點
**首個活物件指標**：JS 層無 klass 表／物件表入口，前序純數值掃描被網格頂點／動畫／燈光雜訊淹沒，且跨場景傳送會使舊位址失效。其餘環節（型別、偏移、參考鏈、方法位址）本輪已就緒。

## 五、先前開放問題的更新解答

- **輸入系統走新 InputSystem 還是舊 Input Manager？**
  自有類別的面板開啟鍵全部宣告為 **`KeyCode`**（ClueManager.togglePanelKey/clueKey、FilesPanelController.openKey、MapPanelController.openKey、FadeUIOnMoveOrShift.closeKey），屬**舊 Input Manager**；未發現自有類別持有 `InputAction` 欄位。新 InputSystem 組件主要為 UI／觸控配套。行動移動的具體 `Input.GetAxis/GetKey` 呼叫在方法本體（wasm），未逐指令確認，但欄位證據指向舊 API。
- **欄位型別／偏移／方法位址**：靜態已還原（見第二節）。
- **自有序列化預設值**：仍讀不到（場景型別樹剝除）。
- **活物件指標**：仍缺（路 3 阻塞點）。

## 六、產出檔案（vm 工作目錄 `wasm-re/out/`）
- `dump/dump.cs`：5,201 型別完整傾印（欄位偏移＋方法 RVA）。
- `dump/script.json`：方法名→wasm 函式索引＋簽名（33,681 方法）。
- `dump/stringliteral.json`：6,901 字串字面量。
- `dump/DummyDll/`：40 個 dummy .dll。
- `own-enriched.json`：95 實類別＋編譯器項目的型別／偏移／位址機讀檔。
- `probe-targets.json`：路 3 探測目標與參考圖。
- `world-model.json`：靜態世界模型分類與座標。
- `world.json`：全部 GameObject／Transform／元件明細。
- `agents.json`：9 筆 NavMeshAgent 參數。
