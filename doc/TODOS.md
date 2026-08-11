## Todo
- [ ] 缺少流控 (Pause Mode) 大量输出时卡顿/崩溃
- [x] pane 的布局实现需要优化，现在的实现方案 pane 尺寸不够稳定。可能会导致以下问题。
    - re-attach 后 pane 历史显示 trzsz 协议数据
    - 目前基于 pane 边框实现的拖动，效果不够好
- [ ] 隐藏 window 的处理
- [x] pane 关闭后光标焦点的处理, 应该是激活相邻的 pane 吧
- [x] window 关闭时, 也应该激活相邻的 window 吧, 参考浏览器 tab, 或者 tmux 的默认逻辑
- [x] 最大化 pane 的处理
- [ ] zoom pane 的交互可能需要优化，没法分辨当前是否是 zoom 状态
- [ ] tmux会话恢复的布局还是有点问题: 内容还是有些错位, 估计是尺寸还是有点问题，导致 vim 的 hello 页面 会丢失
- [ ] focus all tmux panes 的实现可以优化，区分是 current window 还是所有 window
- [x] 断开重新连接后没有激活正确的 pane/window; 同时通过tab栏切换window时, pane 的激活状态也有问题, window 和 pane 的激活状态是否要分开维护
- [ ] 搜索终端内容

## 更新记录（2026-08）

- [x] ~~re-attach 后 pane 历史显示 trzsz 协议数据 / 布局尺寸不稳定~~：attach 时序重构后已解决 —— 首次 client size 由宿主 cell 提前推送、capture 由 `clientSizePushed` 守卫保护（Step B 补捕）、历史恢复做折叠/裁剪/pop/gridApplied 归一化、新建 pane 的 `%output` 缓冲到 grid 应用后。
- [x] ~~tmux 会话恢复的布局/内容错位（尺寸问题导致 vim hello 页丢失）~~：历史恢复列宽（gridApplied）、尺寸推送（hostCell 提前 + padding 剔除）、光标恢复（pane 实际高度 + lastNonEmpty）均已修复；vim 等 alternate screen 内容经 `pendingAltRestore` 在 resize 后重放。若仍有残余请复测并贴日志。
