## Configuration file recipes

This file lists some useful configuration file snippets to control tmux
behaviour.

### Create new panes in the same working directory

This changes the default key bindings to add the `-c` flag to specify the
working directory:

~~~~
bind '"' split-window -c "#{pane_current_path}"
bind % split-window -hc "#{pane_current_path}"
bind c new-window -c "#{pane_current_path}"
~~~~

### Prevent pane movement wrapping

This stops the pane movement keys wrapping around at the top, bottom, left and
right.

Requires tmux 2.6 or later.

~~~~
bind -r Up if -F '#{pane_at_top}' '' 'selectp -U'
bind -r Down if -F '#{pane_at_bottom}' '' 'selectp -D'
bind -r Left if -F '#{pane_at_left}' '' 'selectp -L'
bind -r Right if -F '#{pane_at_right}' '' 'selectp -R'
~~~~

### Send `Up` and `Down` keys for the mouse wheel

Some terminals do this by default when an application has not enabled the mouse
itself. This does the same in tmux (the `mouse` option must also be `on`):

~~~~
bind -n WheelUpPane if -Ft= "#{mouse_any_flag}" "send -M" "send Up"
bind -n WheelDownPane if -Ft= "#{mouse_any_flag}" "send -M" "send Down"
~~~~

An alternative is to only send the keys when in the alternate screen:

~~~~
bind -n WheelUpPane {
	if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' {
		send -M
	} {
		if -F '#{alternate_on}' { send-keys -N 3 Up } { copy-mode -e }
	}
}
bind -n WheelDownPane {
	if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' {
		send -M
	} {
		if -F '#{alternate_on}' { send-keys -N 3 Down }
	}
}
~~~~

### Make `C-b w` binding only show the one session

This makes the `C-b w` tree mode binding only show windows in the attached
session.

~~~~
bind w run 'tmux choose-tree -Nwf"##{==:##{session_name},#{session_name}}"'
~~~~

### Create a new pane to copy

This opens a new pane with the history of the active pane - useful to copy
multiple items from the history to the shell prompt.

Requires tmux 3.2 or later.

~~~~
bind C {
	splitw -f -l30% ''
	set-hook -p pane-mode-changed 'if -F "#{!=:#{pane_mode},copy-mode}" "kill-pane"'
	copy-mode -s'{last}'
}
~~~~

### C-DoubleClick to open *emacs(1)*

C-DoubleClick on a word to open *emacs(1)* in a popup (handles `file:line`).

Requires tmux 3.2 or later.

~~~~
set -g word-separators ""
bind -n C-DoubleClick1Pane if -F '#{m/r:^[^:]*:[0-9]+:,#{mouse_word}}' {
	run -C 'popup -w90% -h90% -E -d "#{pane_current_path}" "
		x=\$(echo "#{mouse_word}"|awk -F: \"{print \\\"+\\\"\\$2,\\$1}\")
		emacs "\$x"
	"'
} {
	run -C 'popup -w90% -h90% -E -d "#{pane_current_path}" "
		emacs "#{mouse_word}"
	"'
}
~~~~

### Change shortcut keys in tree mode

This assigns the shortcut keys by the window index for the current session
rather than by line number and uses `a` to `z` for higher numbers rather than
`M-a` to `M-z`. Note that this replaces the existing uses for the `a` to `z`
keys.

~~~~
bind w run -C { choose-tree -ZwK "##{?##{!=:#{session_name},##{session_name}},,##{?window_format,##{?##{e|<:##{window_index},10},##{window_index},##{?##{e|<:##{window_index},36},##{a:##{e|+:##{e|-:##{window_index},10},97}},}},}}" }
~~~~
