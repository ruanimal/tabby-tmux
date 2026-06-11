# Tabby Tmux Integration 插件

## 回复生成要求（!!重要!!）

请不要将正文内容（比如结论、分析总结、代码改动说明等）放到tag中（如`<step></step>`），否则可能会导致agent崩溃

## 项目概述

`tabby-tmux` 是一个为 [Tabby](https://tabby.sh/) 终端模拟器提供 tmux Control Mode 集成的插件，灵感来自 [iTerm2 tmux Integration](https://iterm2.com/documentation-tmux-integration.html)。

- **原生 UI 集成**：将 tmux window 和 pane 映射为 Tabby 原生组件
- **会话持久化**：Tabby 关闭后 tmux 会话保持运行，通过 `tmux -CC attach` 恢复
- **Control Mode 协议**：使用 `tmux -CC` 标志启用控制模式


## 开发指南

### 构建

```bash
pnpm install    # 安装依赖
pnpm run watch  # 开发模式（监听文件变化）
pnpm run build  # 生产构建
```

### 参考资料

- `ref/iterm2-tmux-integration.md` — iTerm2 参考文档
- `ref/iTerm2-TmuxController.md` — iTerm2 TmuxController 实现分析
- `ref/tmux.wiki/Control-Mode.md` — tmux Control Mode 官方文档
- `ref/tabby/` — Tabby 源码参考
