## Plan: Tmux Mode 右键菜单调整

### TL;DR
进入 tmux mode 后，需要调整右键菜单行为：保留常用菜单项，调整 Tmux Mode 切换选项，处理 Focus all tabs 的广播逻辑，实现 tmux pane 的分割功能。

### 当前状态分析

**现有菜单提供者**：
- `TmuxContextMenuProvider` (`src/tabContextMenu.ts`) - 只提供 Enter/Exit Tmux Mode
- Tabby 原生菜单通过 `TabContextMenuItemProvider` 注入：
  - `CopyPasteContextMenu`: Copy, Paste
  - `MiscContextMenu`: Focus all tabs, Focus all panes
  - `SaveAsProfileContextMenu`: Save as profile
  - `TaskCompletionContextMenu`: Notify on activity
  - `NewTabContextMenu`: New terminal, New with profile
  - `TabManagementContextMenu`: Close, Split (在 SplitTab 中)
  - `ExportTerminalContextMenu`: Export to file

**关键发现**：
1. `TmuxPaneTabComponent` 继承 `BaseTerminalTabComponent`，会继承所有原生菜单
2. `TmuxSessionTabComponent` 继承 `SplitTabComponent`，支持 Split 操作
3. `TmuxController` 有 `gateway.sendCommand()` 可以发送 tmux 命令
4. tmux 分割命令：`split-window -h` (水平/左右), `split-window -v` (垂直/上下)

### 实现计划

#### Phase 1: 修改 TmuxContextMenuProvider

**文件**: `src/tabContextMenu.ts`

**改动**:
1. 检测 tab 类型：
   - `TmuxSessionTabComponent` → 显示 "Exit Tmux Mode"
   - `TmuxPaneTabComponent` → 显示 "Exit Tmux Mode"（同一 session）
   - `BaseTerminalTabComponent` → 显示 "Enter Tmux Mode"

2. 为 `TmuxPaneTabComponent` 添加分割菜单：
   ```typescript
   {
     label: 'Split',
     submenu: [
       { label: 'Right', click: () => splitPane('right') },
       { label: 'Down', click: () => splitPane('down') },
       { label: 'Left', click: () => splitPane('left') },
       { label: 'Up', click: () => splitPane('up') },
     ]
   }
   ```

3. 实现 `splitPane` 方法，通过 `controller.gateway.sendCommand()` 发送：
   - Right: `split-window -h -t %{paneId}`
   - Down: `split-window -v -t %{paneId}`
   - Left: `split-window -h -b -t %{paneId}`
   - Up: `split-window -v -b -t %{paneId}`

#### Phase 2: 处理 Focus all tabs

**方案**: 创建自定义 `TabContextMenuItemProvider` 覆盖原生 `MiscContextMenu` 的 "Focus all tabs" 行为

**实现**:
1. 在 `src/tabContextMenu.ts` 中添加新的 provider，weight 设置比 `MiscContextMenu` (weight=1) 更高
2. 检测 tab 类型：
   - `TmuxPaneTabComponent` → 显示 "Focus all tmux panes"，点击后只广播到当前 tmux session 的所有 pane
   - 其他 tab → 不干预，让原生行为生效
3. 实现广播逻辑：
   - 获取当前 `TmuxController`
   - 遍历所有 pane session
   - 触发 focus 事件

**技术细节**:
- 需要在 `TmuxPaneTabComponent` 中访问 `controller`
- 通过 `controller.getAllWindowStates()` 获取所有 window
- 通过 `controller.getWindowPanes(windowId)` 获取所有 pane
- 调用 `TmuxSessionTabComponent.switchToWindow()` 切换窗口

#### Phase 3: 过滤原生菜单项

**策略**: 创建自定义 `TabContextMenuItemProvider`，weight 设为 100（最高优先级），拦截并过滤原生菜单

**保留的菜单项**:
| 菜单 | 提供者 | 处理方式 |
|------|--------|----------|
| Copy | CopyPasteContextMenu | 保留 |
| Paste | CopyPasteContextMenu | 保留 |
| ~~Save as profile~~ | ~~SaveAsProfileContextMenu~~ | 移除 |
| Notify on activity | TaskCompletionContextMenu | 保留 |
| Export to file | ExportTerminalContextMenu | 保留 |
| ~~New terminal~~ | ~~NewTabContextMenu~~ | 移除 |
| ~~New with profile~~ | ~~NewTabContextMenu~~ | 移除 |
| Close | TabManagementContextMenu | **改为关闭当前 pane** |

**实现方式**:
- 不需要过滤原生菜单，因为原生菜单是通过 `buildContextMenu()` 动态组装的
- 需要在 `TmuxPaneTabComponent` 中 override `buildContextMenu()` 方法
- 或者通过 `handleRightMouseDown` 拦截右键事件，自定义弹出菜单

**Close pane 实现**:
- 调用 `controller.killPane(paneId)` 关闭 tmux pane
- 而不是 `app.closeTab(tab)` 关闭整个 tab

### 实现步骤

#### Step 1: 修改 `src/tabContextMenu.ts`

**导入**:
- `TmuxPaneTabComponent` from `./components/tmuxPaneTab.component`
- `TmuxSessionTabComponent` from `./components/tmuxSessionTab.component`

**修改 `TmuxContextMenuProvider.getItems()`**:
```typescript
async getItems(tab: BaseTabComponent, _tabHeader?: boolean): Promise<MenuItemOptions[]> {
    // TmuxSessionTab 或 TmuxPaneTab: 显示 Exit Tmux Mode + Split
    if (tab instanceof TmuxSessionTabComponent) {
        return [
            {
                label: 'Exit Tmux Mode',
                click: async () => {
                    await this.tmuxService.disconnect()
                },
            },
        ]
    }

    if (tab instanceof TmuxPaneTabComponent) {
        const items: MenuItemOptions[] = [
            {
                label: 'Exit Tmux Mode',
                click: async () => {
                    await this.tmuxService.disconnect()
                },
            },
            {
                label: 'Split',
                submenu: [
                    { label: 'Right', click: () => this.splitPane(tab, 'right') },
                    { label: 'Down', click: () => this.splitPane(tab, 'down') },
                    { label: 'Left', click: () => this.splitPane(tab, 'left') },
                    { label: 'Up', click: () => this.splitPane(tab, 'up') },
                ]
            },
        ]
        return items
    }

    // 普通终端 tab: 显示 Enter Tmux Mode
    if (tab instanceof BaseTerminalTabComponent) {
        return [
            {
                label: 'Enter Tmux Mode',
                click: async () => {
                    await this.tmuxService.attachToTerminal(tab as BaseTerminalTabComponent<any>)
                },
            },
        ]
    }

    return []
}

private async splitPane(paneTab: TmuxPaneTabComponent, direction: 'right' | 'down' | 'left' | 'up'): Promise<void> {
    const controller = paneTab.controller
    if (!controller) return

    const paneId = paneTab.paneId
    const flagMap = {
        'right': '-h',
        'down': '-v',
        'left': '-h -b',
        'up': '-v -b',
    }
    const flag = flagMap[direction]
    await controller.gateway.sendCommand(`split-window ${flag} -t %${paneId}`)
}
```

#### Step 2: 添加 Focus all tmux panes 菜单

**在 `src/tabContextMenu.ts` 中添加新 provider**:
```typescript
@Injectable()
export class TmuxFocusContextMenuProvider extends TabContextMenuItemProvider {
    weight = 2  // 比 MiscContextMenu (weight=1) 高

    constructor(
        private tmuxService: TmuxService,
    ) {
        super()
    }

    async getItems(tab: BaseTabComponent, _tabHeader?: boolean): Promise<MenuItemOptions[]> {
        if (tab instanceof TmuxPaneTabComponent) {
            return [
                {
                    label: 'Focus all tmux panes',
                    click: () => this.focusAllTmuxPanes(tab),
                },
            ]
        }
        return []
    }

    private async focusAllTmuxPanes(paneTab: TmuxPaneTabComponent): Promise<void> {
        const controller = paneTab.controller
        if (!controller) return

        // 获取当前 session tab
        const sessionTab = this.tmuxService.getCurrentSessionTab()
        if (!sessionTab) return

        // 遍历所有 window，切换到每个 pane
        for (const windowState of controller.getAllWindowStates()) {
            await sessionTab.switchToWindow(windowState.id)
            // 可以在这里添加焦点切换逻辑
        }
    }
}
```

**注册 provider** (在 `src/index.ts`):
```typescript
providers: [
    // ... existing providers
    { provide: TabContextMenuItemProvider, useClass: TmuxFocusContextMenuProvider, multi: true },
]
```

#### Step 3: 在 TmuxService 中添加辅助方法

**修改 `src/services/tmux.service.ts`**:
```typescript
getCurrentSessionTab(): TmuxSessionTabComponent | null {
    // 返回当前活跃的 TmuxSessionTab
    // 可以通过 app.activeTab 检测
    const activeTab = this.app.activeTab
    if (activeTab instanceof TmuxSessionTabComponent) {
        return activeTab
    }
    return null
}
```

### 验证

1. **普通终端 tab 右键** → 显示 "Enter Tmux Mode" + 原生菜单
2. **TmuxSessionTab 右键** → 显示 "Exit Tmux Mode" + 原生菜单
3. **TmuxPaneTab 右键** → 显示：
   - Exit Tmux Mode
   - Split > (Right, Down, Left, Up)
   - Focus all tmux panes
   - Copy, Paste (原生)
   - Notify on activity (原生)
   - Export to file (原生)
   - Close (关闭当前 pane，而非 tab)
4. **Split 操作** → tmux pane 正确分割，布局同步
5. **Focus all tmux panes** → 只在 tmux pane 间切换焦点
6. **Close pane** → 只关闭当前 tmux pane，不影响其他 pane

### 相关文件

- `src/tabContextMenu.ts` - 主要修改文件
- `src/components/tmuxPaneTab.component.ts` - 需要访问 controller 和 paneId
- `src/services/tmux.service.ts` - 添加 getCurrentSessionTab() 方法
- `src/index.ts` - 注册新的 provider
- `src/session.ts` - TmuxController 提供 gateway.sendCommand()
