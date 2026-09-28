# webgpt-api

把 ChatGPT 网页版的 Chat 模式，包装成一个只在本地监听的 OpenAI 兼容 API。

`webgpt-api` 是一个本地转接层：它接收既有 OpenAI 接口的请求，使用你本人登录的 ChatGPT 账号完成生成，再把结果转回 `Responses` 或 `Chat Completions` 格式。这让 Codex CLI、Claude Code、OpenCode 等工具可以沿用原本的客户端设置，同时使用 Chat 网页端实际提供给该账号的模型与权限。

请求路径很直接：

```text
OpenAI 兼容客户端
        │  127.0.0.1 + 本地 API 密钥
        ▼
webgpt-api gateway
        │  隔离的专用浏览器工作阶段
        ▼
ChatGPT 网页版 Chat
```

它不是官方 OpenAI API、远程代理或代管服务。服务只绑定 loopback；登录状态、本地密钥、对话数据与专用浏览器配置文件留在你的电脑上。ChatGPT 网页协议不是稳定的公开 API，因此可用模型、登录状态与部分功能会随账号、浏览器和网站变更而变化。

## 设计取向

- **保持 Chat 的原生选择。** 模型列表来自账号自己的 Chat 菜单；`auto` 会原样交给上游，不自行假定某个固定模型。
- **本地边界清楚。** 生成 API 只接受本地连接与本地密钥，不开放公网、不建立隧道，也不接管日常浏览器。
- **失败不被掩盖。** 网站回复未完成、模型被替换、登录或协议验证失败时，网关会回报错误，不把半截内容当成成功，也不静默改用另一个模型。
- **兼容性有明确范围。** 目前涵盖文本、多轮上下文、JSON／SSE、函数工具协议，以及部分附件输入；详细边界与未验证项目列在文档中。

## 核心定位与推荐工作流 (Planner-Worker)

`webgpt-api` 最强大的使用情境，是作为 AI 开发流程中的**“执行节点 (Worker)”**，用以大幅减轻官方付费 API 的账单负担。

建议在使用本项目时，采用以下“脑手分离 (Planner-Worker)”的架构：

1. 🧠 **大脑（使用官方付费 API）：负责“看大局与计划”**
   - 当你需要让 AI 读取整个项目（例如几十个文件）、分析复杂架构或规划重构步骤时，请使用官方 API。
   - 官方 API 拥有超大的上下文窗口且纯数据传输极度稳定，不会因为载入大量字符而卡顿。

2. 💪 **执行者（使用 `webgpt-api`）：负责“具体修改与调试”**
   - 当大脑产出“修改清单”后，将模型切换为 `webgpt-api`（消耗网页版免费或 Plus 额度）。
   - 让 `webgpt-api` 负责具体的单一文件修改、编写测试、或重复的 Debug 循环。
   - 编写代码与反复调试是**最消耗 Token 的环节**。只要任务限缩在少量文件，就不会触发网页版前端的性能极限；你可以无压力地调用当前最新的高阶模型，将最昂贵的调试成本转移至网页版额度上。

⚠️ **注意：请避免让 `webgpt-api` 一次读取整个大项目。** 由于底层是自动化浏览器，一口气塞入数 MB 的源代码会导致网页前端卡死并引发“超时断线”。**精准指定、一次修改一个组件**，才是发挥本项目最大价值的正确用法。

## 快速开始（Windows）

1. 下载或 clone 这个仓库。
2. 双击 `start.cmd`。
3. 在专用登录窗口完成你自己的 ChatGPT 登录与必要验证。
4. 在任何支持自定义 OpenAI Base URL 的工具里，填入下方三个字段即可。
5. 命令行工具也可以直接双击 `webgpt.cmd 工具名`，省掉复制粘贴。

默认网址：

- 控制页：`http://127.0.0.1:17840/`
- API 根目录：`http://127.0.0.1:17841/v1`

服务只绑定本地。`node src/cli.js key` 可以在命令行取得本地 API 密钥；这个密钥不是 ChatGPT 凭证，也不会被转发给 ChatGPT。

## 标准 OpenAI 兼容接入

这个项目对用户就是一个本地 OpenAI API。启动并登录后，在工具的 `OpenAI API`、`Custom Provider` 或 `OpenAI-compatible` 设置中填入：

```text
Base URL: http://127.0.0.1:17841/v1
API Key:  控制页的“本地 API Key”
Model:    auto
```

不需要填 ChatGPT 账号密码，也不需要申请或购买 OpenAI API key。这个 Base URL 同时支持 Responses API 与 Chat Completions API；工具选哪一种协议，照工具原本的默认即可。模型填 `auto` 会使用账号目前可用的 Chat 模型。

只要工具允许自定义 Base URL，它就能直接接入；若工具把 API 网址硬编码成官方服务、完全不支持自定义 provider，就不能只靠 API 端改变它的限制。

## 一般用户如何接入

最省事的方式是不碰 Key，也不改任何第三方配置文件：

```bat
webgpt.cmd codex
webgpt.cmd opencode
webgpt.cmd 你的工具名
```

这个启动器只把设置传给该次启动的工具，不写入全局环境变量。它会提供 `OPENAI_BASE_URL`、`OPENAI_API_BASE`、`OPENAI_API_KEY`、`OPENAI_MODEL` 及 `WEBGPT_API_*` 变量；工具本身仍须支持 OpenAI 兼容 API。Codex 会自动建立并使用 `webgpt-api` profile，不需要用户手动编辑 `config.toml`。

若只双击 `webgpt.cmd` 而不带工具名，会开一个已准备好的终端；在里面启动的兼容工具会继承同一组设置。

启动服务并完成登录后，从控制页复制 API 地址和本地密钥。对支持 OpenAI 兼容 API 的工具，填入：

```text
Base URL: http://127.0.0.1:17841/v1
API Key:  控制页显示的本地 API 密钥
Model:    auto
```

API 密钥只用来保护你电脑上的 loopback 服务，不是 ChatGPT 的登录凭证。最小的 HTTP 请求如下：

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

也可以直接使用官方 OpenAI SDK，只替换 Base URL 和 API Key：

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

Codex CLI、Claude Code、OpenCode 等工具则使用同一组 Base URL、API Key 和模型设置；各工具自己的工具执行、权限与沙盒政策仍然照原本规则运行。

## 命令行启动

需要 Node.js 24.14 或更新版本：

```powershell
npm ci --ignore-scripts
npm run build:vendor
node src/cli.js setup
node src/cli.js serve
```

若已有本地登录数据，也可以使用 `node src/cli.js init`。命令行登录则是 `node src/cli.js login`；一般用户建议直接使用 `start.cmd` 的控制页。

## API 范围

| 路径 | 用途 |
| --- | --- |
| `GET /healthz` | 本地程序状态；不代表账号或模型一定可用 |
| `GET /v1/models` | 读取账号目前可用的 Chat 模型列表 |
| `POST /v1/models/refresh` | 清除模型列表缓存并重新获取 |
| `POST /v1/responses` | Responses API 风格的文本、多轮、工具、JSON／SSE 请求 |
| `POST /v1/chat/completions` | Chat Completions API 风格的文本、工具、JSON／SSE 请求 |
| `GET /v1/responses/{id}` | 读取本地保存的已完成回复 |
| `DELETE /v1/responses/{id}` | 删除本地保存的回复 |

除了 `/healthz`，其余端点都需要：

```text
Authorization: Bearer <本地 API 密钥>
```

最小请求例：

```json
{
  "model": "auto",
  "input": "你好",
  "stream": true,
  "store": true
}
```

完整规范请参考 [openapi.json](openapi.json)。实现边界与模型验收结果见 [模型适配验证](docs/model-verification.md) 和 [客户端兼容性](docs/client-compatibility.md)。

## 账号与本地数据

登录流程使用隔离的专用浏览器配置文件，不读取被锁定的日常浏览器 Cookie 数据库，也不要求安装扩展功能。你仍须亲自完成账号密码、验证码或其他网站要求的步骤；程序不代做验证。

Windows 默认文件夹是 `%LOCALAPPDATA%\\webgpt-api`；其他系统使用 `$XDG_STATE_HOME/webgpt-api`，也可以用 `WEBGPT_HOME` 覆盖。可能出现的文件包括 `api.key`、`session.json`、`conversations.sqlite` 和 `browser-profile`。它们包含本地密钥、登录状态或对话内容，请勿提交到 Git、贴到 issue，或分享给他人。

## 重要限制

- ChatGPT 网页协议不是稳定的公开 API；网站变更可能需要更新本项目。
- 这个服务只允许 loopback，不提供公网部署、账号轮替或付费后端备援。
- `usage` 不伪造 token 计量；未实现或不安全的字段会拒绝，部分常见客户端字段则只为兼容性收下而不应用。
- 附件目前只接受 base64 data URL；PNG、文本文件与单页 PDF 已验收，其他格式仍要依环境逐一确认。
- 实际可用模型、权限、登录与跨平台行为取决于你的账号、浏览器与网站状态。

## 开发与验证

```powershell
npm ci --ignore-scripts
npm run build:vendor
npm test
npm run check
```

单元测试不使用账号或个人凭证。`npm run test:live` 及其衍生脚本会使用你已登录的账号并消耗实际使用额度，只应在本地手动执行；不要放进公开 CI。

更多内容：

- [架构说明](docs/architecture.md)
- [发布前验收](docs/release-readiness.md)
- [开发与贡献](CONTRIBUTING.md)

## 授权

本项目采用 MIT License。第三方依赖与授权见 [`vendor/THIRD_PARTY_NOTICES.txt`](vendor/THIRD_PARTY_NOTICES.txt)。
