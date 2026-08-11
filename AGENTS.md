# Tabby Tmux Integration 插件
## 要求
- 搜索代码时使用 ripgrep
- 修复问题时尽量从根源修复, 不要打补丁式更改

## 项目概述

`tabby-tmux` 是一个为 [Tabby](https://tabby.sh/) 终端模拟器提供 tmux Control Mode 集成的插件，灵感来自 [iTerm2 tmux Integration](https://iterm2.com/documentation-tmux-integration.html)。

- **原生 UI 集成**：将 tmux window 和 pane 映射为 Tabby 原生组件
- **会话持久化**：Tabby 关闭后 tmux 会话保持运行，通过 `tmux -CC attach` 恢复

## 术语表

统一以下术语，对齐认知；tmux 概念保留英文原文，不翻译。

### tmux 核心概念

| 术语 | 含义 | 备注 |
| --- | --- | --- |
| session | tmux 会话 | ID 格式 `$<id>` |
| window | tmux 窗口 | ID 格式 `@<id>` |
| pane | tmux 窗格 | ID 格式 `%<id>` |
| layout | tmux 布局字符串 | 格式 `checksum,WxH,X,Y<content>`，`[...]` 垂直分割、`{...}` 水平分割 |
| Control Mode | tmux 控制模式 | 用 `tmux -CC` 启用；输出经 DCS 转义序列包裹 |
| attach / detach | 附着到 / 从 tmux 会话分离 | attach 需带 `-CC` |
| zoom | pane 缩放 | 缩放时 pane 占满整个 window |
| synchronize-panes | 同步输入 | 输入广播到会话内所有 pane |

### Control Mode 协议消息

| 消息 | 含义 |
| --- | --- |
| `%begin` / `%end` / `%error` | 命令响应块，按 cmdId 匹配请求 |
| `%output` / `%extended-output` | pane 输出；extended 带 latency |
| `%layout-change` | 布局变化，主 pane 发现触发点 |
| `%window-add` / `%window-close` / `%window-renamed` | window 增删改（含 `unlinked-` 变体）|
| `%session-changed` / `%sessions-changed` / `%session-window-changed` | 会话变化 |
| `%window-pane-changed` | 活动 pane 变化 |
| `%pane-close` | pane 关闭（含 `unlinked-` 变体）|
| `%pause` / `%continue` / `%no-output` / `%exit` | 流控与退出 |

### 关键流程概念

| 术语 | 含义 |
| --- | --- |
| Enter / Exit Tmux Mode | 进入 / 退出 tmux 模式，由右键菜单触发 |
| batch discovery | 批量发现 window/pane：`list-windows` → `list-panes` → pane 快照 |
| PaneState | `list-panes -F` 捕获的 pane 状态（光标、滚动区、模式标志等）|
| window bar | 底部 tmux window 切换栏（可折叠）|
| layout sync | 把 tmux layout 同步到 Tabby 的像素绝对定位布局 |
| refresh-client | 客户端尺寸刷新 |
| capture-pane | 捕获 pane 屏幕内容，用于历史恢复 |

## 开发指南

### 构建

```bash
pnpm install    # 安装依赖
pnpm run watch  # 开发模式（监听文件变化）
pnpm run build  # 生产构建
```

### 参考资料

- `ref/iterm2-tmux-integration.md` — iTerm2 参考文档
- `ref/iTerm2-TmuxController.md` — iTerm2 TmuxController 实现分析
- `ref/tmux.wiki/Control-Mode.md` — tmux Control Mode 官方文档
- `ref/tabby/` — Tabby 源码参考
