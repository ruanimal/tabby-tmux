## Source code and development process

tmux is part of the OpenBSD base system and OpenBSD CVS is the primary source
repository:

https://cvsweb.openbsd.org/cgi-bin/cvsweb/src/usr.bin/tmux/

GitHub holds the portable tmux version. There are a few minor differences,
mostly for portability.

Code changes to the main tmux code are committed to OpenBSD and then a script
automatically applies any new commits to the GitHub repository every few hours.

It is fine to develop and submit code changes with a GitHub PR, but the final
form will be a patch file which is applied to OpenBSD CVS.

## Releases

tmux currently sees a new release approximately every six months - the same
schedule as OpenBSD, around May and October. This means that the GitHub
releases contain roughly the same code as OpenBSD releases (but not necessarily
exactly the same).

The release process consists of a branch from which one or more release
candidates are produced for testing, until the final release is published and
the branch removed.

## Code contributions

Here is a list of outstanding feature requests or notes for future development.
They are sorted into three sections approximately by difficulty of
implementation. If there is a GitHub issue then its number is shown in
brackets.

It is worth getting in touch before starting work, particularly on larger
items, to avoid any duplication of effort.

### Documentation

- The getting started guide on the wiki need to be updated for 3.2 and later:

  * popups

  * using marked panes with tree mode

  * changes to the extended keys documentation

- The advanced use guide is unfinished and also needs these added for 3.2 and
  later:

  * %local

  * terminal-features

### Small things

- ([#3455](https://github.com/tmux/tmux/issues/3455) Show ;; more nicely in `list-keys`
  accept it in the configuration parser.

- ([#4357](https://github.com/tmux/tmux/issues/4357)) Make `?` or `h` display
  key bindings in choose modes.

- ([#4127](https://github.com/tmux/tmux/issues/4127)) Support requesting OSC 12
  from outside terminal like OSC 10 and 11.

- ([#3488](https://github.com/tmux/tmux/issues/3488)) Allow entering and
  scrolling in copy mode when read only.

- ([#3466](https://github.com/tmux/tmux/issues/3466)) Accept ANSI colour and
  attribute sequences for styles where appropriate.

- ([#2854](https://github.com/tmux/tmux/issues/2854)) Add a `monitor-input`
  option like `monitor-activity` but that only fires when the pane has not seen
  any user input, not all types of activity.

- ([#3159](https://github.com/tmux/tmux/issues/3159)) Key to centre cursor in
  copy mode.

- ([#3061](https://github.com/tmux/tmux/issues/3061)) Format modifier to
  specify server, session, window, pane option to allow user options with the
  same name.

- ([#3047](https://github.com/tmux/tmux/issues/3047)) Expand targets as
  formats. Should this be done by default or require a prefix (maybe a leading
  `+` or just look for `#{`)?

- ([#3074](https://github.com/tmux/tmux/issues/3074)) Option to set the text
  shown with display-panes in the top right of the pane.

- It would be nice if a menu item could be prefixed by a + (like - for
  disabled) and this mean the menu should not be closed when it is selected,
  instead the item text (or all items) should be regenerated. This would mean
  toggle items could be implemented by having the item toggle an option which
  caused a change in its text.

- ([#2953](https://github.com/tmux/tmux/issues/2953)) Keep menus open on
  resize.

- ([#2840](https://github.com/tmux/tmux/issues/2840)) A way to toggle line
  selection like `rectangle-toggle`.

- ([#2766](https://github.com/tmux/tmux/issues/2766)) A flag to select-window
  to create the window, or to new-window to select.

- ([#2601](https://github.com/tmux/tmux/issues/2601)) A way to handle duplicate
  window targets (choose MRU?). Note sure if should be default or optional.

- ([#2346](https://github.com/tmux/tmux/issues/2346)) Add a flag to
  kill-session to kill a session group, and perhaps rename-session to rename
  one.

- ([#2671](https://github.com/tmux/tmux/issues/2671)) Add a `window-size
  manual-or-smallest` which uses manual size only if there are no smaller
  clients.

- It is annoying that -t= is still needed for select-window on the status line
  when it is not needed for panes.

- "After" hooks are missing for many commands that do not use CMD_AFTERHOOK.

- A command in copy mode to toggle the selection.

- It would be nice to have some more preset layouts.

- In emacs cursor movement cancels incremental search, tmux should work the
  same way.

- ([#2205](https://github.com/tmux/tmux/issues/2205)) In copy mode, should add
  incremental search with regex (new commands).

- When queueing notifications for control mode, there is no need to queue
  session notifications for sessions other than the attached one. Similarly
  for some window notifications.

- ([#3139](https://github.com/tmux/tmux/issues/3139)) An option to change
  cursor style and colour when in copy mode (or any mode?).

- In copy mode, refresh (r) will update the content but not move the scroll
  position, so the text appears to jump. It would be better to also move the
  position so there was no apparent movement.

- A toggle in copy mode to automatically refresh, either when new output is
  added - with some sort of time limit, say at most once a second - or if that
  is tricky, just once a second.

### Medium things

- ([#4329])(https://github.com/tmux/tmux/issues/4329)) &
  ([#4431](https://github.com/tmux/tmux/issues/4431)) Support SIXEL, bracket
  paste, etc in popups.

- ([#4381])(https://github.com/tmux/tmux/issues/4381)) Allow middle splits to be
  resized by `resize-pane`.

- ([#3794])(https://github.com/tmux/tmux/issues/3794)) Some way to access
  hyperlinks through commands.

- ([#4483])(https://github.com/tmux/tmux/issues/4483)) Draw command prompt with
  `format_draw` so that styles (notably alignment) can work.

- ([#3655](https://github.com/tmux/tmux/issues/3655)) Ability to change popup
  styles after it is open.

- ([#3503](https://github.com/tmux/tmux/issues/3503)) Move panes or windows by
  dragging with mouse.

- (#[3342](https://github.com/tmux/tmux/issues/3242)) Ability to synchronize
  the scrolling of two panes in copy mode.

- (#[3258](https://github.com/tmux/tmux/issues/3258)) Server-wide list of last
  used panes (and windows?) and mode to choose.

- (#[3166](https://github.com/tmux/tmux/issues/3166)) A way to number matches
  in copy mode to easily select them, and default keys to number useful stuff.

- More use of commands as their own objects:

  - Pretty print commands from list-keys etc.

  - Store commands in options (so thay can be pretty printed as well). Options
    would be better if they were not tied to the table, so the options tree
    allows any option to be any type, and set-option did the validation. Also
    if array indexes could be strings.

- ([#3036](https://github.com/tmux/tmux/issues/3036)) Could choose mode show
  multiple columns?

- ([#2484](https://github.com/tmux/tmux/issues/2797)) Highlight incoming text.

- Allow focus to be put back to pane while leaving popup open, and back to
  popup later. Problem: what if a pane is completely obscured by popup?

- A key table timeout and a key binding fired when timeout happens with the
  previous key in a format or something, would allow binding C-b 1 0 to window
  10 while keeping C-b 1 for window 1.

- ([#2537](https://github.com/tmux/tmux/issues/2537)) Copy mode should try to
  let the terminal wrap naturally if possible when redrawing so that terminal
  line copy works better. This could only happen when the terminal is the same
  width as it was when copy mode was entered. Redrawing a region would be
  difficult - have to redraw lines before in case it wraps? Maybe writing the
  copy mode screen could use grid_reader?

- ([#2495](https://github.com/tmux/tmux/issues/2495)) Per-session window
  options.

- ([#2499](https://github.com/tmux/tmux/issues/2499)) &
  ([#2512](https://github.com/tmux/tmux/issues/2512)) Add a way for
  command-prompt, confirm-before and possibly choose-tree and similar to print
  choice to stdout. Options are 1) to add flags to do it (like display-message
  -p) or 2) permit display-message -p to work when used as the choice command.

- Per line grid time tracking and use of it in copy mode and elsewhere?

- ([#2354](https://github.com/tmux/tmux/issues/2354)) Copy mode styles for the
  word and line.

- Extend the active-pane flag to windows so a client can have an independent
  current window. This can be similar to how it works for panes but is probably
  more complicated. The idea would be to get rid of session groups.

- Customize mode:
  1) way to export option or tagged options to a file;
  2) `e` key like in buffer mode to edit option value or key command in an editor popup;
  3) way to add new user options;
  4) way to add new key bindings;
  5) 'd' on a header should restore entire key table to default.

- unbind -d flag to restore key bindings to default, with -a to restore all.

- In copy mode - should the bottom be the last used line? It can be annoying to
  have to move the cursor through a load of empty space. It might be better to
  draw a line at the bottom (already have code for this) and prevent the cursor
  moving below it.

- Completion at the command prompt could be more clever: it could recognise
  commands and have some way to describe their arguments so for example only
  complete options for set-option and layouts for select-layout; it could
  complete -t with a space after it as well as without; it could complete
  special targets like {left}; it could complete panes as well as windows.
  Probably lots more things.

- Support DECSLRM margins within tmux itself.

- Should remember the last layout before select-layout was used and
  select-layout without an argument should include it, so C-Space could cycle
  through it with the preset layouts. Also a separate flag or layout name to
  restore it directly. Or how about a layout history and a way to move back? A menu?

- Should last pane be a stack like windows?

- wait-for could do more, for example being able to wait for a pane to exit or
  close (could use the existing notify code in some way). Also a flag for a
  timeout or to stop waiting on a signal.

- ([#1784](https://github.com/tmux/tmux/issues/1784)) A way to disable line
  wrap but preserve any trimmed content (so it can be viewed if the pane is
  made bigger).

- Moving, joining and otherwise reorganizing panes, windows and session should
  be easier in tree mode. This should use the marked pane rather than mixing it
  up with tagging. Maybe keys to break/join/move without leaving tree mode?
  Also dragging would be nice.

- Make the command prompt able to take up multiple lines.

- ([#918](https://github.com/tmux/tmux/issues/918)) A way to specify how panes
  are merged when one is killed. Could be an option to kill-pane.

- Allow multiple targets either with multiple -t or by giving a pattern or both.

- It would be nice to be able to remember the position in copy mode and go back
  to the same place when entering it again. How would this work if the pane
  scrolls? What about entering with the mouse?

- It would be nice to have commands to build a paste buffer in copy mode by
  doing multiple copies. It would need to display the work in progress
  somewhere (bottom left?) and have a command to add a chunk of text and a
  command to remove the last chunk and a command to clear.

- ([#1868](https://github.com/tmux/tmux/issues/1868)) Vertical-only zoom.

- ([#1774](https://github.com/tmux/tmux/issues/1774)) Resizing panes should
  move to the parent cell and resize it if this would allow the pane to
  become closer to what is requested.

- ([#3753](https://github.com/tmux/tmux/issues/3753)) Improve SIXEL placeholders.

- ([#4236](https://github.com/tmux/tmux/issues/4236)) Option to turn off pane
  borders entirely.

### Large things

- More consistent command handling (at cost of breaking all configs);

  - Commands given to other commands are all parsed immediately at parse time,
    basically either they have to be {} or strings becomes treated like {}. So
    if-shell and friends never get string arguments, only commands arguments.

  - Parser tags string arguments as " or '.

  - Before a command is executed, a callback is fired to get a format tree,
    then each " argument has formats expanded (other stuff could be expanded at
    the same time like \n which would simplify the parser).

  - %% expansion would remain a second expansion step, it could also apply only to " arguments.

  - All -F flags and inline format expansion become no-ops or removed.

  - Options would need to support commands as native arguments for both user
    options and hooks. This could be done without breaking any backwards
    compatibility.

  - command-alias is replaced with something else where the name and commands
    are given separately so the commands can be parsed up front (more like a
    function). An equivalent to the shell's argument accessor stuff like $1 and
    "$@" would need to be expanded at execution time.

  - I think some way to do execution type parsing would need to remain, an
    equivalent of eval - maybe run -C stays like this.

- Better layouts. For example it would be good if they were driven by hints
  rather than fixed positions and could be automatically reapplied after
  resize/split/kill. Pane options can be used.

- ([#1269](https://github.com/tmux/tmux/issues/1269)) Store grids in
  blocks. Can be used to reflow on demand. Would be nice to revisit how
  history-limit works - would it be better as a global limit rather than per
  pane?

- ([#2449](https://github.com/tmux/tmux/issues/2449)) Link panes into multiple
  windows.

- ([#44](https://github.com/tmux/tmux/issues/44)) &
  ([#1613](https://github.com/tmux/tmux/issues/1613)) Support for SIXEL.
