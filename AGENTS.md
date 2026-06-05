# Tabby Tmux Integration 插件

## 项目概述

`tabby-tmux` 是一个为 [Tabby](https://tabby.sh/) 终端模拟器提供 tmux Control Mode 集成的插件，灵感来自 [iTerm2 tmux Integration](https://iterm2.com/documentation-tmux-integration.html)。

- **原生 UI 集成**：将 tmux window 和 pane 映射为 Tabby 原生组件
- **会话持久化**：Tabby 关闭后 tmux 会话保持运行，通过 `tmux -CC attach` 恢复
- **Control Mode 协议**：使用 `tmux -CC` 标志启用控制模式

## 技术架构

```
TmuxService (src/services/tmux.service.ts)
├── SessionContext: controller + pty + sessionTab
├── connectToSession() → spawn PTY → 创建 TmuxController
└── disconnectContext() → 清理连接

TmuxController (src/session.ts)
├── TmuxGateway (src/gateway.ts) — 协议解析
├── paneSessions: Map<paneId, TmuxPaneSession>
├── windowStates: Map<windowId, WindowState>
└── events: Subject — pane-add, window-add, layout-change, exit...

TmuxSessionTabComponent (src/components/tmuxSessionTab.component.ts)
├── 继承 SplitTabComponent
├── windowPaneTabs: Map<windowId, Map<paneId, TmuxPaneTabComponent>>
├── switchToWindow() — 切换 window（removeTab/addTab 隐藏/显示 pane）
└── syncLayout() — 同步 tmux layout 到 SplitTab

TmuxWindowBarComponent (src/components/tmuxWindowBar.component.ts)
├── 底部可折叠的 tmux window 栏
├── 显示所有 window 按钮，当前活跃的高亮
└── 支持新建 window、断开连接、折叠/展开

TmuxPaneTabComponent (src/components/tmuxPaneTab.component.ts)
├── 继承 BaseTerminalTabComponent
└── TmuxPaneSession — 面板会话，继承 BaseSession
```

### 数据流

```
用户输入 → TmuxPaneTab → paneSession.feedFromTerminal()
  → controller.writeToPane(paneId, data)
  → gateway.sendKeys(hex, paneId) → PTY → tmux

tmux 输出 → PTY → controller.handleLine()
  → gateway.executeLine() → 解析协议
  → %output → paneSession.emitOutput()
  → %layout-change → event → SessionTab.syncLayout()
```

### 注册入口 (src/index.ts)

- `ProfileProvider` → `TmuxProfileProvider` (src/profiles.ts) — 提供 `tmux:default` profile
- `CommandProvider` → `TmuxCommandProvider` (src/buttonProvider.ts) — 工具栏按钮
- `TabContextMenuItemProvider` → `TmuxContextMenuProvider` (src/tabContextMenu.ts) — 右键菜单

## tmux Control Mode 协议

```bash
tmux -CC new -A -s <session-name>  # 启动控制模式
tmux -CC attach                     # 附加到已有会话
```

### 关键协议格式

| 格式 | 说明 |
|------|------|
| `%begin <ts> <id> <flags>` / `%end` / `%error` | 命令响应块 |
| `%output %<pane-id> <escaped>` | 面板输出（八进制转义，如 `\015` = CR） |
| `%layout-change @<window-id> <layout>` | 布局变化 |
| `%window-add @<id>` / `%window-close @<id>` | 窗口增减 |
| `%session-changed $<id> <name>` | 会话切换 |

### 常用命令

| 命令 | 用途 |
|------|------|
| `send-keys -t %<pane-id> -H <hex>` | 发送十六进制编码按键 |
| `refresh-client -C <width>x<height>` | 设置客户端尺寸 |
| `capture-pane -ep -S- -t %<id>` | 恢复面板历史 |
| `list-panes -s -F "TABBY_PANE:#{pane_id}"` | 列出所有面板 |

## 开发指南

### 构建

```bash
pnpm install    # 安装依赖
pnpm run watch  # 开发模式（监听文件变化）
pnpm run build  # 生产构建
```

### 技术栈

- **框架**：Angular 15 + TypeScript 4.9
- **依赖**：`tabby-core`, `tabby-terminal`, `tabby-local`, `rxjs`

### 参考资料

- `ref/iterm2-tmux-integration.md` — iTerm2 参考文档
- `ref/iTerm2-TmuxController.md` — iTerm2 TmuxController 实现分析
- `ref/tmux.wiki/Control-Mode.md` — tmux Control Mode 官方文档
- `ref/tabby/` — Tabby 源码参考
