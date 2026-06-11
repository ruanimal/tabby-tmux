# Fix: trzsz 文件传输兼容性（双重文件对话框）

## 问题描述

安装了 tabby-trzsz 插件后，在 tmux 模式下执行 `trz` 上传文件时：
1. 弹出两次文件选择对话框
2. 两次都选择文件后传输不会开始
3. 终端卡死

## 根因分析

tabby-trzsz 通过 `TerminalDecorator` 向**所有** `BaseTerminalTabComponent` 注入 `SessionMiddleware`，拦截双向数据流检测 trzsz 协议。但在 tmux 模式下存在两个 session：

| Session | 角色 | trzsz middleware |
|---------|------|-----------------|
| 原始终端 session（SSH） | 承载 tmux 控制模式协议 | ✅ 有（Decorator 自动注入） |
| TmuxPaneSession | 表示单个 tmux pane | ✅ 有（TmuxPaneTabComponent 也是 BaseTerminalTabComponent） |

当远程执行 `trz` 时，trzsz 协议标记嵌入在 tmux 的 `%output` 行中：

```
%output %0 \033::TRZSZ:TRANSFER:1.0.0:...
```

数据流经过两个 session 的 trzsz middleware，导致 `chooseSendFiles()` 被调用两次：

```
远程 trz 输出（含 trzsz 标记）
  ↓
原始终端 session 收到原始 tmux 数据
  ├─→ 原始 session 的 trzsz middleware.processServerOutput()
  │   → 检测到标记 → chooseSendFiles() → 文件对话框 #1 ❌（误触发）
  │
  └─→ TmuxGateway 解析 %output → paneSession.emitOutputToPane()
      → pane session 的 trzsz middleware.processServerOutput()
      → 检测到标记 → chooseSendFiles() → 文件对话框 #2 ✅（正确触发）
```

此外，`TmuxPaneSession.feedFromTerminal()` 原先直接调用 `writeToPane()` 绕过了 middleware 链，导致 trzsz 的 `processTerminalInput()` 从未被调用，双向状态机不完整，协议握手失败 → 终端卡死。

## 修复方案

### 1. 移除 `TmuxPaneSession.feedFromTerminal()` 的 override（`session.ts`）

让终端输入走正常的 middleware 链路：

```
用户输入 → feedFromTerminal() → middleware 链
  → [trzsz: processTerminalInput() 拦截/转发]
  → outputToSession$ → write() → writeToPane() → tmux
```

### 2. 插入 `TmuxOutputInterceptor`（`tmux.service.ts`）

在原始终端 session 的 middleware 链头部插入拦截 middleware：

- **捕获**原始 tmux 控制模式数据，供给 `TmuxGateway` 解析
- **阻止**数据传播到后续 middleware（trzsz），避免误检测
- TmuxPaneSession 的 trzsz middleware 正常处理解码后的 pane 输出
- `disconnect` 时自动移除 interceptor

```
原始终端 session middleware 链：
  [TmuxOutputInterceptor, trzszMiddleware, ...]
   ↑ 拦截原始输出，阻止传播到 trzsz

TmuxPaneSession middleware 链：
  [trzszMiddleware, ...]
   ↑ 正常工作（处理不含 tmux 协议包装的纯 pane 输出）
```

## 影响

- trzsz 的上传（`trz`）/ 下载（`tsz`）在 tmux 模式下正常工作
- 不影响普通（非 tmux）终端的 trzsz 功能
- 不影响 tmux 模式下的其他功能

---

## 附：re-attach 后 pane 历史显示 trzsz 协议数据

### 问题描述

在 tmux 模式下完成 trzsz 文件传输后断开连接，重新 attach 时，之前传输过的 pane 会在终端上显示原始的 trzsz 协议字符串（`::TRZSZ:TRANSFER:...`、`#CFG:...`、`#DATA:...` 等），并且带有不规则的列偏移。

### 根因

trzsz CLI 工具在传输期间通过 ANSI 序列"隐藏"协议输出：

```
\x1b[s                          ← 保存光标位置
::TRZSZ:TRANSFER:S:1.2.0:...   ← 协议头（\r\n 结尾）
#CFG:base64...\r\n              ← 协议数据（多行）
#NUM:1\r\n
#NAME:base64\r\n
#SIZE:1737\r\n
#DATA:base64...\r\n             ← 可能多行
#MD5:base64\r\n
\x1b[u                          ← 恢复光标到 \x1b[s 保存的位置
\x1b[0J                         ← 清除光标到屏幕末尾
```

**tmux 的处理**：

- `\x1b[s` — tmux 内部消费（保存光标），**不保留在 cell grid 中**
- 协议数据行 — 写入 pane 的 cell grid，\r\n 导致换行
- `\x1b[u` — tmux 内部消费（恢复光标），**不保留在 cell grid 中**
- `\x1b[0J` — tmux 内部消费（清除可见区域），**不保留在 cell grid 中**

**关键问题**：`\x1b[0J` 只清除**可见屏幕区域**，不清除 scrollback。协议数据写入时可能导致屏幕滚动（pushing lines into scrollback），此时 `\x1b[0J` 无法清除已进入 scrollback 的协议行。

`capture-pane` 输出的 scrollback 中只有协议数据的纯文本行（含列偏移的空格），**没有** `\x1b[s`/`\x1b[u`/`\x1b[0J`。回放时这些行以原始列偏移显示，互相之间不会覆盖：

```
::TRZSZ:TRANSFER:S:1.2.0:...              ← 列 0
#CFG:base64...                             ← 列 0
                                            ← 空行（从列 0 到行尾的空格被滚动到 scrollback）
                #NUM:1                     ← 列 16（\x1b[u 恢复光标后的位置）
                                            ← 空行
                      #NAME:base64         ← 列 20
                                     #SIZE:1737  ← 列 35
```

### iTerm2 的情况

iTerm2 使用 `TmuxHistoryParser` 将 `capture-pane` 输出解析为 `screen_char_t` 数组，通过 `setHistory` 直接写入 screen buffer（不经过 ANSI 回放）。协议数据行同样会出现在 iTerm2 的 screen buffer 中。

iTerm2 也可能出现协议行可见的情况，但以下因素降低了可见性：
1. 使用 `-S -maxHistory` 限制 capture 范围（非完整 scrollback）
2. 协议行的列偏移被正确保留为 cell grid 数据，后续 shell 输出从正确位置继续写入，视觉上可能被覆盖

### 修复方案

在 `restorePaneHistory` 写入 xterm 之前，显式过滤 trzsz 协议数据。

trzsz 协议格式固定，每行以 `::TRZSZ:TRANSFER:` 或 `#` + 关键字 + `:` 开头（base64 编码）：

```typescript
// Remove trzsz protocol data from captured history.
// tmux consumes the \x1b[s/\x1b[u/\x1b[0J sequences that trzsz uses
// to hide protocol output, leaving raw protocol lines in scrollback
// with column offsets that would not self-overlap on replay.
if (history.includes('::TRZSZ:TRANSFER:')) {
    history = history
        .replace(/^[ \t]*::TRZSZ:TRANSFER:.*$/gm, '')
        .replace(/^[ \t]*#(?:CFG|NUM|NAME|SIZE|DATA|MD5):.*$/gm, '')
}
```

仅当检测到 `::TRZSZ:TRANSFER:` 时才执行过滤，避免对正常输出产生不必要的开销。

### 关于 `-J` 参数

`-J`（join wrapped lines）的作用是将 tmux 因 pane 宽度而折行的逻辑行重新拼接，与 trzsz 协议数据清理**无关**。`-J` 不会保留已被 tmux 消费的 ANSI 序列。

## 问题说明
attach tmux 恢复 pane 历史时,  trzsz 传输的输出的处理有些问题

原本输出

```
~/projects/tabby-tmux pane-layout* ⇡ ❯ tsz package.json
Saved 1 file/directory to /Users/ruan/Downloads
- package.json.3
```

重新 attach 之后
```
~/projects/tabby-tmux pane-layout* ⇡ ❯ tsz package.json | tee a.log
::TRZSZ:TRANSFER:S:1.2.0:8116099374100:56722
#CFG:eJyqVkoqTSvOrEpVsjI0MLEwNTcz0FHKScxLV7JSSs9X0lEqycxNzS8tUbIyMtBRKsktrYgvSMxLjS/PTCnJULIyNDKpBQQAAP//utUVGA==
                                                                                                                 #NUM:1
                                                                                                                       #NAME:eJwqSEzOTkxP1csqzs8DBAAA//8eggS1
                                 #SIZE:1737
                                           #DATA:eJycU0Gr1DAQvvsrQr2JbX2gCIvIg+fFw7vtTRTSdLadfUkmzCRuy+J/l6attqs8xFv6zZdvvvkmvb5QSqnCawfFQRVRN81YRpeG4vVc+Q4sSH4q3lVvqrsVb0EMY4hL7ejSoB7IRyarHqkFJSkE4qhOxOo4ya43n2C8ELdSHNSXjGR07hxs6tAXGf668J3G3KJFiTX6FobqLKtYHAP6TrL3+bhQ2ir+IjEEEozEY3FQ103PMeSpO4wLNcOJ7YT2MQY51HWHsU9NZcjVnLRHp239O6dqupzv/li69eQg6A7+XeMlg24drHablAe6/qejGkUSyN7UvKwb2SahbSfhCzRBmydVloGpYxBRZWnIEm9zueho+ufpqixn1q75CS3crHta5lZ73eNu8zrFnnjqOI1Z2bP6sBzuTzQ4jXbK4OOam0UDXnLuj5+PKxpSY1H6B/In7Pbza2NA8tvJJLN3HQD4EwTwLXiDcJPdvfZdspprQ87N/8C3u3fbkTYMhufqJ2InfyP4rmyIokTWod5+zOS3WzIP51nj/S7W/CpWA6/+LP0MAAD//0yLHic=
 #DATA:eJyMksFO8zAQhO99iirHX783dkrSlhMHngPJcVbGwrUjrymKUN8dJQ5gtwLh63w749UsYYzGaarut9W/6v9mu74qyr6fWMRwMk7aJC/qJUHVgOdHHNEN6JTB2eD9e/pBOv1qZaiVP43GYpgNnkQLDQiex9yATFnzI+x09N5S/Yb9KNVLxomCi9OIVDs/4II0HHZQEL3s0TLr5fD5NQ4cijBFlAN7ENDkOkmiNArH/a1UmHfAoSuIOFnMkbvreDprZpw1rsA4HMqoVJPyYdlUAIdmJ5gz+jnaqXRMqPUq1fkHNm//d9wzisE4XWwNzRU1t6KCGeO68hHaXM9bbeHQldOr+nUfLXAQ60luLpuPAAAA//+AB7Bg
       #MD5:eJxqNPG9pHlXtmvOxhcZJRzPVQEBAAD//0B9B6c=
Saved 1 file/directory to /Users/ruan/Downloads
- package.json.3
```



