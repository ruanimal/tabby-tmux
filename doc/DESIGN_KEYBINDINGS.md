# 快捷键设计:三层热键模型

> 本文档记录 tabby-tmux 快捷键系统的完整设计:热键分层、键位表、实现路径与设置入口决策。面向对象:本项目未来的维护者(含 agent)。

## TL;DR

- **Tabby 顶层热键保留**:`next-tab` / `close-tab` / 新建 tab 等继续作用于 Tabby tab,插件不碰
- **pane 层复用 Tabby 原生热键**:分屏 / pane 导航 / 缩放 / 关闭直接用 Tabby 内置动作(`split-right`、`pane-nav-*`、`pane-maximize` 等),键位由 **Tabby Settings → Hotkeys** 统一管理;`TmuxSessionTabComponent`(继承 `SplitTabComponent`)override 布局操作方法,把动作重路由为 tmux 命令
- **window 层插件专属**:切换 / 跳转 / 新建 / 退出 tmux window 注册为 `tmuxPlugin.*` 动作,默认键用 **Tabby 未占用组合键**,同样在 Tabby Settings → Hotkeys 配置
- **插件设置页不加快捷键表单**:避免与 Tabby Hotkeys 界面形成双入口

## 为什么是三层

tmux 集成把两个心智模型叠在一起:Tabby 的 tab/pane 模型与 tmux 的 window/pane 模型。热键冲突的根源是**同一按键在不同模型下的语义**:

| 层次 | Tabby 侧语义 | tmux 侧语义 | 冲突 |
|---|---|---|---|
| 顶层 tab | 切换/关闭 Tabby tab | (本项目)整个会话占一个 Tabby tab | window 切换无对应键 |
| pane | 分屏/导航/缩放/关闭 | tmux pane 分屏/导航/zoom/关闭 | **语义天然一致** |
| window | (无) | tmux window 切换/新建/关闭 | Tabby tab 键被顶层占用 |

- **pane 相关动作语义一致**,复用原生热键零学习成本、零冲突。
- **window 相关动作没有 Tabby 对应物**(Tabby 的 `next-tab`/`Alt+数字` 在 `appRoot.component.ts` 顶层处理 `app.activeTab`,SessionTab 无法拦截),必须用未占用组合键。

## 键位表

### 默认键位(window 层,可在 Tabby Settings → Hotkeys 修改)

| 动作 id | 默认键 | 说明 |
|---|---|---|
| `tmuxPlugin.previous-window` | `Ctrl-Shift-[` | 上一个 window,回写 tmux(`select-window`) |
| `tmuxPlugin.next-window` | `Ctrl-Shift-]` | 下一个 window |
| `tmuxPlugin.window-1..9` | `Ctrl-Shift-1..9` | 按 index 跳转 window |
| `tmuxPlugin.new-window` | `Ctrl-Shift-B` | 新建 window(`Ctrl-Shift-N` 被 Tabby 内置 `new-window` 占用,见下) |
| `tmuxPlugin.toggle-tmux-mode` | `Ctrl-Shift-X` | 切换 tmux mode：已连接则退出(detach)，未连接则从当前终端 tab 进入 |

关闭 window 不设默认键:window bar 的 × 按钮 / pane 右键菜单;`Ctrl-Shift-W` 保留给 Tabby `close-tab`。

### pane 层(复用 Tabby 默认,键位归属 Tabby)

| Tabby 动作 | 默认键(Linux) | tmux 重路由 |
|---|---|---|
| `split-right` | `Ctrl-Shift-S` | `split-window -h -t %id` |
| `split-bottom` | `Ctrl-Shift-D` | `split-window -v -t %id` |
| `pane-nav-left/right/up/down` | `Ctrl-Alt-←/→/↑/↓` | `select-pane -L/-R/-U/-D -t %id` |
| `pane-nav-previous/next` | `Ctrl-Alt-[` / `Ctrl-Alt-]` | `select-pane -t <按布局顺序相邻 pane>` |
| `pane-maximize` | `Ctrl-Alt-Enter`(macOS `⌘-⌥-Enter`) | 热键由 SessionTab **完全接管**(`handlePaneMaximizeHotkey`),直接 `resize-pane -Z -t %id`(toggle);`maximize()` override 为 no-op 防双触发 |
| `pane-increase/decrease-*` | (默认无键) | `resize-pane -L/-R/-U/-D -t %id <n>` |

### 与 Tabby 默认占用的冲突比对依据

- Linux 默认占用:`Ctrl-Tab`/`Ctrl-Shift-←→`(next/previous-tab)、`Alt-1..0`(tab-N)、`Ctrl-Shift-W/R/S/D/T/F/C/V/E/P`、`Ctrl-Alt-方向键/[/]/Enter/T`、`F11`、`Ctrl-Shift-,/.`
- macOS 默认占用:`⌘-W/R/数字`、`⌘-Shift-D/E/W`、`⌘-⌥-方向键/[/]/Enter`、`Ctrl-Tab`/`Ctrl-Shift-Tab`
- **tabby-electron 占用**(曾遗漏):`new-window` = `Ctrl-Shift-N`(Linux/Windows)/`⌘-N`(macOS)、`toggle-window` = `Ctrl-Space`;tabby-local `new-tab` = `Ctrl-Shift-T`;tabby-terminal `search` = `Ctrl-Shift-F` 等。**`Ctrl-Shift-N` 与内置 `new-window` 冲突,故 `tmuxPlugin.new-window` 默认用 `Ctrl-Shift-B`**
- 选用的 `Ctrl-Shift-[` / `Ctrl-Shift-]` / `Ctrl-Shift-1..9` / `Ctrl-Shift-B` / `Ctrl-Shift-X` 在所有平台默认均**未占用**

## 实现路径

### pane 层:override SplitTab 方法重路由

`SplitTabComponent` 构造函数订阅 `hotkeys.hotkey$`,调用的是**实例方法**(`splitTab` / `navigate` / `navigateLinear` / `navigateSpecific` / `maximize` / `resizePane`)。`TmuxSessionTabComponent` override 这些方法,把参数映射为 tmux 命令 flag(映射逻辑在 `src/tmuxKeymap.ts` 纯函数模块),经 `TmuxController` 发 `sendCommand`。只影响 tmux 会话实例,普通 SplitTab 不受影响。

**`pane-maximize` 例外——完全接管**:基类分支用 `getAllTabs().length > 1` 守卫,而 zoom 时非 zoomed pane 已从 SplitContainer 树 detach(`length === 1`),导致 exit zoom 死键。故 SessionTab 在构造函数里直接订阅 `hotkey$` 处理 `pane-maximize`(以 `getWindowPaneCount` 真实 pane 数守卫,单 pane window 不 zoom),`maximize()` override 为 no-op 防止基类分支双触发。

xterm 前端(`xtermFrontend.ts`)在 keydown 时对命中热键 `preventDefault` + `stopPropagation`,按键不会泄漏进 tmux。

### window 层:HotkeyProvider 注册

`TmuxHotkeyProvider` 的 `provide()` 返回 `tmuxPlugin.*` 动作描述;`config.ts` 的 `TmuxConfigProvider` 提供嵌套默认键位 `hotkeys.tmuxPlugin.*`。Tabby 的 `getHotkeysConfigRecursive` 原生支持嵌套,emit 的热键 id 为 `tmuxPlugin.xxx`。路由分两处:**window 切换/新建**由 `TmuxSessionTabComponent` 订阅 `hotkey$` 按 id 路由(需要会话存在);**`toggle-tmux-mode`** 由 `TmuxService` 全局订阅(进入方向在会话不存在时触发,必须全局可达):已连接 → `disconnect()`,未连接 → 从 `AppService.activeTab` 解析当前终端 tab 并 `attachToTerminal`。

## 设置表单决策

**插件设置页不加快捷键表单**。原因:

1. Tabby Settings → Hotkeys(`hotkeySettingsTab.component.ts`)遍历所有 `HotkeyProvider` 的 `getHotkeyDescriptions()`,`tmuxPlugin.*` 自动出现;改键走 Tabby 的 `setHotkeys`(单 stroke 存字符串、多 stroke 存数组)并自动 `config.save()`,天然持久化
2. 插件页若再放一份键位表单 = 双入口改同一 `config.store.hotkeys`,需要手动同步,重复且易错
3. pane 层键位本来就是 Tabby 动作,只能由 Tabby 界面管

插件设置页保持现状,只保留 tmux 集成独有的**非快捷键**配置:`defaultSessionName` / `commandTimeoutMs` / `sendKeysChunkSize` / `resizeDebounceMs` / `debugLogging` / `showWindowCloseButton`。

## 全局吞键副作用声明

Tabby 热键是全局的:新注册的 `tmuxPlugin.*` 组合键在**普通终端**(非 tmux 模式)按下时,xterm 前端 partial-match 命中同样会 `preventDefault`。所选默认键(`Ctrl-Shift-[` 等)在 shell 中本无有效输入含义,副作用可忽略;若用户自定义到有含义的键位,属用户自己的配置选择。

## 手动验证清单

- [ ] tmux 模式下按 `Ctrl-Shift-S` / `Ctrl-Shift-D` 触发 `split-window`,`%layout-change` 后 UI 出现新 pane
- [ ] tmux 模式下按 `Ctrl-Alt-方向键` 触发 `select-pane`,焦点在 pane 间移动
- [ ] tmux 模式下按 `Ctrl-Alt-Enter` 触发 `resize-pane -Z`(zoom in/out),zoom 指示器同步
- [ ] 按 `Ctrl-Shift-]` / `Ctrl-Shift-[` 切换 window,window bar 高亮更新且 tmux active window 同步(`%session-window-changed` 或 list-windows 验证)
- [ ] 按 `Ctrl-Shift-1..9` 跳转 window
- [ ] 按 `Ctrl-Shift-B` 新建 window
- [ ] 按 `Ctrl-Shift-X` 切换 tmux mode：tmux mode 中按下 → 退出并恢复原终端 tab;普通终端中按下 → 进入 tmux mode
- [ ] Tabby Settings → Hotkeys 出现 `tmuxPlugin.*` 条目,改键后新键生效
- [ ] 普通终端按 `Ctrl-Shift-[` 无输入泄漏(无字符进入 shell)
- [ ] 非 tmux 模式按 `Ctrl-Shift-W` 仍关闭 Tabby tab
