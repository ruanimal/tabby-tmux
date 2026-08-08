# Design: 为什么不用"每个 tmux window 一个 Tabby 原生 tab"

> 本文档记录 tabby-tmux 架构上一个关键决策的完整来龙去脉：**为什么 tmux window 不映射为 Tabby 顶层原生 tab，而是用一个 TmuxSessionTab 承载整个会话、window 切换自绘**。
>
> 面向对象：本项目未来的维护者（含 agent）。当有人提议"改成 iTerm2 式原生 tab"时，先读本文。

## TL;DR

iTerm2 将每个 tmux window 映射为终端的一个原生 tab，体验直观。tabby-tmux 曾尝试过同款方案（commit `7677ed2`），约 1 小时后重构推翻（commit `6b847e3`），改为：

- **Tabby 顶层 tab = 一个 tmux 会话**（`TmuxSessionTabComponent`）
- **tmux window = 会话内部状态**，通过 `removeTab()/addTab()` 隐藏/显示 pane tab 组来切换
- window 切换 UI 自绘（底部 `TmuxWindowBarComponent`）

根本原因：**tmux 控制模式下 tmux 是状态与布局的唯一权威，Tabby 顶层 tab 的模型（激活/重排/关闭/生命周期）与 tmux window 语义冲突，强行映射需要双向状态同步，复杂度集中在最容易出竞态的同步层。** 自绘方案把复杂度移到了插件自己可控的鼠标适配层，且复刻了 tmux 普通模式用户已有的心智模型。

另有一个**平台层面的补充原因**（见下文"为什么没走 iTerm2 完整形态"）：Electron 无法像 iTerm2（macOS 原生应用）那样实现对应用窗口的精确控制，iTerm2 式"tmux 集成独占一个原生窗口 + 原生窗口级 tab 操作"的形态在 Tabby 上根本不具备可行性。

## 问题陈述

tmux 会话由多个 window、每个 window 由多个 pane 组成。插件需要把 tmux 的层次结构呈现在 Tabby UI 中，核心问题是：

**tmux window 应该映射为 Tabby 的什么？**

- 方案 A（iTerm2 式）：每个 tmux window = 一个 Tabby 顶层 tab（继承 `SplitTabComponent`）
- 方案 B（当前实现）：整个会话 = 一个 Tabby 顶层 tab；window 是会话内部状态，用底部自绘 window bar 切换

## 方案对比

| 维度 | A：window = 原生 tab | B：session = 原生 tab（当前） |
|---|---|---|
| 顶层 tab 数量 | 每 window 一个 | 每会话一个 |
| window 切换 UI | Tabby 顶部 tab 栏 | 自绘底部 window bar |
| 状态权威 | 双份（Tabby tab 状态 + tmux window 状态），需同步 | 单一（tmux），Tabby 侧只有"当前显示哪个 window"投影 |
| 用户心智 | 需同时维护两套 tab 语义 | 复刻 tmux 普通模式（视口 = 当前 window） |
| 鼠标体验 | 原生（可拖拽/重排/关闭 tab） | 自绘（window bar 点击切换，代价见下） |
| 恢复/退出 | 每个 window tab 都要参与 recovery | 只处理一个 session tab |

## 决策历史（git 证据）

1. `7677ed2 feat: 每个 tmux window 一个 split Tab (not done)` — 实现方案 A，新增 `src/components/tmuxWindowTab.component.ts`（304 行），提交信息自带 "(not done)"
2. `6b847e3 feat: 重构实现方式`（约 1 小时 14 分钟后）— 删除 `tmuxWindowTab.component.ts`，新增 `TmuxSessionTabComponent`（498 行）+ `TmuxWindowBarComponent`（200 行），即方案 B

即：**方案 A 被实际实现过、验证过，然后快速止损**。这不是没有考虑过原生方案，而是实测后否决。

## 为什么选 B

### 1. 工程：双向状态同步是最大风险源

控制模式下 tmux 主动推送一切状态变化（`%window-add`、`%window-close`、`%session-window-changed`、`%layout-change`），UI 必须被动跟随；用户操作 UI 又要回写 tmux。这是天然双向流。

- 方案 B：tmux 是唯一权威，单向流动。即便这样，session tab **内部**的事件处理仍需 promise 链串行化（`eventQueue`）防 `switchToWindow`/`syncLayout` 交错竞态，并 override `removeTab()` 防空 root 自毁（`tmuxSessionTab.component.ts:609`）。
- 方案 A：Tabby 顶层 tab 的激活/拖拽重排/随手关闭是第二套独立状态，在 tmux 里**没有对应语义**（拖拽重排 = `swap-window`？随手关 tab = `kill-window`？），每条都要定义映射与反悔逻辑。同一 session 内部的竞态问题会在顶层 tab 层面放大，且多一层双向同步。

### 2. 工程：Tabby SplitTab 的布局能力在此场景下无用武之地

Tabby 顶层 `SplitTabComponent` 的核心价值是 ratio 布局、spanner 拖拽、drop-zone 拖放。而 tmux 是布局权威，插件只用它做挂载点：

> `tmuxSessionTab.component.ts:22-24`：Layout is pixel-absolute: pane positions are computed from tmux's character coordinates × cell pixel size, NOT from SplitTab's ratio-based percentage layout. The SplitContainer tree is only used by addTab()/removeTab() for ViewContainerRef management.

方案 A 中每个 window tab 内部照样要 pixel 定位，只是外面多套一层 Tabby tab 壳，壳自带的布局/拖拽能力全是负资产（早期 `tmuxWindowTab.component.ts` 里就带全套 spanner/drop-zone/pane-label UI）。

### 3. 工程：生命周期与恢复语义

- `SplitTabComponent` 默认"最后一个子 tab 移除即自毁"，而 window 切换时 root 清空是正常操作 → 必须 override（已做）。
- Tabby 有 tab recovery（`recoveryToken`）；tmux 会话本身持久化（`tmux -CC new -A`），Tabby 侧真正需要恢复的只有"进入 tmux 模式"这一个动作。B 方案下恢复/退出只处理一个对象；A 方案每个 window tab 都要参与，复杂度翻倍。

### 4. UX：tab 层级语义清晰

B 方案形成清晰的层级：**Tabby tab = 会话，window bar = 会话内窗口**。鼠标用户不会混淆"我在切 tmux 窗口"和"我在切 Tabby 标签"。iTerm2 能用原生 tab 是因为其 tab 层级恰好等于 window 层级；Tabby 的 tab 层级不等于（Tabby tab 可以任意拆分/嵌套/重排），映射必然错位。

### 5. 目标用户：理解成本最低

项目目标用户是"想要 tmux 能力（会话持久化/多路复用）、但习惯鼠标 GUI 交互"的人。方案 B 在三个层面复刻了 tmux 普通模式的心智模型：

- **视觉**：底部 window bar ≈ tmux 状态栏（window 列表 + 高亮当前项 + 新建/关闭）
- **布局**：消费同一套 layout 字符串，pane 位置/大小与普通模式完全一致
- **键盘**：`send-keys` 直通，`prefix+n/p/c/数字` 等 tmux 快捷键原样工作，肌肉记忆零迁移

方案 A 反而要求用户同时维护"Tabby 的 tab 语义"和"tmux 的 window 语义"两套模型，理解成本更高。

## B 的代价（诚实清单）

1. **鼠标适配层自绘**：普通模式下 tmux 自己处理鼠标（点状态栏、拖 pane 边界）；B 方案里这些全部要插件实现——divider 拖拽、右键菜单、window bar 点击、`emitVisibility(false)`、`removeTab` override，这是 B 方案全部的 hack 集中地。
2. **丢原生体验**：window 不能拖拽重排（tmux `swap-window`）、Tabby 顶部 tab 栏不显示 window 列表、多个 tmux 会话时顶层 tab 是"会话"级而非"窗口"级。
3. **热键冲突**：Tabby 全局快捷键与转发给 tmux 的输入竞争（git 历史 `8611a84 fix: stop detached panes from receiving hotkey input (Ctrl+C leaking to other windows)` 即此问题）。
4. **pane 边框识别度弱**：`b45afaf tmux 不要绘制 pane 分割线` 后 pane 边界是 hover 才高亮的 1px divider，对来自 GUI 终端的用户定位感偏弱。

## 结论

对"以插件身份跑在 Tabby 上、无权改 Tabby 本体"这一约束，方案 B 是正确且务实的选择——判断依据不是美学而是**单一状态源**：它把最容易出 bug 的双向同步整个砍掉，复杂度预算花在了用户不可见的鼠标适配层。

方案 A 只有在 Tabby 本体（或 fork）把 tmux window 当成一等公民支持时才真正成立，那已超出插件能力范围。

## 为什么没走 iTerm2 完整形态（平台约束）

iTerm2 的 tmux 集成形态与方案 A/B 都不是一回事，需要单独说明。iTerm2 官方文档（`ref/iterm2-tmux-integration.md`）确认的事实：

- `tmux -CC` 时**单独打开一个新 iTerm2 窗口**（"An iTerm2 window opens"），tmux window 作为该窗口内的 tab
- 该集成窗口是**专用**的：tab 不能混入非 tmux 的 split pane；所有 window 尺寸统一，受最小 attached client 限制
- window 数量多时 iTerm2 还专门做了 **tmux Dashboard** 概览面板补救

tabby-tmux 没有走这个形态，除了前文"为什么选 B"的理由外，还有一个**平台层面的原因**：

- iTerm2 是 macOS 原生应用，tmux 集成可以独占一个原生 NSWindow，tab 是原生窗口系统的一等公民（原生 tab 容器、原生窗口操作）。
- Tabby 基于 Electron：`BrowserWindow` 只是 OS 窗口的薄封装，tab 系统完全实现在 renderer 进程的 DOM 里（`tabs` 数组 + `SplitTab` 树），**没有原生窗口级 tab 容器**。
- 因此 iTerm2 式能力（如 tab 跨窗口移动、窗口级原生操作）在 Tabby 上需要自己实现：状态序列化 → 跨 `BrowserWindow` IPC → 目标窗口重建组件树 → 源窗口销毁实例，成本极高且手感达不到原生。Tabby 本身也没有多窗口 tab 架构。

**重要澄清**：该平台约束解释的是"为什么没做 iTerm2 完整形态"（独立窗口 + 原生窗口级 tab 操作），**不是**"为什么方案 A 失败"。方案 A 是"同窗口内 window → 顶层 tab"（`7677ed2` 实测），不涉及跨窗口移动，其失败原因仍是前文的双向同步、生命周期、SplitTab 布局冲突——即便 Electron 能精确控制窗口，这些问题依然存在。

另一点观察：iTerm2 开新窗口与其说是"精确控制窗口的能力"的展示，不如说是**产品隔离决策**——tmux 集成 UI 独占性强（尺寸受限、tab 专用），单独开窗避免污染用户主窗口布局。tmux Dashboard 的存在恰恰说明原生 tab 形态在 window 数量多时同样有 UI 债。

## 后续方向（在 B 框架内补齐 A 的体验）

- window bar 支持拖拽重排（发 `swap-window`）
- 支持 `prefix+n/p` 等 tmux 快捷键直接驱动切换（已天然可用，需验证 UI 高亮同步）
- Tabby profile/自动恢复集成（`tmux -CC new -A` 已保证 tmux 侧，Tabby 侧仍为手动入口）
- window 切换过渡动画
