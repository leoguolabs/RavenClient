# Raven 原生终端（Native Terminal）技术方案

> 分支：`feature/native-terminal`
> 目标：用 Raven 原生终端替换嵌入式 Chaterm 作为 Terminal 页签的实现，完整实现 SSH 基础能力，
> 并落地对 Termius 逆向分析得出的两个 P0 机制。

## 1. 背景与决策

对 Termius 9.37.6 的逆向分析（REA 证据 `ev_bc31a085…`）确认了其终端体验的核心基建：

| P0 | 机制 | 价值 |
|---|---|---|
| P0-1 | **OSC 4545 shell integration**：shell 侧脚本通过自定义 OSC 序列上报 cwd、提示符边界、命令开始/退出码 | 可靠的命令边界与上下文，是一切智能功能（历史/AI 建议）的地基 |
| P0-2 | **带 exit_code + rating 的命令历史**：按使用频次评分、跨会话持久化 | AI 命令建议的核心上下文来源 |

**架构决策：替换而非改造 Chaterm。**

理由：
1. Chaterm 是 third_party 子模块（独立仓库、独立构建链、资源依赖 `resources/chaterm/`），改造需跨仓协作且打包耦合重；
2. Raven 主进程已具备完整 service 层模式，原生实现（xterm.js + node-pty + ssh2）与 React/Redux 技术栈一致；
3. LLM 桥（`raven:llm:*`）为 Chaterm 而建，原生终端未来接 AI 建议时可直接进程内调用，无需 IPC 桥；
4. Chaterm 代码**保留不删**，通过 feature flag 休眠，可随时回滚。

## 2. 架构

```
┌─ Renderer (React) ─────────────────────────────────┐
│ TerminalPage → TerminalWorkbench                   │
│   ├─ ConnectPanel        本地 Shell / SSH 连接表单   │
│   ├─ TerminalSessionView × N（tab）                 │
│   │    ├─ xterm.js + FitAddon                      │
│   │    ├─ RavenOsc4545Addon   ← 解析 OSC 4545      │
│   │    ├─ SuggestionPopup     ← 历史补全（P0-2）    │
│   │    └─ 状态栏（cwd / 上条命令退出码）              │
└──────────────┬─────────────────────────────────────┘
               │ IPC（invoke + 动态事件通道）
┌─ Main ───────▼─────────────────────────────────────┐
│ TerminalService（会话注册表 + IPC handler）          │
│   ├─ LocalPtySession   node-pty（ConPTY/winpty）    │
│   ├─ SshSession        ssh2（shell channel）        │
│   ├─ shellIntegration  脚本安装 + 远程引导注入        │
│   └─ TerminalHistoryStore  JSON 持久化（P0-2）       │
└────────────────────────────────────────────────────┘
```

- 数据面：main → renderer 用动态通道 `terminal:data:<id>`（Buffer 结构化克隆，零序列化开销）；
- 控制面：`terminal:createSession/write/resize/close` invoke；
- 每个 session 绑定创建它的 `event.sender`，sender 销毁即回收 session（防泄漏）。

## 3. P0-1：OSC 4545 Shell Integration

协议消息（`\e]4545;<action>;<payload>\a`）：

| 消息 | 载荷 | 语义 |
|---|---|---|
| `SetCwd` | base64(UTF-8 PWD) | 提示符出现时的当前目录 |
| `ShellPromptBegins` / `ShellPromptEnds` | 无 | 提示符渲染边界（MVP 预留） |
| `CommandStarted` | base64(UTF-8 命令) | 用户命令开始执行 |
| `CommandExited` | 十进制退出码 | 命令结束及退出码 |

注入方式（区分场景）：

- **本地 PTY（macOS/Linux）**：环境变量注入，零视觉噪音
  - zsh → `ZDOTDIR` 指向 `<userData>/shell-integration/zdotdir`
  - bash → 追加参数 `--rcfile <userData>/shell-integration/bashrc.sh`（脚本内部 source 用户 ~/.bashrc）
  - fish → `XDG_DATA_DIRS` 前置 `<userData>/shell-integration/xdg_data`
  - Windows / 其它 shell：暂不注入（ graceful 降级，无历史记录）
- **SSH 远程**：shell channel 就绪后发送单行引导：
  ` eval "$(printf %s <b64> | base64 -d || printf %s <b64> | base64 -D)"`（兼容 GNU/BSD base64；
  前导空格避免进入 bash history）。载荷为 bash/zsh 双兼容脚本（preexec/precmd hook）。

脚本实现遵循 VS Code MIT 版 shell integration 的成熟模式（Termius 同源）：
DEBUG trap 兼容、保留用户原 PROMPT_COMMAND、防递归。

## 4. P0-2：命令历史（exit_code + rating）

- 存储：`<userData>/terminal-history.json`，上限 1000 条，防抖落盘（2s）+ 退出时 flush；
- 模型：`{ script, rating, completedAt, exitCode?, cwd?, host? }`；
- 上报：renderer 的 OSC addon 解析到 `CommandStarted/CommandExited` 后经
  `terminal:history:report` 写入；同脚本 upsert → rating+1、更新退出码/时间；
- 过滤：脚本 >4095 字符（bash 上限）与 shell integration 自身命令不入库；
- 消费：`terminal:history:list` 供补全弹层与未来的 AI 命令建议（经 `raven:llm:*`）使用。

## 5. SSH 基础能力清单

| 能力 | 实现 |
|---|---|
| 认证 | password / privateKey(+passphrase) / keyboard-interactive 降级 |
| 终端 | `conn.shell({ term: 'xterm-256color' })`，resize 转发 `stream.setWindow` |
| 保活 | `keepalive: { interval: 15s, maxcount: 3 }` |
| 主机密钥校验 | TOFU：首次记录 sha256 指纹（`<userData>/terminal-known-hosts.json`），变更即拒绝并给出明确错误 |
| 重连 | 会话结束后 UI 提供「重连」（复用原配置）；自动重连队列列为 P1 |
| 密码提示检测 | 多语言正则（password/密码/口令/…）识别后可提示保存身份（预留） |

## 6. Chaterm 休眠策略

- `src/renderer/src/config/terminalFlags.ts`：`CHATERM_TERMINAL_ENABLED = false`；
- `App.tsx` 按该 flag 决定是否挂载 `ChatermWebviewHost`；
- `TerminalPage` 优先渲染原生终端，flag 关闭时回退旧 Chaterm 守卫逻辑；
- main 进程 Chaterm 启动逻辑保留（无资源时本就 no-op，不 crash）。

## 7. 依赖

| 包 | 用途 | 备注 |
|---|---|---|
| `ssh2@^1.17` | SSH 协议（纯 JS） | optional cpu-features 原生模块，构建失败可降级 |
| `node-pty@1.1.0-beta34` | 本地 PTY | 1.0.0 在新 MSVC 下编译失败（winpty.cc C2362），beta34 已修；N-API，兼容 Electron 41 |
| `@xterm/xterm@^6` + `addon-fit` | 终端渲染 | 与 Chaterm 同版本系 |
| `node-gyp`（devDep） | Yarn 4 下 node-pty 构建所需 | beta34 未声明该依赖，需顶层提供 |

## 8. 已知限制与后续（P1/P2）

- 自动重连队列、广播输入、run-in-all-tabs（P1）；
- SSH agent forwarding、SFTP、端口转发（P2）；
- Windows 本地 shell 的 integration 注入（P2，需 PowerShell profile 方案）；
- AI 命令生成（Termius `generation` 态）：经 `raven:llm:*` 接入，P1；
- 提示符边界（ShellPromptBegins/Ends）当前仅透传，UI 尚未消费。
