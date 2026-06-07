# tabby-tmux

[中文](README.zh-CN.md)

[![Build](https://github.com/ruanimal/tabby-tmux/actions/workflows/build.yml/badge.svg)](https://github.com/ruanimal/tabby-tmux/actions/workflows/build.yml)
[![npm version](https://img.shields.io/npm/v/tabby-tmux)](https://www.npmjs.com/package/tabby-tmux)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [Tabby](https://tabby.sh/) plugin that provides tmux Control Mode integration, inspired by [iTerm2 tmux Integration](https://iterm2.com/documentation-tmux-integration.html).

## Features

- **Native UI integration** — Maps tmux windows and panes into native Tabby components
- **Session persistence** — tmux sessions survive Tabby restarts; reconnect via `tmux -CC attach`
- **Window bar** — Collapsible bottom bar for switching tmux windows, with support for creating new windows and disconnecting
- **Layout sync** — Automatically syncs tmux layout into Tabby SplitTab

## Installation

### Via Tabby Settings

1. Open Tabby → **Settings** → **Plugins**
2. Search for `tabby-tmux`
3. Click **Install**

### Via command line

```bash
cd <tabby-plugins-dir>
npm install tabby-tmux
```

## Usage

1. Create a new profile in Tabby, select the **Tmux** type
2. Configure the tmux session name (default: `default`)
3. Once connected, the bottom window bar shows tmux windows — switch between windows and panes from there

### Development

```bash
pnpm install
pnpm run watch  # watch mode

# Launch Tabby with the plugin loaded
TABBY_PLUGINS=$(pwd) tabby --debug
```

## trzsz Support

This plugin is fully compatible with the [tabby-trzsz](https://github.com/trzsz/tabby-trzsz) plugin, enabling file transfer (`trz`/`tsz`) and drag-and-drop upload over tmux panes.

Install both plugins and they work together automatically:

```bash
cd <tabby-plugins-dir>
npm install tabby-tmux tabby-trzsz
```

> **Note:** When uploading files over WebSocket terminals (e.g. via [tabby-ws-term](https://github.com/ruanimal/tabby-ws-term)), use `trzsz -B 10K` to improve compatibility.

## Architecture

```
TmuxService
├── TmuxGateway        — tmux Control Mode protocol parser
├── TmuxController     — session state management & event dispatch
├── TmuxSessionTab     — extends SplitTabComponent, manages window/pane mapping
├── TmuxWindowBar      — collapsible bottom window switcher bar
└── TmuxPaneTab        — extends BaseTerminalTabComponent, single pane
```

### Data flow

```
User input → TmuxPaneTab → paneSession.feedFromTerminal()
  → controller.writeToPane(paneId, data)
  → gateway.sendKeys(hex, paneId) → PTY → tmux

tmux output → PTY → controller.handleLine()
  → gateway.executeLine() → parse protocol
  → %output → paneSession.emitOutput()
  → %layout-change → event → SessionTab.syncLayout()
```

## Tech Stack

- **Framework**: Angular 15 + TypeScript 4.9
- **Dependencies**: `tabby-core`, `tabby-terminal`, `tabby-local`, `rxjs`

## License

MIT
