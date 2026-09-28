# webgpt-api

把 ChatGPT 網頁版的 Chat 模式，接成一個只在本機監聽的 OpenAI 相容 API。

`webgpt-api` 是一個本機轉接層：它接收既有 OpenAI 介面的請求，使用你本人
登入的 ChatGPT 帳號完成生成，再把結果轉回 `Responses` 或 `Chat Completions`
格式。這讓 Codex CLI、Claude Code、OpenCode 等工具可以沿用原本的客戶端
設定，同時使用 Chat 網頁端實際提供給該帳號的模型與權限。

請求路徑很直接：

```text
OpenAI 相容客戶端
        │  127.0.0.1 + 本機 API 金鑰
        ▼
webgpt-api gateway
        │  隔離的專用瀏覽器工作階段
        ▼
ChatGPT 網頁版 Chat
```

它不是官方 OpenAI API、遠端代理或代管服務。服務只綁定 loopback；登入狀態、
本機金鑰、對話資料與專用瀏覽器設定檔留在你的電腦上。ChatGPT 網頁協定不是
穩定的公開 API，因此可用模型、登入狀態與部分功能會隨帳號、瀏覽器和網站
變更而變化。

## 設計取向

- **保持 Chat 的原生選擇。** 模型清單來自帳號自己的 Chat 選單；`auto` 會原樣交給上游，不自行假定某個固定模型。
- **本機邊界清楚。** 生成 API 只接受本機連線與本機金鑰，不開放公網、不建立隧道，也不接管日常瀏覽器。
- **失敗不被掩蓋。** 網站回覆未完成、模型被替換、登入或協定驗證失敗時，閘道會回報錯誤，不把半截內容當成成功，也不靜默改用另一個模型。
- **相容性有明確範圍。** 目前涵蓋文字、多輪上下文、JSON／SSE、函式工具協定，以及部分附件輸入；詳細邊界與未驗證項目列在文件中。

## 快速開始（Windows）

1. 下載或 clone 這個 repository。
2. 雙擊 `start.cmd`。
3. 在專用登入視窗完成你自己的 ChatGPT 登入與必要驗證。
4. 從控制頁複製 API 位址與本機金鑰，填入你的 OpenAI 相容工具。

預設網址：

- 控制頁：`http://127.0.0.1:17840/`
- API 根目錄：`http://127.0.0.1:17841/v1`

服務只綁定本機。`node src/cli.js key` 可以在命令列取得本機 API 金鑰；這個
金鑰不是 ChatGPT 憑證，也不會被轉送給 ChatGPT。

## 一般使用者怎麼接入

啟動服務並完成登入後，從控制頁複製 API 位址和本機金鑰。對支援 OpenAI 相容
API 的工具，填入：

```text
Base URL: http://127.0.0.1:17841/v1
API Key:  控制頁顯示的本機 API 金鑰
Model:    auto
```

API 金鑰只用來保護你電腦上的 loopback 服務，不是 ChatGPT 的登入憑證。最小
的 HTTP 請求如下：

```powershell
$key = (node src/cli.js key).Trim()
$body = @{ model = "auto"; input = "你好"; store = $false } | ConvertTo-Json
Invoke-RestMethod `
  -Uri "http://127.0.0.1:17841/v1/responses" `
  -Method Post `
  -Headers @{ Authorization = "Bearer $key" } `
  -ContentType "application/json" `
  -Body $body
```

也可以直接使用官方 OpenAI SDK，只替換 Base URL 和 API Key：

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:17841/v1",
  apiKey: process.env.WEBGPT_API_KEY,
});

const response = await client.responses.create({
  model: "auto",
  input: "你好",
});

console.log(response.output_text);
```

Codex CLI、Claude Code、OpenCode 等工具則使用同一組 Base URL、API Key 和
模型設定；各工具自己的工具執行、權限與沙箱政策仍然照原本規則運作。

## 命令列啟動

需要 Node.js 24.14 或更新版本：

```powershell
npm ci --ignore-scripts
npm run build:vendor
node src/cli.js setup
node src/cli.js serve
```

若已有本機登入資料，也可以使用 `node src/cli.js init`。命令列登入則是
`node src/cli.js login`；一般使用者建議直接使用 `start.cmd` 的控制頁。

## API 範圍

| 路徑 | 用途 |
| --- | --- |
| `GET /healthz` | 本機程序狀態；不代表帳號或模型一定可用 |
| `GET /v1/models` | 讀取帳號目前可用的 Chat 模型清單 |
| `POST /v1/models/refresh` | 清除模型清單快取並重新取得 |
| `POST /v1/responses` | Responses API 風格的文字、多輪、工具、JSON／SSE 請求 |
| `POST /v1/chat/completions` | Chat Completions API 風格的文字、工具、JSON／SSE 請求 |
| `GET /v1/responses/{id}` | 讀取本機保存的已完成回覆 |
| `DELETE /v1/responses/{id}` | 刪除本機保存的回覆 |

除了 `/healthz`，其餘端點都需要：

```text
Authorization: Bearer <本機 API 金鑰>
```

最小請求例：

```json
{
  "model": "auto",
  "input": "你好",
  "stream": true,
  "store": true
}
```

完整規格請參考 [openapi.json](openapi.json)。實作邊界與模型驗收結果見
[模型適配驗證](docs/model-verification.md) 和 [客戶端相容性](docs/client-compatibility.md)。

## 帳號與本機資料

登入流程使用隔離的專用瀏覽器設定檔，不讀取被鎖定的日常瀏覽器 Cookie
資料庫，也不要求安裝擴充功能。你仍須親自完成帳密、驗證碼或其他網站要求
的步驟；程式不代做驗證。

Windows 預設資料夾是 `%LOCALAPPDATA%\\webgpt-api`；其他系統使用
`$XDG_STATE_HOME/webgpt-api`，也可以用 `WEBGPT_HOME` 覆寫。可能出現的檔案
包括 `api.key`、`session.json`、`conversations.sqlite` 和
`browser-profile`。它們包含本機金鑰、登入狀態或對話內容，請勿提交到 Git、
貼到 issue，或分享給他人。

## 重要限制

- ChatGPT 網頁協定不是穩定的公開 API；網站變更可能需要更新本專案。
- 這個服務只允許 loopback，不提供公網部署、帳號輪替或付費後端備援。
- `usage` 不假造 token 計量；未實作或不安全的欄位會拒絕，部分常見用戶端欄位則只為相容性收下而不套用。
- 附件目前只接受 base64 data URL；PNG、文字檔與單頁 PDF 已驗收，其他格式仍要依環境逐一確認。
- 實際可用模型、權限、登入與跨平台行為取決於你的帳號、瀏覽器與網站狀態。

## 開發與驗證

```powershell
npm ci --ignore-scripts
npm run build:vendor
npm test
npm run check
```

單元測試不使用帳號或個人憑證。`npm run test:live` 及其衍生腳本會使用你
已登入的帳號並消耗實際使用額度，只應在本機手動執行；不要放進公開 CI。

更多內容：

- [架構說明](docs/architecture.md)
- [發布前驗收](docs/release-readiness.md)
- [開發與貢獻](CONTRIBUTING.md)

## 授權

本專案採 MIT License。第三方依賴與授權見
[`vendor/THIRD_PARTY_NOTICES.txt`](vendor/THIRD_PARTY_NOTICES.txt)。
