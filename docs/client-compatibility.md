# 真實客戶端相容性驗收

目標：一般 OpenAI 客戶端只替換 Base URL 和本機 Key，就能完成實際工作。
這是驗收目標，不是目前已達成的宣傳。

## 實測結果

`node scripts/codex-client-check.js` 使用本機安裝的 Codex CLI、獨立臨時工作目錄、
忽略使用者設定、唯讀沙箱與 ephemeral 模式，明確指定本機 provider，不走付費 API。
測試提示只要求一段固定文字、不使用工具。只輸出欄位名稱與失敗摘要，不保存原始請求、憑證或 CLI 日誌。
臨時工作目錄保留在系統 Temp，名稱以 webgpt-client-check- 開頭；不包含專案來源或憑證。

文字測試已通過：CLI 退出碼 0 並取得預期回答。先前 tools 欄位阻擋已修復。
`--tool` 讀檔測試已收到模型的工具呼叫，但客戶端執行命令時回報 blocked by policy；
腳本立即停止，不更改或繞過執行政策。因此完整 Codex 工具工作流仍未驗收通過。
CLI 真正送出的欄位包括：model、instructions、input、tools、tool_choice、parallel_tool_calls、
reasoning、store、stream、include、prompt_cache_key、client_metadata。
即使提示「不用工具」，客戶端仍送工具定義；不能靠短提示避開協定相容問題。

`node scripts/tool-live-check.js` 使用真正網站模型與固定、無害的測試函式：
模型要求讀取測試值後，呼叫端才產生隨機值，使用原 call_id 與 previous_response_id 回傳。
模型正確回答该隨機值，工具 SSE 事件與結果續接均通過。JSON Schema 輸出也已實測，
包含 Ajv 驗證的 pattern、email format。這是實際 API 往返，不是 Codex 本機命令執行成功。
腳本只刪除自己建立的本機測試對話。離線測試共 100 項通過。

`scripts/sdk-live-check.js` 使用官方 OpenAI SDK，已通過 Responses 串流、已儲存回覆讀取／刪除、Chat 串流 runTools、Responses parse。runTools 回呼實際讀取臨時檔案中的隨機值，模型看過工具結果後正確回傳；只執行固定讀檔函式，不執行模型產生的指令。測試建立的檔案與本機回覆會清除。

`scripts/media-live-check.js` 已通過文字附件與隨機色塊 PNG，`scripts/pdf-live-check.js` 已通過含隨機標記的單頁 PDF。曾發現網站初始化切換模型使附件綁定失效，已加入 prepare 完成／穩定等待及回歸測試；不是重送失敗的生成請求。多頁、掃描及加密 PDF 與其他圖片格式仍未逐項驗證。

`scripts/ui-browser-check.js` 的隔離瀏覽器驗證使用合成管理回應，涵蓋版面與操作，不代表真實帳號首次登入。`scripts/release-check.js` 通過無 node_modules、無帳號的解壓啟動檢查；它不驗證網站生成。取消後恢復的真實帳號測試已於附件修正後再通過。

工具能力由提示協定與本機驗證轉接：先取得完整提案、驗證名稱及 JSON 參數，再發送標準工具事件，
最後由呼叫端真正執行。不是網站原生工具 API，也不保證與官方 constrained decoding 相同的可靠度。
無效回覆會報錯，不派發半截工具或偷偷忽略 schema。參數串流目前在整份驗證後才發送。

## 必須逐項通過的驗收

| 能力 | 目前狀態 | 通過標準 |
| --- | --- | --- |
| 純文字 JSON / SSE、多輪 | 自有測試通過 | 真實聊天客戶端可完成多輪、取消與重連 |
| Codex CLI 最小請求 | 文字通過；讀檔受執行政策阻擋 | 原樣接受客戶端必要欄位，完成回覆；不得無聲丟棄有作用的選項 |
| Function tools | 實機函式往返通過；完整 CLI 尚未通過 | 真實 CLI 選工具、產生合法參數、收到結果、繼續到完成 |
| 工具串流及多工具 | 單工具 SSE 實機通過；多工具離線通過 | call_id、增量、結束事件及多次呼叫正確，不重複執行 |
| 結構化輸出 | JSON Schema 實機通過；Ajv 驗證 | JSON Schema 等約束有驗證與明確失敗處理 |
| 圖片與檔案輸入 | PNG、文字檔、單頁 PDF 實機通過；其他格式待驗證 | 真實客戶端傳入內容，限制、格式及錯誤符合契約 |
| 圖片／檔案輸出及音訊 | 未支援 | 真實客戶端取回內容；不以文字或假 URL 冒充 |
| 推理設定 | 未支援獨立控制 | 請求設定確實送達並可確認生效 |
| 故障與長時間使用 | 部分本機測試 | 長對話、連續操作、取消、帳號過期、程序重啟與中斷均有可重現結果 |
| 其他官方端點與能力 | 尚未逐項盤點 | 每個列為支援的端點均有實作、客戶端測試及能力來源 |

網頁模型沒提供的功能必須明確揭露相容層如何實作，不能用固定假值、只送工具事件卻未往返的假測試，或未經使用者同意的付費後端替代。
無法測到的方案、權限或故障條件維持未驗證，不用合成單元測試冒充實機結果。
