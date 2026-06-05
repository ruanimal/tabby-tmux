# Resize 与换行对齐问题修复

## 问题描述

tmux pane 恢复后，用户输入过程中内容超过行宽自动换行时，下一行开头的几个字符被覆盖。
按换行键后问题更严重。多 pane 窗口（同一行有多个不同宽度的 pane）下问题尤为突出。

## 根因分析

### 核心：tmux 客户端尺寸 ≠ xterm.js 实际尺寸

tmux 控制模式中，`refresh-client -C cols,rows` 设置的是**全局客户端尺寸**，tmux 据此决定每个 pane 的宽度和换行位置。如果发送的 cols 偏大，tmux pane 宽度 > xterm.js 实际宽度 → 换行位置不同 → 字符被覆盖。

```
tmux 侧（cols 偏大）        xterm.js 侧（实际宽度）
┌────────────────────────┐   ┌──────────────────┐
│ hello world foo bar baz│   │ hello world foo   │
│ qux                    │   │ bar baz qux       │
└────────────────────────┘   └──────────────────┘
     ↑ tmux 在第 21 列换行          ↑ xterm 在第 18 列换行
```

### 导致尺寸不准的四个问题

| # | 问题 | 影响 |
|---|------|------|
| 1 | `refresh-client -C` 用像素÷cellSize 计算，未扣除 scrollbar/spanner 装饰 | cols 偏大，内容宽度 < 容器宽度约 25% |
| 2 | `TmuxPaneSession.resize()` 是 no-op，xterm refit 后不通知上层 | 初始尺寸发错后无人纠正 |
| 3 | 多 pane 布局未加回 tmux divider（1 字符/个） | cols 偏小 1~2 列 |
| 4 | spanner 拖拽后无事件触发 client size 刷新 | 拖拽分隔条后 pane 内容错位 |

### 装饰元素详情

| 元素 | 像素 | 说明 |
|------|------|------|
| SplitTab spanner (divider) | 10px/个 | `.child` 之间的可拖拽分隔条 |
| xterm.js scrollbar | ~12-17px | 侧边滚动条（系统相关） |
| xterm.js border/padding | ~2px | 边框 |

直接用 `.pane-area` 的总像素宽度 ÷ cellSize 会把这些装饰算进字符面积，导致 cols 偏大。

## 解决方案

### 设计原则（参考 iTerm2）

iTerm2 的 `TmuxController.m` 中：
- **单个 pane resize 绝不直接触发 `refresh-client -C`**
- 只有 **窗口级 resize**（`windowDidResize`）和 **布局变化后**（`fitLayoutToWindows`）才发
- 尺寸计算精确扣除所有装饰（divider、scrollbar、title bar、margins）
- pane 的 resize 信号只用于触发窗口级尺寸重算

### 修复方案

#### 1. `TmuxPaneSession.resize()` → 通知控制器（非 no-op）

```typescript
resize(_columns: number, _rows: number): void {
    // 通知控制器：某个 pane 的 xterm.js 尺寸变了
    // TmuxSessionTabComponent 订阅此信号，重算整体 client size
    this.controller.onPaneDisplayResized()
}
```

`TmuxController.paneDisplayResized$` 是一个 `Subject<void>`，每次任何 pane
的 xterm.js refit 时触发，由 SessionTab 订阅后去重+防抖发送。

#### 2. `refreshClientSize()` 精确计算（布局树法）

计算方式分为两级：

**首选：布局树法（最精确）** — `computeClientSizeFromLayout()`

遍历 tmux layout 树，从每个 pane 的 `xterm.cols/rows`（已扣除 scrollbar）加上 tmux divider（1 字符/个）递归求和：

```
水平分割: total_cols = sum(child_cols) + (num_children - 1)
垂直分割: total_rows = sum(child_rows) + (num_children - 1)
```

```typescript
private computeClientSizeFromLayout(): { cols; rows } | null {
    const paneDims = new Map<number, { cols, rows }>()
    for (const [paneId, paneTab] of paneMap) {
        const frontend = (paneTab as any).frontend
        // xterm.cols/rows 已扣除 scrollbar、padding
        paneDims.set(paneId, { cols: frontend.xterm.cols, rows: frontend.xterm.rows })
    }
    return this.computeSizeFromNode(layoutTree, paneDims)  // 递归计算
}
```

**回退：像素法** — `measurePaneArea()`（pane 未挂载时用）

```typescript
// 扣除 UI spanner + scrollbar + 加回 tmux dividers
availableWidth = rect.width - spanners×10 - panes×14
cols = Math.floor(availableWidth / cellW) + (paneCount - 1)
```

#### 3. 发送时机（四个触发源）

| 时机 | 触发方式 | 去重/防抖 |
|------|---------|----------|
| **初始恢复** | `switchToWindow()` 创建 pane 前先发像素近似值 | `_lastSentCols/Rows` |
| **pane refit** | 任何 pane 的 xterm.js refit → `paneDisplayResized$` → `scheduleRefreshClientSize` | 100ms auditTime + 150ms 防抖 |
| **窗口 resize** | `window.addEventListener('resize')` → `scheduleRefreshClientSize` | 150ms 防抖 |
| **spanner 拖拽** | `onSpannerAdjusted()` override → `scheduleRefreshClientSize` | 150ms 防抖 |

所有信号最终汇入 `scheduleRefreshClientSize()`（150ms 防抖），
调用 `refreshClientSize()` → `computeClientSizeFromLayout()` 精确计算 →
`_lastSentCols/Rows` 去重。

#### 4. 响应块中正确分派 `%output` 通知

`capture-pane` 执行期间 gateway 处于 `inResponseBlock` 状态。
如果遇到 `%output` 通知，必须立即分派而不是累积为响应内容：

```typescript
// gateway.ts — executeLine()
if (line.startsWith('%output ') || line.startsWith('%extended-output ')) {
    // Dispatch immediately, don't accumulate as response text
    if (this.acceptNotifications) {
        if (line.startsWith('%output ')) {
            this.parseOutput(line)
        } else {
            this.parseExtendedOutput(line)
        }
    }
    return
}
```

#### 5. `registerPane` 丢弃 pending output

连接时 tmux 立即发送的 `%output`（当前可见内容）与 `capture-pane -S-` 恢复的历史重复。
必须丢弃 pending output，否则可见内容出现两次，最早的历史行被挤出 scrollback：

```typescript
registerPane(paneId: number, session: TmuxPaneSession): void {
    this.paneSessions.set(paneId, session)
    this.knownPanes.add(paneId)
    // Discard — capture-pane -S- already includes visible content
    this.pendingPaneOutput.delete(paneId)
}
```

## 修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `src/session.ts` | `TmuxPaneSession.resize()` 调用 `controller.onPaneDisplayResized()` 通知上层；新增 `paneDisplayResized$` Subject 和 `onPaneDisplayResized()` 方法；`registerPane` 丢弃 pending output |
| `src/gateway.ts` | 响应块中正确分派 `%output`/`%extended-output` 通知 |
| `src/components/tmuxSessionTab.component.ts` | 订阅 `paneDisplayResized$` 触发尺寸重算；布局树法精确计算（`computeClientSizeFromLayout` + `computeSizeFromNode`）；spanner 拖拽触发 `scheduleRefreshClientSize`；像素回退扣除 scrollbar 加回 tmux dividers |

## 数据流图

```
xterm.js refit (fitAddon.fit)
  → xterm.onResize({ cols, rows })
  → BaseTerminalTabComponent.resize$ (auditTime 100ms)
  → TmuxPaneSession.resize(columns, rows)
  → controller.onPaneDisplayResized()
  → paneDisplayResized$.next()
  → TmuxSessionTabComponent.scheduleRefreshClientSize()
    (debounce 150ms, dedup via _lastSentCols/Rows)
  → refreshClientSize() → computeClientSizeFromLayout()
  → refresh-client -C cols,rows → tmux

window.resize / spanner drag
  → scheduleRefreshClientSize() → 同上
```

## 与 iTerm2 的对照

| 场景 | iTerm2 (TmuxController.m) | 我们的实现 |
|------|---------------------------|-----------|
| pane 显示尺寸变化 | `didResizePane:` → `fitLayoutToWindows` | `resize()` → `onPaneDisplayResized()` → `scheduleRefreshClientSize()` |
| 窗口 resize | `windowDidResize` → `setClientSize` | `window.resize` → `scheduleRefreshClientSize` |
| spanner 拖拽 | N/A (AppKit divider) | `onSpannerAdjusted` → `scheduleRefreshClientSize` |
| 初次恢复 | `openWindowsOfSize` | `switchToWindow` → `refreshClientSize` (近似) + pane refit 后精确 |
| 尺寸计算 | `variableTmuxSize`: 切片分析，扣除 divider/scrollbar/title bar | `computeClientSizeFromLayout`: 遍历 layout 树，xterm cols + tmux dividers |
| 去重 | `lastSize_` + `numOutstandingWindowResizes_` | `_lastSentCols/Rows` + 150ms 防抖 |
| 历史恢复 pending output | 不缓冲 pending output | `registerPane` 丢弃 pending output |
