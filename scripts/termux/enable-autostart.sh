# Faz o painel subir sozinho quando o celular liga (Termux:Boot).
# Rode:  bash scripts/termux/enable-autostart.sh
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$HOME/.termux/boot"

cat > "$HOME/.termux/boot/00-painel-bots.sh" <<EOF
#!/usr/bin/env bash
termux-wake-lock
sleep 15
nohup bash "$ROOT/scripts/termux/start.sh" >/dev/null 2>&1 &
EOF
chmod +x "$HOME/.termux/boot/00-painel-bots.sh"

echo "Autostart instalado: ~/.termux/boot/00-painel-bots.sh"
echo ""
echo "Falta:"
echo "  1) Instale o app Termux:Boot (F-Droid) e abra-o UMA vez."
echo "  2) Desative a otimizacao de bateria para Termux e Termux:Boot."
