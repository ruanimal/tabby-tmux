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

在 tmux 模式下完成 trzsz 文件传输后断开连接，重新 attach 时，之前传输过的 pane 会在终端上显示原始的 trzsz 协议字符串（`::TRZSZ:TRANSFER:...`、`#CFG:...`、`#DATA:...` 等）。

### 根因

- 传输期间，trzsz middleware 拦截了协议数据，xterm 不显示
- 但 tmux server 本身在 pane 的 scrollback 中记录了这些原始数据
- `capture-pane` 恢复历史时会捕获 scrollback 中的所有内容，包括 trzsz 协议标记
- 这些数据被写入 xterm 后就可见了

### 修复

与 iTerm2 保持一致，`capture-pane` 使用 `-peJS-` 参数（原先用 `-ep -S-`，缺少 `-J`）。

trzsz 命令行工具自身通过 ANSI 序列清理协议输出：

```
\x1b[s                          ← 保存光标位置
::TRZSZ:TRANSFER:S:1.2.0:...   ← 协议头 + 数据
\x1b[u                          ← 恢复光标位置
\x1b[0J                         ← 清除光标到屏幕末尾
```

加入 `-J`（join wrapped lines）后，tmux server 在 `capture-pane` 输出中正确保留了这些 ANSI 序列。xterm 回放时执行 `\x1b[u\x1b[0J` 即可自动清理协议内容，无需额外硬编码过滤。

`-J` 是 tmux server 端的输出格式参数，对已有的 tmux pane 无效——需要关闭旧 pane 并开启新 pane 才能生效（`-J` 的生效时机可能在 pane 创建时就已确定）。
