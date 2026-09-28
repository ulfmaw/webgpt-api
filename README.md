# webgpt-api

把你自己的 ChatGPT Chat 轉成本機的 OpenAI 相容 API。

`webgpt-api` 會使用你本人登入的 ChatGPT 帳號，在自己的電腦上開一個只接受
loopback 連線的服務。Codex CLI、Claude Code、OpenCode，以及其他支援
OpenAI 相容端點的工具，可以繼續使用既有工作流程；請求最後仍由你的 Chat
帳號處理，不需要另買一份 API 額度。

這不是官方 OpenAI API 的替代品，也不是遠端代理服務。它是由 `ulfmaw`
維護的本機轉接層，會直接面對 ChatGPT 網頁協定的變動。

## 特色

- 本機 `127.0.0.1` API，不開放公網、不建立隧道，也不接管日常瀏覽器。
- 提供 `/v1/responses` 與 `/v1/chat/completions`，可供常見 OpenAI 相容工具使用。
- 透過控制頁查看帳號回報的 Chat 模型與選擇狀態，`auto` 會保留 Chat 網頁自己的 Auto 選擇。
- 支援文字、多輪上下文、JSON／SSE、函式工具協定，以及 base64 圖片、文字檔與單頁 PDF 輸入。
- 憑證、API 金鑰、對話資料與專用瀏覽器設定檔都留在本機私人資料夾。
- Windows 提供 `start.cmd`；缺少指定 Node.js 版本時，啟動器可下載並校驗免安裝執行檔。

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
