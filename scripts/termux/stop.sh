# Para o painel e libera o wake-lock.
# Rode:  bash scripts/termux/stop.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

stopped=0
if [ -f logs/panel.pid ]; then
  PID="$(cat logs/panel.pid 2>/dev/null)"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    pkill -P "$PID" 2>/dev/null || true   # mata o node filho
    kill "$PID" 2>/dev/null || true       # mata o loop de reinicio
    stopped=1
  fi
  rm -f logs/panel.pid
fi
pkill -f "server/index.js" 2>/dev/null || true

if command -v termux-wake-unlock >/dev/null 2>&1; then
  termux-wake-unlock
fi

if [ "$stopped" = "1" ]; then echo "Painel parado."; else echo "Nada estava rodando."; fi
