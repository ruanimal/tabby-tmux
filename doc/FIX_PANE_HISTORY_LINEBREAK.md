# Pane 历史输出换行问题修复

## 问题描述

打开 tmux pane 标签页时，历史输出的换行处理不正确，导致：
- 内容重复显示
- 换行位置错误
- 显示混乱（如图所示）

![问题截图](/Users/ruan/.gemini/antigravity/brain/0c551640-48f3-461c-aa9d-ba90314a67a2/uploaded_image_1767862239109.png)

## 根本原因

本问题有两个层面：

### 1. 强制换行问题（已通过 `-J` 选项解决）

终端中的长行会被自动换行以适应终端宽度。这些被强制换行的行在 tmux 内部是作为多行存储的。使用 `-J` 选项可以连接这些被强制换行的行。

### 2. **换行符格式问题**（核心问题）

`capture-pane` 输出使用 **Unix 风格的换行符** `\n`（Line Feed），但终端需要 `\r\n`（Carriage Return + Line Feed）才能正确显示：

- **`\n`** (Line Feed, 0x0A)：将光标向下移动一行，但**保持在当前列**
- **`\r`** (Carriage Return, 0x0D)：将光标移到**行首**

**问题表现**：
```
如果只使用 \n：
行1：Applications Desktop Library
     ↓ 只有 \n，光标下移但不回到行首
     Documents Movies（从上一行结束的位置开始）

正确使用 \r\n：
行1：Applications Desktop Library
     ↓ \r 回到行首，\n 下移一行
Documents Movies（从行首开始）
```

**实际效果**：
- ❌ 只有 `\n`：第二行从第一行结束的列位置开始显示，造成严重的显示错位
- ✅ 使用 `\r\n`：第二行从行首开始，显示正确

## 解决方案

### 步骤 1: 使用 `-J` 连接被强制换行的行

使用 `capture-pane -epJ -S-` 选项。

### 步骤 2: 将 `\n` 转换为 `\r\n`

在 JavaScript/TypeScript 中：
```typescript
const normalizedOutput = output.replace(/\n/g, '\r\n')
```

### 选项说明

| 选项 | 说明 |
|------|------|
| `-e` | 包含 ANSI 转义序列（escape sequences），保留颜色、粗体等样式 |
| `-p` | 输出到 stdout 而不是粘贴缓冲区 |
| `-J` | **连接被换行的行**（这是关键！） |
| `-S-` | 从历史记录的开始捕获（`-` 表示历史的起点） |

### 修改的代码

**文件**: `src/session.ts` - `TmuxController.restorePaneHistory()`

```typescript
// ❌ 修复前
const output = await this.gateway.sendCommand(
    `capture-pane -e -p -t %${paneId}`,  // 缺少 -J 和 -S-
    TMUX_COMMAND_TOLERATE_ERRORS
)
const buffer = Buffer.from(output, 'utf-8')  // 直接使用，未转换换行符
this.paneSessions.get(paneId)?.emitOutputToPane(buffer)

// ✅ 修复后
const output = await this.gateway.sendCommand(
    `capture-pane -epJ -S- -t %${paneId}`,  // 添加 -J 和 -S-
    TMUX_COMMAND_TOLERATE_ERRORS
)
// 关键：将 Unix 风格的 \n 转换为终端需要的 \r\n
const normalizedOutput = output.replace(/\n/g, '\r\n')
const buffer = Buffer.from(normalizedOutput, 'utf-8')
this.paneSessions.get(paneId)?.emitOutputToPane(buffer)
```

**变更**：
1. ✅ 添加了 `-J` 选项来连接被换行的行
2. ✅ 添加了 `-S-` 选项来捕获完整历史记录
3. ✅ **添加了换行符转换**：`output.replace(/\n/g, '\r\n')`

## tmux 文档参考

根据 tmux wiki（`ref/tmux.wiki/Advanced-Use.md` 第834行）：

```
A few additional flags control the format of the output:

* `-e` includes escape sequences for colour and attributes;
* `-C` escapes nonprintable characters as octal sequences;
* `-N` preserves trailing spaces at the end of lines;
* `-J` both preserves trailing spaces and joins any wrapped lines.
```

**`-J` 选项的作用**：
- 保留行尾的空格
- **连接任何被换行的行**

这确保了捕获的内容在新的终端中以正确的方式重新格式化，而不会保留旧的强制换行。

## iTerm2 的实现

参考 `ref/iTerm2-TmuxController.md` 第442-446行，iTerm2 使用：

```objc
NSString *command = [NSString stringWithFormat:
    @"capture-pane -peJ%@S- -t \"%d\"",
    alternate ? @"a" : @"",
    [wp intValue]];
```

**选项**：
- `-p`: stdout
- `-e`: escape sequences
- `-J`: join wrapped lines
- `-S-`: 从历史开始
- `-a` (可选): 捕获备用屏幕（alternate screen）

## 测试验证

### 预期行为

打开 tmux pane 标签页后：
- ✅ 历史输出换行正确
- ✅ 长行在终端宽度处自动换行
- ✅ 没有重复或错位的内容
- ✅ 颜色和样式保留（因为使用了 `-e`）

### 测试步骤

1. 重新构建插件：
   ```bash
   npm run build
   ```

2. 重启 Tabby

3. 打开包含长行输出的 tmux pane（如 `ls` 命令的输出）

4. 验证：
   - [ ] 内容显示正确，无重复
   - [ ] 换行位置合理
   - [ ] 颜色和格式保留

## 相关问题

### 为什么不使用 `-N` 选项？

`-N` 只保留行尾空格，不连接被换行的行。我们需要 `-J` 来处理换行问题。

### 为什么需要 `-S-`？

- `-S` 指定起始行号
- `-` 表示历史的开始
- 没有 `-S-` 时，只捕获可见内容，不包含滚动缓冲区

### 备用屏幕（Alternate Screen）？

一些程序（如 vim、less）使用备用屏幕。要捕获备用屏幕内容，需要添加 `-a` 选项：
```bash
capture-pane -epJ -a -S- -t %${paneId}
```

目前我们只捕获主屏幕，如果需要支持备用屏幕，可以参考 iTerm2 的实现：
- 调用两次 `capture-pane`，一次不带 `-a`，一次带 `-a`
- 根据当前是否在备用屏幕决定使用哪个

## 总结

通过添加 `-J` 选项，解决了历史输出的换行错位问题。这是一个简单但关键的修复，确保 tmux pane 的内容在 Tabby 中正确显示。

**核心原理**：让 tmux 在捕获时连接被强制换行的行，然后让终端自己根据当前宽度重新换行，而不是保留旧的换行位置。

## 后续更新（2026-08：历史恢复 normalize 链）

`\n → \r\n` 与 `-J` 仍然保留，但 `restorePaneHistory()` 现在在写入前做了一整套 normalize，解决三类历史错位：

1. **`gridApplied()` 等待**：`TmuxPaneSession.start()` 先等 pane 的 xterm 应用 tmux 布局列宽（首次 `setTmuxGrid → xterm.resize`）再恢复历史 —— 否则历史按 xterm 初始列宽（attach 时 fit 用 fallback 字体算的）写入，逻辑行被错误折行。
2. **折叠 zsh SIGWINCH 重绘残留**：窗口尺寸变化（split/resize/attach 的 refresh-client）时 zsh 重绘 prompt，会把一行 prompt 推进 tmux 历史（每次 +1）；`collapseRedundantTailLines()` 折叠末尾连续相同的行（保留 1 行）。
3. **删除历史部分/开头的全空格占位行 + pop 末尾伪影空行**：tmux 按窗口宽度存储历史，capture -S- 会输出宽于 pane 的占位行（写入 pane 宽度 xterm 时 wrap 膨胀行数、把屏幕内容下推）；按"最后 rows 行 = 屏幕"剔除历史部分的全空格占位行，并 pop capture 输出末尾换行产生的空元素。
