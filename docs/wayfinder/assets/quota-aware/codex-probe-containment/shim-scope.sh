#!/usr/bin/env bash
# Fleet process-host shim, cgroup variant. One transient scope PER SPAWN — the
# unit name must be unique, so the shim mints it and hands it back to Fleet
# through the handshake file alongside the pid.
scope="${FLEET_SCOPE_PREFIX:-fleet}-$$-$(date +%s%N).scope"
printf '%s\t%s\n' "$$" "$scope" >> "$FLEET_PID_FILE"
exec systemd-run --user --scope --quiet --collect --unit="$scope" \
  /home/kyle/.nvm/versions/node/v22.23.1/bin/codex "$@"
