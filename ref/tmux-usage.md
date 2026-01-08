# 列出所有 pane（包含 pane ID）
tmux list-panes -a -F "#{pane_id} #{window_id} #{pane_width}x#{pane_height}"

# 列出当前 session 的所有 pane
tmux list-panes -s -F "#{pane_id}"

# 列出所有 window
tmux list-windows -a -F "#{window_id} #{window_name}"

# 更详细的 pane 信息
tmux list-panes -a -F "pane=#{pane_id} window=#{window_id} active=#{pane_active} size=#{pane_width}x#{pane_height}"

# 列出所有 session
tmux list-sessions -F "#{session_id} #{session_name}"
