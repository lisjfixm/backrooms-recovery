# re/ — 離線成品逆向產出

對 `Build/` 內 IL2CPP WebGL 成品（Unity 6000.3.3f1，metadata v39）做靜態逆向的結果。僅供研究／互通分析；方法本體未還原，dummy DLL 不含程式碼。

## 檔案清單

| 檔案 | 內容 |
|---|---|
| `BackroomsRecovery-路123-深逆向與靜態世界模型.md` | 完整報告：路 1 註冊表重建、路 2 靜態世界模型、路 3 準備狀態與限制 |
| `own-enriched.json` | 95 個自有實類別：欄位型別＋位元組偏移、方法簽名＋wasm 函式索引、所屬組件 |
| `probe-targets.json` | 路 3 執行期探測目標：12 個 bot 關鍵類別的狀態欄位與自有類別參考圖 |
| `world-model.json` | 靜態世界模型分類：怪物／生成點／記憶體／電池／門／重生點／攝影機等座標與 NavMesh 參數 |
| `world.json` | 全部 GameObject／Transform／元件明細（含世界座標） |
| `method-body-analysis.md` | 方法本體靜態分析：位址映射、薄包裝／間接呼叫形態、輸入系統判定與還原邊界 |
| `agents.json` | 9 筆 NavMeshAgent 參數（速度、加速度、半徑、角速） |
| `dump.cs` | 5,201 型別完整傾印：欄位偏移、方法 RVA（wasm 函式索引） |
| `script.json` | 方法名→wasm 函式索引＋簽名（33,681 方法、38,433 位址） |
| `stringliteral.json` | 6,901 條字串字面量（多語系劇情旁白、UI 標籤） |
| `dll/Assembly-CSharp.dll` | 自有程式碼 dummy 組件（僅結構，無程式碼），可用 dnSpy／ILSpy 開啟 |
| `dll/Assembly-CSharp-firstpass.dll` | firstpass dummy 組件（PointerLockGuard 等） |

## 關鍵靜態事實

- 註冊表位址：CodeRegistration `0x1a8934`、MetadataRegistration `0x1135dc`（wasm 線性記憶體偏移）。
- IL2CPP 32-bit 物件表頭：klass 指標 `0x0`、monitor `0x8`，實例欄位自 `0x10` 起。
- 輸入：自有面板按鍵宣告為 `KeyCode`（舊 Input Manager）；未發現自有類別持有 `InputAction` 欄位。
- 場景：單一 `Assets/Backroom map.unity`；NavMesh agent 半徑 0.5、高 2.0、坡度 45°、攀爬 0.75。

## 限制（誠實標註）

- **方法本體空白**：邏輯仍在 wasm 函式中；`script.json` 給了函式索引，可再反組譯，本輪未做指令級還原。
- **自有序列化預設值讀不到**：場景 MonoBehaviour 型別樹被剝除，Inspector 上的速度／距離／生成點陣列值未還原，只存在執行期物件上。
- **執行期活物件指標未定位**：JS 層無 klass 表／物件表入口；路 3 須在本機 WebGL 實機以 heap 掃描找到首個活實例後，再依 `probe-targets.json` 參考圖步行。
- `world.json`／`world-model.json` 座標為序列化快照的初始停放位置，進場傳送後的執行期位置可能不同。

## 再生方式（記錄用）

- 工具：AndnixSH/Il2CppDumper v3.2.1（支援 metadata 16–39、WASM），.NET 10 SDK 自建 CLI。
- 輸入：解壓後 `Game.wasm.unityweb`（原始 wasm）與 `Il2CppData/Metadata/global-metadata.dat`（自 `Game.data.unityweb` 的 UnityWebData 封存解出）。
- 世界模型：UnityPy 解析 `data.unity3d` 與 `sharedassets0.resource`。
