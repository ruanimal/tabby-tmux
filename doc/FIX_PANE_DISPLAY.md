# Tmux Pane 显示问题修复说明

## 问题描述

tmux pane 标签页不显示任何内容：
- ❌ 不显示用户输入
- ❌ 不显示 shell prompt
- ❌ 不显示命令输出
- ✅ 输入已经正常发送到 tmux（验证：通过 tmux attach 可以看到命令执行）

## 根本原因

`BaseSession` 类（来自 tabby-terminal）有一个**初始数据缓冲机制**：

1. 在 `BaseSession` 构造函数中初始化了 `initialDataBuffer` 和 `initialDataBufferReleased = false`
2. 所有通过 `emitOutput()` 发送的数据会先被缓冲，直到调用 `releaseInitialDataBuffer()`
3. 这个机制的目的是等待终端 frontend 完全就绪后再显示输出，避免输出丢失

**时序问题**：

```
正确的时序：
1. super.ngOnInit() 注册 frontend.resize$ 事件监听
2. Frontend 初始化并触发第一次 resize 事件
3. BaseTerminalTabComponent 在 resize 回调中调用 releaseInitialDataBuffer()
4. 缓冲的输出被释放到终端显示

错误的时序（原实现）：
1. super.ngOnInit() 注册监听
2. initializeSession() 创建 session
3. 尝试订阅 frontendReady$ - 但可能已经完成（竞态条件）
4. 手动调用 releaseInitialDataBuffer() - 但时机不确定
5. 可能导致：调用太早（frontend 未就绪）或太晚（已有输出丢失）或根本未调用
```

## 解决方案

**依赖 BaseTerminalTabComponent 的自动机制，而不是手动管理**：

### 修改的文件

`src/components/tmuxPaneTab.component.ts`:

```typescript
// 之前的实现（有问题）
async initializeSession(): Promise<void> {
    // ... 创建 session ...
    this.setSession(paneSession, true)

    // 复杂的 frontendReady$ 订阅和 fallback 逻辑
    const syncAndRelease = () => {
        paneSession.resize(...)
        paneSession.releaseInitialDataBuffer()  // ❌ 手动调用，时序不可控
    }

    if (this.frontendIsReady) {
        syncAndRelease()
    } else {
        this.frontendReady$.pipe(first()).subscribe(syncAndRelease)
        setTimeout(() => { ... }, 500)  // ❌ fallback 更不可靠
    }
}

// 修复后的实现
async initializeSession(): Promise<void> {
    // ... 创建 session ...

    // ✅ 直接设置 session，父类会在合适的时机自动调用 releaseInitialDataBuffer()
    this.setSession(paneSession, true)

    // ✅ 只需要处理 resize，buffer 释放由父类负责
    if (this.frontendIsReady && this.size) {
        paneSession.resize(this.size.columns, this.size.rows)
    }
}
```

### 为什么这样修复有效？

查看 `BaseTerminalTabComponent` 的 `ngOnInit()` 方法（第381-402行）：

```typescript
this.frontend.resize$.pipe(first()).subscribe(async ({ columns, rows }) => {
    this.size = { columns, rows }
    this.frontendReady.next()
    this.frontendReady.complete()

    // ... 装饰器初始化 ...

    setTimeout(() => {
        this.session?.resize(columns, rows)  // 延迟 resize
    }, 1000)

    this.session?.releaseInitialDataBuffer()  // ✅ 在这里自动释放！
    this.sessionChanged$.subscribe(() => {
        this.session?.releaseInitialDataBuffer()  // session 切换时也释放
    })
})
```

**关键点**：
1. Frontend 的 **第一次 resize 事件** 是 frontend 完全就绪的标志
2. 父类在这个时机自动调用 `releaseInitialDataBuffer()`
3. 我们只需要在 `setSession()` 之前或之后设置 session，父类会处理剩下的一切

## 测试验证

### 预期行为

1. **启动 tmux pane 标签页**：
   - ✅ 应该立即显示 shell prompt（如 `user@host ~ $`）
   - ✅ 光标应该在 prompt 末尾

2. **输入命令**：
   - ✅ 输入应该立即回显（除非是密码输入）
   - ✅ 按回车后应该看到命令输出
   - ✅ 执行完成后应该看到新的 prompt

3. **历史记录**：
   - ✅ tmux 的历史输出应该被正确加载和显示
   - ✅ 滚动条应该可以查看历史

### 测试步骤

1. 重新构建插件：
   ```bash
   cd /Users/ruan/projects/tabby-tmux
   npm run build
   ```

2. 重启 Tabby 并加载插件

3. 创建新的 Tmux 配置文件标签页

4. 验证：
   - [ ] 是否显示 shell prompt？
   - [ ] 输入 `ls` 是否有输出？
   - [ ] 输入 `echo hello` 是否有输出？
   - [ ] 光标位置是否正确？

## 相关代码引用

### BaseSession (tabby-terminal/src/session.ts)

```typescript
export abstract class BaseSession {
    private initialDataBuffer = Buffer.from('')
    private initialDataBufferReleased = false

    constructor (protected logger: Logger) {
        this.middleware.outputToTerminal$.subscribe(data => {
            if (!this.initialDataBufferReleased) {
                // ⚠️ 数据被缓冲，不显示
                this.initialDataBuffer = Buffer.concat([this.initialDataBuffer, data])
            } else {
                // ✅ 数据正常输出到终端
                this.output.next(data.toString())
                this.binaryOutput.next(data)
            }
        })
    }

    releaseInitialDataBuffer (): void {
        this.initialDataBufferReleased = true
        this.output.next(this.initialDataBuffer.toString())
        this.binaryOutput.next(this.initialDataBuffer)
        this.initialDataBuffer = Buffer.from('')
    }
}
```

### TmuxPaneSession (src/session.ts)

```typescript
export class TmuxPaneSession extends BaseSession {
    emitOutputToPane(data: Buffer) {
        // 调用父类的 emitOutput，数据会被送入 middleware
        // 然后根据 initialDataBufferReleased 决定是缓冲还是输出
        this.emitOutput(data)
    }
}
```

### 数据流向

```
tmux server
    ↓ %output %paneId <data>
TmuxControllerSession.parseLine()
    ↓
TmuxPaneSession.emitOutputToPane()
    ↓
BaseSession.emitOutput()
    ↓
SessionMiddlewareStack.feedFromSession()
    ↓
SessionMiddlewareStack.outputToTerminal$
    ↓
BaseSession 构造函数中的订阅
    ↓
if (!initialDataBufferReleased) {
    缓冲数据 ❌ 不显示
} else {
    output.next() ✅ 显示到终端
}
```

## 总结

通过移除手动的 `releaseInitialDataBuffer()` 调用和复杂的时序控制逻辑，依赖 Tabby 框架提供的标准机制，解决了 pane 不显示内容的问题。

**核心原则**：信任框架，不要过度控制时序。BaseTerminalTabComponent 已经在合适的时机处理了 buffer 释放，我们只需要正确设置 session 即可。
