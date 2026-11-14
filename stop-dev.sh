#!/usr/bin/env bash
# Stop the Cocoa Legal dev servers.
#   Backend  (Express)  -> :3004
#   Frontend (Next.js)  -> :3003
# Surgical: only touches those two ports — never your other Node/Next apps.
# Usage:  ./stop-dev.sh
set -uo pipefail

any=0
for p in 3003 3004; do
  pid=$(lsof -ti tcp:"$p" 2>/dev/null | tr '\n' ' ')
  if [ -n "${pid// /}" ]; then
    kill $pid 2>/dev/null && echo "→ stopping :$p (pid ${pid% })…"
    any=1
  else
    echo "→ :$p already stopped"
  fi
done

# Give graceful shutdown a beat, then SIGKILL anything that ignored SIGTERM.
if [ "$any" = 1 ]; then
  sleep 1
  for p in 3003 3004; do
    pid=$(lsof -ti tcp:"$p" 2>/dev/null | tr '\n' ' ')
    if [ -n "${pid// /}" ]; then
      echo "   :$p still up — forcing (SIGKILL)…"
      kill -9 $pid 2>/dev/null
    fi
  done
fi

# Final confirmation.
left=""
for p in 3003 3004; do
  pid=$(lsof -ti tcp:"$p" 2>/dev/null)
  [ -n "${pid:-}" ] && left="$left :$p"
done
if [ -n "$left" ]; then
  echo "⚠ Still listening on$left — inspect: lsof -i tcp:3003 -i tcp:3004"
else
  echo "✓ Both servers stopped. Ports 3003 / 3004 are free."
fi
