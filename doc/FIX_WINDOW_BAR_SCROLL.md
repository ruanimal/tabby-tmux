# window bar 横向滚动（单行 + 固定新建/退出按钮）

## 问题描述

tmux window 数量变多以后，底部 window bar 会「换行」：bar 变成两行、pane 区域被挤占，
窗口 tab 被压得很窄，而且「新建 window（+）」按钮跑到滚动区末尾看不见了。

## 根因

不是 `flex-wrap: wrap`（模板里从来没写过，Tabby 全局样式里也没有）。真正原因是
`.window-tabs` 用 `overflow-x: auto` 做横向滚动，但没有处理**原生滚动条**：

1. **滚动条吃掉了 bar 的第二行**：`.window-bar` 的 `min-height: 28px` 是按 tab 高度
   （22px + padding）定的，一旦出现横向滚动条（Chromium 下约 13～15px），bar 实际高度
   变成 ~42px，看上去就是「多了一行」。用无头 Chromium 复现（12 个 window，480px 宽）：

   | 指标                     | 修复前 | 修复后 |
   | ------------------------ | ------ | ------ |
   | window bar 高度          | 42px   | 29px   |
   | tab 行数                 | 1      | 1      |
   | `+` 按钮在 bar 可见范围内 | 否     | 是     |
   | 退出按钮可见             | 是     | 是     |
   | tab 实际宽度             | 72px（被压到 min-width，长名字溢出到相邻 tab） | 内容宽度（72/76/80/173） |

2. **「新建 window」按钮在滚动区里面**：`.window-tab.add-btn` 是 `.window-tabs` 的最后一个
   flex item，只要窗口多到需要滚动，它就被滚出视口（上表的 `+` 不可见），用户必须先把
   strip 滚到底才能新建 window。
3. **tab 会被压缩**：`.window-tab` 是默认的 `flex-shrink: 1`，长窗口名的 tab 被压到
   `min-width: 72px`，`white-space: nowrap` 的文字直接溢出到相邻 tab 上。

## 方案

把 bar 明确拆成「可滚动的 window 列表」+「列表外固定的按钮」：
`.window-tabs` 只装 window tab，`+` 与退出按钮都在它外面，滚动只发生在列表内部。

1. **单行、不换行**：`.window-bar` / `.window-tabs` 显式 `flex-wrap: nowrap`，bar 用
   `overflow: hidden`，滚动全部交给 `.window-tabs`（`overflow-x: auto; overflow-y: hidden`）。
2. **tab 不再收缩**：`.window-tab { flex: 0 0 auto }`，宽度由内容决定，溢出靠滚动而不是压缩。
3. **隐藏原生滚动条**（`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`），
   保持 bar 高度恒定（29px），不再挤占 pane 区域。
4. **两个按钮都在滚动区之外，但位置保持原样**：
   - `+` 紧跟在 `.window-tabs` **之后**（不再是 strip 内的 flex item）。strip 改成
     `flex: 0 1 auto`：窗口少时按内容宽度收缩，`+` 就停在最后一个 tab 右边——和原来一样；
     窗口多时 strip 让出空间并自己滚动，`+` 被顶到 strip 右缘，永远可见（不会再被滚走）。
   - 退出按钮用 `.bar-actions { margin-left: auto }` 钉在 bar 最右端。
   - 实测（480px 宽 / 3 个 window）：`+` 的横坐标 230px，与改动前完全一致。
5. **补齐滚动的可用性**：
   - 滚轮（含 Shift+滚轮）在 strip 上转成横向滚动；已经滚到两端时不 `preventDefault`，
     把事件交回终端/上层，避免吞掉滚轮；
   - 切换 window、新增/关闭/重命名 window 后自动把 active tab 滚入视口
     （`revealActiveWindow()`）；无关的刷新不会把用户手动滚走的 strip 拽回去；
   - 两端用渐隐（`.can-scroll-left` / `.can-scroll-right`）提示还有窗口在视口外，
     替代被隐藏的滚动条。

滚动相关的计算（夹取、边界提示、滚轮换算、把某项滚入视口的偏移）抽到
`src/windowBarScroll.ts` 的纯函数里，组件只负责读写 DOM。

## 验证

- 单元测试：`src/windowBarScroll.spec.ts`（17 个用例）、
  `src/components/tmuxWindowBar.component.spec.ts`（20 个用例，含模板/CSS 契约测试：
  两个按钮都必须位于 `.window-tabs` 之外、`+` 必须紧跟在 strip 之后、bar 与 strip 必须
  `flex-wrap: nowrap`、strip 必须 `flex: 0 1 auto`、tab 必须 `flex: 0 0 auto`、
  退出按钮必须 `margin-left: auto`、原生滚动条必须隐藏）。
- 布局实测：无头 Chromium 渲染真实模板 + 样式（抽出 `styles`/`template` 后套静态数据），
  覆盖 1 / 3 / 8 / 12 / 20 / 40 个 window、300~1440px 宽度，断言：
  单行、bar 高度恒定 29px、`+` 与退出按钮始终在 bar 可见范围内、active tab 可见、
  strip 可横向滚动、tab 不被压缩；并对比改动前后 `+` 的横坐标一致（少窗口场景）。
