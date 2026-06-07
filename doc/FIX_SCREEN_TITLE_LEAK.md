# Fix: 命令输出异常 — zsh 标题序列泄漏

## 问题描述

在 zsh 环境下执行命令时，命令名会出现在输出前面：

```
# 执行时
~ ❯ echo 111
echo111

# 重新 attach 后
~ ❯ echo 111
111
```

不单是 `echo`，所有命令的第一个单词都会出现在输出前面。bash 和无配置的 zsh 不受影响。

## 根因分析

### 标题序列机制

zsh 的 `preexec` hook 会在执行命令前发送 **screen/tmux 风格的 "set window title" 转义序列**：

```
ESC k echo ESC \        （即 \033 kecho \033 \134）
 ESC   k  ...  ESC  \
 0x1b 0x6b       0x1b 0x5c
```

这个序列用于设置终端窗口标题（标题文本为命令名 `echo`）。

### 为什么 zsh 会发送这个序列？

zsh 的 `preexec` hook 通常检查 `$TERM` 来决定是否发送标题序列：

```zsh
case "$TERM" in
  screen*|tmux*)
    print -Pn "\ek${1:q:e}\\e\\" ;;
esac
```

| 场景 | `$TERM` | 发送 `ESC k`？ |
|------|---------|---------------|
| Tabby 原生终端 | `xterm-256color` | ❌ 不发送 |
| tmux 集成 | `tmux-256color` | ✅ 发送 |

### tmux 控制模式的行为

tmux 处理 `ESC k` 序列时：
1. 更新 pane 的标题（正常行为）
2. **同时**把序列原样转发给控制模式客户端（`%output`）

tmux **没有选项**能阻止这个转发。`set -g set-titles off` 控制的是 tmux 对外部终端的标题设置，不影响 `%output` 转发。

### xterm.js 的问题

xterm.js 的 VT100 解析器**不认识 `ESC k`**（它不在 VT100/VT220 的合法序列列表中）：

1. 遇到 `ESC` → 进入 escape 状态
2. `k` 无匹配 → 重置到 ground 状态
3. `k` 作为可见字符渲染
4. 之后 `\010`（backspace）把光标移回去
5. 带颜色的 `e` 覆盖了 `k` → 最终显示 `echo`

### iTerm2 为什么没问题？

iTerm2 的 `PTYSession` 原生实现了 `ESC k` 的处理逻辑，识别序列后设置窗口标题，不会把标题文本渲染为可见内容。

### 为什么重新 attach 后显示正确？

重新 attach 时，`capture-pane` 返回的屏幕缓冲区中，tmux 已经消费了标题序列，所以只包含纯输出内容。

## 修复方案

在 `TmuxPaneSession.feedOutput()` 中过滤 `ESC k ... ESC \` 序列，在数据到达 xterm.js 之前将其剥离。

### 关键实现细节

- **跨调用缓冲**：`ESC k` 序列可能跨越多次 `feedOutput` 调用的边界（TCP 分段），需要缓冲不完整的序列
- **尾部 ESC 缓冲**：如果 buffer 末尾是孤立的 `ESC`（0x1b），而下一次 `feedOutput` 以 `k`（0x6b）开头，需要正确缓冲等待配对
- **多序列支持**：单次 `feedOutput` 可能包含多个标题序列，循环处理

### 修改文件

- `src/session.ts` — `TmuxPaneSession` 类
  - 新增 `_pendingTitleSeq` 字段：跨调用缓冲
  - 重写 `feedOutput()`：调用过滤器后转发
  - 新增 `filterScreenTitleSequences()`：核心过滤逻辑
  - 修改 `destroy()`：清理缓冲

## 验证

```bash
# 在 tmux 集成中执行
~ ❯ echo 111
111              # 应该只显示 "111"，不带 "echo"

~ ❯ ls /tmp
/tmp/...         # 应该只显示输出，不带 "ls"
```
