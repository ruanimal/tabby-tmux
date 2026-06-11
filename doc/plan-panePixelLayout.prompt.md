# Plan: Pane 布局重构 — 像素绝对定位 + 独立 Divider + Overlay Scrollbar

## TL;DR

将 pane 布局从「SplitTab ratio → 百分比定位 → 像素（有舍入误差）+ border/padding 混合体」重构为「tmux 字符坐标 × cell = 像素绝对定位」的简洁模型。同时引入独立 divider 元素替代 pane border，overlay scrollbar 替代 hidden scrollbar，移除 window bar 折叠功能。

---

## Phase 1: Pane 容器改造 — 去除 border/padding，overlay scrollbar

### Step 1.1: 修改 `tmuxPaneTab.component.scss`

**文件**: `src/components/tmuxPaneTab.component.scss`

改动：
- 去除 `padding: 4px`
- 去除 `border: 0`（保留 box-sizing: border-box）
- scrollbar 改为 overlay 模式：

```scss
:host > .content {
    margin: 0;
    padding: 0;
    border: 0;
    box-sizing: border-box;
}

:host ::ng-deep .xterm {
    overflow: hidden !important;
}
:host ::ng-deep .xterm-viewport {
    overflow-y: overlay !important;   // scrollbar 不占布局空间
    scrollbar-width: thin;
}
:host ::ng-deep .xterm-viewport::-webkit-scrollbar {
    width: 6px;
}
:host ::ng-deep .xterm-viewport::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.2);
    border-radius: 3px;
}
```

**影响**: 每个 pane 的 xterm 区域现在完全填满容器，像素 = cols × cell，无 padding 偏移。

---

### Step 1.2: 简化 `tmuxPaneTab.component.ts` 中的 `setTmuxGrid`

**文件**: `src/components/tmuxPaneTab.component.ts`

改动：
- `setTmuxGrid` 和 `applyTmuxGrid` 保持不变（它们只设置字符网格）
- 移除前端 fitAddon monkey-patch 注释中关于 scrollbar 的过时说明

无需大改——overlay scrollbar 意味着 `xterm.resize(cols, rows)` 的 canvas 正好填满容器宽度，无需额外补偿。

---

## Phase 2: 像素绝对定位 — 替换 SplitTab 百分比布局

### Step 2.1: 新增 `applyPixelLayout()` 方法

**文件**: `src/components/tmuxSessionTab.component.ts`

新增方法，替代 `buildSplitContainerFromLayout()` + `layoutInternal()` 的百分比递归：

```ts
/**
 * Position each pane using tmux's absolute character coordinates × cell pixel size.
 * This is a flat calculation — no ratio nesting, no percentage rounding.
 */
private applyPixelLayout(layoutTree: TmuxLayoutNode): void {
    const cell = this.getCellSize()
    if (!cell) return

    const paneMap = this.windowPaneTabs.get(this.activeWindowId!)
    if (!paneMap) return

    for (const pane of flattenLayout(layoutTree)) {
        const paneTab = paneMap.get(pane.paneId) as any
        if (!paneTab) continue

        // Set pixel position from tmux char coords
        const viewRef = (this as any).viewRefs?.get(paneTab)
        if (viewRef) {
            const el = viewRef.rootNodes[0] as HTMLElement
            el.style.left   = `${pane.x * cell.width}px`
            el.style.top    = `${pane.y * cell.height}px`
            el.style.width  = `${pane.width * cell.width}px`
            el.style.height = `${pane.height * cell.height}px`
        }

        // Set xterm character grid (same values, in cells)
        if (paneTab.setTmuxGrid) {
            paneTab.setTmuxGrid(pane.width, pane.height)
        }
    }
}
```

### Step 2.2: 修改 `syncLayout()` — 使用 `applyPixelLayout` 替代 `buildSplitContainerFromLayout` + `this.root` + `this.layout()`

**文件**: `src/components/tmuxSessionTab.component.ts` 中的 `syncLayout()` 方法

当前代码末尾：
```ts
const newRoot = this.buildSplitContainerFromLayout(layoutTree)
if (newRoot instanceof SplitContainer) {
    this.root = newRoot
    this.layout()
} else if (newRoot) { ... }
this.cdr.detectChanges()
this.applyLayoutGrids(layoutTree)
```

替换为：
```ts
this.applyPixelLayout(layoutTree)
this.cdr.detectChanges()
```

- 不再修改 `this.root`（SplitContainer 树用于 focus 管理，不用于布局）
- 不再调用 `this.layout()`（layoutInternal 百分比定位）
- `applyPixelLayout()` 同时处理定位和字符网格

### Step 2.3: 修改 `switchToWindow()` — 移除 SplitContainer 树重建

**文件**: `src/components/tmuxSessionTab.component.ts` 中的 `switchToWindow()`

当前步骤 4 中：
```ts
this.root = new SplitContainer()
this.root.orientation = 'h'
// ... addTab for each pane ...
// ... syncLayout ...
```

改为：
- 仍然用 `addTab()` 注册 pane 的 ViewContainerRef（创建 DOM 元素）
- 但不再重建 `this.root` 的树结构
- `syncLayout()` 内部的 `applyPixelLayout()` 会直接定位

### Step 2.4: 删除 `buildSplitContainerFromLayout()` 方法

**文件**: `src/components/tmuxSessionTab.component.ts`

这个方法不再需要。移除整个方法。

### Step 2.5: 删除 `applyLayoutGrids()` 方法

已被 `applyPixelLayout()` 中的 `setTmuxGrid` 调用替代。

---

## Phase 3: 独立 Divider 元素 — 替换 pane border

### Step 3.1: 在 `tmuxSessionTab.component.ts` 中新增 divider 生成逻辑

**文件**: `src/components/tmuxSessionTab.component.ts`

新增方法 `updateDividers()`：

```ts
/**
 * Generate divider <div> elements for adjacent pane boundaries.
 * Called after applyPixelLayout() positions the panes.
 */
private updateDividers(layoutTree: TmuxLayoutNode): void {
    // 1. Remove old divider elements
    const host = this.hostElement.nativeElement as HTMLElement
    const paneArea = host.querySelector('.pane-area') as HTMLElement
    paneArea.querySelectorAll('.tmux-divider').forEach(el => el.remove())

    // 2. Get cell size
    const cell = this.getCellSize()
    if (!cell) return

    // 3. Walk the layout tree to find parent-child boundaries
    // For each container node (horizontal/vertical), the boundary between
    // consecutive children is a divider line
    this.collectDividers(layoutTree, cell, paneArea)
}
```

`collectDividers()` 递归遍历树：
- 对 `horizontal` 节点：每对相邻 children 之间有垂直分隔线（right edge of left child == left edge of right child）
- 对 `vertical` 节点：每对相邻 children 之间有水平分隔线（bottom edge of top child == top edge of bottom child）
- 每条分隔线创建一个 `<div class="tmux-divider">` 元素

### Step 3.2: Divider CSS 和交互

**文件**: `src/components/tmuxSessionTab.component.ts` 的 styles

```css
::ng-deep .tmux-divider {
    position: absolute;
    z-index: 5;
    background: rgba(128,128,128,0.3);
    transition: background 0.15s;
}
::ng-deep .tmux-divider.vertical {   /* 水平线，上下分割 */
    height: 1px;
    cursor: row-resize;
}
::ng-deep .tmux-divider.horizontal { /* 垂直线，左右分割 */
    width: 1px;
    cursor: col-resize;
}
::ng-deep .tmux-divider:hover {
    background: rgba(128,128,128,0.75);
}
```

### Step 3.3: Divider 拖拽 resize

将当前的 `attachPaneAreaBorderHandlers()` 中的 mousedown 拖拽逻辑迁移到 divider 元素上：
- `mousedown` on `.tmux-divider` → 记录起始位置和被分割的两个 pane
- `mousemove` → 计算 delta cells，发送 `resize-pane` 命令
- `mouseup` → 结束

比当前方案更简洁：不需要 hit-test 遍历所有 pane，divider 本身就是精确的拖拽目标。

### Step 3.4: 删除旧的 border 相关代码

**文件**: `src/components/tmuxSessionTab.component.ts`

删除/移除：
- CSS: `::ng-deep .pane-area > .child` 中的 `border-right`, `border-bottom`
- CSS: `::ng-deep .pane-area > .child::after`, `::before` (scrollbar hit-target hack)
- CSS: `.border-hover-right`, `.border-hover-bottom`
- JS: `attachPaneAreaBorderHandlers()` 方法（被 divider 交互替代）
- JS: `findPaneIdForElement()` 方法（divider 直接关联 pane ID）
- JS: `_paneAreaMouseMoveHandler`, `_paneAreaMouseDownHandler`

---

## Phase 4: 简化 `measureClientSize()`

### Step 4.1: 重写 `measureClientSize()`

**文件**: `src/components/tmuxSessionTab.component.ts`

当前方法需要猜测 pane 数量来补偿 padding + scrollbar。新实现：

```ts
private measureClientSize(): { cols: number; rows: number } | null {
    const host = this.hostElement.nativeElement as HTMLElement
    const paneArea = host.querySelector('.pane-area') ?? host
    const rect = paneArea.getBoundingClientRect()
    if (rect.width < 10 || rect.height < 10) return null

    const cell = this.getCellSize()
    if (!cell) return null

    // Pure pixel-to-cell conversion. No padding, no scrollbar, no divider
    // compensation — pane containers are exactly cols×cell pixels, scrollbar
    // is overlay, dividers are 1px overlay elements.
    return {
        cols: Math.max(2, Math.floor(rect.width / cell.width)),
        rows: Math.max(1, Math.floor(rect.height / cell.height)),
    }
}
```

- 去除 `paneCount` 计算
- 去除 `spannerPx`, `totalPadPx` 补偿
- 去除 `numDividers` 补偿
- 纯粹的 `rect / cell`，零近似

---

## Phase 5: Attach 时序 — 先推尺寸再做 pane 发现

### 问题

tmux 在 attach 时用的是**上一次断开时的 client size**，但 Tabby 窗口可能完全不同。在 `refresh-client -C` 发出之前，tmux 的 layout 和 Tabby 窗口尺寸是不匹配的：

| 场景 | tmux 认为 | Tabby 实际 |
|------|----------|-----------|
| 上次 200×50，这次窗口更大 | 200×50 的 layout | 可能 250×60 |
| 上次 200×50，这次窗口更小 | 200×50 的 layout | 可能 160×40 |

当前时序中 `scheduleRefreshClientSize()` 在 pane 发现和布局同步**之后**才执行，导致第一帧的 layout 坐标与 Tabby 窗口不匹配。

### Step 5.1: 修改 `ngAfterViewInit` 启动顺序

**文件**: `src/components/tmuxSessionTab.component.ts`

**核心原则：先告诉 tmux "我的尺寸是什么"，再问 tmux "你的 layout 是什么"。**

修改 `requestAnimationFrame` 回调中的顺序：

```ts
async ngAfterViewInit(): Promise<void> {
    await super.ngAfterViewInit()
    if (!this.controller) return

    requestAnimationFrame(async () => {
        this._initialized = true

        // ── Step A: 推送客户端尺寸 FIRST ──
        // tmux 可能以旧的 client size 启动（上次断开时的尺寸）。
        // 在做任何 pane 发现之前，先告诉 tmux 我们的实际尺寸。
        // tmux 会重新布局并发送 %layout-change，携带正确的坐标。
        this.refreshClientSize()           // 无 debounce，立即执行
        await this.eventQueue              // 等 tmux 的 %layout-change 到达

        // ── Step B: pane 发现和布局同步（基于正确的尺寸）──
        await this.controller!.refreshPanes()
        this.bootstrapFromControllerState()
        await this.eventQueue

        const activeWindowId = this.controller!.getActiveWindowId()
        const targetWindowId = (activeWindowId !== null && this.windowPaneTabs.has(activeWindowId))
            ? activeWindowId
            : this.controller!.getFirstWindowId()
        if (targetWindowId !== undefined) {
            await this.switchToWindow(targetWindowId)
        }

        // ── Step C: ResizeObserver + 后续逻辑（不变）──
        this._resizeHandler = () => this.scheduleRefreshClientSize()
        window.addEventListener('resize', this._resizeHandler)

        const host = this.hostElement.nativeElement as HTMLElement
        const paneArea = host.querySelector('.pane-area')
        if (paneArea && typeof ResizeObserver !== 'undefined') {
            this._paneAreaObserver = new ResizeObserver(() => this.scheduleRefreshClientSize())
            this._paneAreaObserver.observe(paneArea)
        }

        this.updateDividers(/* layoutTree from last syncLayout */)
    })
}
```

### 时序保证

```
refresh-client -C 250,60
  → tmux relayout → %layout-change (layout 基于 250×60)
  → eventQueue 等待完成
  → refreshPanes() 发现 pane（layout 已经正确）
  → syncLayout() → applyPixelLayout()（坐标精确）
```

### 边界情况

| 情况 | 处理 |
|------|------|
| xterm 还没渲染，cell size 不可用 | `refreshClientSize()` 返回 null → `scheduleRefreshClientSize()` 延迟重试；`requestAnimationFrame` 已等一帧，通常可用；ResizeObserver 在首次渲染后兜底 |
| tmux 的 %layout-change 在 refreshPanes 之前到达 | `eventQueue` 确保串行处理，不会丢失事件 |
| tmux 旧 layout 的 pane 字符数 ≠ 新 layout | 旧 layout 仅用于 `capture-pane` 获取历史（不关心精度）；新 layout 用于 `applyPixelLayout()`（精确） |

---

## Phase 6: 移除 window bar 折叠功能

### Step 6.1: 确认并移除相关代码

经检查，window bar 当前没有展开/折叠功能（只有 close button 的 hover visibility）。确认 `tmuxWindowBar.component.ts` 中没有折叠逻辑，无需修改。

如果后续需要添加折叠功能，应确保：
- 折叠/展开触发 `.pane-area` 的 ResizeObserver
- 不需要在 `measureClientSize()` 中特殊处理

---

## Relevant Files

- `src/components/tmuxSessionTab.component.ts` — 主要改动：布局、divider、measureClientSize
- `src/components/tmuxSessionTab.component.ts` (styles) — CSS 改造
- `src/components/tmuxPaneTab.component.scss` — padding/scrollbar 改造
- `src/components/tmuxPaneTab.component.ts` — setTmuxGrid 微调
- `src/components/tmuxWindowBar.component.ts` — 确认无需改动
- `src/layoutParser.ts` — 已有 `flattenLayout()` 返回绝对坐标，无需改动

## Verification

1. **构建**: `pnpm run build` 无报错
2. **视觉**: 单 pane、双 pane (h-split)、三 pane (嵌套 split) 布局正确，无间隙
3. **精度**: xterm 字符换行位置与 tmux 原生一致
4. **Resize**: 拖拽 divider 改变 pane 大小，与 tmux 同步
5. **Scroll**: overlay scrollbar 可见且不占空间
6. **窗口 resize**: 浏览器窗口大小改变后 pane 自适应
7. **Attach 尺寸**: 不同大小的 Tabby 窗口 attach 同一个 tmux session，第一帧布局就正确

## Decisions

- 使用 `overflow-y: overlay` 而非 `hidden`，保留鼠标滚轮历史回看能力
- Divider 为 1px 宽度/高度的独立 DOM 元素，非 pseudo-element
- 不再维护 SplitContainer 树做布局，仅用于 focus 管理（如仍需要）
- 移除 window bar 折叠功能（当前本就不存在）
- Divider 拖拽直接绑定在 divider 元素上，不需要全局 hit-test
