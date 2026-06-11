## Todo
- [ ] 缺少流控 (Pause Mode) 大量输出时卡顿/崩溃
- [x] pane 的布局实现需要优化，现在的实现方案 pane 尺寸不够稳定。可能会导致以下问题。
    - re-attach 后 pane 历史显示 trzsz 协议数据
    - 目前基于 pane 边框实现的拖动，效果不够好
- [ ] 隐藏 window 的处理
- [x] pane 关闭后光标焦点的处理, 应该是激活相邻的 pane 吧
- [x] window 关闭时, 也应该激活相邻的 window 吧, 参考浏览器 tab, 或者 tmux 的默认逻辑
- [x] 最大化 pane 的处理
