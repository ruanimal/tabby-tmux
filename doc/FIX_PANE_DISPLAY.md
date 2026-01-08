# Pane 显示问题修复总结

## 问题描述

在当前重构后的分支中，tmux pane 不显示任何内容（用户输入、shell prompt、命令输出）。

## 根本原因：双重缓冲

代码中存在**两层缓冲机制**：

### 第一层：TmuxPaneSession 的自定义缓冲
```typescript
// ❌ 问题代码
export class TmuxPaneSession extends BaseSession {
    private pendingDataBuffer: Buffer[] = []
    private bufferReleased = false

    emitOutputToPane(data: Buffer): void {
        if (!this.bufferReleased) {
            this.pendingDataBuffer.push(data)  // 第一层缓冲
        } else {
            this.emitOutput(data)  // 送入第二层
        }
    }

    releaseInitialDataBuffer(): void {
        this.bufferReleased = true
        for (const data of this.pendingDataBuffer) {
            this.emitOutput(data)  // 释放第一层，但送入第二层
        }
    }
}
```

### 第二层：BaseSession 的标准缓冲
```typescript
// BaseSession 的内部实现（tabby-terminal）
export abstract class BaseSession {
    private initialDataBuffer = Buffer.from('')
    private initialDataBufferReleased = false

    constructor() {
        this.middleware.outputToTerminal$.subscribe(data => {
            if (!this.initialDataBufferReleased) {
                this.initialDataBuffer = Buffer.concat([...])  // 第二层缓冲
            } else {
                this.output.next(data.toString())  // 真正输出
            }
        })
    }
}
```

### 数据流问题

```
tmux 输出
  ↓
TmuxPaneSession.emitOutputToPane(data)
  ↓
if (!bufferReleased)
  → pendingDataBuffer.push(data) ❌ 永远停在第一层！

即使调用 TmuxPaneSession.releaseInitialDataBuffer():
  ↓
this.emitOutput(data)  // 只释放第一层
  ↓
BaseSession middleware
  ↓
if (!initialDataBufferReleased)
  → initialDataBuffer.concat(...) ❌ 又被第二层拦截！
```

**关键问题**：
- `TmuxPaneSession.releaseInitialDataBuffer()` 只释放自己的缓冲
- 它**没有调用** `super.releaseInitialDataBuffer()`
- 所以 `BaseSession.initialDataBufferReleased` 永远是 `false`
- 数据永远被第二层缓冲拦截，永远不会显示

## 解决方案

**移除自定义缓冲，依赖 BaseSession 的标准机制**：

### 修改 1: TmuxPaneSession (src/session.ts)

```typescript
// ✅ 修复后的代码
export class TmuxPaneSession extends BaseSession {
    // ✅ 移除了 pendingDataBuffer 和 bufferReleased

    /**
     * Emit output to the pane.
     *
     * Data flows through BaseSession's middleware and buffering mechanism.
     * BaseTerminalTabComponent will automatically call releaseInitialDataBuffer()
     * when the frontend is ready, so we don't need custom buffering here.
     */
    emitOutputToPane(data: Buffer): void {
        // ✅ 直接调用 emitOutput，让 BaseSession 处理缓冲
        this.emitOutput(data)
    }

    // ✅ 不重写 releaseInitialDataBuffer()，使用继承的版本
}
```

### 修改 2: TmuxPaneTabComponent (src/components/tmuxPaneTab.component.ts)

```typescript
// ✅ 修复后的代码
async initializeSession(): Promise<void> {
    const paneSession = new TmuxPaneSession(this.logger, this.controller, this.paneId)
    await paneSession.start()

    // ✅ 直接 setSession，不手动调用 releaseInitialDataBuffer
    this.setSession(paneSession, true)

    // ✅ 只处理 resize
    if (this.frontendIsReady && this.size) {
        paneSession.resize(this.size.columns, this.size.rows)
    }

    // ❌ 移除了：syncAndRelease(), frontendReady$ 订阅, setTimeout fallback
}
```

## 工作原理

### BaseTerminalTabComponent 的自动处理

在 `tabby-terminal/src/api/baseTerminalTab.component.ts` 第381-402行：

```typescript
ngOnInit(): void {
    // ...
    this.frontend.resize$.pipe(first()).subscribe(async ({ columns, rows }) => {
        this.size = { columns, rows }
        this.frontendReady.next()
        this.frontendReady.complete()

        // ... 装饰器初始化 ...

        setTimeout(() => {
            this.session?.resize(columns, rows)
        }, 1000)

        this.session?.releaseInitialDataBuffer()  // ✅ 在这里自动释放！

        this.sessionChanged$.subscribe(() => {
            this.session?.releaseInitialDataBuffer()  // session 切换时也释放
        })
    })
}
```

**关键点**：
1. Frontend 的**第一次 resize 事件**标志着 frontend 完全就绪
2. 父类在这个时机**自动调用** `session.releaseInitialDataBuffer()`
3. 这会调用 `BaseSession.releaseInitialDataBuffer()`（因为我们没有重写）
4. `BaseSession` 设置 `initialDataBufferReleased = true` 并释放缓冲的数据

### 正确的数据流

```
tmux 输出
  ↓
TmuxController.gateway.output$
  ↓
TmuxPaneSession.emitOutputToPane(data)
  ↓
BaseSession.emitOutput(data)
  ↓
SessionMiddlewareStack
  ↓
BaseSession 构造函数中的订阅:
  if (!initialDataBufferReleased) {
    缓冲数据  // ⏸️ 暂时缓冲
  } else {
    output.next()  // ✅ 显示！
  }

当 Frontend 就绪（第一次 resize）:
  ↓
BaseTerminalTabComponent 自动调用:
  session.releaseInitialDataBuffer()
  ↓
BaseSession.initialDataBufferReleased = true
  ↓
缓冲的数据被释放并显示  ✅
  ↓
后续输出直接显示  ✅
```

## 修改的文件

1. **src/session.ts**：
   - 移除 `TmuxPaneSession` 的 `pendingDataBuffer` 和 `bufferReleased`
   - `emitOutputToPane()` 直接调用 `this.emitOutput(data)`
   - 移除重写的 `releaseInitialDataBuffer()` 方法

2. **src/components/tmuxPaneTab.component.ts**：
   - 移除 `first` 导入
   - 简化 `initializeSession()`，移除手动调用 `releaseInitialDataBuffer()` 的逻辑
   - 移除 `syncAndRelease()` 函数、`frontendReady$` 订阅和 `setTimeout` fallback

## 测试验证

构建成功：
```bash
✅ npm run build
   asset index.js 53.7 KiB [emitted]
   webpack 5.104.1 compiled with 1 warning
```

预期行为：
- ✅ 打开 pane 标签页时立即显示 shell prompt
- ✅ 用户输入有回显
- ✅ 命令输出正常显示
- ✅ 历史记录正确加载

## 核心原则

**不要重复发明轮子**：
- BaseSession 已经提供了完善的初始数据缓冲机制
- BaseTerminalTabComponent 已经在合适的时机调用 releaseInitialDataBuffer()
- 我们只需要正确继承和使用这些机制，不需要自己实现

**信任框架**：
- 框架设计者已经处理了时序、竞态条件等复杂问题
- 手动控制往往会引入新的问题
- 简单的代码更容易维护和调试
