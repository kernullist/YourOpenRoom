# YourOpenRoom

中文 | [English](./README.md) | [한국어](./README_ko.md)

> 一个从 OpenRoom 演化出来的分叉项目：现在的重点是本地优先的浏览器桌面、AI 可操作应用，以及真实工作区自动化。

![License](https://img.shields.io/badge/license-MIT-blue.svg)

**[仓库](https://github.com/kernullist/YourOpenRoom)** ·
**[Issues](https://github.com/kernullist/YourOpenRoom/issues)** ·
**[原始上游](https://github.com/MiniMax-AI/OpenRoom)**

## 这个仓库现在是什么

YourOpenRoom 最初来自 MiniMax OpenRoom，但当前代码已经明显偏离了最初的演示定位。

现在它主要由三层组成：

- **浏览器桌面壳层**：可拖拽/最大化窗口、可由用户重新排序的桌面图标、浮动聊天面板、本地状态。
- **Agent 运行时**：AI 可以通过 `meta.yaml` action、应用状态接口和文件工具直接操作内置应用。
- **本地项目自动化**：围绕 **Kira** 与 **Aoi's IDE**
  的真实工作区搜索、编辑、诊断、语义重构、检查点和自动化实现/审查循环。

当前真正可运行的主应用在 `apps/webuiapps`。

## 当前代码里已经落地的能力

- 独立浏览器桌面：窗口系统、聊天面板、重启后仍保留的拖拽图标顺序、避开聊天面板的最大化/还原、壁纸切换、Kira 自动化提醒。
- 聊天面板内置：
  - OpenAI-compatible / Anthropic-compatible LLM 配置
  - 可选轻量 dialog model
  - 记住用户偏好的称呼/名字
  - 回复语言模式（`match-user` / `english`）
  - 可选的 Aoi 消息 TTS 播放，以及常用短句预生成
  - 长期记忆保存
  - 图像生成
  - Tavily 实时网页搜索
  - prompt budget 与 tool inspector
- 会话级应用数据保存在 `~/.openroom/sessions/...`。
- 开源独立模式使用本地 `@gui/vibe-container` mock，而不是原始 iframe 容器。
- 通过 Vite middleware 提供本地后端接口：Gmail
  OAuth、网页阅读提取、YouTube 搜索、RSS 网络安全新闻、相册目录读取、Tavily 代理、OpenVSCode 工作区工具、PE
  Analyst 的 IDA / PE 分析桥接、TTS lab 合成接口、Kira 自动化、配置保存、会话文件存储。
- 上游的人设/mod 体系仍然保留：角色、mod、情绪媒体、上传生成 mod、记忆注入都还在当前桌面里。

## 内置应用

| 应用             | 当前实际功能                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Twitter`        | 本地社交流，支持发帖、点赞、评论，数据保存在应用存储里                                                                                               |
| `YouTube`        | YouTube 搜索、最近搜索、收藏主题、播放列表、队列播放和弹层播放器                                                                                     |
| `Diary`          | Markdown 日记，支持心情/天气元数据、日历切换和手写风格渲染                                                                                           |
| `Album`          | 支持文件夹选择、保存本地路径、搜索、排序、网格密度和预览信息的本地相册                                                                               |
| `FreeCell`       | 持久化 FreeCell 游戏                                                                                                                                 |
| `Email`          | 真实 Gmail OAuth 同步、收件箱/已发送/草稿/垃圾箱、回复、保存草稿、归档、加星、恢复、删除                                                             |
| `Chess`          | 完整规则国际象棋、3D 棋盘、本地存档与 Agent 回合同步                                                                                                 |
| `Evidence Vault` | 用于浏览结构化“证据档案”文件的本地资料库应用                                                                                                         |
| `CyberNews`      | 基于 RSS 的实时网络安全新闻流，外加 case-board 调查视图                                                                                              |
| `Calendar`       | 支持月视图导航、选中日期议程、日期选择同步到 `Date & Time`、提醒元数据的本地日程规划器                                                               |
| `Notes`          | 支持置顶集合、标签/搜索过滤、排序、格式工具、安全删除确认、持久化视图状态和预览的本地 Markdown 笔记                                                  |
| `Browser Reader` | 内嵌浏览、reader 提取、书签/历史、Google 搜索结果回退 UI、保存到 Notes                                                                               |
| `Kira`           | 项目工作看板，管理 work item、评论、discovery 分析、worker 分配前 clarification 问题和自动化交接                                                     |
| `Aoi's IDE`      | 支持新建文件的本地工作区文件树/编辑器，以及搜索、符号、引用、rename preview/apply、安全命令等接口                                                    |
| `PE Analyst`     | 面向 PE 的分析工作台，支持 `ida_pro_mcp` 的当前 IDB 模式、上传样本的 pre-scan / headless 流程，以及 findings/imports/sections/strings/functions 视图 |

## PE Analyst 与 IDA MCP

`PE Analyst` 目前支持两种工作方式：

- **Current IDB 模式**
  - 最适合 `ida_pro_mcp`
  - 直接把当前在 IDA Pro 中打开的 IDB 作为数据源
  - 不需要上传文件，也可以查看函数列表、伪代码、反汇编和 xref
- **样本上传模式**
  - 适用于内置 PE pre-scan 和 headless 后端流程
  - 上传的 PE 样本会进入本地缓存，分析元数据会保存在会话应用存储中

当前后端会自动识别两类 MCP 风格：

- `ida_pro_mcp`
  - 通常由 IDA 插件暴露为 `http://127.0.0.1:13337/mcp`
- `ida-headless-mcp`
  - 通常作为独立 HTTP MCP 服务运行，例如 `http://127.0.0.1:17300/`

## Aoi TTS 与 Voice Lab

当前桌面已经带有 **Aoi 的可选 TTS 层**。

- 在聊天设置中启用后，新出现的 assistant 消息会被语音播报
- 当前默认声音是 **Google `Despina`**
- TTS helper 会预生成：
  - 常用短句库存
  - 当前会话里最近真实出现过的 assistant 回复
- 浏览器里的语音比较页：
  - `http://localhost:3000/tts-lab.html`
- 本地批量样本生成脚本：
  - `node apps/webuiapps/script/generate-aoi-voice-samples.mjs`

## 聊天面板里的 Agent 工具

当前聊天面板已经不是只会调用 `app_action`：

- **应用运行时工具**
  - `list_apps`、`app_action`、`get_app_state`、`get_app_schema`
  - `file_read`、`file_write`、`file_patch`、`file_list`、`file_delete`
- **网页/内容工具**
  - `search_web`
  - `read_url`
  - `generate_image`
- **工作区与 IDE 工具**
  - `workspace_search`
  - `ide_search`
  - `find_references`
  - `list_exports`
  - `peek_definition`
  - `rename_preview`
  - `apply_semantic_rename`
  - `run_command`
  - `structured_diagnostics`
- **安全与恢复工具**
  - `preview_changes`
  - `undo_last_action`
  - `workspace_checkpoint`
  - `autofix_diagnostics`
  - `background_watch`

安全约束也已经写进当前实现：

- 应用 JSON 写入会尽量做 schema 校验
- 语义 rename 必须先 preview，再带签名 apply
- 工作区命令只允许只读 `git`、`node`、`npm`、`pnpm` 安全模式
- Kira 会自己重跑验证命令，不直接相信 agent 的自报结果

## Kira 与 Aoi's IDE

这个分叉项目最重要的变化之一，就是把重点放在真实本地项目，而不只是内置应用交互。

### Kira

Kira 会在应用存储中保存 work item 和 comment，并且支持对配置好的本地项目做 discovery。
`apps/webuiapps/vite.config.ts` 中的自动化插件还可以：

1. 扫描待处理任务
2. 分析 brief 是否已经足够明确，可以交给 worker
3. 在需求含糊时生成 clarification 问题并阻断交接
4. 规划目标文件和验证命令
5. 跑 worker / reviewer 循环
6. 重新执行验证
7. 根据项目设置阻断、重试或自动提交

Clarification 会在 worker 接手之前运行。如果标题/说明里存在会改变产品决策或实现方向的关键含糊点，Kira 会尽量用客观选项向用户提问。用户回答会保存回 work
item，并追加到 Markdown brief 后，再把任务恢复为 `todo` 继续自动化。

### Aoi's IDE

Aoi's IDE 前端是一个内置文件树和编辑器，但真正强的是 `/api/openvscode/*` 这组接口：

- 工作区目录浏览与文件读写删除
- 基于相对工作区路径创建空文件，并阻止重复创建
- 文本搜索
- 符号搜索
- 引用查询
- export 列表
- definition peek
- semantic rename preview / apply
- 安全命令执行

只要本地项目是 TypeScript/JavaScript，很多语义功能会直接走本地 TypeScript language service。

## 提示词生成应用工作流

原仓库里的提示词生成应用流程还在：

- 入口在 `.claude/commands/vibe.md`
- 阶段定义在 `.claude/workflow/`
- `apps/webuiapps/vite.config.ts` 中的 `appGeneratorPlugin` 负责把生成结果接回运行时

只是它已经不是这个分叉项目唯一的重点。现在更核心的是“AI 桌面 + 本地工作区自动化”。

## 快速开始

### 依赖

| 工具    | 版本 |
| ------- | ---- |
| Node.js | 18+  |
| pnpm    | 9+   |

### 本地运行

```bash
git clone https://github.com/kernullist/YourOpenRoom.git
cd YourOpenRoom
pnpm install
cp apps/webuiapps/.env.example apps/webuiapps/.env
pnpm dev
```

打开 `http://localhost:3000`。

### 重要说明

`pnpm dev` 才是完整本地运行栈。

当前很多能力都依赖 Vite middleware，本地开发服务会同时提供：

- Gmail OAuth / Sync
- Browser Reader 代理
- CyberNews 实时 RSS 聚合
- YouTube 搜索解析
- 相册目录读取
- Tavily 代理
- Kira 自动化接口
- OpenVSCode 工作区接口
- TTS lab 合成接口
- 配置与会话持久化

所以 `pnpm build` 虽然可以产出前端包，但如果你要部署成完整产品，还需要自己补齐这些后端接口。

## 配置

运行时配置读取自 `~/.openroom/config.json`。

同步示例也放在 [`docs/config.example.json`](./docs/config.example.json)。

```json
{
  "llm": {
    "provider": "openrouter",
    "apiKey": "YOUR_API_KEY",
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "anthropic/claude-sonnet-4.6"
  },
  "dialogLlm": {
    "provider": "openrouter",
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "openai/gpt-5-mini"
  },
  "userProfile": {
    "displayName": "Minji"
  },
  "conversationPreferences": {
    "responseLanguageMode": "match-user",
    "ttsEnabled": true,
    "ttsPreloadCommonPhrases": true
  },
  "imageGen": {
    "provider": "openai",
    "apiKey": "YOUR_IMAGE_API_KEY",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-image-1"
  },
  "album": {
    "photoDirectory": "C:\\Users\\your-name\\Pictures"
  },
  "kira": {
    "workRootDirectory": "C:\\Users\\your-name\\workspace",
    "projectDefaults": {
      "autoCommit": true
    },
    "workerLlm": {
      "model": "openai/gpt-5.4-mini"
    },
    "reviewerLlm": {
      "model": "openai/gpt-5.4"
    }
  },
  "openvscode": {
    "workspacePath": "C:\\Users\\your-name\\workspace\\your-project"
  },
  "tavily": {
    "apiKey": "tvly-YOUR_API_KEY"
  },
  "gmail": {
    "clientId": "YOUR_GOOGLE_OAUTH_DESKTOP_CLIENT_ID",
    "clientSecret": "OPTIONAL_GOOGLE_CLIENT_SECRET"
  },
  "idaPe": {
    "mode": "prescan-only",
    "backendUrl": "http://127.0.0.1:17300/"
  },
  "app": {
    "title": "YourOpenRoom"
  }
}
```

说明：

- `openvscode.workspacePath` 指向 Aoi's IDE 与 IDE 工具实际操作的本地项目目录
- 如果不配置 `openvscode.workspacePath`，当前代码默认回退到仓库根目录
- `gmail.clientId` 必须是 Google OAuth **Desktop App** client ID
- `dialogLlm` 启用时至少需要 `baseUrl` 和 `model`
- `userProfile.displayName` 可以让聊天面板跨重启记住应该怎么称呼用户
- `conversationPreferences.responseLanguageMode` 支持 `match-user` 和 `english`
- `conversationPreferences.ttsEnabled` 用来开启或关闭 Aoi 回复语音播放
- `conversationPreferences.ttsPreloadCommonPhrases`
  会预生成常用短句和最近 assistant 回复，以减少播放延迟
- 当 `conversationPreferences.responseLanguageMode` 为 `english`
  时，普通回复、提醒消息和新播种的开场 prologue/建议回复都会使用英文
- `imageGen` 是聊天面板图像生成工具的可选配置
- `idaPe.mode` 支持 `prescan-only` 和 `mcp-http`
- `idaPe.backendUrl` 可以配置为 `ida_pro_mcp` 的 `http://127.0.0.1:13337/mcp`，或 `ida-headless-mcp`
  的 `http://127.0.0.1:17300/`

### 可选 `.env`

`apps/webuiapps/.env.example` 里除了 CDN / Sentry 等可选项，也包含本地 TTS 实验会用到的：

- `GEMINI_API_KEY`
- `ELEVENLABS_API_KEY`

## 本地数据目录

独立模式会把数据写到 `~/.openroom/`：

```text
~/.openroom/
├── config.json
├── characters.json
├── mods.json
└── sessions/
    └── <session-path>/
        ├── apps/
        │   ├── notes/data/
        │   ├── email/data/
        │   ├── kira/data/
        │   ├── peanalyzer/data/
        │   └── ...
        ├── chat/
        └── memory/
```

## 仓库结构

```text
YourOpenRoom/
├── apps/
│   └── webuiapps/          # 主浏览器桌面运行时
├── packages/
│   └── vibe-container/     # 共享类型 + 独立模式 stub
├── .claude/                # 提示词生成应用工作流
├── docs/                   # 配置示例和补充文档
└── e2e/                    # Playwright 场景
```

`apps/webuiapps/src/` 里最重要的部分：

- `components/`：桌面壳层、聊天面板、窗口组件
- `pages/`：内置应用
- `lib/`：运行时 glue code、LLM 客户端、工具、应用注册、IDE/Kira/Gmail 等逻辑
- `routers/`：Standalone 模式路由定义

## 开发命令

| 命令                                              | 用途                          |
| ------------------------------------------------- | ----------------------------- |
| `pnpm dev`                                        | 启动桌面和本地 middleware API |
| `pnpm build`                                      | 构建前端包                    |
| `pnpm clean`                                      | 清理 Turborepo 产物           |
| `pnpm run lint`                                   | Lint + 自动修复               |
| `pnpm run pretty`                                 | 代码格式化                    |
| `pnpm --filter @openroom/webuiapps test`          | 运行桌面应用的 Vitest 单测    |
| `pnpm --filter @openroom/webuiapps test:coverage` | 运行覆盖率测试                |
| `pnpm test:e2e`                                   | 运行 Playwright E2E           |

## 技术栈

| 领域       | 当前实现                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------- |
| UI         | React 18、TypeScript、React Router、Vite                                                 |
| 样式       | SCSS + CSS Modules                                                                       |
| 动效       | Framer Motion                                                                            |
| 应用运行时 | 本地 `@gui/vibe-container` mock、session-data middleware、基于 `meta.yaml` 的 app action |
| 本地工具链 | 文件系统 API、TypeScript language service、安全命令执行、结构化诊断                      |
| 外部集成   | Gmail OAuth、Tavily、图像生成、RSS 聚合、YouTube 搜索解析                                |
| Monorepo   | pnpm workspaces、Turborepo                                                               |
| 测试       | Vitest、Playwright                                                                       |

## 贡献

欢迎提交 issue、文档修正、工具改进、应用修改和工作流升级。先看
[CONTRIBUTING.md](./CONTRIBUTING.md)。

## License

[MIT](./LICENSE)
