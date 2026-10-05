# Pane 载入后空白 / 不更新修复总结（issue #10）

## 问题现象

- attach「载入」时，部分 window 的 pane 显示为空白，或停留在 attach 那一刻的画面
- 该 window 在这之后产生的输出全部丢失 —— 「即使有变化也不更新」
- 先切到该 window、再输入任意内容，后续输出才恢复正常同步

## 根本原因：把「快照覆盖的那一段」当成了「整个缓冲」

载入时序：

1. attach 时 tmux 会为每个 pane 发 `%output`（首屏重绘）。此时只有**当前显示的 window**
   的 pane 会被挂载成 pane tab → 只有它们有 `TmuxPaneSession`；其余 window 的 pane 输出
   全部进入 `TmuxController.pendingPaneOutput`（session.ts）。
2. batch discovery（`list-windows` → `list-panes` → `capture-pane`）对**所有 window 的所有
   pane** 生成快照 `pendingSnapshots`。
3. 用户切到隐藏 window → pane 视图挂载 → `new TmuxPaneSession()` → `registerPane()`。
   旧逻辑：只要快照 `history` 非空，就 `pendingPaneOutput.delete(paneId)` —— **整段丢弃**。

快照只覆盖「capture-pane 执行那一刻」的屏幕；而缓冲里除了这之前的首屏重绘，还包含
capture 之后到用户切窗之间的**全部新输出**（可能几分钟、几千行）。这些被一起删掉，于是
pane 只剩下 attach 时刻的旧画面，看起来就是「空白 / 不更新」，直到有新输出。

触发条件取决于「隐藏 window 的 pane 在 attach 后是否产出过输出 + 多久才切过去」，
所以表现为偶发；长会话、多 window、隐藏 window 里跑东西（回滚历史多）时命中概率和
丢失量都明显变大 —— 与使用者「看不出规律」的反馈一致。

### 附带发现的两个同源缺陷

- **快照生命周期**：`unregisterPane()` 删掉快照（正常，旧快照会渲染过期屏幕），但
  `restorePaneHistory()` 在快照缺失时只打一条 warn 就返回 —— 同一 pane 第二次挂载
  （pane tab 被销毁重建、zoom 收起等）既没有历史回滚、屏幕也是空白，直到有新输出。
- **异常安全**：`start()` 没有 try/catch，`restorePaneHistory()` 一旦抛错，后面的
  `_pendingOutput` flush 永远不执行；调用处 `paneSession.start()` 也未 await/catch，
  留下 unhandled rejection 和一个空白 pane。

## 修复

1. **按基线丢弃，而不是整段丢弃**
   - `PaneSnapshot.bufferedBaseline`：在 capture 命令**发出之前**记录该 pane 已缓冲的
     chunk 数 —— 这些 chunk 一定被快照覆盖（tmux 在执行 capture 前就已把它们写进屏幕）。
   - `registerPane()` 只丢弃 `[0, baseline)`，其余交给 session，在
     `restorePaneHistory()` 之后 replay。方向刻意保守：request 与 response 之间到达的
     chunk 可能重复渲染一次，但绝不丢失。
   - 快照为空（pane 在 shell 打印 prompt 前被捕获）时基线视为 0，全部保留 —— 保持原有
     「prompt 不能丢」的行为。
2. **快照缺失时重新捕获**：`TmuxPaneSession.start()` 在 `_gridDone` 置位之前调用
   `controller.ensurePaneSnapshot()`；捕获期间到达的实时输出仍留在 `_pendingOutput`
   （因此顺序正确），并用「捕获前已入队条数」作为 `_snapshotCovers` 跳过重复部分。
   `unregisterPane()` 丢弃旧快照是刻意的：重挂载时取当前内容，而不是渲染过期屏幕。
3. **异常安全**：`start()` 改为 try/catch/finally，restore 失败也必须 flush 缓冲并记录
   warn，不再 reject；`TmuxPaneTabComponent.initializeSession()` 对 `start()` 加 catch。

## 测试覆盖（src/session.spec.ts）

- `delivers output produced after the snapshot capture (issue #10)` —— 载入后切窗场景：
  快照内容恢复、capture 之后的输出不丢、快照已覆盖的部分不重复回放。
- `captures a fresh snapshot when the pre-loaded one is gone (issue #10)` —— 快照被消费后
  重新挂载会重新捕获当前屏幕，且不会重复回放已覆盖的输出。
- `still flushes pre-grid output when history restore fails` —— restore 抛错时缓冲仍然送达，
  且 `start()` 不再 reject。

## 复现方法（修复前）

1. tmux 里准备两个 window（w0 / w1），当前停在 w0
2. 在 w1 里跑持续输出的命令，例如 `while :; do date; sleep 1; done`
3. 从宿主终端进入 tmux 模式，**不要切窗口**，等 10~30 秒
4. 点 window bar 切到 w1：修复前显示的是 attach 时刻的画面，第 2~3 步之间的输出全部不见
