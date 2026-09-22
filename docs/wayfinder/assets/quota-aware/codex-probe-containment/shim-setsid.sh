#!/usr/bin/env bash
# Fleet process-host shim, containment variant: put the whole Codex tree in its
# own session so Fleet can signal it as a process group without touching itself.
# The session leader's pid is its pgid, which is what Fleet records.
exec setsid --wait bash -c '
  printf "%s\n" "$$" >> "$FLEET_PID_FILE"
  exec /home/kyle/.nvm/versions/node/v22.23.1/bin/codex "$@"
' fleet-codex "$@"
