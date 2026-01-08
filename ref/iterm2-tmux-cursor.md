在 tmux 集成模式下，iTerm2 通过特殊的状态同步机制来处理用户输入的光标位置。

## 核心处理机制

### 1. 光标位置状态同步

当 tmux 状态更新时，`VT100ScreenMutableState` 的 `setTmuxState:` 方法负责同步光标位置 [1](#0-0) ：

```objective-c
self.currentGrid.cursorX = [state[kStateDictCursorX] intValue];
self.currentGrid.cursorY = [state[kStateDictCursorY] intValue];
```

这确保了 iTerm2 的本地光标位置与 tmux 服务器端保持一致。

### 2. 用户输入处理流程

在 tmux 客户端模式下，用户输入通过 `PTYSession` 的 `writeTask:` 方法处理 [2](#0-1) ：

- 检测 `self.tmuxMode == TMUX_CLIENT`
- 通过 `[_tmuxController gateway] sendKeys:toWindowPane:` 发送按键到对应的 tmux 窗格
- 输入不会直接写入 PTY，而是通过 tmux 协议转发

### 3. 光标移动的坐标计算

当用户点击移动光标时，`PTYTextView` 的 `placeCursorOnCurrentLineWithEvent:` 方法计算目标坐标 [3](#0-2) ：

```objective-c
NSPoint clickPoint = [self clickPoint:event allowRightMarginOverflow:NO];
VT100GridCoord target = VT100GridCoordMake(clickPoint.x, clickPoint.y);
```

然后生成相应的光标移动命令序列发送给 tmux。

### 4. tmux 输入的异步处理

tmux 输入通过 `terminalHandleTmuxInput:` 方法异步处理 [4](#0-3) ：

- 使用 `dispatch_group` 确保 tmux 令牌按序执行
- 在主线程上处理 tmux 输入令牌
- 暂停令牌执行器直到 tmux 操作完成

## 关键设计特点

1. **状态驱动**：光标位置由 tmux 服务器端状态驱动，而非本地计算
2. **协议转发**：所有用户输入通过 tmux 控制协议转发，包括光标移动命令
3. **异步同步**：使用 dispatch 机制确保 tmux 状态更新的线程安全
4. **坐标映射**：将屏幕点击坐标转换为 tmux 网格坐标进行传输

这种设计确保了在 tmux 集成模式下，光标位置始终与 tmux 服务器端保持同步，避免了状态不一致的问题。

## Notes

- tmux 模式下的光标位置处理与普通终端模式有本质区别，前者是状态同步，后者是直接控制
- 光标位置的保存和恢复逻辑在 `VT100Terminal` 中实现，支持主屏幕和备用屏幕的不同光标状态 [5](#0-4)
- Metal 渲染器中的光标绘制逻辑与 tmux 状态管理是独立的，只负责显示当前光标位置 [6](#0-5)

Wiki pages you might want to explore:
- [Overview (gnachman/iTerm2)](/wiki/gnachman/iTerm2#1)
- [Core Architecture (gnachman/iTerm2)](/wiki/gnachman/iTerm2#2)

### Citations

**File:** sources/VT100ScreenMutableState.m (L5544-5548)
```text
    self.currentGrid.cursorX = [state[kStateDictCursorX] intValue];
    self.currentGrid.cursorY = [state[kStateDictCursorY] intValue];
    int top = [state[kStateDictScrollRegionUpper] intValue];
    int bottom = [state[kStateDictScrollRegionLower] intValue];
    self.currentGrid.scrollRegionRows = VT100GridRangeMake(top, bottom - top + 1);
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

**File:** sources/PTYTextView.m (L3868-3877)
```text
- (void)placeCursorOnCurrentLineWithEvent:(NSEvent *)event
                               verticalOk:(BOOL)verticalOk {
    DLog(@"PTYTextView placeCursorOnCurrentLineWithEvent BEGIN %@", event);

    NSPoint clickPoint = [self clickPoint:event allowRightMarginOverflow:NO];
    VT100GridCoord target = VT100GridCoordMake(clickPoint.x, clickPoint.y);
    VT100Output *terminalOutput = [_dataSource terminalOutput];

    VT100GridCoord cursor = VT100GridCoordMake([_dataSource cursorX] - 1,
                                               [_dataSource absoluteLineNumberOfCursor] - [_dataSource totalScrollbackOverflow]);
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

**File:** sources/VT100Terminal.m (L1516-1533)
```text
- (void)saveCursor {
    self.dirty = YES;
    VT100SavedCursor *savedCursor = [self savedCursor];

    savedCursor->position = VT100GridCoordMake([_delegate terminalCursorX] - 1,
                                               [_delegate terminalCursorY] - 1);
    savedCursor->charset = _charset;

    for (int i = 0; i < NUM_CHARSETS; i++) {
        savedCursor->lineDrawing[i] = [_delegate terminalLineDrawingFlagForCharset:i];
    }
    savedCursor->graphicRendition = graphicRendition_;
    savedCursor->origin = self.originMode;
    savedCursor->wraparound = self.wraparoundMode;
    savedCursor->unicodeVersion = [_delegate terminalUnicodeVersion];
    savedCursor->protectedMode = _protectedMode;
    savedCursor->invalid = NO;
}
```

**File:** sources/Metal/iTermMetalDriver.m (L1240-1288)
```text
    if (cursorInfo.copyMode) {
        iTermCopyModeCursorRendererTransientState *tState = [frameData transientStateForRenderer:_copyModeCursorRenderer];
        tState.selecting = cursorInfo.copyModeCursorSelecting;
        tState.coord = cursorInfo.copyModeCursorCoord;
    }
    if (cursorInfo.cursorVisible && cursorInfo.password) {
        iTermCursorRendererTransientState *tState = [frameData transientStateForRenderer:_keyCursorRenderer];
        tState.coord = cursorInfo.coord;
        tState.backgroundIsDark = SIMDPerceivedBrightness(cursorInfo.backgroundColor) < 0.5;
    } else if (cursorInfo.cursorVisible) {
        switch (cursorInfo.type) {
            case CURSOR_UNDERLINE: {
                iTermCursorRendererTransientState *tState = [frameData transientStateForRenderer:_underlineCursorRenderer];
                tState.coord = cursorInfo.coord;
                tState.color = cursorInfo.cursorColor;
                tState.doubleWidth = cursorInfo.doubleWidth;

                iTermCursorRendererTransientState *shadowTState = [frameData transientStateForRenderer:_horizontalShadowCursorRenderer];
                shadowTState.coord = cursorInfo.coord;
                shadowTState.color = cursorInfo.cursorColor;
                shadowTState.doubleWidth = cursorInfo.doubleWidth;
                break;
            }
            case CURSOR_BOX: {
                iTermCursorRendererTransientState *tState = [frameData transientStateForRenderer:_blockCursorRenderer];
                tState.coord = cursorInfo.coord;
                tState.color = cursorInfo.cursorColor;
                tState.doubleWidth = cursorInfo.doubleWidth;

                tState = [frameData transientStateForRenderer:_frameCursorRenderer];
                tState.coord = cursorInfo.coord;
                tState.color = cursorInfo.cursorColor;
                tState.doubleWidth = cursorInfo.doubleWidth;
                break;
            }
            case CURSOR_VERTICAL: {
                iTermCursorRendererTransientState *tState = [frameData transientStateForRenderer:_barCursorRenderer];
                tState.coord = cursorInfo.coord;
                tState.color = cursorInfo.cursorColor;

                iTermCursorRendererTransientState *shadowTState = [frameData transientStateForRenderer:_verticalShadowCursorRenderer];
                shadowTState.coord = cursorInfo.coord;
                shadowTState.color = cursorInfo.cursorColor;
                break;
            }
            case CURSOR_DEFAULT:
                break;
        }
    }
```
