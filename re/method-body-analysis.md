# 方法本體靜態分析（路 1 補充）

對 `Build/Game.wasm.unityweb` 解出的 `game.wasm` 做函式級反組譯，評估能否在**無執行期**條件下還原各玩法方法的實作邏輯（輸入 API、視野／拾取門檻、狀態流轉）。

## 工具與核對基準

- 反組譯器：binaryen `wasm-dis` 119，全模組傾印為 wat。
- 模組統計：定義函式 57,900；函式匯入 519（wat `$fimport$0..$fimport$518`，wasi／env 執行期助手）。
- 位址映射：`script.json` 的 `Address` 即 **wat 定義函式序號**（`$N`），不是含匯入的全域索引。
  - 驗證方式：取數個編譯產生的狀態機 `MoveNext`，比較 `$Address` 與 `$Address−519` 兩支函式主體；前者為數十行含呼叫的狀態機主體，後者為 6 行空殼，故定序＝Address。

## 觀察到的函式形態

抽查 `FreeFPSControllerStable`、`MonsterController`、`MonsterAI`、`ClueManager`、`MemoryProgression`、`BatterySystem`、`DeathManager` 的關鍵方法（HandleMovement / HandleLook / HandleSprint / CheckIfSeen / CatchSequence / ScreamAndChase / 各 MoveNext）：

- 每支方法函式多為**薄包裝**：執行期類別初始化守衛（`call $994/$996`）、接收者／欄位 null 檢查、依偏移讀寫欄位，再以 `call_indirect` 或鄰近助手函式轉發。
- 自有／引擎方法呼叫大多走 `call_indirect`，目標方法指標在**啟動後**填入；直接 `call` 的對象多為 IL2CPP 執行期助手或編譯器產生的閉包，靜態無法可靠對應到某個 Unity API。
- 方法本體內**未見顯著 f32 門檻常數**；速度、視野距離、捕捉距離、拾取半徑等量值位於**實例序列化欄位**（偏移見 `own-enriched.json`），而場景 MonoBehaviour 型別樹已被剝除，靜態讀不到 Inspector 預設值。

## 輸入系統判定（靜態可證部分）

`stringliteral.json` 中存在舊 Input Manager 的軸名與按鍵字面量：

- 軸名：`Horizontal`、`Vertical`、`Mouse X`、`Mouse Y`
- 按鍵／動作字面量：`Left Shift`、`Shift`、`Space`、`E`、`F`、`Tab`、`Escape`、`LeftAlt`
- 自有類別欄位掃描未發現 `InputAction` 欄位；新 InputSystem 組件主要為 UI／觸控配套。

**結論**：玩法移動與視角走舊 Input Manager（`Input.GetAxis` 讀上述軸；動作／疾跑／跳躍走 `KeyCode`），不是新 InputSystem 動作資產。仍無法在靜態層逐方法斷定哪個動作用 `GetAxis`、哪個用 `GetKey`——該細節在方法本體的間接呼叫之後。

## 靜態還原不了的部分（誠實標註）

- 每支方法實際呼叫的具體 Unity API（`CharacterController.Move`、`Physics.Raycast`、`Input.GetKey` 等）與其參數。
- 怪物視野 FOV／射線距離／捕捉距離、拾取距離、移動速度等**預設數值**。
- 協程／狀態機的實際分支流轉與計時。
- 以上須在執行期取得活物件後，依 `probe-targets.json` 偏移讀欄位，並解析 `call_indirect` 目標再反組譯該真實主體（路 3）。

## 再生方式

```bash
# 反組譯全模組（產出約 320MB wat）
wasm-dis game.wasm -o game.wat
# 函式序號對照方法名：re/script.json 的 ScriptMethod[].Address == wat $N
```

`re/own-enriched.json` 提供欄位型別與偏移；`re/probe-targets.json` 提供路 3 執行期探測的欄位與參考圖。
