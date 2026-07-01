# tabby-tmux

[English](README.md)

[![Build](https://github.com/ruanimal/tabby-tmux/actions/workflows/build.yml/badge.svg)](https://github.com/ruanimal/tabby-tmux/actions/workflows/build.yml)
[![npm version](https://img.shields.io/npm/v/tabby-tmux)](https://www.npmjs.com/package/tabby-tmux)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[Tabby](https://tabby.sh/) 终端模拟器的 tmux Control Mode 集成插件，灵感来自 [iTerm2 tmux Integration](https://iterm2.com/documentation-tmux-integration.html)。

## 功能

- **原生 UI 集成** — 将 tmux window 和 pane 映射为 Tabby 原生组件
- **会话持久化** — Tabby 关闭后 tmux 会话保持运行，重新打开时通过 `tmux -CC attach` 恢复
- **底部窗口栏** — 可折叠的 tmux window 切换栏，支持新建 window、断开连接
- **布局同步** — 自动同步 tmux layout 到 Tabby SplitTab

## 安装

### 通过 Tabby 设置界面

1. 打开 Tabby → **Settings** → **Plugins**
2. 搜索 `tabby-tmux`
3. 点击 **Install**

### 通过命令行

```bash
cd <tabby-plugins-dir>
npm install tabby-tmux
```

## 使用

1. 在 Tabby 中打开任意终端标签页
2. 右键点击标签页 → **Enter Tmux Mode**
3. 底部出现 tmux window 栏，可切换 window 和 pane
4. 右键 → **Exit Tmux Mode** 退出 tmux 模式

## 配置

### 右键行为

默认情况下，在 tmux pane 内右键会直接弹出 **tmux pane 上下文菜单**（用于 *Enter/Exit Tmux Mode*、*New Window* 等操作），而**不会**遵循 Tabby 的 *Settings → Terminal → "On right-click"* 设置。

如果你在 Tabby 设置中将 **"On right-click"** 改为 `Paste` 或 `Clipboard`，本插件会尊重该选择：

- **短按右键** → 执行设置中的操作（粘贴剪贴板内容 / 复制选中内容）
- **长按右键（≥ 250 毫秒）** → 仍会弹出 tmux pane 上下文菜单，所有 tmux 功能依然可用

> **提示：** 修改设置后如果觉得 tmux 菜单不好调出，可以按住右键稍等片刻再松开，即可触发菜单。

## 兼容性

### trzsz

本插件与 [tabby-trzsz](https://github.com/trzsz/tabby-trzsz) 插件完全兼容，可在 tmux pane 中使用文件传输（`trz`/`tsz`）和拖拽上传。

同时安装两个插件即可自动配合工作：

```bash
cd <tabby-plugins-dir>
npm install tabby-tmux tabby-trzsz
```

> **提示：** 通过 WebSocket 终端上传文件时（如使用 [tabby-ws-term](https://github.com/ruanimal/tabby-ws-term)），建议使用 `trzsz -B 10K` 以提高兼容性。

## 开发调试

```bash
pnpm install
pnpm run watch  # 监听模式

# 启动 Tabby 并加载插件
TABBY_PLUGINS=$(pwd) tabby --debug
```

## License

MIT
