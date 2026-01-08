# iTerm2 TmuxController 实现文档

本文档梳理 iTerm2 中 tmux 集成模式（Control Mode）的核心实现，主要关注 `TmuxController` 及其相关类的架构设计。

## 目录

1. [概述](#概述)
2. [架构设计](#架构设计)
3. [核心类详解](#核心类详解)
4. [通信协议](#通信协议)
5. [数据流](#数据流)
6. [关键功能实现](#关键功能实现)
7. [状态管理](#状态管理)

---

## 概述

iTerm2 的 tmux 集成模式允许用户通过 `tmux -CC` 命令进入控制模式，将 tmux 的窗格（pane）映射为原生的 iTerm2 标签页和分屏，提供无缝的用户体验。

### 核心优势

- 无需学习 tmux 命令，使用原生 iTerm2 操作
- 会话持久化，断开连接后可恢复
- 原生滚动和搜索功能
- 多客户端协作支持

### 进入控制模式

```bash
tmux -CC           # 新建会话
tmux -CC attach    # 附加到现有会话
```

---

## 架构设计

### 类层次结构

```
┌─────────────────────────────────────────────────────────────┐
│                      PTYSession                              │
│  (终端会话，tmuxMode = TMUX_GATEWAY 或 TMUX_CLIENT)          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    TmuxController                            │
│  (tmux 会话控制器，管理窗口/窗格状态)                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      TmuxGateway                             │
│  (协议网关，解析和发送 tmux 控制模式命令)                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    VT100TmuxParser                           │
│  (DCS 钩子，解析 tmux 控制模式输出)                           │
└─────────────────────────────────────────────────────────────┘
```

### 辅助类

| 类名 | 职责 |
|------|------|
| `TmuxWindowOpener` | 打开 tmux 窗口，获取历史记录和状态 |
| `TmuxLayoutParser` | 解析 tmux 布局字符串为解析树 |
| `TmuxStateParser` | 解析窗格状态（光标位置、滚动区域等） |
| `TmuxHistoryParser` | 解析 `capture-pane` 的历史输出 |
| `TmuxControllerRegistry` | 全局注册表，管理所有 TmuxController 实例 |
| `TmuxDashboardController` | tmux 仪表盘 UI 控制器 |
| `iTermTmuxBufferSizeMonitor` | 监控 tmux 缓冲区大小，用于流控 |

---

## 核心类详解

### TmuxGateway

`TmuxGateway` 是 tmux 控制模式的协议网关，负责：

1. **命令发送**：将 tmux 命令发送到服务器
2. **响应解析**：解析 `%begin`/`%end`/`%error` 响应块
3. **通知处理**：处理异步通知（`%output`、`%layout-change` 等）

#### 主要属性

```objc
@interface TmuxGateway : NSObject

@property(nonatomic, assign) BOOL tmuxLogging;           // 是否记录协议日志
@property(nonatomic, weak) id<TmuxGatewayDelegate> delegate;
@property(nonatomic, retain) NSDecimalNumber *minimumServerVersion;
@property(nonatomic, retain) NSDecimalNumber *maximumServerVersion;
@property(nonatomic, assign) BOOL acceptNotifications;   // 是否接受通知
@property(nonatomic, readonly) NSString *dcsID;          // DCS 标识
@property(nonatomic, readonly) BOOL detachSent;          // 是否已发送 detach
@property(nonatomic) BOOL pauseModeEnabled;              // 流控模式

@end
```

#### 命令发送

```objc
// 发送单个命令
- (void)sendCommand:(NSString *)command
     responseTarget:(id)target
   responseSelector:(SEL)selector
     responseObject:(id)obj
              flags:(int)flags;

// 发送命令列表（原子执行）
- (void)sendCommandList:(NSArray *)commandDicts initial:(BOOL)initial;

// 发送按键到窗格
- (void)sendKeys:(NSString *)string toWindowPane:(int)windowPane;
```

#### 命令标志

```objc
typedef NS_OPTIONS(int, kTmuxGatewayCommandOptions) {
    kTmuxGatewayCommandShouldTolerateErrors = (1 << 0),  // 容忍错误
    kTmuxGatewayCommandWantsData = (1 << 1),              // 返回 NSData
    kTmuxGatewayCommandOfferToDetachIfLaggyDuplicate = (1 << 2)  // 延迟时提示分离
};
```

#### 协议解析 (executeToken:)

```objc
- (void)executeToken:(VT100Token *)token {
    NSString *command = token.string;

    // 处理响应块
    if ([command hasPrefix:@"%begin"]) {
        [self parseBegin:command];
    } else if ([command hasPrefix:endCommand]) {
        [self currentCommandResponseFinishedWithError:NO];
    } else if ([command hasPrefix:errorCommand]) {
        [self currentCommandResponseFinishedWithError:YES];
    }

    // 处理通知
    else if ([command hasPrefix:@"%output "]) {
        [self parseOutputCommandData:data];
    } else if ([command hasPrefix:@"%extended-output "]) {
        [self parseExtendedOutputCommandData:data];
    } else if ([command hasPrefix:@"%layout-change "]) {
        [self parseLayoutChangeCommand:command];
    } else if ([command hasPrefix:@"%window-add"]) {
        [self parseWindowAddCommand:command];
    } else if ([command hasPrefix:@"%session-changed"]) {
        [self parseSessionChangeCommand:command];
    }
    // ... 其他通知类型
}
```

### TmuxGatewayDelegate 协议

```objc
@protocol TmuxGatewayDelegate <NSObject>

- (TmuxController *)tmuxController;

// 布局更新
- (BOOL)tmuxUpdateLayoutForWindow:(int)windowId
                           layout:(NSString *)layout
                    visibleLayout:(NSString *)visibleLayout
                           zoomed:(NSNumber *)zoomed
                             only:(BOOL)only;

// 窗口事件
- (void)tmuxWindowAddedWithId:(int)windowId;
- (void)tmuxWindowClosedWithId:(int)windowId;
- (void)tmuxWindowRenamedWithId:(int)windowId to:(NSString *)newName;

// 会话事件
- (void)tmuxSessionChanged:(NSString *)sessionName sessionId:(int)sessionId;
- (void)tmuxSessionsChanged;

// 数据传输
- (void)tmuxReadTask:(NSData *)data windowPane:(int)wp latency:(NSNumber *)latency;
- (void)tmuxWriteString:(NSString *)string;

// 连接状态
- (void)tmuxHostDisconnected:(NSString *)dcsID;
- (void)tmuxInitialCommandDidCompleteSuccessfully;

@end
```

---

### TmuxController

`TmuxController` 是 tmux 会话的核心控制器，管理：

1. **窗口和窗格映射**：tmux 窗口 ↔ PTYTab，tmux 窗格 ↔ PTYSession
2. **状态同步**：保持本地状态与 tmux 服务器一致
3. **用户操作转发**：将 iTerm2 操作转换为 tmux 命令

#### 主要属性

```objc
@interface TmuxController : NSObject

@property(nonatomic, readonly) TmuxGateway *gateway;
@property(nonatomic, copy) NSString *sessionName;
@property(nonatomic, readonly) int sessionId;
@property(nonatomic, readonly) NSString *clientName;
@property(nonatomic, readonly) BOOL isAttached;
@property(nonatomic, readonly) BOOL detaching;
@property(nonatomic, copy) Profile *sharedProfile;
@property(nonatomic, readonly) BOOL variableWindowSize;  // tmux 3.2+ 支持

@end
```

#### 初始化流程

```objc
- (instancetype)initWithGateway:(TmuxGateway *)gateway
                     clientName:(NSString *)clientName
                        profile:(Profile *)profile
                   profileModel:(ProfileModel *)profileModel {
    self = [super init];
    if (self) {
        gateway_ = gateway;
        windowPanes_ = [[NSMutableDictionary alloc] init];      // paneId -> PTYSession
        _windowStates = [[NSMutableDictionary alloc] init];     // windowId -> iTermTmuxWindowState
        pendingWindowOpens_ = [[NSMutableSet alloc] init];
        hiddenWindows_ = [[NSMutableSet alloc] init];
        affinities_ = [[EquivalenceClassSet alloc] init];       // 窗口亲和性

        [[TmuxControllerRegistry sharedInstance] setController:self forClient:_clientName];
    }
    return self;
}
```

#### 窗口打开流程

```objc
- (void)openWindowsInitial {
    // 1. 获取会话大小
    NSString *command = [NSString stringWithFormat:@"show -v -q -t $%d @iterm2_size", sessionId_];
    [gateway_ sendCommand:command responseTarget:self responseSelector:@selector(handleShowSize:)];
}

- (void)openWindowsOfSize:(VT100GridSize)size {
    // 2. 发送命令列表
    NSArray *commands = @[
        // 获取会话 GUID
        [gateway_ dictionaryForCommand:getSessionGuidCommand ...],
        // 设置客户端大小
        [gateway_ dictionaryForCommand:@"refresh-client -C width,height" ...],
        // 获取隐藏窗口
        [gateway_ dictionaryForCommand:@"show -v -q -t $id @hidden" ...],
        // 获取亲和性
        [gateway_ dictionaryForCommand:@"show -v -q -t $id @affinities" ...],
        // 列出会话
        [gateway_ dictionaryForCommand:@"list-sessions -F ..." ...],
        // 列出窗口
        [gateway_ dictionaryForCommand:@"list-windows -F ..." ...],
    ];
    [gateway_ sendCommandList:commands];
}
```

#### 会话/窗格注册

```objc
// 注册窗格
- (void)registerSession:(PTYSession *)aSession
               withPane:(int)windowPane
               inWindow:(int)window {
    [self retainWindow:window withTab:tab];
    [windowPanes_ setObject:aSession forKey:@(windowPane)];
}

// 查询窗格
- (PTYSession *)sessionForWindowPane:(int)windowPane {
    return [windowPanes_ objectForKey:@(windowPane)];
}

// 查询窗口
- (PTYTab *)window:(int)window {
    return _windowStates[@(window)].tab;
}
```

#### 布局更新

```objc
- (BOOL)setLayoutInTab:(PTYTab *)tab
              toLayout:(NSString *)layout
         visibleLayout:(NSString *)visibleLayout
                zoomed:(NSNumber *)zoomed {
    TmuxWindowOpener *windowOpener = [TmuxWindowOpener windowOpener];
    windowOpener.layout = layout;
    windowOpener.visibleLayout = visibleLayout;
    windowOpener.controller = self;
    windowOpener.gateway = gateway_;
    windowOpener.zoomed = zoomed;
    return [windowOpener updateLayoutInTab:tab];
}
```

#### 用户操作处理

```objc
// 分割窗格
- (void)splitWindowPane:(int)wp
             vertically:(BOOL)splitVertically
                  scope:(iTermVariableScope *)scope
       initialDirectory:(iTermInitialDirectory *)initialDirectory
             completion:(void (^)(int wp))completion;

// 新建窗口
- (void)newWindowWithAffinity:(NSString *)windowIdString
                         size:(NSSize)size
             initialDirectory:(iTermInitialDirectory *)initialDirectory
                        index:(NSNumber *)index
                        scope:(iTermVariableScope *)scope
                   completion:(void (^)(int))completion;

// 关闭窗格
- (void)killWindowPane:(int)windowPane;

// 关闭窗口
- (void)killWindow:(int)window;

// 调整窗口大小
- (void)windowDidResize:(NSWindowController<iTermWindowController> *)term;
```

---

### VT100TmuxParser

`VT100TmuxParser` 是一个 DCS (Device Control String) 解析钩子，负责解析 tmux 控制模式的输出。

#### 工作原理

```objc
@implementation VT100TmuxParser {
    BOOL _inResponseBlock;      // 是否在 %begin/%end 块中
    BOOL _recoveryMode;         // 恢复模式
    NSMutableData *_line;       // 当前行缓冲
}

- (VT100DCSParserHookResult)handleInput:(iTermParserContext *)context
           support8BitControlCharacters:(BOOL)support8BitControlCharacters
                                  token:(VT100Token *)result {
    // 查找换行符
    int bytesTilNewline = iTermParserNumberOfBytesUntilCharacter(context, '\n');

    if (bytesTilNewline == -1) {
        // 没有换行，缓存数据等待更多输入
        [_line appendBytes:...];
        result->type = VT100_WAIT;
    } else {
        // 找到完整行，处理命令
        [_line appendBytes:...];
        if ([self processLineIntoToken:result]) {
            return VT100DCSParserHookResultUnhook;  // %exit 时退出
        }
    }
    return VT100DCSParserHookResultCanReadAgain;
}

- (BOOL)processLineIntoToken:(VT100Token *)result {
    NSString *command = [[NSString alloc] initWithData:_line encoding:NSUTF8StringEncoding];

    if ([command hasPrefix:@"%begin"]) {
        _inResponseBlock = YES;
        // 提取命令 ID
    } else if ([command hasPrefix:@"%end "] || [command hasPrefix:@"%error "]) {
        _inResponseBlock = NO;
    } else if ([command hasPrefix:@"%exit"]) {
        result->type = TMUX_EXIT;
        return YES;  // 退出控制模式
    }

    result->type = TMUX_LINE;
    result.string = command;
    return NO;
}
```

---

### TmuxWindowOpener

`TmuxWindowOpener` 负责打开 tmux 窗口，包括获取历史记录和状态。

#### 窗口打开流程

```objc
- (BOOL)openWindows:(BOOL)initial {
    // 1. 解析布局
    self.parseTree = [[TmuxLayoutParser sharedInstance] parsedLayoutFromString:self.layout];

    // 2. 遍历所有窗格，生成命令列表
    NSMutableArray *cmdList = [NSMutableArray array];
    [[TmuxLayoutParser sharedInstance] depthFirstSearchParseTree:self.parseTree
                                                 callingSelector:@selector(appendRequestsForNode:toArray:)
                                                        onTarget:self
                                                      withObject:cmdList];

    // 3. 发送命令
    [gateway_ sendCommandList:cmdList initial:initial];
    return YES;
}

// 为每个窗格生成请求
- (id)appendRequestsForNode:(NSMutableDictionary *)node toArray:(NSMutableArray *)cmdList {
    NSNumber *wp = node[kLayoutDictWindowPaneKey];

    // 获取历史记录（主屏幕）
    [cmdList addObject:[self dictForRequestHistoryForWindowPane:wp alt:NO]];
    // 获取历史记录（备用屏幕）
    [cmdList addObject:[self dictForRequestHistoryForWindowPane:wp alt:YES]];
    // 获取状态
    [cmdList addObject:[self dictForDumpStateForWindowPane:wp]];

    return nil;
}
```

#### 历史记录获取

```objc
- (NSDictionary *)dictForRequestHistoryForWindowPane:(NSNumber *)wp alt:(BOOL)alternate {
    // capture-pane -peJS- -t %wp [-a for alternate]
    NSString *command = [NSString stringWithFormat:
        @"capture-pane -peJ%@S- -t \"%%%d\"",
        alternate ? @"a" : @"",
        [wp intValue]];

    return [gateway_ dictionaryForCommand:command
                           responseTarget:self
                         responseSelector:@selector(dumpHistoryResponse:info:)
                           responseObject:@[wp, @(alternate)]
                                    flags:kTmuxGatewayCommandShouldTolerateErrors];
}
```

---

### TmuxLayoutParser

解析 tmux 布局字符串为层次结构的解析树。

#### 布局格式

tmux 布局字符串格式如：
```
checksum,WxH,x,y{layout1,layout2,...}  // 水平分割
checksum,WxH,x,y[layout1,layout2,...]  // 垂直分割
checksum,WxH,x,y,paneId                // 叶子节点
```

#### 解析结果

```objc
// 解析树节点类型
typedef NS_ENUM(NSInteger, LayoutNodeType) {
    kLeafLayoutNode,    // 叶子节点（窗格）
    kHSplitLayoutNode,  // 水平分割
    kVSplitLayoutNode   // 垂直分割
};

// 节点字典键
extern NSString *kLayoutDictNodeType;       // 节点类型
extern NSString *kLayoutDictChildrenKey;    // 子节点数组
extern NSString *kLayoutDictWidthKey;       // 宽度
extern NSString *kLayoutDictHeightKey;      // 高度
extern NSString *kLayoutDictXOffsetKey;     // X 偏移
extern NSString *kLayoutDictYOffsetKey;     // Y 偏移
extern NSString *kLayoutDictWindowPaneKey;  // 窗格 ID
extern NSString *kLayoutDictHistoryKey;     // 历史记录
extern NSString *kLayoutDictStateKey;       // 状态
```

---

### TmuxStateParser

解析窗格状态信息。

#### 状态格式

通过 `list-panes -F` 获取的格式化输出：

```objc
+ (NSString *)format {
    return @"#{pane_id} "
           @"#{cursor_x} #{cursor_y} "
           @"#{scroll_region_upper} #{scroll_region_lower} "
           @"#{pane_tabs} "
           @"#{?pane_cursor_mode,1,0} "
           @"#{?pane_insert_mode,1,0} "
           // ... 更多状态
           ;
}
```

#### 状态字典键

```objc
extern NSString *kStateDictCursorX;           // 光标 X
extern NSString *kStateDictCursorY;           // 光标 Y
extern NSString *kStateDictScrollRegionUpper; // 滚动区域上边界
extern NSString *kStateDictScrollRegionLower; // 滚动区域下边界
extern NSString *kStateDictTabstops;          // 制表位
extern NSString *kStateDictCursorMode;        // 光标模式
extern NSString *kStateDictInsertMode;        // 插入模式
extern NSString *kStateDictWrapMode;          // 换行模式
extern NSString *kStateDictMouseStandardMode; // 鼠标标准模式
```

---

## 通信协议

### tmux 控制模式协议

#### 进入控制模式

```
tmux -CC new-session    # 新会话
tmux -CC attach         # 附加会话
```

进入后发送 DCS 序列：`\033P1000p`

#### 命令/响应格式

```
命令:
new-window -n mywindow

响应:
%begin 1578920529 257 1    # 时间戳 命令号 标志
%end 1578920529 257 1

或错误:
%begin 1578923149 270 1
parse error: unknown command
%error 1578923149 270 1
```

#### 通知类型

| 通知 | 描述 |
|------|------|
| `%output %pane data` | 窗格输出 |
| `%extended-output %pane latency : data` | 带延迟的输出（流控模式） |
| `%layout-change @window layout` | 布局变化 |
| `%window-add @window` | 新增窗口 |
| `%window-close @window` | 关闭窗口 |
| `%window-renamed @window name` | 窗口重命名 |
| `%session-changed $session name` | 会话切换 |
| `%sessions-changed` | 会话列表变化 |
| `%pause %pane` | 窗格暂停（流控） |
| `%continue %pane` | 窗格继续（流控） |
| `%exit [reason]` | 退出控制模式 |

#### 输出编码

输出中小于 ASCII 32 的字符和 `\` 被编码为八进制：

```
\015 = CR
\012 = LF
\134 = \
```

---

## 数据流

### 输入流（用户 → tmux）

```
用户输入
    │
    ▼
PTYSession (tmuxMode = TMUX_CLIENT)
    │
    ▼ writeTask:
    │ 检测 self.tmuxMode == TMUX_CLIENT
    │
    ▼
TmuxGateway.sendKeys:toWindowPane:
    │
    ▼ 编码为 send -t %pane 0xNN 0xNN...
    │
    ▼
tmux server
```

### 输出流（tmux → 用户）

```
tmux server
    │
    ▼ %output %pane data 或 %extended-output
    │
    ▼
VT100TmuxParser.handleInput:
    │
    ▼ 解析为 TMUX_LINE token
    │
    ▼
PTYSession.screenHandleTmuxInput:
    │
    ▼
TmuxGateway.executeToken:
    │
    ▼ parseOutputCommandData: 或 parseExtendedOutputCommandData:
    │
    ▼
TmuxGatewayDelegate.tmuxReadTask:windowPane:latency:
    │
    ▼ 查找对应的 PTYSession
    │
    ▼
对应窗格的 PTYSession 写入终端
```

---

## 关键功能实现

### 1. 窗口大小调整

```objc
// 统一大小模式（tmux < 3.2）
- (void)setClientSize:(NSSize)size {
    // 保存大小到会话选项
    NSString *setSizeCommand = [NSString stringWithFormat:
        @"set -t $%d @iterm2_size %d,%d", sessionId_, (int)size.width, (int)size.height];

    // 刷新客户端大小
    NSString *refreshCommand = [NSString stringWithFormat:
        @"refresh-client -C %d,%d", (int)size.width, (int)size.height];

    // 重新列出窗口
    NSString *listCommand = [self commandToListWindows];

    [gateway_ sendCommandList:@[setSizeCommand, refreshCommand, listCommand]];
}

// 可变大小模式（tmux 3.2+）
- (void)setSize:(NSSize)size window:(int)window {
    NSString *command = [NSString stringWithFormat:
        @"refresh-client -C @%d:%dx%d", window, (int)size.width, (int)size.height];
    [gateway_ sendCommand:command ...];
}
```

### 2. 流控（Pause Mode）

tmux 3.2+ 支持流控，防止客户端被大量输出淹没：

```objc
- (void)enablePauseModeIfPossible {
    if (![self versionAtLeastDecimalNumberWithString:@"3.2"]) {
        return;
    }

    NSUInteger catchUpTime = [iTermPreferences unsignedIntegerForKey:kPreferenceKeyTmuxPauseModeAgeLimit];
    gateway_.pauseModeEnabled = YES;

    // 设置暂停超时
    [gateway_ sendCommand:[NSString stringWithFormat:@"refresh-client -fpause-after=%@", @(catchUpTime)]
           responseTarget:nil
         responseSelector:nil];

    // 启动缓冲区监控
    _tmuxBufferMonitor = [[iTermTmuxBufferSizeMonitor alloc] initWithController:self pauseAge:catchUpTime];
}

// 取消暂停
- (void)unpausePanes:(NSArray<NSNumber *> *)wps {
    TmuxWindowOpener *windowOpener = [TmuxWindowOpener windowOpener];
    [windowOpener unpauseWindowPanes:wps];  // 发送 refresh-client -A '%pane:continue'
}
```

### 3. 窗口亲和性（Affinity）

用于将多个 tmux 窗口组织到同一个 iTerm2 窗口中：

```objc
// 保存亲和性到 tmux 会话选项
- (void)saveAffinities {
    NSString *value = [affinities_ encodedValue];
    NSString *command = [NSString stringWithFormat:
        @"set -t $%d @affinities \"%@\"", sessionId_, value];
    [gateway_ sendCommand:command ...];
}

// 查找具有相同亲和性的窗口
- (PseudoTerminal *)windowWithAffinityForWindowId:(int)wid {
    NSSet *siblings = [affinities_ valuesEqualTo:[@(wid) stringValue]];
    for (NSString *sibling in siblings) {
        PTYTab *tab = [self window:sibling.intValue];
        if (tab) {
            return (PseudoTerminal *)tab.realParentWindow;
        }
    }
    return nil;
}
```

### 4. 光标位置同步

```objc
// VT100ScreenMutableState.m
- (void)setTmuxState:(NSDictionary *)state {
    // 同步光标位置
    self.currentGrid.cursorX = [state[kStateDictCursorX] intValue];
    self.currentGrid.cursorY = [state[kStateDictCursorY] intValue];

    // 同步滚动区域
    int top = [state[kStateDictScrollRegionUpper] intValue];
    int bottom = [state[kStateDictScrollRegionLower] intValue];
    self.currentGrid.scrollRegionRows = VT100GridRangeMake(top, bottom - top + 1);
}
```

---

## 状态管理

### 会话模式

PTYSession 有两种 tmux 模式：

```objc
typedef NS_ENUM(int, TmuxMode) {
    TMUX_NONE,      // 非 tmux 会话
    TMUX_GATEWAY,   // 网关会话（运行 tmux -CC 的会话）
    TMUX_CLIENT     // 客户端会话（tmux 窗格映射的会话）
};
```

### 通知系统

TmuxController 使用通知来广播状态变化：

```objc
// 会话相关
extern NSString *const kTmuxControllerSessionsWillChange;
extern NSString *const kTmuxControllerSessionsDidChange;
extern NSString *const kTmuxControllerDetachedNotification;
extern NSString *const kTmuxControllerAttachedSessionDidChange;
extern NSString *const kTmuxControllerSessionWasRenamed;

// 窗口相关
extern NSString *const kTmuxControllerWindowsChangeNotification;
extern NSString *const kTmuxControllerWindowWasRenamed;
extern NSString *const kTmuxControllerWindowDidOpen;
extern NSString *const kTmuxControllerWindowDidClose;
extern NSString *const kTmuxControllerDidChangeHiddenWindows;
```

### 分离流程

```objc
- (void)detach {
    self.sessionGuid = nil;
    [listSessionsTimer_ invalidate];
    detached_ = YES;

    // 关闭所有窗格
    [self closeAllPanes];

    gateway_ = nil;

    // 通知等待的回调
    [_when enumerateKeysAndObjectsUsingBlock:^(NSNumber *key, void (^obj)(PTYSession *), BOOL *stop) {
        obj(nil);
    }];
    [_when removeAllObjects];

    // 发送通知
    [[NSNotificationCenter defaultCenter] postNotificationName:kTmuxControllerDetachedNotification
                                                        object:self];

    // 从注册表移除
    [[TmuxControllerRegistry sharedInstance] setController:nil forClient:self.clientName];
}
```

---

## 总结

iTerm2 的 tmux 集成是一个复杂但设计精良的系统：

1. **分层架构**：VT100TmuxParser → TmuxGateway → TmuxController → PTYSession，职责清晰
2. **协议驱动**：利用 tmux 控制模式协议，实现双向通信
3. **状态同步**：通过状态解析器保持本地与服务器状态一致
4. **可扩展性**：支持流控、可变窗口大小等新特性
5. **健壮性**：完善的错误处理和恢复机制

这种设计可以作为实现 Tabby tmux 集成的重要参考。
