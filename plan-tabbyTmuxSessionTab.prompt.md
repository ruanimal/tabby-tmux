# Plan: Tabby Tab 内嵌套 Tmux Window/Pane 管理

## TL;DR

将 tmux 集成从 **"每个 tmux window = 一个 Tabby tab"** 改为 **"单个 Tabby tab 内嵌套管理所有 tmux window 和 pane"**。底部放置可折叠的 window tab 栏，所有 pane 通过隐藏/显示切换（保留状态），支持多个 tmux session 并存，完全替换旧的 `TmuxWindowTabComponent`。

### 当前 vs 新设计

```
当前:
Tabby Tab 栏:
├── [TmuxWindowTab: win-0] → SplitTab(pane0, pane1, pane2)
├── [TmuxWindowTab: win-1] → SplitTab(pane3)
└── [TmuxWindowTab: win-2] → SplitTab(pane4, pane5)

新设计:
Tabby Tab 栏:
└── [TmuxSessionTab: session "dev"]
    ├── SplitTab 区域 (所有 pane 存在，隐藏非活跃的)
    │   └── 显示 win-0: pane0 | pane1
    └── 底部 [win-0 ●] [win-1] [win-2] [+] [⏏] [▼折叠]
```

---

## 当前架构分析

### 组件层次

```
TmuxWindowTabComponent (SplitTab)
├── TmuxPaneTabComponent (BaseTerminalTab) × N
│   └── TmuxPaneSession (BaseSession)
└── 状态栏 (session name, pane count)

TmuxController (session.ts)
├── paneSessions: Map<paneId, TmuxPaneSession>
├── windowStates: Map<windowId, WindowState>
├── events: Subject (pane-add, window-add, layout-change...)
└── TmuxGateway (gateway.ts)
    └── PTY 输出 → 行解析 → 协议事件
```

### 数据流

```
用户输入 → TmuxPaneTab → TmuxPaneSession.feedFromTerminal()
  → controller.writeToPane(paneId, data)
  → gateway.sendKeys(hex, paneId) → PTY → tmux

tmux 输出 → PTY → controller.handleLine()
  → gateway.executeLine() → 解析协议
  → %output → paneSession.emitOutput()
  → %layout-change → controller → event → TabComponent.syncLayout()
```

### 协议关键点

- `%output %<pane-id> <escaped>` — 面板输出（八进制转义）
- `%layout-change @<window-id> <layout>` — 布局变化
- `%window-add @<id>` / `%window-close @<id>` — 窗口增减
- `%session-changed $<id> <name>` — 会话变更
- `send-keys -t %<pane-id> -H <hex>` — 十六进制发送按键
- `capture-pane -ep -S- -t %<id>` — 恢复历史

### 布局解析 (layoutParser.ts)

tmux layout 格式: `"41e9,279x71,0,0[279x40,0,0,71,{...}]"`

- `[...]` = 水平分割, `{...}` = 垂直分割
- 每个 pane 有 `(width)x(height),(x),(y),(paneId)`
- 转换为 SplitTab 的 SplitContainer 格式用于 UI 渲染

### TmuxService (tmux.service.ts)

- `connectToSession(name)` → spawn PTY → 创建 TmuxController → 监听事件
- `attachToTerminal(tab)` → 从现有终端附加
- `disconnect()` → 清理所有 session
- 每个 SessionContext: controller + pty + windowTabs + subscriptions

### 注册入口 (index.ts)

- `ProfileProvider` → `TmuxProfileProvider` → 提供 `tmux:default` profile
- `CommandProvider` → `TmuxCommandProvider` → 工具栏 Tmux 按钮
- `TabContextMenuItemProvider` → `TmuxContextMenuProvider` → 右键菜单

---

## 核心组件

### 1. TmuxSessionTabComponent (新建，替换 TmuxWindowTabComponent)

- 继承 `SplitTabComponent`
- 底部集成可折叠的 tmux window tab 栏
- 管理所有 tmux window 的隐藏/显示切换（保留状态）
- 支持多个 tmux session（每个 session 一个 tab）
- 提供断开连接按钮

### 2. TmuxWindowBarComponent (新建)

- 独立的 Angular 组件
- 显示 tmux window 列表
- 支持折叠/展开
- 支持新建 window、切换 window、断开连接
- 显示当前 window 信息（pane 数量等）

### 3. TmuxPaneTabComponent (保留)

- 单个 tmux pane 的终端显示
- 添加 `active` 属性控制显示/隐藏

### 4. TmuxService (重构)

- 管理多个 tmux session 连接
- 提供全局断开/重连功能
- 与右键菜单集成

---

## 实现步骤

### Phase 1: 创建 TmuxWindowBarComponent

**新建文件**: `src/components/tmuxWindowBar.component.ts`

底部可折叠的 tmux window 栏组件：

功能：
- 横向显示所有 tmux window 按钮，当前活跃的高亮
- 每个按钮显示 window 名称 + pane 数量
- `+` 按钮创建新 window
- `⏏` 断开 tmux session
- `▼/▲` 折叠/展开按钮
- 右键单个 window 按钮显示上下文菜单（重命名、关闭等）

数据绑定：
- `@Input() controller: TmuxController` — tmux 控制器
- `@Input() activeWindowId: number` — 当前活跃 window id
- `@Output() windowSwitch: EventEmitter<number>` — 切换 window
- `@Output() disconnect: EventEmitter<void>` — 断开
- `@Output() createWindow: EventEmitter<void>` — 新建 window
- `@Output() collapsed: EventEmitter<boolean>` — 折叠状态变化

监听 `controller.events` 更新 window 列表（`window-add`, `window-close`, `window-renamed`）。

---

### Phase 2: 创建 TmuxSessionTabComponent

**新建文件**: `src/components/tmuxSessionTab.component.ts`

**删除文件**: `src/components/tmuxWindowTab.component.ts`（完全替换）

继承 `SplitTabComponent`，一个 tab 管理一个 tmux session 的所有 window。

#### 核心数据结构

```typescript
private windowPaneTabs: Map<number, Map<number, TmuxPaneTabComponent>>
                                 ↑ windowId    ↑ paneId
private activeWindowId: number | null
```

每个 window 的每个 pane 都有对应的 `TmuxPaneTabComponent` 实例。非活跃 window 的 pane 通过 `removeTab()` 从 SplitContainer 树和 DOM 中移除，但 **tab 对象保持存活**（session 连接不断、scrollback 保留）。切换回来时通过 `addTab()` 重新挂载，零重建开销。

> 这是 Tabby 原生的子 tab 管理方式 — `removeTab()` 只移除 DOM 视图，tab 对象本身可通过 `addTab()` 恢复。`addTab()` 是 public 方法，内部会调用 private 的 `attachTabView()` 并正确维护 SplitContainer 树。

#### 关键方法

**switchToWindow(windowId)**：
1. 遍历当前活跃 window 的 pane tabs，调用 `this.removeTab(paneTab)` 从 SplitTab 中移除（保留 tab 对象）
2. 更新 `activeWindowId`
3. 重置 `this.root = new SplitContainer()`
4. 如果目标 window 的 pane 还没创建，调 `addPanesForWindow(windowId)`
5. 否则遍历目标 window 的 pane tabs，依次调用 `this.addTab(paneTab, prevPane, 'r')` 重新挂载到 SplitTab
6. 同步 layout：调用 `syncLayout()` 将 SplitTab 布局调整为目标 window 的 tmux layout
7. 发送 `refresh-client -C <width>x<height>` 刷新 tmux 客户端尺寸

```typescript
async switchToWindow(windowId: number) {
    // 1. 移除当前活跃 window 的 pane（保留 tab 对象）
    if (this.activeWindowId !== null) {
        const paneMap = this.windowPaneTabs.get(this.activeWindowId)
        if (paneMap) {
            for (const paneTab of paneMap.values()) {
                paneTab.emitVisibility(false)
                this.removeTab(paneTab)
            }
        }
    }

    // 2. 切换
    this.activeWindowId = windowId
    const paneMap = this.windowPaneTabs.get(windowId)

    if (!paneMap || paneMap.size === 0) {
        // 首次访问：创建 pane tab
        await this.addPanesForWindow(windowId)
    } else {
        // 已有 pane：重新挂载到 SplitTab
        // 重建 SplitContainer 树
        this.root = new SplitContainer()
        this.root.orientation = 'h'
        let firstPane: TmuxPaneTabComponent | null = null
        for (const paneTab of paneMap.values()) {
            await this.addTab(paneTab, firstPane, firstPane ? 'r' : 'r')
            paneTab.emitVisibility(true)
            if (!firstPane) firstPane = paneTab
        }
        // 同步 tmux layout
        const layout = this.controller?.getWindowState(windowId)?.layout
        if (layout) this.syncLayout(layout)
    }

    // 3. 刷新 tmux 客户端尺寸
    this.refreshClientSize()
}
```

> **注意**：`attachTabView()` 是 SplitTab 的 **private** 方法，无法直接调用。使用 `addTab()` 代替，它内部会调用 `attachTabView()` 并正确维护 SplitContainer 树。切换时先重置 `this.root` 再依次添加 pane，让 `addTab()` 自动构建正确的分屏布局。

**addPanesForWindow(windowId)**：
1. 调用 `controller.getWindowPanes(windowId)` 获取 paneId 列表
2. 对每个 paneId 创建 `TmuxPaneTabComponent` 实例并调用 `setSession()`
3. 注册到 `windowPaneTabs` map
4. 如果是活跃 window：调用 `addTab()` 挂载到 SplitTab 并同步 layout
5. 否则：不挂载 DOM，仅保持 tab 对象存活（等切换时再挂载）

**syncLayout(layoutStr)**：
1. 使用现有 `layoutParser.ts` 解析 tmux layout 字符串
2. 转换为 SplitTab 的 split 格式
3. 重新组织 SplitTab 的子 tab 布局

**handleControllerEvent(event)**：
- `pane-add`：如果属于活跃 window → 实时添加到 SplitTab；否则只记录
- `pane-close`：销毁对应 pane tab，从 map 中移除
- `layout-change`：如果涉及活跃 window → 重新 syncLayout
- `window-add`：创建新的 pane tab 集（但不显示）
- `window-close`：销毁该 window 的所有 pane tab；如果关闭的是活跃 window → 切换到下一个

#### 模板

```html
<!-- SplitTab 内容区 -->
<ng-container #vc></ng-container>
<split-tab-spanner .../>
<split-tab-drop-zone .../>
<split-tab-pane-label .../>

<!-- 底部 window 栏 -->
<tmux-window-bar
    [controller]="controller"
    [activeWindowId]="activeWindowId"
    [collapsed]="windowBarCollapsed"
    (windowSwitch)="switchToWindow($event)"
    (disconnect)="onDisconnect()"
    (createWindow)="onCreateWindow()"
    (collapsed)="onToggleCollapse($event)"
/>
```

#### 样式

`:host` 使用 `display: flex; flex-direction: column;`，SplitTab 内容区 `flex: 1 1 auto`，底部栏 `flex: 0 0 auto`。

---

### Phase 3: 重构 TmuxService

**修改文件**: `src/services/tmux.service.ts`

#### 变更

1. **SessionContext 结构调整**：
   ```typescript
   interface SessionContext {
       controller: TmuxController
       pty?: PTYProxy
       sessionTab?: TmuxSessionTabComponent  // 替代 windowTabs map
       subscriptions: Subscription[]
   }
   ```

2. **connectToSession()**：
   - 启动 PTY 后只创建一个 `TmuxSessionTabComponent`
   - 移除原来 `openWindowTab()` 中为每个 window 打开 tab 的逻辑

3. **attachToTerminal(tab)**：
   - 从现有终端标签附加到 tmux
   - 保持不变

4. **disconnect()**：保持不变

5. **移除 openWindowTab()**：不再需要

6. **setupControllerEvents()**：
   - 移除 `window-add` / `window-close` 的 tab 打开/关闭逻辑
   - 这些现在由 `TmuxSessionTabComponent` 自己处理（通过 `removeTab`/`attachTabView` 管理 pane 的挂载状态）

---

### Phase 4: 更新右键菜单

**修改文件**: `src/tabContextMenu.ts`

增加更多 tmux 相关菜单项：

```
未连接终端右键：
  └── "进入 Tmux 模式" → attachToTerminal

已连接时的 TmuxSessionTab 右键：
  ├── "断开 Tmux"
  ├── "新建 Tmux 窗口"
  ├── "切换 Tmux 窗口" → 弹出 window 选择器
  └── "折叠/展开 Window 栏"
```

---

### Phase 5: 更新模块注册和配置

**修改文件**: `src/index.ts`

- declarations: 移除 `TmuxWindowTabComponent`，添加 `TmuxSessionTabComponent` + `TmuxWindowBarComponent`
- entryComponents: `TmuxSessionTabComponent` 替换 `TmuxWindowTabComponent`

**修改文件**: `src/profiles.ts`

- `getNewTabParameters()` 改为返回 `TmuxSessionTabComponent` 类型

**修改文件**: `src/buttonProvider.ts`

- 更新命令，打开 `TmuxSessionTabComponent`

---

### Phase 6: 清理旧代码

**完全删除**：
- `src/components/tmuxWindowTab.component.ts` — 整个文件 (~400 行)，被 TmuxSessionTabComponent 替代

**TmuxService 中删除的代码**：
- `SessionContext.windowTabs` Map
- `setupControllerEvents()` 中 `window-add` / `window-close` 处理逻辑
- `openWindowTab()` 整个方法
- `disconnectContext()` 中 `windowTabs` 遍历清理逻辑

**保留不变**：
- `src/session.ts` — `windowStates`、`getWindowPanes()`、`createWindow()`、事件系统全部需要
- `src/components/tmuxPaneTab.component.ts` — 直接复用
- `src/gateway.ts` — 协议层不变
- `src/layoutParser.ts` — `syncLayout()` 仍需要
- `src/buttonProvider.ts` — 调用链不变

---

## 关键实现细节

### Pane 隐藏/显示机制

采用 **方案 B：removeTab / addTab**，与 Tabby 原生 SplitTab 的子 tab 管理方式完全一致。

**原理**：
- `SplitTab.removeTab(tab)` — 从 SplitContainer 树和 DOM 中移除子 tab，但 **tab 对象本身存活**（session 连接、scrollback、光标状态全部保留）
- `SplitTab.addTab(tab, relative, side)` — 内部调用 `attachTabView()` 将 tab 重新插入 DOM，并正确维护 SplitContainer 树
- `tab.emitVisibility(true/false)` — 通知 tab 可见性变化，触发正确的生命周期事件

**切换 window 的操作序列**：
1. `removeTab()` 移除所有当前 pane → SplitContainer 树清空
2. 重置 `this.root = new SplitContainer()`
3. 依次 `addTab(paneTab, prevPane, 'r')` 重建布局
4. `syncLayout()` 按 tmux layout 调整 SplitContainer 树的 ratios 和 orientation

**优势**：
- 与 Tabby 原生设计一致，不引入 hack
- `addTab()` 是 **public** 方法，无需访问 private `attachTabView()`
- 非活跃 pane 完全不参与 SplitTab 布局计算（`layoutInternal()` 只遍历 SplitContainer 中的 children）
- tab 对象存活 → 零重建开销 → 切换延迟极低
- 窗口大小同步自然解决：只有活跃 window 的 pane 在布局中

### 多 Session 管理

每个 `TmuxSessionTabComponent` 独立管理自己的 session。`TmuxService` 维护 `sessions: Set<SessionContext>` 支持多个 session 并存。

### 窗口大小同步

当切换 window 时，调用 `refreshClientSize()` 重新发送 `refresh-client -C <width>x<height>` 给 tmux，确保 tmux 服务器知道当前客户端的终端尺寸。

---

## 验证方案

1. **基本连接**：点击 Tmux 按钮 → 创建 session tab → 底部显示 window 栏
2. **Window 切换**：点击底部 window → 内容切换（无延迟）→ 布局正确
3. **隐藏显示**：切换到 win-1 再切回 win-0 → win-0 的 pane 状态保留（scrollback、光标位置）
4. **实时 pane 添加**：在 tmux 中 split → 新 pane 实时出现在活跃 window
5. **断开连接**：点击断开 → 所有 pane 清理 → tab 可正常关闭
6. **多 Session**：连接两个不同 session → 各自独立管理
7. **折叠底部栏**：点击折叠按钮 → 栏收起 → 再点展开
8. **右键菜单**：右键终端 → 显示 tmux 相关选项

---

## 相关文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/components/tmuxSessionTab.component.ts` | 新建 | 核心 session tab 组件 |
| `src/components/tmuxWindowBar.component.ts` | 新建 | 底部 window 栏组件 |
| `src/components/tmuxWindowTab.component.ts` | 删除 | 被 TmuxSessionTab 替代 |
| `src/components/tmuxPaneTab.component.ts` | 保留不变 | 直接复用 |
| `src/services/tmux.service.ts` | 重构 | 删除 ~80 行，修改 ~25 行 |
| `src/tabContextMenu.ts` | 保留不变 | 后续可扩展菜单项 |
| `src/profiles.ts` | 小改 | 返回类型改为 TmuxSessionTabComponent |
| `src/buttonProvider.ts` | 保留不变 | 调用链自动处理 |
| `src/index.ts` | 小改 | 替换 declarations/entryComponents |
| `src/session.ts` | 保留不变 | 全部保留 |
| `src/gateway.ts` | 保留不变 | 协议层不变 |
| `src/layoutParser.ts` | 保留不变 | syncLayout 仍需要 |

## Scope 边界

**包含**：
- 底部可折叠 window tab 栏
- Pane 隐藏/显示切换（保留状态）
- 多 session 支持
- 右键菜单集成
- 断开/重连功能
- 完全替换旧组件

**不含（未来工作）**：
- Tabby 内 tmux pane 间的拖拽重排
- tmux session dashboard 视图
- 流控制（pause-after）
