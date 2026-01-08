# 修复高亮跨行问题

## 问题描述

恢复 tmux pane 历史记录后，某些高亮文本（如 `.V2rayU`）的背景色会跨越到下一行，甚至延伸到整行（如图所示）。

![高亮跨行问题 - 示例1](/Users/ruan/.gemini/antigravity/brain/0c551640-48f3-461c-aa9d-ba90314a67a2/uploaded_image_0_1767863729173.png)

![高亮跨行问题 - 示例2](/Users/ruan/.gemini/antigravity/brain/0c551640-48f3-461c-aa9d-ba90314a67a2/uploaded_image_1_1767863729173.png)

## 根本原因

问题出在 `capture-pane -J` 选项上：

### `-J` 选项的副作用

`-J`（joint wrapped lines）选项会连接被强制换行的行，但在处理过程中，**可能会破坏 ANSI 转义序列的完整性**：

1. **ANSI 转义序列**用于控制文本颜色、背景色、粗体等属性
2. 高亮通常通过设置背景色来实现（如 `\x1b[43m` 设置黄色背景）
3. 正常情况下，应该有对应的重置序列（如 `\x1b[0m` 重置所有属性）

**问题场景**：
```
原始输出（假设在80列宽终端）：
行1: drwxrwxrwx  7 ruan staff  224  8 15 14:34 \x1b[43m.V2rayU\x1b[0m
行2: drwxr-xr-x  9 ruan staff  288 11 12 14:58 .version-fox

因为行被强制换行，tmux 内部可能存储为：
行1a: drwxrwxrwx  7 ruan staff  224  8 15 14:34 \x1b[43m.V2rayU
行1b: \x1b[0m
行2:  drwxr-xr-x  9 ruan staff  288 11 12 14:58 .version-fox

使用 capture-pane -J 连接行时：
行1: drwxrwxrwx  7 ruan staff  224  8 15 14:34 \x1b[43m.V2rayU ❌ 丢失了 \x1b[0m
行2: drwxr-xr-x  9 ruan staff  288 11 12 14:58 .version-fox

结果：
黄色背景从 .V2rayU 一直延续到 .version-fox 甚至更后面！
```

### 为什么会破坏转义序列？

`-J` 在连接行时：
- 会移除行尾的换行符
- 可能移除或重新排列某些 ANSI 转义序列
- 特别是当转义序列跨越了原始的强制换行边界时

## 解决方案

**移除 `-J` 选项**，只保留基本的捕获选项：

```typescript
// ❌ 有问题的版本
capture-pane -epJ -S- -t %${paneId}
// -J 会破坏 ANSI 转义序列

// ✅ 修复后的版本
capture-pane -ep -S- -t %${paneId}
// 移除 -J，让 tmux 保持原始的行结构和 ANSI 转义序列
```

### 选项说明

| 选项 | 说明 | 是否使用 |
|------|------|---------|
| `-e` | 包含 ANSI 转义序列（颜色、属性） | ✅ 使用 |
| `-p` | 输出到 stdout | ✅ 使用 |
| `-S-` | 从历史记录的开始捕获 | ✅ 使用 |
| ~~`-J`~~ | 连接被换行的行 | ❌ **不使用**（会破坏转义序列） |

### 代码修改

**文件**: `src/session.ts` - `TmuxController.restorePaneHistory()`

```typescript
async restorePaneHistory(paneId: number): Promise<void> {
    const output = await this.gateway.sendCommand(
        `capture-pane -ep -S- -t %${paneId}`,  // 移除 -J
        TMUX_COMMAND_TOLERATE_ERRORS
    )

    if (output && this.paneSessions.has(paneId)) {
        // 仍然需要将 \n 转换为 \r\n 以正确显示
        const normalizedOutput = output.replace(/\n/g, '\r\n')
        const buffer = Buffer.from(normalizedOutput, 'utf-8')
        this.paneSessions.get(paneId)?.emitOutputToPane(buffer)
    }
}
```

## 权衡考虑

### 不使用 `-J` 的影响

**可能的副作用**：
- 长行在原终端中被强制换行的位置会被保留
- 如果新终端的宽度不同，可能看起来有些奇怪

**实际影响**：
- **最小化**：因为大多数终端输出（如 `ls -l`）都是短行
- 即使有长行，也会在新终端中自然重新换行
- **更重要的是**：保持 ANSI 转义序列的完整性，避免高亮跨行

### 为什么这是正确的选择？

1. **完整性优先**：保持 ANSI 转义序列完整比连接行更重要
2. **视觉正确性**：高亮跨行比行有些多余的换行更让人困扰
3. **原始性**：tmux 存储的就是这样的格式，我们应该尊重它
4. **兼容性**：不做过多处理，减少引入新问题的可能性

## 最终方案总结

我们的历史记录恢复策略：

1. ✅ 使用 `capture-pane -ep -S-` 捕获内容
   - `-e`: 包含 ANSI 转义序列
   - `-p`: 输出到 stdout
   - `-S-`: 从历史开始

2. ✅ 将 `\n` 转换为 `\r\n`
   - 解决换行符格式问题
   - 确保每行从行首开始

3. ❌ **不使用** `-J`
   - 避免破坏 ANSI 转义序列
   - 防止高亮跨行

## 测试验证

### 预期行为

重启 Tabby 后：
- ✅ 高亮正确显示，不会跨行
- ✅ ANSI 转义序列完整保留
- ✅ 每行从行首开始（`\r\n` 转换）
- ✅ 颜色、粗体等样式正确

### 测试场景

1. 查看包含高亮文件名的 `ls -l` 输出
2. 查看包含语法高亮的代码或日志
3. 查看包含彩色输出的命令（如 `git status`）

## 参考

- tmux wiki: Advanced Use - Capturing pane content
- `-J` 选项会"join wrapped lines"，但可能破坏 ANSI 转义序列
- ANSI 转义序列标准：控制字符的完整性很重要
