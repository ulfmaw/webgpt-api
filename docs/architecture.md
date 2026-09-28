# webgpt-api 本地架構

`webgpt-api` 把使用者自己的 ChatGPT Chat 帳號轉接成只在本機監聽的
OpenAI 相容 API。本頁說明請求如何從本機客戶端進入、經過模型目錄與瀏覽器
傳輸層，再回到 Responses／Chat Completions 格式；它不是 ChatGPT 網頁協定
的穩定性保證。

本專案由 `ulfmaw` 維護。核心使用 Node.js 內建 HTTP、fetch、SQLite、加密
及測試工具；JSON Schema 使用 Ajv 與 ajv-formats，SSE 分幀使用
eventsource-parser，本機另檢查容量與完成訊號。約 153 KB 的執行 bundle 與
完整依賴授權放在 vendor，使用者不需要 npm install。版本由
package-lock.json 固定，開發時透過 `npm run build:vendor` 重建。Node.js 是
外部執行環境；Windows 啟動器可自動下載校驗過的免安裝版本。

```text
CLI → 本機 HTTP 協定 → Engine → Transport → 帳號服務
                        ├─ Catalog：發現、選擇、不可用紀錄
                        ├─ Gate：併發與有界等待佇列
                        └─ ConversationStore：SQLite 逐輪增量
```

`/v1` 同時提供本機模型控制頁；管理請求使用獨立的路徑、管理 Cookie／token 及同源檢查，生成 API 保持拒絕瀏覽器 Origin。`ModelSelection` 在登入／刷新時保存帳號回報清單，並只把最近一次成功測試的目前設定標成已驗證；失敗、取消或回報模型不符不更動原設定。Engine 在請求開始取得選擇快照，切換不會改掉已接受的請求。原生 Auto 傳送字面值 auto，不再從目錄挑預設 slug 冒充網站 Auto。登入後的探測先刷新清單，再測試目前設定；不會批次生成所有候選模型。

HTTP 層不理解網站訊息格式；Transport 不知道 localhost 金鑰或資料庫路徑。金鑰不會轉送給帳號服務，帳號憑證不會出現在 API 回應。

`tool-protocol.js` 處理函式提案、call_id 歷史及結構化輸出；`json-schema.js` 僅包裝 Ajv 的版本選擇、容量限制、禁止外部引用與本機錯誤映射。工具由呼叫端執行；模型先透過提示協定生成完整 JSON 提案，驗證全部通過後才轉成 Responses / Chat Completions 工具事件。它不是網站原生工具呼叫，也不聲稱具備官方 constrained decoding。工具輸出先緩衝完整回覆，與純文字逐段串流的延遲特性不同。

## 狀態及失敗界線

1. 檢查請求、金鑰及來源，排入有界佇列。
2. 重建完整本機歷史。若祖先缺失或超限，在送出前停止。
3. 取得帳號模型目錄。引擎保留未開始輸出前的降檔流程；網站錯誤分類必須先通過實機驗收，目前沒有啟用任何降檔規則，不能把合成測試當成網站證據。
4. 將生成事件逐段寫入 socket；遵守 backpressure。客戶端中斷會取消同一筆遠端請求。
5. 只有明確完成的回答才保存到 SQLite，再送 completed。串流途中失敗不保存部分答案。

重新啟動保留已完成的對話，不聲稱能續傳進行中的模型生成。SQLite 只保存每輪輸入與輸出，續接時遍歷父節點，因此存入量不隨完整對話平方增長。新增 details 欄位以非破壞遷移保存建立時間及輸出 ID，支援 Responses 讀取與刪除；舊紀錄缺少中繼資料時明確報錯，不捏造原始回應。刪掉祖先後的續接會報歷史缺失。

`media.js` 驗證 inline base64、檔名及附件總量；完整歷史以角色標記和附件檔名關聯，不把 base64 放入文字提示。原生檔案控制項上傳後，保留網站的附件中繼資料與圖片 asset pointer。暫存檔留在私人 runtime 目錄直到生成完成或取消才移除，因為網站可能到送出時才讀檔。續接會重新上傳歷史附件，尚無上游檔案快取。

## 相容規格與實驗協定

本機文字 API 的事件格式參考公開的 [Responses 串流規格](https://developers.openai.com/api/docs/guides/streaming-responses)，但不是完整 API 實作。未實作的欄位直接拒絕。

預設傳輸為 `src/transports/browser.js`：`chat-catalog.js` 在 Chat 頁面導航前監聽網路，讀取頁面自己發出的 `/backend-api/models` 回應，以啟用版本的 `intelligence_presets` 對應可用的 Chat model 與 thinking_effort；選項 key 使用版本與 preset，避免同一 slug 的不同 effort 被合併。忽略 Work 的 `/backend-api/tpp/models/`，不把原始 `models` 全列出，也沒有 HTTP 通用清單或固定名稱的備援。生成使用 `chatgpt.com` 一般對話頁既有的 `/conversation/init`、prepare 與 `/backend-api/f/conversation` 流程，不走工作區／Codex 路由，也不自行偽造網站驗證 token。只調整自己的請求之模型、完整文字 messages 與 temporary-chat 欄位；原本的驗證與準備資訊不輸出、不放入 Git。`web-events.js` 解析實際觀測到的 v1 快照與補丁，跳過非最終回答與思考內容。明確指定模型時，`requested_model_slug` 回顯不足以驗證成功，還須 `model_slug` 符合指定值。

`BrowserPool` 序列化專用瀏覽器操作，兩秒閒置後關閉。同一波模型查詢與生成可以重用一個實例；取消或失敗會釋放該實例。背景啟動載入正常 temporary-chat 頁面以確認 session；輕量 robots 頁面無法可靠完成此初始化，已停用。生成停用字型與影音下載；圖片請求保留圖片資源。附件上傳前等待網站 prepare 完成並穩定，避免前端模型在載入途中切換而使檔案綁定失效。`src/transports/chatgpt.js` 的舊生成路徑仍只供實驗，並非預設傳輸。網站協定不是穩定 API 合約；函式工具由上層轉接，附件能力仍需逐格式驗收。

`launch` 先建立獨立的 loopback 管理介面，再啟動 API；首次缺少 session 才自動開啟一次登入，驗證失敗不觸發登入迴圈。管理操作需要衍生管理金鑰、正確 Host 與同源 Origin，頁面禁止嵌入。啟動器透過本機 `/v1/responses` 做不儲存的完整文字生成檢查。`/healthz` 的 live_transport_verified 表示本程序曾完成生成，不是未來可用性的保證。停止優先對自己啟動的瀏覽器送 Browser.close，無回應時僅清理保存的子程序 PID，絕不按瀏覽器程序名稱大範圍終止。

## 第一版邊界

只允許 loopback，所有生成路徑須本機金鑰，拒絕瀏覽器跨來源請求。沒有隧道、自動開埠、帳號輪替、桌面殼或付費後端退路。部署檔案與執行時秘密分開。
