# Tabby Tmux Integration 插件

## 项目概述

`tabby-tmux` 是一个为 [Tabby](https://tabby.sh/) 终端模拟器提供 tmux Control Mode 集成的插件。该插件的设计灵感来自于 [iTerm2 的 tmux Integration](https://iterm2.com/documentation-tmux-integration.html) 功能，旨在为 Tabby 用户提供原生的 tmux 窗口和面板管理体验。

## 核心功能

### 主要特性

- **原生 UI 集成**：将 tmux 的窗口和面板映射为 Tabby 的原生标签页，无需使用传统的 tmux 快捷键
- **会话持久化**：即使 Tabby 关闭或 SSH 连接断开，tmux 会话仍然保持运行
- **无缝重连**：通过 `tmux -CC attach` 可以恢复之前的会话状态
- **多面板支持**：自动为每个 tmux 面板创建独立的 Tabby 标签页
- **Control Mode 协议**：使用 tmux 的 `-CC` 标志启用控制模式，通过文本协议与 tmux 通信

### 解决的问题

传统使用 tmux 时存在以下痛点：

1. **快捷键冲突**：需要专门的前缀键（默认 `^B`）来控制 tmux，影响其他应用的快捷键使用
2. **多连接需求**：需要多次 SSH 连接才能查看同一会话的不同视图
3. **学习成本**：需要记忆大量 tmux 命令
4. **功能限制**：终端模拟器的原生功能（如滚动历史、搜索）在 tmux 中体验不佳

**本插件通过 tmux Control Mode 完美解决了这些问题。**

## 技术架构

### 核心组件

#### 1. **TmuxProfile** (`src/profiles.ts`)

配置文件提供者，负责：
- 定义 tmux 配置文件类型
- 提供内置的默认配置
- 创建新标签页时的参数配置

```typescript
export interface TmuxProfile extends Profile {
    type: 'tmux'
    sessionName?: string  // tmux 会话名称
    options: any
    weight: number
    isBuiltin: boolean
    isTemplate: boolean
    disableDynamicTitle: boolean
}
```

#### 2. **TmuxTabComponent** (`src/components/tmuxTab.component.ts`)

主控制器标签页组件，负责：
- 启动 `tmux -CC` 进程
- 创建 `TmuxControllerSession` 实例
- 监听 tmux 事件（如新面板创建）
- 自动为新面板打开 `TmuxPaneTabComponent` 标签页

**工作流程**：
1. 通过 PTY 接口启动 `tmux -CC new -A -s <session-name>` 命令
2. 将 PTY 输出包装为 `BaseSession` 兼容的接口
3. 创建 `TmuxControllerSession` 来解析 Control Mode 协议
4. 监听 `pane-add` 事件，自动为每个面板创建标签页

#### 3. **TmuxPaneTabComponent** (`src/components/tmuxPaneTab.component.ts`)

单个 tmux 面板的标签页组件，负责：
- 显示特定面板的终端输出
- 处理用户输入并发送到对应面板
- 管理面板的生命周期

#### 4. **TmuxControllerSession** (`src/session.ts`)

Control Mode 协议解析器，负责：
- 解析 tmux Control Mode 的文本协议
- 管理多个 `TmuxPaneSession` 实例
- 处理 tmux 通知（如 `%output`、`%window-add`、`%session-changed` 等）
- 将输出路由到对应的面板会话

**协议解析**：
- `%output %<pane-id> <content>`：面板输出
- `%begin` / `%end` / `%error`：命令执行状态
- `%window-add @<window-id>`：新窗口创建
- `%session-changed`：会话切换
- 自定义 `TABBY_PANE:%<pane-id>`：面板列表（通过 `list-panes` 获取）

#### 5. **TmuxPaneSession** (`src/session.ts`)

单个面板的会话实例，负责：
- 继承自 `BaseSession`，提供标准的终端会话接口
- 将用户输入通过 `send-keys -t %<pane-id> -H <hex>` 发送到特定面板
- 接收来自 `TmuxControllerSession` 的输出并触发 `output$` 事件
- 处理面板的调整大小、关闭等操作

### 数据流

```
用户输入 → TmuxPaneTabComponent → TmuxPaneSession
    → TmuxControllerSession.writeToPane()
    → 底层 PTY (tmux -CC)
    → tmux 服务器

tmux 服务器输出 → PTY → TmuxControllerSession.handleOutput()
    → parseLine() 解析协议
    → TmuxPaneSession.emitOutputToPane()
    → TmuxPaneTabComponent 显示
```

## tmux Control Mode 协议

### 启动控制模式

使用 `-CC` 标志启动 tmux：

```bash
tmux -CC new -A -s <session-name>
```

- `-CC`：启用控制模式（双 C 表示禁用终端回显等特性）
- `new -A -s <name>`：创建或附加到指定名称的会话

### 协议格式

#### 命令输出包装

每个命令的输出都被 `%begin` 和 `%end`（或 `%error`）包围：

```
new -n mywindow
%begin 1578920529 257 1
%end 1578920529 257 1
```

参数说明：
1. 时间戳（秒）
2. 唯一命令编号
3. 标志位（通常为 1）

#### 面板输出

```
%output %<pane-id> <escaped-content>
```

- `<pane-id>`：面板 ID（如 `%0`、`%1`）
- `<escaped-content>`：输出内容，ASCII < 32 和 `\` 字符被转换为八进制转义（如 `\015` 表示回车）

#### 通知事件

| 通知 | 描述 |
|------|------|
| `%window-add @<window-id>` | 窗口创建 |
| `%window-close @<window-id>` | 窗口关闭 |
| `%session-changed $<session-id> <name>` | 会话切换 |
| `%pane-mode-changed %<pane-id>` | 面板模式改变 |

### 特殊命令

- `refresh-client -C <width>x<height>`：设置客户端尺寸
- `refresh-client -f pause-after=<seconds>`：启用流控制
- `send-keys -t %<pane-id> -H <hex>`：向指定面板发送十六进制编码的按键

## 使用方法

### 基本使用

1. **启动新会话**：
   - 在 Tabby 中打开 Tmux 配置文件
   - 插件会自动执行 `tmux -CC new -A -s default`
   - 每个 tmux 面板会自动在新标签页中打开

2. **重新连接**：
   - 如果 Tabby 关闭或连接断开，tmux 会话仍在服务器上运行
   - 重新打开 Tmux 配置文件即可恢复所有面板

3. **操作面板**：
   - 关闭标签页 = 关闭对应的 tmux 面板
   - 所有输入输出都通过 Tabby 的原生 UI 处理

### 与 iTerm2 的对比

| 功能 | iTerm2 | Tabby-Tmux |
|------|--------|------------|
| 原生窗口集成 | ✅ | ✅ |
| 会话持久化 | ✅ | ✅ |
| 自动面板映射 | ✅ | ✅ |
| 跨平台支持 | ❌ (仅 macOS) | ✅ (Windows/Linux/macOS) |
| 分屏支持 | ✅ | 🚧 (开发中) |

## 开发指南

### 项目结构

```
tabby-tmux/
├── src/
│   ├── index.ts                    # 插件入口
│   ├── profiles.ts                 # 配置文件提供者
│   ├── session.ts                  # 会话管理（Controller + Pane）
│   ├── components/
│   │   ├── tmuxTab.component.ts    # 主控制器标签页
│   │   └── tmuxPaneTab.component.ts # 面板标签页
│   └── tabby-local.d.ts            # 类型定义
├── ref/
│   ├── iterm2-tmux-integration.md  # iTerm2 参考文档
│   └── tmux.wiki/
│       └── Control-Mode.md         # tmux Control Mode 官方文档
├── package.json
├── tsconfig.json
└── webpack.config.mjs
```

### 构建与开发

```bash
# 安装依赖
pnpm install

# 开发模式（监听文件变化）
pnpm run watch

# 生产构建
pnpm run build
```

### 技术栈

- **框架**：Angular 15
- **语言**：TypeScript 4.9
- **依赖**：
  - `tabby-core`：核心 API
  - `tabby-terminal`：终端会话基类
  - `tabby-local`：本地 PTY 接口
  - `rxjs`：响应式编程

### 关键实现细节

#### 1. 八进制转义解析

tmux Control Mode 将特殊字符转换为八进制转义（如 `\015` = CR）：

```typescript
private unescapeTmuxOutput(str: string): Buffer {
    const buf = Buffer.alloc(str.length)
    let bufIdx = 0
    for (let i = 0; i < str.length; i++) {
        if (str[i] === '\\' && i + 3 < str.length) {
            const octal = str.substring(i + 1, i + 4)
            if (/^[0-7]{3}$/.test(octal)) {
                buf[bufIdx++] = parseInt(octal, 8)
                i += 3
                continue
            }
        }
        buf[bufIdx++] = str.charCodeAt(i)
    }
    return buf.slice(0, bufIdx)
}
```

#### 2. 面板输入发送

使用 `send-keys -H` 以十六进制格式发送，避免转义问题：

```typescript
writeToPane(paneId: number, data: Buffer) {
    const hex = data.toString('hex')
    if (hex.length > 0) {
        this.write(Buffer.from(`send-keys -t %${paneId} -H ${hex}\r`))
    }
}
```

#### 3. 面板自动发现

通过 `list-panes` 命令获取所有面板：

```typescript
private refreshPanes() {
    this.write(Buffer.from('list-panes -s -F "TABBY_PANE:#{pane_id}"\r'))
}
```

输出格式：`TABBY_PANE:%0`，解析后触发 `pane-add` 事件。

## 已知限制

1. **窗口大小同步**：所有 tmux 窗口必须具有相同的行列数（tmux 限制）
2. **分屏支持**：Tabby 标签页内的分屏功能尚未完全实现
3. **流控制**：高频输出时可能需要实现 `pause-after` 流控制机制
4. **工作目录**：当前不支持获取面板的工作目录

## 未来规划

- [ ] 实现 Tabby 内的分屏布局映射
- [ ] 添加配置界面（会话名称、自动重连等）
- [ ] 支持 tmux 窗口重命名同步
- [ ] 实现流控制以优化高频输出性能
- [ ] 添加 tmux Dashboard 视图
- [ ] 支持远程 SSH + tmux 的无缝集成

## 参考资料

- [iTerm2 tmux Integration 文档](https://iterm2.com/documentation-tmux-integration.html)
- [tmux Control Mode Wiki](https://github.com/tmux/tmux/wiki/Control-Mode)
- [Tabby 插件开发文档](https://github.com/Eugeny/tabby)
- [tmux 官方手册](https://man.openbsd.org/tmux)
- [tabby 代码](ref/tabby)
- [tmux wiki](ref/tmux.wiki)
- [iterm2](ref/iTerm2)

## 许可证

MIT License

## 作者

Ruan

---

**注意**：本插件目前处于开发阶段，部分功能可能尚未完全实现或存在 bug。欢迎提交 Issue 和 Pull Request！
