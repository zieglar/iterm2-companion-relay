#!/usr/bin/env bash
# Raise an iTerm2 notification via OSC 9. When an iTerm2 session is attached to
# the watcher's multiplexer session, iTerm2 posts the notification and the iTerm2
# companion app forwards it to your phone.
#
# CRITICAL detail: OSC 9 is interpreted by the terminal emulator reading the tty,
# so the bytes must reach the multiplexer's pty, NOT get captured as a tool's
# stdout. We therefore write straight to /dev/tty (the controlling terminal),
# which bypasses any stdout redirection Claude's Bash tool applies. If no iTerm2
# is currently attached, screen/zellij buffers it and it appears on reattach; a
# fully-detached-and-quit iTerm2 will not push until you reattach, so keep a tab
# on the session (that same tab is what the phone drives) or lean on the email
# backstop while away.
#
# Usage: notify.sh "short message"
set -euo pipefail
msg="${*:-relay-watch alert}"

# OSC 9 notification, written to the controlling terminal. Fall back to stderr if
# there is no tty (e.g. run outside a mux), so the message is never silently lost.
if [ -w /dev/tty ]; then
  printf '\033]9;%s\007' "$msg" > /dev/tty
  printf '\a' > /dev/tty   # bell, in case notifications are muted but a tab is watched
else
  printf 'relay-watch NOTIFY (no tty): %s\n' "$msg" >&2
fi
