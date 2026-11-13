#!/usr/bin/env bash
# Restart the Coco Legal dev servers, detached so they survive your terminal.
#   Backend  (Express)  -> http://localhost:3004
#   Frontend (Next.js)  -> http://localhost:3003
# Usage:  ./restart-dev.sh        (run from anywhere; resolves its own path)
# Logs:   /tmp/coco-backend.log  and  /tmp/coco-frontend.log
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "→ Clearing ports 3003 / 3004…"
for p in 3003 3004; do
  pid=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2; exit}')
  if [ -n "${pid:-}" ]; then kill "$pid" 2>/dev/null && echo "   cleared :$p (pid $pid)"; fi
done

echo "→ Starting backend (:3004)…"
( cd "$ROOT/backend"  && nohup npm run dev            > /tmp/coco-backend.log  2>&1 & ) ; disown 2>/dev/null || true

echo "→ Starting frontend (:3003)…"
( cd "$ROOT/frontend" && nohup npm run dev -- -p 3003 > /tmp/coco-frontend.log 2>&1 & ) ; disown 2>/dev/null || true

echo "→ Waiting for health…"
if curl -sS --retry 40 --retry-delay 1 --retry-connrefused --max-time 60 http://localhost:3004/health >/dev/null 2>&1; then
  echo "   ✓ backend  :3004 up"
else
  echo "   ✗ backend  :3004 did NOT come up — see /tmp/coco-backend.log"
fi
if curl -sS -o /dev/null --retry 45 --retry-delay 2 --retry-connrefused --max-time 120 http://localhost:3003/assistant 2>/dev/null; then
  echo "   ✓ frontend :3003 up"
else
  echo "   ✗ frontend :3003 did NOT come up — see /tmp/coco-frontend.log"
fi

echo ""
echo "Done. Open → http://localhost:3003/assistant"
echo "Tail logs: tail -f /tmp/coco-backend.log  |  tail -f /tmp/coco-frontend.log"
