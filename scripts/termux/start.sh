# Inicia o painel no celular (Android/Termux) em SEGUNDO PLANO, com wake-lock.
# Rode:  bash scripts/termux/start.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
mkdir -p logs

running() {
  [ -f logs/panel.pid ] && kill -0 "$(cat logs/panel.pid 2>/dev/null)" 2>/dev/null
}

# --- Sem --foreground: apenas daemoniza (roda a si mesmo em background) ---
if [ "${1:-}" != "--foreground" ]; then
  if running; then
    echo "O painel ja esta rodando (pid $(cat logs/panel.pid))."
    exit 0
  fi
  nohup bash "$0" --foreground >/dev/null 2>&1 &
  sleep 1
  echo "Painel iniciado em segundo plano."
  echo "Abra no navegador do celular: http://localhost:${PORT:-3000}"
  echo "Log: logs/server.log  |  Parar: bash scripts/termux/stop.sh"
  exit 0
fi

# ================= daqui pra baixo e o servidor =================

# Segura o Android acordado (evita suspender o Termux).
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
fi

if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
export DATA_DIR="${DATA_DIR:-$ROOT/data}"
export PORT="${PORT:-3000}"
export BASE_URL="${BASE_URL:-}"   # vazio = modo celular (polling, sem URL publica)

echo $$ > logs/panel.pid
echo "[$(date '+%F %T')] painel iniciado (porta $PORT)" >> logs/server.log

fails=0
while true; do
  echo "[$(date '+%F %T')] iniciando servidor" >> logs/server.log
  start=$(date +%s)
  node server/index.js >> logs/server.log 2>&1
  code=$?
  dur=$(( $(date +%s) - start ))

  # rodou por pelo menos 10s? foi so um restart normal e zera as falhas seguidas.
  if [ "$dur" -ge 10 ]; then
    fails=0
  else
    fails=$((fails + 1))
  fi

  # erro que se repete (ex.: node quebrado) desacelera em vez de tentar a cada 3s
  if [ "$fails" -ge 5 ]; then
    delay=60
  elif [ "$fails" -ge 3 ]; then
    delay=15
  else
    delay=3
  fi

  echo "[$(date '+%F %T')] servidor saiu (codigo $code, ${dur}s); reiniciando em ${delay}s (falhas seguidas: $fails)" >> logs/server.log
  sleep "$delay"
done
