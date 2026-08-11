# Pane / Window 激活状态修复总结

## 问题描述

1. **断开重新连接后**没有激活正确的 pane/window
2. **通过 tab 栏切换 window** 时，pane 的激活状态错误（切走再切回后，激活的 pane 变成另一个）
3. **反复切换时结果不稳定**（激活 pane 在多个 pane 之间抖动，日志中出现 `%1 → %9 → %1 → %1` 的连环 `active-pane-changed`）

错误的激活状态不只是视觉问题：`TmuxPaneTabComponent._tmuxActive` 守卫热键输入
（Ctrl+C、粘贴等），激活错 pane 会把热键发到错误的 tmux pane，杀死其他 window 里
正在运行的命令。

## 架构分析：window 与 pane 的激活状态必须分开维护

tmux 协议本身就是分层建模的，插件代码却把 pane 激活当成了"会话级单一状态"：

| 状态 | 层级 | tmux 通知 | 应存放的位置 |
|---|---|---|---|
| active window | 会话级（单一值） | `%session-window-changed` / `#{window_active}` | `TmuxController.activeWindowId` |
| active pane | **window 级（每个 window 一个）** | `%window-pane-changed @w %p` / `#{pane_active}` | `Map<windowId, paneId>` |

`%window-pane-changed` 通知自带 windowId，本身是 window 级状态。切换 window 时，
该 window 自己的 active pane 是独立状态，需要单独记录并在切换时恢复。

## 根本原因（四层叠加）

### 1. Controller 没有按 window 记录 active pane

- `list-panes -s -F "#{pane_id} #{window_id}"` 没有取 `#{pane_active}`，**重连后
  active pane 状态从未从 tmux 恢复**
- `%window-pane-changed` 订阅只转发事件，不保存状态
- UI 侧 `handleActivePaneChanged` 用 `if (windowId !== this.activeWindowId) return`
  把**非当前 window** 的 pane 激活事件直接丢弃 → 切回该 window 时不知道激活哪个 pane

### 2. emitFocused() 挂载循环抢走 xterm DOM 焦点

`BaseTerminalTabComponent` 订阅了 `focused$`（tabby-terminal
`baseTerminalTab.component.ts`）：

```typescript
this.focused$.subscribe(() => {
    this.configure()
    this.frontend?.focus()   // ← 每个 pane 收到 emitFocused() 都会抢 DOM 焦点
})
```

`switchToWindow` / `syncLayout` 的挂载循环对**所有** display pane 调用
`emitFocused()` → **DOM 焦点（键盘输入入口）最后落在循环末尾的 pane**，而
`_tmuxActive`（热键路由守卫）指向 tmux 的 active pane → 键盘输入进错误 pane 且被
`sendInput` 守卫丢弃。

### 3. tabby 基类 onAfterTabAdded() 异步抢走 focusedTab

tabby-core `splitTab.component.ts`：

```typescript
private onAfterTabAdded (tab: BaseTabComponent) {
    setImmediate(() => {
        this.layout()
        this.tabAdded.next(tab)
        this.focus(tab)   // ← 每次 addTab() 后异步 focus 该 pane
    })
}
```

挂载循环对每个 pane 调 `addTab()` → 每个都排一个 `setImmediate(focus)` → **最后一个
addTab 的 pane 在挂载循环结束后异步抢走 `focusedTab`**，覆盖 restore 的结果。

### 4. select-pane 反馈循环 + 切换并发

上一轮修复让 `focus()` 在焦点变化时发 `select-pane` 同步 tmux，但**内部恢复路径
也会触发**，形成反馈循环：

```
restore → focus(%1) → select-pane %1
onAfterTabAdded → focus(%9) → select-pane %9
tmux 回 %window-pane-changed %9 → handleActivePaneChanged → focus(%9) changed=true
  → select-pane %9 → tmux 再回通知 ...（抖动）
```

同时 `window bar` 的 `switchToWindow` 是模板直接调用（**不进事件队列**），与队列里
排队的 `layout-change → syncLayout`、`active-pane-changed` 事件**并发交错**，焦点
恢复互相覆盖。

## 解决方案

### 修改 1: Controller 按 window 维护 active pane（src/session.ts）

```typescript
/** Window-level active pane: each window has its own active pane. */
private windowActivePanes = new Map<number, number>()
```

- `list-panes` 命令加 `#{pane_active}`，**重连 / refreshPanes 时恢复**每个 window 的
  active pane：
  ```typescript
  const paneResult = await this.gateway.sendCommand(
      'list-panes -s -F "#{pane_id} #{window_id} #{pane_active}"',
      TMUX_COMMAND_TOLERATE_ERRORS
  )
  // 解析时：match[3] === '1' → this.windowActivePanes.set(windowId, paneId)
  ```
- `%window-pane-changed` 订阅更新 map（不再只转发）
- pane/window 关闭、layout 清理时同步删除过期记录
- 新增 API：`getActivePaneId(windowId): number | null`

### 修改 2: 挂载后恢复 active pane（tmuxSessionTab.component.ts）

提取 `restoreActivePaneFocus(windowId, paneTabs, displayPanes)`：
- 优先取 `controller.getActivePaneId(windowId)` 对应的 pane
- 记录缺失时按 **tmux 布局顺序**（`flattenLayout`，非 paneMap 插入序）回退
- **包在 `setImmediate` 里执行**，排在 `onAfterTabAdded` 的异步 focus 之后运行，
  最终 `focusedTab` 稳定为 tmux 的 active pane

在 `switchToWindow` 与 `syncLayout` 的挂载循环之后都调用。

### 修改 3: 切换入队串行化

新增 `enqueueSwitchToWindow(windowId)`，所有外部切换入口
（window bar 点击、ngAfterViewInit 初始切换、创建新 window）统一走事件队列：

```typescript
enqueueSwitchToWindow(windowId: number): void {
    this.eventQueue = this.eventQueue
        .then(() => this.switchToWindow(windowId))
        .catch(err => this.logger.warn('switchToWindow failed:', err))
}
```

消除 `switchToWindow` 与事件队列的并发交错。

### 修改 4: select-pane 只响应真实用户点击

`focus()` 加 `syncToTmux` 参数，**只有用户点击路径传 true**：

```typescript
override focus(tab: any, syncToTmux = false): void {
    ...
    if (syncToTmux && changed && this.controller && tab instanceof TmuxPaneTabComponent) {
        this.controller.gateway.sendCommand(`select-pane -t %${tab.paneId}`, ...)
    }
}

/** 用户点击 pane → 同步 tmux（与 mouse 模式解耦） */
focusPaneFromUserClick(paneTab: TmuxPaneTabComponent): void {
    this.focus(paneTab, true)
}
```

内部恢复路径（`restoreActivePaneFocus` / `handleActivePaneChanged` /
`ensureVisiblePaneFocused` / 基类 `onAfterTabAdded` 的异步 focus）全部走默认
`false`——只更新 UI 焦点，**不回写 tmux**，从源头切断反馈循环。

`TmuxPaneTabComponent` 增加用户点击入口：

```typescript
@HostListener('click')
onHostClick(): void {
    const sessionTab = this.parent as any
    sessionTab?.focusPaneFromUserClick?.(this)
}
```

UI 点击 pane 时显式 `select-pane` 同步 tmux，不再依赖 tmux mouse 模式
（mouse off 时 tmux 也能感知点击，后续 layout 同步不会把焦点"纠正"回去）。

## 修改的文件

1. **src/session.ts**：
   - 新增 `windowActivePanes: Map<number, number>`（window 级 active pane 状态）
   - `list-panes` 加 `#{pane_active}` 字段并在解析时恢复记录
   - `%window-pane-changed`、pane/window close、layout 清理时维护 map
   - 新增 `getActivePaneId(windowId)` API

2. **src/components/tmuxSessionTab.component.ts**：
   - 新增 `restoreActivePaneFocus()`（setImmediate 延迟 + 布局序回退），
     `switchToWindow` 与 `syncLayout` 挂载后调用
   - 新增 `enqueueSwitchToWindow()`，window bar / ngAfterViewInit / createWindow
     切换统一入队
   - `focus(tab, syncToTmux = false)`：select-pane 仅用户点击发送
   - `handleActivePaneChanged`：未挂载 pane 跳过 focus（状态已由 controller 记录）
   - 新增 `focusPaneFromUserClick()`

3. **src/components/tmuxPaneTab.component.ts**：
   - 新增 `@HostListener('click') onHostClick()` → `focusPaneFromUserClick`

## 测试验证

- `tsc --noEmit` 编译通过
- tmux 3.5a 控制模式实测（临时探针脚本，已清理）：
  - `select-pane` 到同一 pane：**零通知**
  - `select-pane` 到同 window 其他 pane：仅一条 `%window-pane-changed`
  - `select-pane` 到其他 window 的 pane：**不切 current window**，只发 pane-changed
  - `select-window -t @N`：发 `%session-window-changed`
  - `refresh-client -C`：不重发 pane 通知
- 用户实机验证：
  - 断开重连后激活正确的 pane/window
  - tab 栏反复切换 window，激活稳定在 tmux 的 active pane
  - 点击 pane 后切走再切回，激活保持点击的 pane

## 经验教训

1. **激活状态按 tmux 协议分层建模**：window 级状态（每个 window 的 active pane）
   不能塞进会话级单一值，否则切换时必然丢失
2. **框架的隐式行为也要纳入排查**：`emitFocused() → frontend.focus()`（DOM 焦点）
   和 `onAfterTabAdded() → setImmediate(focus)` 都是 tabby 基类的异步副作用，
   覆盖挂载循环后的同步恢复结果——恢复逻辑必须排在它们之后
3. **回写 tmux 的命令只能由真实用户意图触发**：内部状态恢复路径发 `select-pane`
   会形成 `select-pane → %window-pane-changed → focus → select-pane` 反馈循环；
   用"来源参数"（syncToTmux）而不是"changed 守卫"来区分
4. **异步 UI 操作必须串行化**：直接调用 async 的 `switchToWindow` 与事件队列
   并发，竞态导致焦点恢复互相覆盖
