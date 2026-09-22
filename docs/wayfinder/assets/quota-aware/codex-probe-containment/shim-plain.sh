#!/usr/bin/env bash
# Fleet process-host shim: record the pid we are about to become, then exec the
# real codex so the recorded pid IS the process the SDK is talking to.
printf '%s\n' "$$" >> "$FLEET_PID_FILE"
exec /home/kyle/.nvm/versions/node/v22.23.1/bin/codex "$@"
