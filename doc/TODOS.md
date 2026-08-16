## Todo
- [ ] 缺少流控 (Pause Mode) 大量输出时卡顿/崩溃
- [x] pane 的布局实现需要优化，现在的实现方案 pane 尺寸不够稳定。可能会导致以下问题。
    - re-attach 后 pane 历史显示 trzsz 协议数据
    - 目前基于 pane 边框实现的拖动，效果不够好
- [ ] 隐藏 window 的处理
- [x] pane 关闭后光标焦点的处理, 应该是激活相邻的 pane 吧
- [x] window 关闭时, 也应该激活相邻的 window 吧, 参考浏览器 tab, 或者 tmux 的默认逻辑
- [x] 最大化 pane 的处理
- [x] zoom pane 的交互可能需要优化，没法分辨当前是否是 zoom 状态
- [x] tmux会话恢复的布局还是有点问题: 内容还是有些错位, 估计是尺寸还是有点问题
    - vim 的 hello 页面 会丢失, 和这个无关, vim 在终端此处变化后 hello 内容自然会丢.
- [x] focus all tmux panes 的实现可以优化，区分是 current window 还是所有 window（右键菜单改为 "Focus all tmux panes" 二级菜单，含 Current window / All windows 两个互斥范围项；范围状态提升到 controller 的 SyncScope）
- [x] 断开重新连接后没有激活正确的 pane/window; 同时通过tab栏切换window时, pane 的激活状态也有问题, window 和 pane 的激活状态是否要分开维护
- [x] 搜索终端内容（自研 session 级搜索面板替换内置 per-pane 面板：增量搜索/上下导航/正则/大小写/全词/结果计数，切换 pane 自动关闭并清理高亮）
- [x] 快捷键支持(三层热键模型,见 `doc/DESIGN_KEYBINDINGS.md`:pane 层复用 Tabby 原生热键 override 重路由;window 层 `tmuxPlugin.*` 注册为 Tabby 热键,默认键 `Ctrl-Shift-[`/`]`/`1..9`/`B`/`X`,设置入口统一在 Tabby Settings → Hotkeys)

## 更新记录（2026-08）

- [x] ~~attach 后总是激活最后一个 window~~：并非激活状态获取不到 —— `#{window_active}` 解析和初始恢复逻辑都正确（真实 tmux 数据实测 4 个场景），恢复的确实是 tmux 的 active window。根因是 **window bar 切换只改 UI、不回写 tmux**：Tabby 创建新 window 时 tmux 自动激活它（index 最大 = 最后一个），之后用户在 window bar 上的切换不会同步给 tmux，于是 tmux 的 active 一直停留在「最后创建的 window」，detach 后 attach 自然恢复它而不是用户最后看的那个。修复：window bar 点击切换时通过 `select-window -t @N` 回写 tmux（`enqueueSwitchToWindow(windowId, syncToTmux)`，仅用户路径传 true，内部恢复路径跟随 tmux 不回写）；`%session-window-changed` 只更新 controller 状态、SessionTab 无对应事件 case，无反馈循环。
- [x] ~~attach 时 window 顺序不稳定~~：windowStates 顺序不再依赖 Map 插入序，改为按 list-windows 的 `#{window_index}` 显式排序（`move-window`/`swap-window` 重排 index 不改变 window ID，运行时 `%window-add` 的到达顺序也与 index 无关）；`list-windows` 窗口名改用 `#{q:window_name}` 转义，避免名字含「空格+数字」（如 `foo 1`）时解析错位导致 index/active 字段错乱。同时修复 `TmuxPaneTabComponent._tmuxActive` 初始值 `true` 的 bug：所有 pane tab 的 hotkey$ 都会触发（hasFocus 全为 true），未挂载 pane（其他 window 的 pane、bootstrap 批量创建未显示的 pane）从未被 `focus()` 遍历到，保持 `true` 会把 Ctrl+C/粘贴误发到错误 window 的 tmux pane；初始值改为 `false`，挂载后由 `restoreActivePaneFocus`/`focus()` 设置。
- [x] ~~re-attach 后 pane 历史显示 trzsz 协议数据 / 布局尺寸不稳定~~：attach 时序重构后已解决 —— 首次 client size 由宿主 cell 提前推送、capture 由 `clientSizePushed` 守卫保护（Step B 补捕）、历史恢复做折叠/裁剪/pop/gridApplied 归一化、新建 pane 的 `%output` 缓冲到 grid 应用后。
- [x] ~~tmux 会话恢复的布局/内容错位（尺寸问题导致 vim hello 页丢失）~~：历史恢复列宽（gridApplied）、尺寸推送（hostCell 提前 + padding 剔除）、光标恢复（pane 实际高度 + lastNonEmpty）均已修复；vim 等 alternate screen 内容经 `pendingAltRestore` 在 resize 后重放。若仍有残余请复测并贴日志。
