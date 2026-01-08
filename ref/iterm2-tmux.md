iTerm2 的 tmux 集成系统通过 `TmuxController` 作为核心控制器，使用 `TmuxGateway` 进行协议转换，实现 tmux 窗口到原生 iTerm2 窗口的映射和互操作。 [1](#2-0)

## 核心架构组件

### 1. TmuxController - 核心控制器
负责管理整个 tmux 集成生命周期，维护关键映射关系： [2](#2-1)
- `windowPanes_` - 窗格 ID 到 PTYSession 的映射
- `_windowStates` - 窗口状态管理
- `affinities_` - 窗口亲和性分组

### 2. TmuxGateway - 协议网关
处理与 tmux 服务器的通信协议转换，定义了委托协议用于事件通知： [3](#2-2)

### 3. PTYSession - 会话适配
支持三种 tmux 模式： [4](#2-3)
- `TMUX_NONE` - 非 tmux 模式
- `TMUX_GATEWAY` - 接收 tmux 协议消息
- `TMUX_CLIENT` - 会话镜像 tmux 虚拟窗口

## 通信流程

### 初始化连接
通过 `openWindowsInitial` 方法建立连接并获取会话信息： [5](#2-4)
1. 获取会话 GUID 防止重复连接
2. 设置客户端大小
3. 列出窗口和获取亲和性信息

### 输入处理
在 tmux 客户端模式下，用户输入通过 `writeTask:` 方法重定向： [6](#2-5)
- 检测 `self.tmuxMode == TMUX_CLIENT`
- 通过 `[_tmuxController gateway] sendKeys:toWindowPane:` 发送到 tmux

### 状态同步
tmux 输入通过 `terminalHandleTmuxInput:` 异步处理： [7](#2-6)
- 使用 `dispatch_group` 确保令牌按序执行
- 在主线程处理 tmux 输入令牌

## 窗口映射机制

### 窗格注册
通过 `registerSession:withPane:inWindow:` 建立映射关系： [8](#2-7)

### 动态窗口管理
`openWindowWithId:affinities:intentional:profile:` 处理新窗口打开： [9](#2-8)
1. 解析窗口亲和性确定目标标签页
2. 获取窗口详细信息
3. 创建实际的 iTerm2 窗口

### 布局同步
`setLayoutInWindow:toLayout:` 将 tmux 布局转换为 iTerm2 分割视图： [10](#2-9)

## 高级特性

### 暂停模式支持
tmux 3.2+ 支持暂停模式，通过 `enablePauseModeIfPossible` 启用： [11](#2-10)

### 版本检测
通过 `guessVersion` 系列方法检测 tmux 版本以适配不同功能： [12](#2-11)

### 键绑定集成
通过 `loadKeyBindings` 加载 tmux 键绑定并集成到 iTerm2： [13](#2-12)

## Notes

- tmux 集成使用控制模式 (`tmux -CC`)，所有操作通过协议转发
- 支持窗口位置记忆和恢复功能 [14](#2-13)
- 通过亲和性机制允许多个 tmux 窗口在同一个 iTerm2 标签页中显示
- 状态变更都是双向同步的，确保 tmux 和 iTerm2 状态一致

Wiki pages you might want to explore:
- [Overview (gnachman/iTerm2)](/wiki/gnachman/iTerm2#1)

### Citations

**File:** sources/TmuxController.m (L127-142)
```text
@implementation TmuxController {
    TmuxGateway *gateway_;
    NSMutableDictionary *windowPanes_;  // paneId -> PTYSession *
    NSMutableDictionary<NSNumber *, iTermTmuxWindowState *> *_windowStates;      // Key is window number
    NSArray<iTermTmuxSessionObject *> *sessionObjects_;
    int numOutstandingWindowResizes_;
    NSMutableDictionary *windowPositions_;
    NSSize lastSize_;  // last size for windowDidChange:
    NSString *lastOrigins_;
    NSString *sessionName_;
    int sessionId_;
    NSMutableSet *pendingWindowOpens_;
    NSString *lastSaveAffinityCommand_;
    // tmux windows that want to open as tabs in the same physical window
    // belong to the same equivalence class.
    EquivalenceClassSet *affinities_;
```

**File:** sources/TmuxController.m (L661-683)
```text
    NSString *getSessionGuidCommand = [NSString stringWithFormat:@"show -v -q -t $%d @iterm2_id",
                                       sessionId_];
    size.height = [self adjustHeightForStatusBar:size.height];
    if (size.width < 2) {
        size.width = 2;
    }
    if (size.height < 2) {
        size.height = 2;
    }
    // Set the size so that newly created windows will take the size of the profile.
    NSString *setSizeCommand = [NSString stringWithFormat:@"refresh-client -C %d,%d",
                                size.width, size.height];
    NSString *listWindowsCommand = [NSString stringWithFormat:@"list-windows -F %@", [self listWindowsDetailedFormat]];
    NSString *listSessionsCommand = @"list-sessions -F \"#{session_id} #{session_name}\"";
    NSString *getAffinitiesCommand = [NSString stringWithFormat:@"show -v -q -t $%d @affinities", sessionId_];
    NSString *getPerWindowSettingsCommand = [NSString stringWithFormat:@"show -v -q -t $%d @per_window_settings", sessionId_];
    NSString *getPerTabSettingsCommand = [NSString stringWithFormat:@"show -v -q -t $%d @per_tab_settings", sessionId_];
    NSString *getBuriedIndexesCommand = [NSString stringWithFormat:@"show -v -q -t $%d @buried_indexes", sessionId_];
    NSString *getOriginsCommand = [NSString stringWithFormat:@"show -v -q -t $%d @origins", sessionId_];
    NSString *getHotkeysCommand = [NSString stringWithFormat:@"show -v -q -t $%d @hotkeys", sessionId_];
    NSString *getTabColorsCommand = [NSString stringWithFormat:@"show -v -q -t $%d @tab_colors", sessionId_];
    NSString *getHiddenWindowsCommand = [NSString stringWithFormat:@"show -v -q -t $%d @hidden", sessionId_];

```

**File:** sources/TmuxController.m (L804-825)
```text
- (void)registerSession:(PTYSession<iTermTmuxControllerSession> *)aSession
               withPane:(int)windowPane
               inWindow:(int)window {
    PTYTab *tab = [aSession.delegate.realParentWindow tabForSession:aSession];
    ITCriticalError(tab != nil, @"nil tab for session %@ with delegate %@ with realparentwindow %@",
                    aSession, aSession.delegate, aSession.delegate.realParentWindow);
    if (tab) {
        [self retainWindow:window withTab:tab];
        [windowPanes_ setObject:aSession forKey:[self _keyForWindowPane:windowPane]];
        void (^call)(PTYSession<iTermTmuxControllerSession> *) = _when[@(windowPane)];
        if (call) {
            dispatch_async(dispatch_get_main_queue(), ^{
                call(aSession);
            });
            [_when removeObjectForKey:@(windowPane)];
        }
        if (_paneToActivateWhenCreated == windowPane) {
            [aSession revealIfTabSelected];
            _paneToActivateWhenCreated = -1;
        }
    }
}
```

**File:** sources/TmuxController.m (L1141-1162)
```text
- (void)enablePauseModeIfPossible {
    DLog(@"enablePauseModeIfPossible min=%@ max=%@", gateway_.minimumServerVersion, gateway_.maximumServerVersion);
    if (gateway_.minimumServerVersion &&
        [gateway_.minimumServerVersion compare:[NSDecimalNumber decimalNumberWithString:@"3.2"]] == NSOrderedAscending) {
        DLog(@"min < 3.2");
        return;
    }
    if (!gateway_.minimumServerVersion) {
        DLog(@"have no min version");
        return;
    }
    NSUInteger catchUpTime = [iTermPreferences unsignedIntegerForKey:kPreferenceKeyTmuxPauseModeAgeLimit];
    gateway_.pauseModeEnabled = YES;
    const NSInteger age = MAX(1, round(catchUpTime));
    DLog(@"Enable pause-after=%@", @(age));
    [gateway_ sendCommand:[NSString stringWithFormat:@"refresh-client -fpause-after=%@", @(age)]
           responseTarget:nil
         responseSelector:nil];
    _tmuxBufferMonitor = [[iTermTmuxBufferSizeMonitor alloc] initWithController:self
                                                                       pauseAge:age];
    _tmuxBufferMonitor.delegate = self;
}
```

**File:** sources/TmuxController.m (L1300-1302)
```text
- (void)loadKeyBindings {
    [gateway_ sendCommand:@"list-keys" responseTarget:self responseSelector:@selector(handleListKeys:)];
}
```

**File:** sources/TmuxController.m (L1432-1440)
```text
- (void)guessVersion {
    // Run commands that will fail in successively older versions.
    // show-window-options pane-border-format will succeed in 2.3 and later (presumably. 2.3 isn't out yet)
    // the socket_path format was added in 2.2.
    // the session_activity format was added in 2.1
    NSArray *commands = @[ [gateway_ dictionaryForCommand:@"display-message -p \"#{version}\""
                                           responseTarget:self
                                         responseSelector:@selector(handleDisplayMessageVersion:)
                                           responseObject:nil
```

**File:** sources/TmuxController.m (L2240-2267)
```text
            _pendingWindows[@(windowId)] = [iTermTmuxPendingWindow trivialInstance];
        }
        [hiddenWindows_ removeObject:[NSNumber numberWithInt:windowId]];
        [self saveHiddenWindows];
        [[NSNotificationCenter defaultCenter] postNotificationName:kTmuxControllerDidChangeHiddenWindows object:self];
    }
    __block NSNumber *tabIndex = _pendingWindows[@(windowId)].index;
    [_buriedWindows enumerateKeysAndObjectsUsingBlock:^(NSString * _Nonnull terminalGUID, NSMutableArray<iTermTuple<NSNumber *, NSNumber *> *> * _Nonnull tuples, BOOL * _Nonnull stop) {
        const NSInteger i = [tuples indexOfObjectPassingTest:^BOOL(iTermTuple<NSNumber *,NSNumber *> * _Nonnull obj, NSUInteger idx, BOOL * _Nonnull stop) {
            return [obj.firstObject isEqual:@(windowId)];
        }];
        if (i != NSNotFound) {
            tabIndex = tuples[i].secondObject;
            [tuples removeObjectAtIndex:i];
            DLog(@"Add affinities for terminal %@: %@", terminalGUID, [[tuples mapWithBlock:^id(iTermTuple *anObject) {
                return anObject.description;
            }] componentsJoinedByString:@", "]);
            [affinities_ setValue:[@(windowId) stringValue] equalToValue:terminalGUID];
        }
    }];
    // Get the window's basic info to prep the creation of a TmuxWindowOpener.
    [gateway_ sendCommand:[NSString stringWithFormat:@"display -p -F %@ -t @%d",
                           [self listWindowsDetailedFormat], windowId]
           responseTarget:self
         responseSelector:@selector(listedWindowsToOpenOne:forWindowIdAndAffinities:)
           responseObject:@[ @(windowId), affinities, profile, tabIndex ?: @-1 ]
                    flags:kTmuxGatewayCommandShouldTolerateErrors];
}
```

**File:** sources/TmuxController.m (L2299-2313)
```text
- (NSValue *)positionForWindowWithPanes:(NSArray *)panes
                               windowID:(int)windowID {
    NSValue *pos = nil;
    for (NSNumber *n in panes) {
        pos = [windowPositions_ objectForKey:n];
        if (pos) {
            break;
        }
    }
    [windowPositions_ removeObjectsForKeys:panes];
    if ([iTermAdvancedSettingsModel disableTmuxWindowPositionRestoration]) {
        return nil;
    }
    return pos ?: origins_[@(windowID)];
}
```

**File:** sources/TmuxController.m (L2724-2730)
```text
- (void)setLayoutInWindow:(int)window toLayout:(NSString *)layout {
    NSArray *commands = @[ [gateway_ dictionaryForCommand:[NSString stringWithFormat:@"select-layout -t @%@ %@",
                                                           @(window), layout]
                                           responseTarget:self
                                         responseSelector:@selector(didSetLayout:)
                                           responseObject:nil
                                                    flags:0],
```

**File:** sources/TmuxGateway.h (L34-70)
```text
@protocol TmuxGatewayDelegate <NSObject>

- (TmuxController *)tmuxController;
- (BOOL)tmuxUpdateLayoutForWindow:(int)windowId
                           layout:(NSString *)layout
                    visibleLayout:(NSString *)visibleLayout
                           zoomed:(NSNumber *)zoomed
                             only:(BOOL)only;
- (void)tmuxWindowAddedWithId:(int)windowId;
- (void)tmuxWindowClosedWithId:(int)windowId;
- (void)tmuxWindowRenamedWithId:(int)windowId to:(NSString *)newName;
- (void)tmuxHostDisconnected:(NSString *)dcsID;
- (void)tmuxWriteString:(NSString *)string;
- (void)tmuxReadTask:(NSData *)data windowPane:(int)wp latency:(NSNumber *)latency;
- (void)tmuxSessionChanged:(NSString *)sessionName
				 sessionId:(int)sessionId;
- (void)tmuxSessionsChanged;
- (void)tmuxWindowsDidChange;
- (void)tmuxSession:(int)sessionId renamed:(NSString *)newName;
- (VT100GridSize)tmuxClientSize;
- (NSInteger)tmuxNumberOfLinesOfScrollbackHistory;
- (void)tmuxSetSecureLogging:(BOOL)secureLogging;
- (void)tmuxPrintLine:(NSString *)line;
- (NSWindowController<iTermWindowController> *)tmuxGatewayWindow;
- (void)tmuxInitialCommandDidCompleteSuccessfully;
- (void)tmuxInitialCommandDidFailWithError:(NSString *)error;
- (void)tmuxCannotSendCharactersInSupplementaryPlanes:(NSString *)string windowPane:(int)windowPane;
- (void)tmuxDidOpenInitialWindows;
- (void)tmuxDoubleAttachForSessionGUID:(NSString *)sessionGUID;
- (NSString *)tmuxOwningSessionGUID;
- (BOOL)tmuxGatewayShouldForceDetach;
- (void)tmuxGatewayDidTimeOutDuringInitialization:(BOOL)duringInitialization;
- (void)tmuxActiveWindowPaneDidChangeInWindow:(int)windowID toWindowPane:(int)paneID;
- (void)tmuxSessionWindowDidChangeTo:(int)windowID;
- (void)tmuxWindowPaneDidPause:(int)wp notification:(BOOL)notification;
- (void)tmuxSessionPasteDidChange:(NSString *)pasteBufferName;
@end
```

**File:** sources/PTYSession.h (L111-115)
```text
typedef enum {
    TMUX_NONE,
    TMUX_GATEWAY,  // Receiving tmux protocol messages
    TMUX_CLIENT  // Session mirrors a tmux virtual window
} PTYSessionTmuxMode;
```

**File:** sources/PTYSession.m (L3810-3824)
```text
    if (self.tmuxMode == TMUX_CLIENT || _conductor.handlesKeystrokes || _connectingSSH) {
        [self setBell:NO];
        if ([[_delegate realParentWindow] broadcastInputToSession:self]) {
            [[_delegate realParentWindow] sendInputToAllSessions:string
                                                        encoding:optionalEncoding
                                                   forceEncoding:forceEncoding];
        } else if (_conductor.handlesKeystrokes) {
            [_conductor sendKeys:[string dataUsingEncoding:encoding]];
        } else if (_connectingSSH) {
            [_queuedConnectingSSH appendData:[string dataUsingEncoding:encoding]];
        } else {
            assert(self.tmuxMode == TMUX_CLIENT);
            [[_tmuxController gateway] sendKeys:string
                                   toWindowPane:self.tmuxPane];
        }
```

**File:** sources/VT100ScreenMutableState+TerminalDelegate.m (L1383-1410)
```text
- (void)terminalHandleTmuxInput:(VT100Token *)token {
    DLog(@"begin %@", token);
    if (!_tmuxGroup) {
        _tmuxGroup = dispatch_group_create();
    }
    dispatch_group_enter(_tmuxGroup);
    if (token->type == TMUX_EXIT) {
        // Pause so that the "Detached" message can be appended before any more tokens
        // are handled. That's added as a high-pri task and will therefore run before
        // the token executor handles another token post-unpause.
        iTermTokenExecutorUnpauser *unpauser = [self.tokenExecutor pause];
        dispatch_async(dispatch_get_main_queue(), ^{
            DLog(@"finish handling exit");
            id<VT100ScreenDelegate> delegate = self.sideEffectPerformer.sideEffectPerformingScreenDelegate;
            [delegate screenHandleTmuxInput:token];
            [unpauser unpause];
            dispatch_group_leave(self->_tmuxGroup);
        });
        return;
    }

    dispatch_async(dispatch_get_main_queue(), ^{
        DLog(@"on main queue for %@", token);
        id<VT100ScreenDelegate> delegate = self.sideEffectPerformer.sideEffectPerformingScreenDelegate;
        [delegate screenHandleTmuxInput:token];
        DLog(@"leave group");
        dispatch_group_leave(self->_tmuxGroup);
    });
```
