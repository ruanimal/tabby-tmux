# Resize 与换行对齐问题修复

## 问题描述

tmux pane 恢复后，pane 尺寸持续抖动（如 `169x49` ⇄ `169x48` 反复跳变），
用户输入超过行宽自动换行时下一行开头字符被覆盖。多 pane 窗口尤为严重。

## 根因：尺寸反馈环（bidirectional size coupling）

旧实现把**每个 pane 的 `xterm.cols/rows` 反推为 tmux 客户端尺寸**，形成闭环：

```
refresh-client -C
  → tmux 重新布局 → %layout-change
  → syncLayout 按百分比重新定位 pane 容器
  → 容器像素变化 → xterm ResizeObserver → fitAddon.fit()
  → xterm.onResize → TmuxPaneSession.resize()
  → paneDisplayResized$ → refreshClientSize()
  → computeClientSizeFromLayout()  ← 又读 xterm.cols/rows
  → refresh-client -C  ← 回到起点
```

三个放大因素：

| # | 因素 | 后果 |
|---|------|------|
| 1 | `paneDisplayResized$` 把"我们自己触发的 refit"再变成一次 refresh-client | 闭合反馈环 |
| 2 | `.child { transition: 0.125s all }` 动画期间 ResizeObserver 连续触发中间尺寸 | 瞬态值（如比窗口还大的 `173x17`）被当真 |
| 3 | `computeSizeFromNode` 跨轴用 `Math.min` | 多 pane 重排时少 1 行就把整窗口砍 1 行（49→48） |

每轮 round-trip 的 ±1 像素舍入使 `_lastSentCols/Rows` 去重永不命中，无限抖动。

## 解决方案：tmux 权威 + 单一数据源（参考 iTerm2 真实模型）

核心原则：**数据流单向化**。tmux 决定每个 pane 的字符网格，视图按 tmux 网格设尺寸，
而不是反过来用视图反推喂 tmux。

### 1. tmux 对 pane 字符网格成为权威

- `%layout-change` 的 layout 字符串里已包含每个 pane 的精确字符宽高（`WxH`）。
- `syncLayout()` 解析后调用 `applyLayoutGrids()`，对每个 pane 直接
  `xterm.resize(cols, rows)`（`TmuxPaneTabComponent.setTmuxGrid`）。
- **关闭 tmux pane 的 xterm 自动 fit**：frontend 就绪后设
  `frontend.enableResizing = false`，pane 不再 fit-to-pixels，也不再把自己的
  尺寸（带舍入）回报上层。
- `TmuxPaneSession.resize()` 改为 no-op（不再发 refresh-client）。

这样 xterm 显示的就是 tmux 给的精确网格 → 换行与 tmux 完全一致 → 同时修复 wrap 问题。

### 2. 整窗客户端尺寸只由容器（`.pane-area`）像素决定

`refreshClientSize()` 是客户端尺寸的**唯一来源**：

```
cols = floor((paneArea宽 − spanner分隔条 − 每pane装饰) / cell宽) + (pane数−1 个tmux divider)
rows = floor(paneArea高 / cell高)
```

- `.pane-area` 像素尺寸只依赖容器，**与 tmux 的 pane 布局无关**。
- cell 尺寸取 xterm `_renderService.dimensions.css.cell`（真实字符像素），不估算。
- 装饰像素：spanner 10px/个、每 pane scrollbar+padding ≈ 16px。

因为结果只来自稳定的容器尺寸，tmux relayout **不会**改变它 → 去重一次即终止，环被打破。

### 3. 单一触发源：`.pane-area` 的 ResizeObserver

```
容器像素变化（窗口 resize / spanner 拖拽 / 侧栏切换 / 首次挂载）
  → ResizeObserver → scheduleRefreshClientSize()（150ms 防抖）
  → refreshClientSize() → measureClientSize() → refresh-client -C
```

删除了 `paneDisplayResized$` 订阅这条回灌路径。

## 数据流图（修复后，单向）

```
容器尺寸变化
  → .pane-area ResizeObserver（唯一触发源）
  → refreshClientSize()（容器像素 ÷ cell）
  → refresh-client -C cols,rows → tmux
  → tmux 切分网格 → %layout-change
  → syncLayout() → applyLayoutGrids()
  → 每个 pane xterm.resize(tmux 给的 cols,rows)   （终点，不回灌）
```

## 修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `src/session.ts` | `TmuxPaneSession.resize()` 改为 no-op；删除 `paneDisplayResized$` Subject 和 `onPaneDisplayResized()` |
| `src/components/tmuxPaneTab.component.ts` | frontend 就绪后 `enableResizing = false`；新增 `setTmuxGrid()` / `applyTmuxGrid()` 按 tmux layout 设 xterm 网格 |
| `src/components/tmuxSessionTab.component.ts` | `refreshClientSize()` 仅由 `.pane-area` 像素计算（`measureClientSize` + `getCellSize`）；`syncLayout()` 调用 `applyLayoutGrids()` 下发 tmux 网格；新增 `.pane-area` ResizeObserver 作为唯一触发源；删除 `computeClientSizeFromLayout` / `computeSizeFromNode` / 旧 `measurePaneArea` 及 `paneDisplayResized$` 订阅 |

## 与 iTerm2 的对照

| 场景 | iTerm2 (TmuxController.m) | 本实现 |
|------|---------------------------|--------|
| pane 字符尺寸 | tmux layout 权威，`setLayoutInTab` 设各 pane 尺寸 | `applyLayoutGrids` → `setTmuxGrid` → `xterm.resize` |
| 整窗 resize | `windowDidResize` → `setClientSize` | `.pane-area` ResizeObserver → `refresh-client -C` |
| pane 不反推尺寸 | pane 尺寸由 tmux 驱动，非本地计算 | `enableResizing=false` + `resize()` no-op |
| 去重 | `lastSize_` | `_lastSentCols/Rows` + 150ms 防抖 |
