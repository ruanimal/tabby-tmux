# Pane 滚动条支持（Overlay，不占布局空间）

## 问题描述

tmux pane 恢复历史后没有滚动条：无法拖拽、看不到滚动位置、不能点 track 翻页，
只能靠滚轮（且无任何位置指示）。

## 根因

`tmuxPaneTab.component.scss` 对 `.xterm-viewport` 设置了 `overflow-y: hidden !important`。
这是**有意为之**——pane 容器按 tmux 布局像素绝对定位（cols × cell，无 padding/border），
任何占用布局宽度的滚动条都会压缩 canvas 导致 wrap 与 tmux 错位，所以当初选择了彻底
隐藏滚动条来保证布局简单。代价是失去滚动条 UI。

> 注：SCSS 旧注释声称"xterm 6+ 才有独立 scrollbar 元素，5.4 下 viewport 即原生滚动条"，
> 这是对宿主 xterm 版本的误解；宿主 `tabby-terminal` 依赖的是 `@xterm/xterm: ^5.4.0`，
> 滚动条就长在 `.xterm-viewport`（原生 overflow scrollbar）上，被 `hidden` 直接干掉。

## 方案：自绘 Overlay 滚动条（xterm 5.4）

1. **恢复滚动能力，但隐藏原生滚动条**（不占空间）：

   ```scss
   .xterm-viewport {
       overflow-y: auto !important;
       scrollbar-width: none;                 /* Firefox */
   }
   .xterm-viewport::-webkit-scrollbar {
       display: none;                         /* Chromium / Electron */
   }
   ```

   滚动仍由 xterm 5.4 的原生 scrollTop 驱动（滚轮/键盘/PgUp 等），只是不再显示
   会占用布局宽度的系统滚动条。

2. **自绘 overlay 滚动条**（`TmuxPaneTabComponent.setupScrollbar()`）：
   - pane host 上 append 一个 `.tmux-pane-scrollbar`（absolute 右侧 8px，z-index 6，
     overlay 不参与布局，像素网格保持 tmux-exact）；
   - **样式必须用 `::ng-deep`**：元素是 `document.createElement` 动态创建的，没有
     Angular 的 `_ngcontent` 属性，emulated encapsulation 下的组件样式匹配不到
     （这是首版"滚动条没出现"的根因，与 `tmuxSessionTab` 的 `.tmux-divider` 同理）；
   - **不能依赖 `isConnected` 早退**：`frontendReady$` 触发时 pane host 可能尚未挂载
     进 DOM（组件创建早于 view 挂载），`if (!isConnected) return` 会导致滚动条静默
     缺失且无重试。在 detached host 上创建元素是合法的，挂载后由 scroll /
     ResizeObserver 接管尺寸；诊断日志走 `logger.info`（`custom overlay scrollbar
     created` / 降级原因）；
   - `.tmux-pane-scrollbar-thumb` 位置/高度由 JS 按
     `scrollTop / scrollHeight / clientHeight` 比例计算（最小高度 24px）；
   - 显隐策略：默认 `opacity: 0; pointer-events: none`（不拦截终端鼠标交互），
     滚动活动/hover 时显示，停止滚动 600ms 后淡出，拖动中不隐藏；
   - 交互：拖 thumb 设置 `viewport.scrollTop`；点 track 按比例跳转；
   - 同步：`viewport` 的 `scroll` 事件 + `ResizeObserver`（观察 `.xterm-screen` 与
     viewport，历史增长/网格 resize 时刷新）+ `applyTmuxGrid()` 末尾主动刷新；
   - 生命周期：`addEventListenerUntilDestroyed` 绑定事件，`ngOnDestroy` 里
     `disconnect()` ResizeObserver、移除 track 元素。

## xterm 版本兼容性（重要）

| xterm | 滚动模型 | 本插件滚动条 |
|-------|----------|--------------|
| 5.4（当前宿主） | `.xterm-viewport` 原生滚动容器，原生滚动条 | 自绘 overlay 滚动条接管 |
| 6+ | 虚拟滚动（VS Code `SmoothScrollableElement`），滚动条是独立元素 `.xterm-scrollable-element > .scrollbar`，本身即 overlay 不占空间 | `setupScrollbar()` 检测到 `.xterm-scrollable-element` 结构即跳过自绘，交给 xterm 自带滚动条 |

设计要点：**结构检测 + 优雅降级**。升级宿主 xterm 后无需改本插件代码，
滚动条自动由 xterm 6+ 自带 overlay 滚动条提供。

### 升级到 xterm 6+ 后的回归验证清单

- [ ] pane 历史滚动条自动出现，且 overlay 不占空间（wrap 与 tmux 一致，无错位）
- [ ] 滚轮/键盘滚动 pane 历史正常（xterm 6 虚拟滚动，滚轮经 `Scrollable` 驱动）
- [ ] 历史增长（`%output` 持续写入）时滚动条 thumb 比例正确
- [ ] 拖拽/点击自带滚动条交互正常（其颜色来自 themeService，确认 Tabby 侧已配置）
- [ ] `xterm.resize()` / `setTmuxGrid` 在 6+ 下行为正常（smooth scroll 相关回归）
- [ ] 插件对 `frontend.xterm` / fitAddon 的私有访问仍可用（Tabby 前端适配后）
