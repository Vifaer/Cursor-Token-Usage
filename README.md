<div align="center">

<img src="icon.png" width="96" alt="Cursor Token Usage">

# Cursor Token Usage

**在状态栏显示 Cursor 现行 token 计费用量的 Cursor IDE 扩展**

[![Release](https://img.shields.io/github/v/release/Vifaer/Cursor-Token-Usage)](https://github.com/Vifaer/Cursor-Token-Usage/releases)
[![Open VSX](https://img.shields.io/open-vsx/v/vifaer/cursor-token-usage)](https://open-vsx.org/extension/vifaer/cursor-token-usage)
[![License](https://img.shields.io/github/license/Vifaer/Cursor-Token-Usage)](LICENSE)

[中文](#cursor-token-usage) · [English](#english) · [快速开始](#快速开始) · [核心特性](#核心特性) · [认证](#认证) · [界面](#操作界面) · [常见问题](#常见问题)

</div>

---

Cursor 已改为按 token、双池计费（不再是旧的「fast-premium 请求次数 + 美元」）。本扩展读取 dashboard 接口，按账号类型切换展示：个人看双池百分比，团队 / 企业看套餐内花费。

## 核心特性

| **状态栏常驻** 个人：`C xx% · O xx%`。团队 / 企业：套餐内已用 vs 上限（接口美分，非本地估算） | **详情面板** 点击状态栏：环形用量、彩色进度条、按模型 Token、最近事件、趋势图 |
| --- | --- |
| **账号自适应** 类型来自接口（`individual` / `team` / `enterprise`），不从 token 猜测 | **用量提醒** 两次轮询之间的变化超过阈值时弹窗，监控项与阈值可配 |

**更多亮点：**

- 自动刷新，默认 30 秒；窗口失焦时降低频率
- 状态栏轮询只拉一页事件；打开或刷新详情面板时才翻页拉全量账单周期
- 中 / 英界面，跟随编辑器语言
- macOS / Windows / Linux 通用 VSIX，自动读本机 Cursor 会话（`state.vscdb`）
- UI 扩展（`extensionKind: ui`）：SSH Remote、WSL、Dev Containers 下仍读**本机**登录
- 只在接口返回美分时显示 `$`，不用官网单价估算账单
- 趋势图默认近 7 天；From / To 可在账单周期内跨月
- **v1.3：** 详情面板默认 **多账号总览**，展示 Prompt Cache 命中率；状态栏默认当前账号用量（`cursorTokenUsage.statusBarDataSource`，可选 overview）
- **v1.3.1：** 账号表固定高度可滚动（约 10 行）；默认不限制保存账号数；Token 数字自动切换单位（万/亿、K/M/B）
- **v1.3.2：** 状态栏 tooltip 按更新时间排序 + 中文界面；按模型可折叠（标准/快速/高阶）；趋势筛选修复 intent/slug 映射
- **v1.3.3：** 状态栏去掉多余「用量」前缀；费用格优先套餐用量；缓存写入字段级 hybrid；零值 Cache Write / On-Demand $0 隐藏
- **v1.3.4：** 状态栏默认当前账号；合并 Auto/Default 重复「标准」；趋势接入 dailyBuckets 且默认近 7 日；meter/hero 去重与文案修正
- **v1.3.5：** 状态栏一键切换 **当前账号** / **总览**；悬停 tooltip 可点切换；详情面板工具栏 + ⋯ 菜单；命令面板：切换状态栏当前/总览
- **v1.3.9：** 身份以 JWT `sub` + `cachedEmail` 为准（修复 Sentry 误标）；曾登录账号的 session 可并行刷新总览

## 快速开始

### 从 Open VSX 安装

从 [Open VSX](https://open-vsx.org/extension/vifaer/cursor-token-usage)（Cursor 扩展市场）安装。搜 `Cursor Token Usage`，或：

```bash
cursor --install-extension vifaer.cursor-token-usage
```

### 从 VSIX 安装

1. 从 [Releases](https://github.com/Vifaer/Cursor-Token-Usage/releases) 下载 `cursor-token-usage-1.3.9.vsix`
2. 拖进 Cursor，或 `Cmd+Shift+P`（Windows：`Ctrl+Shift+P`）→ `Extensions: Install from VSIX...`
3. 执行 `Developer: Reload Window`

装好后状态栏应出现用量。读不到会话时显示 **Set Token**，见下方认证。

## 认证

扩展从本机 `state.vscdb` 读取 `cursorAuth/accessToken` 与用户 id，拼成 `WorkosCursorSessionToken` Cookie，**只发给 `cursor.com`**。

| 系统 | 会话文件 |
| --- | --- |
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |

自动读取需要 PATH 上有 **Python 3**（`python3` / `python`，Windows 可用 `py`）。没有 Python 时用 **Set Session Token**，其余功能仍可用。

自动检测失败时：

1. 命令面板 → **Cursor Token Usage: Set Session Token**
2. 粘贴 `WorkosCursorSessionToken`（格式：`userId%3A%3AaccessToken`）
3. Token 写入 VS Code SecretStorage，不进 `settings.json`

浏览器取 Cookie：打开 [cursor.com](https://cursor.com) → 开发者工具 → Application → Cookies → 复制 `WorkosCursorSessionToken`。

**远程工作区：** 本扩展在本机 Cursor 进程跑，不要装到 SSH / WSL / 容器远端。

## 操作界面

```
状态栏（个人）：     $(graph) C 42% · O 18%
状态栏（团队/企业）： $(graph) $67.88/$52.00

详情面板
┌─────────────────────────────────────────────┐
│ Cursor Token Usage              enterprise  │
│ 重置倒计时：12天4小时        Token 合计 1.2M │
│                                             │
│   (  131%  )   套餐内用量                    │
│                $67.88 / $52.00              │
│ ████████████████████████████░░░░  已超 100% │
│ Cursor Models   ████████░░░░░░░░     42%    │
│ Other Models    ███░░░░░░░░░░░░░     18%    │
│ On-Demand       $5.74                       │
│                                             │
│ 按模型                                      │
│ claude-4.6-opus  ████████████████    80.1万  │
│ gpt-5            ██████░░░░░░░░░░    12.4万  │
│                                             │
│ 最近消耗                                    │
│ 08-13 21:04  Claude 4.6 Opus  Included  2.1万│
└─────────────────────────────────────────────┘
```

进度条：绿 < 40%、黄 < 80%、橙 ≥ 80%、红 ≥ 100%。用量 ≥ 80% 状态栏警告底色，≥ 100% 错误底色。

面板按钮：刷新、设置 Session Token、状态栏位置、配置提醒。

趋势图：Token（输入 / 输出 / 缓存堆叠 + 折线）或费用（柱 + 折线）。日期框范围是账单周期，默认近 7 天。费用 Tab 仅在接口返回美分时作图。后台轮询只更新状态栏；面板开着时若数据已过时，会提示点刷新。

## 配置

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `cursorTokenUsage.displayCount` | 5 | 详情面板最近用量条数（不影响趋势图拉取范围） |
| `cursorTokenUsage.pollingInterval` | 30 | 轮询间隔（秒，5–300） |
| `cursorTokenUsage.showStatusBar` | true | 是否显示状态栏 |
| `cursorTokenUsage.statusBarAlignment` | `right` | 状态栏位置：`left` / `right` |
| `cursorTokenUsage.alertEnabled` | true | 启用用量变化提醒 |
| `cursorTokenUsage.alertItems` | `newSession` `overallSpending` `cursorModels` `otherModels` `totalTokens` | 监控项 |
| `cursorTokenUsage.alertThreshold.newSession` | 2 | 单次轮询新增调用数 |
| `cursorTokenUsage.alertThreshold.overallSpending` | 1 | 套餐内花费变化（$） |
| `cursorTokenUsage.alertThreshold.cursorModels` | 10 | Cursor Models 池变化（%） |
| `cursorTokenUsage.alertThreshold.otherModels` | 10 | Other Models 池变化（%） |
| `cursorTokenUsage.alertThreshold.onDemandSpending` | 1 | On-Demand 花费变化（$） |
| `cursorTokenUsage.alertThreshold.totalTokens` | 100000 | Token 总量变化 |
| `cursorTokenUsage.maxStoredAccounts` | 0 | 最多保存账号数（0=不限制） |

## 命令

| 命令 | 作用 |
| --- | --- |
| Show Token Usage Details | 打开详情面板（等同点击状态栏） |
| Refresh Token Usage | 立即刷新 |
| Set Session Token | 粘贴 / 清除 Session Token |
| Set Polling Interval | 5–300 秒 |
| Set Status Bar Side | 左 / 右 |
| Configure Usage Alerts | 开关、监控项、阈值 |

## 用量提醒

1. 命令面板 → **Configure Usage Alerts**，或详情面板里的提醒按钮
2. 开启提醒 → 选监控项 → 设阈值
3. 可监控：新增调用、套餐内花费、Cursor Models %、Other Models %、On-Demand 花费、Token 总量
4. 阈值 `0` 表示任何变化都提醒

> 阈值看的是**两次轮询之间的变化量**，不是累计或绝对上限。例如 `onDemandSpending = 1.0`：两次成功轮询之间 On-Demand 增加 $1.00 或以上才触发。

## 常见问题

**为什么不估算美元？**

自助套餐的用量事件里，美元经常是 `$0`（`chargedCents: 0`），即使已经消耗 token。用 token × 官网单价对不上账单：套餐额度、团队 / 企业折扣、Cursor Token Rate 都在服务端结算。只有接口自己返回美分时才显示 `$`。Token 始终按 token 显示。这时 **费用** Tab 会空，请看 **Token**。

**状态栏一直是 Set Token？**

先确认本机已登录 Cursor，PATH 上有 Python 3。仍失败就用 **Set Session Token** 粘贴 `WorkosCursorSessionToken`。

**账号显示成旧邮箱 / hotmail 统计不到？**

扩展以 `state.vscdb` 的 `cachedEmail` + JWT `sub` 识别当前账号（不再优先 Sentry）。命令面板运行 **Diagnose Auth** 可对照 JWT / DB / Sentry。曾登录或粘贴过的其它账号，会按保留的 session 在总览里并行刷新（同一 JWT 不会造出假双账号）；过期后需再登录或重新 Set Token。

**远程 SSH / WSL 读不到用量？**

扩展必须装在**本机** Cursor，不要装到远端。它是 UI 扩展，只读本机 `state.vscdb`。

**提醒太频繁 / 从不响？**

阈值是相邻两次轮询的 delta。把 `pollingInterval` 和对应 `alertThreshold.*` 调大或调小；`0` 表示有变化就提醒。

**详情面板数字没跟着状态栏变？**

状态栏按轮询间隔刷新。面板会保住当前日期和图表，直到点 **刷新**（或重新打开），避免日期选择被重置。状态栏已更新时，面板顶部会提示去刷新。

## 从源码构建

```bash
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
```

安装生成的 `.vsix` 后执行 **Developer: Reload Window**。

## 更新说明（1.0.10）

- 双池比例低于 1% 时显示一位小数（`0.2%`），不再四舍五入成 `0%`
- Tracker 日志打印 `autoPercentUsed` / `apiPercentUsed` / `totalPercentUsed` 原始值

## 更新说明（1.0.9）

- 打开或刷新详情面板时翻页拉取用量事件（每页 100 条，最多 30 页）
- 状态栏轮询保持轻量（一页），并把新事件合并进已有全量列表，不会用短列表覆盖
- 打开 / 刷新面板会等正在进行的轮询结束，不再把全量拉取直接跳过
- 日期选择范围跟账单周期；趋势图默认近 7 天；From / To 可跨月
- 后台轮询不再整页重绘面板；状态栏已更新时会提示点刷新
- 费用图同样画趋势线；图例随 Token / 费用 Tab 切换并居中
- 接口没返回美分时费用 Tab 为空（不按官网单价估算）

## 更新说明（1.0.8）

- 重发 1.0.7：Open VSX 上 1.0.7 发过又删，版本号已占用不能再发
- 中英文首页标题区整块居中

## 更新说明（1.0.7）

- 商店短描述改为 Cursor token **计费**（不再用泛称「用量」）
- README：只写 Cursor IDE；安装走 Open VSX；去掉 VS Code Marketplace

## 更新说明（1.0.6）

- 读不到会话时状态栏显示 **Set Token**
- 英文 Token 单位用 K/M，中文满万仍用「万」
- 窗口失焦时降低轮询频率
- 按模型进度条显示占总用量比例
- 趋势图：Token 为输入 / 输出 / 缓存堆叠柱 + 折线；费用仅在接口返回美分时绘制；可按模型筛选；悬停看明细；日期范围可选
- 团队 / 企业：始终显示 On-Demand（接口美分，含 $0）
- Webview 跟随 Cursor 浅色 / 深色主题（`--vscode-*` 变量）

## 参与贡献

欢迎 Issue 和 Pull Request。

1. Fork 本仓库
2. `git checkout -b feature/your-feature`
3. 提交更改
4. 开 Pull Request

## 开源协议

[MIT](LICENSE)

---

<div align="center">

## English

**A Cursor IDE extension that shows live Cursor token billing on the status bar**

[中文](#cursor-token-usage) · [English](#english) · [Quick Start](#quick-start) · [Features](#features) · [Authentication](#authentication) · [UI](#ui) · [FAQ](#faq)

</div>

Cursor now bills by tokens in two pools (not the old “fast-premium requests + dollars” model). This extension reads the live dashboard APIs and switches the display by account type: individual accounts see two-pool percentages; Team / Enterprise see included spend vs limit.

### Features

| **Status bar** Individual: `C xx% · O xx%`. Team / Enterprise: included used vs limit (API cents, not a local estimate) | **Details panel** Click the status bar for a usage ring, colored bars, per-model tokens, recent events, and a trend chart |
| --- | --- |
| **Account-aware** Type comes from the API (`individual` / `team` / `enterprise`), not guessed from the token | **Usage alerts** Notify when the delta between two polls exceeds a threshold; metrics and thresholds are configurable |

**Also:**

- Auto refresh, default 30 seconds; slower while the window is unfocused
- Status-bar polls are light (one page of events); opening or refreshing the details panel paginates the full billing-cycle list
- English / Chinese UI, follows the editor language
- Universal VSIX for macOS / Windows / Linux; reads the local Cursor session (`state.vscdb`)
- UI extension (`extensionKind: ui`): on SSH Remote, WSL, or Dev Containers it still reads the **local** login
- Shows `$` only when the API returns cents; does not estimate invoices from list prices
- Trend chart defaults to the last 7 days; From / To can span months within the billing cycle
- **v1.3:** Details panel defaults to **multi-account overview** with cache hit rate; status bar shows current account usage by default (`cursorTokenUsage.statusBarDataSource`, optional `overview`)
- **v1.3.1:** Scrollable account table (~10 visible rows); unlimited account storage by default; token numbers auto-scale (万/亿, K/M/B)
- **v1.3.2:** Tooltip sorted by last update + Chinese l10n; foldable By Model groups (Standard/Fast/High); trend filter uses event slugs
- **v1.3.3:** Status bar drops redundant「用量」prefix; smart cost pill (pool usage first); field-level cache Write hybrid; hide zero Cache Write / On-Demand $0
- **v1.3.4:** Status bar default = current account; merge Auto/Default duplicate modes; trend uses dailyBuckets + ≥7-day window; meter/hero cleanup
- **v1.3.5:** Quick toggle status bar between **current account** and **overview**; tooltip switch link; details panel toolbar + ⋯ menu; Command Palette toggle
- **v1.3.9:** Identity from JWT `sub` + `cachedEmail` (fixes Sentry mislabel); retained sessions refresh in overview in parallel

### Quick Start

#### From Open VSX

Install from [Open VSX](https://open-vsx.org/extension/vifaer/cursor-token-usage) (Cursor’s extension marketplace). Search `Cursor Token Usage`, or:

```bash
cursor --install-extension vifaer.cursor-token-usage
```

#### From a VSIX

1. Download `cursor-token-usage-1.3.9.vsix` from [Releases](https://github.com/Vifaer/Cursor-Token-Usage/releases)
2. Drag it into Cursor, or `Cmd+Shift+P` (Windows: `Ctrl+Shift+P`) → `Extensions: Install from VSIX...`
3. Run `Developer: Reload Window`

The status bar should show usage. If the session is missing it shows **Set Token** — see Authentication.

### Authentication

The extension reads `cursorAuth/accessToken` and the user id from the local `state.vscdb`, builds a `WorkosCursorSessionToken` cookie, and sends it to **`cursor.com` only**.

| OS | Session file |
| --- | --- |
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |

Auto-detect needs **Python 3** on PATH (`python3` / `python`, or the Windows `py` launcher). Without Python, use **Set Session Token**; the rest of the extension still works.

If auto-detect fails:

1. Command Palette → **Cursor Token Usage: Set Session Token**
2. Paste `WorkosCursorSessionToken` (format: `userId%3A%3AaccessToken`)
3. The token is stored in VS Code SecretStorage, never in `settings.json`

To copy the cookie: open [cursor.com](https://cursor.com) → DevTools → Application → Cookies → `WorkosCursorSessionToken`.

**Remote workspaces:** this extension runs in the local Cursor process. Do not install it on the SSH / WSL / container host.

### UI

```
Status bar (individual):      $(graph) C 42% · O 18%
Status bar (team/enterprise): $(graph) $67.88/$52.00

Details panel
┌─────────────────────────────────────────────┐
│ Cursor Token Usage              enterprise  │
│ Reset in: 12d 4h          Total Tokens 1.2M │
│                                             │
│   (  131%  )   Included usage               │
│                $67.88 / $52.00              │
│ ████████████████████████████░░░░  over 100% │
│ Cursor Models   ████████░░░░░░░░     42%    │
│ Other Models    ███░░░░░░░░░░░░░     18%    │
│ On-Demand       $5.74                       │
│                                             │
│ By Model                                    │
│ claude-4.6-opus  ████████████████     801K  │
│ gpt-5            ██████░░░░░░░░░░     124K  │
│                                             │
│ Recent Usage                                │
│ 08-13 21:04  Claude 4.6 Opus  Included  21K │
└─────────────────────────────────────────────┘
```

Bar colors: green < 40%, yellow < 80%, orange ≥ 80%, red ≥ 100%. Usage ≥ 80% tints the status bar warning; ≥ 100% tints it error.

Panel buttons: Refresh, Set Session Token, status bar side, Configure Alerts.

Trend chart: Token (stacked input / output / cache + line) or Cost (bars + line). Date inputs are bounded by the billing cycle and default to the last 7 days. The Cost tab only draws when the API returns cents. Background polls update the status bar only; if the panel is open, a banner asks you to Refresh for details.

### Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `cursorTokenUsage.displayCount` | 5 | Recent usage rows in the details panel (does not limit the trend chart) |
| `cursorTokenUsage.pollingInterval` | 30 | Poll interval in seconds (5–300) |
| `cursorTokenUsage.showStatusBar` | true | Show the status bar item |
| `cursorTokenUsage.statusBarAlignment` | `right` | Status bar side: `left` / `right` |
| `cursorTokenUsage.alertEnabled` | true | Enable usage-change alerts |
| `cursorTokenUsage.alertItems` | `newSession` `overallSpending` `cursorModels` `otherModels` `totalTokens` | Metrics to watch |
| `cursorTokenUsage.alertThreshold.newSession` | 2 | New usage requests in one poll |
| `cursorTokenUsage.alertThreshold.overallSpending` | 1 | Included spend change ($) |
| `cursorTokenUsage.alertThreshold.cursorModels` | 10 | Cursor Models pool change (%) |
| `cursorTokenUsage.alertThreshold.otherModels` | 10 | Other Models pool change (%) |
| `cursorTokenUsage.alertThreshold.onDemandSpending` | 1 | On-demand spend change ($) |
| `cursorTokenUsage.alertThreshold.totalTokens` | 100000 | Total tokens change |
| `cursorTokenUsage.maxStoredAccounts` | 0 | Max stored accounts (0 = unlimited; N>0 prunes oldest) |

### Commands

| Command | What it does |
| --- | --- |
| Show Token Usage Details | Open the details panel (same as clicking the status bar) |
| Refresh Token Usage | Poll immediately |
| Set Session Token | Paste / clear the session token |
| Set Polling Interval | 5–300 seconds |
| Set Status Bar Side | Left / right |
| Configure Usage Alerts | Toggle, pick metrics, set thresholds |

### Usage Alerts

1. Command Palette → **Configure Usage Alerts**, or the Alerts button in the details panel
2. Enable alerts → pick metrics → set thresholds
3. Monitors: new requests, included spend, Cursor Models %, Other Models %, On-Demand spend, total tokens
4. A threshold of `0` means any change fires an alert

> Thresholds are the **delta between two consecutive polls**, not a lifetime or absolute cap. Example: `onDemandSpending = 1.0` fires when on-demand spend rises by $1.00 or more since the last successful poll.

### FAQ

**Why not estimate dollars?**

Self-serve usage events often return `$0` (`chargedCents: 0`) even when tokens were used. Token × public list price will not match the invoice: included quota, Team / Enterprise discounts, and Cursor Token Rate are applied server-side. `$` is shown only when the API returns cents. Token counts are always tokens. The **Cost** tab stays empty in that case; use **Token**.

**Status bar stuck on Set Token?**

Confirm Cursor is signed in locally and Python 3 is on PATH. If it still fails, use **Set Session Token** and paste `WorkosCursorSessionToken`.

**Wrong email / hotmail not showing?**

Identity uses `cachedEmail` + JWT `sub` from `state.vscdb` (not Sentry). Run **Diagnose Auth** to compare JWT / DB / Sentry. Other accounts you previously signed into (or pasted) are refreshed in the overview from retained sessions (same JWT never counts as two accounts); re-login or Set Token after expiry.

**No usage on SSH / WSL?**

Install the extension in **local** Cursor, not on the remote host. It is a UI extension and only reads the local `state.vscdb`.

**Alerts too noisy / never fire?**

Thresholds are the delta between adjacent polls. Raise or lower `pollingInterval` and the matching `alertThreshold.*`. `0` means any change.

**Details panel looks stale?**

The status bar refreshes on the polling interval. The panel keeps the current date range and chart until you click **Refresh** (or reopen it), so the date picker is not reset. A banner appears when the status bar has newer data.

### Build from Source

```bash
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
```

Install the resulting `.vsix`, then **Developer: Reload Window**.

### Changelog (1.0.10)

- Pool percentages below 1% show one decimal (`0.2%`) instead of rounding to `0%`
- Tracker log prints raw `autoPercentUsed` / `apiPercentUsed` / `totalPercentUsed`

### Changelog (1.0.9)

- Paginate usage events (100 per page, up to 30 pages) when the details panel is opened or refreshed
- Status-bar polls stay light (one page) and merge new events into the full list; they never replace a completed event list with a shorter one
- Opening or refreshing the panel waits for an in-flight poll instead of skipping the full fetch
- Date picker `min` / `max` follow the billing cycle; default chart window is the last 7 days; From / To can span months
- Background polling does not rebuild the panel; a banner asks you to Refresh when the status bar has newer data
- Cost chart also draws a trend line; the legend switches with the Token / Cost tab and is centered
- Cost tab stays empty when the API returns no cents (no list-price estimate)

### Changelog (1.0.8)

- Republish of 1.0.7: Open VSX reserved 1.0.7 after it was published and deleted
- README header (EN / 中文) is centered as one block

### Changelog (1.0.7)

- Store listing copy: Cursor token **billing** (not generic “usage”)
- README: Cursor IDE only; Open VSX install path; no VS Code Marketplace

### Changelog (1.0.6)

- Status bar shows **Set Token** when the session is missing
- English token units use K/M; Chinese still uses 万
- Slower polling while the window is unfocused
- Per-model bars show share of total tokens
- Trend chart: Token stacked bars (input / output / cache) + line; Cost bars only when the API returns cents; model filter; hover tooltip; selectable date range
- Team / Enterprise: On-Demand always shown (API cents, including $0)
- Webview follows Cursor light / dark via `--vscode-*` theme colors

### Contributing

Issues and pull requests are welcome.

1. Fork this repo
2. `git checkout -b feature/your-feature`
3. Commit your changes
4. Open a pull request

### License

[MIT](LICENSE)

---

由 [Vifaer](https://github.com/Vifaer) 维护 · 基于 [Akito-Go/Cursor-Token-Usage](https://github.com/Akito-Go/Cursor-Token-Usage)。有帮助的话欢迎 Star。

Maintained by [Vifaer](https://github.com/Vifaer) · based on [Akito-Go/Cursor-Token-Usage](https://github.com/Akito-Go/Cursor-Token-Usage). Star the repo if this helps.
