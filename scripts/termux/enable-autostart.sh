# Faz o painel subir sozinho quando o celular liga (Termux:Boot).
# Rode:  bash scripts/termux/enable-autostart.sh
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOOTDIR="$HOME/.termux/boot"
BOOTFILE="$BOOTDIR/00-painel-bots.sh"
mkdir -p "$BOOTDIR" "$ROOT/logs"

# O Termux:Boot NAO carrega o termux-exec (que traduz /usr/bin -> $PREFIX/bin no
# uso normal). Por isso o shebang precisa ser o caminho ABSOLUTO do bash do Termux
# e o PATH tem que ser definido a mao, senao 'bash'/'termux-wake-lock' nao existem.
cat > "$BOOTFILE" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# Gerado por enable-autostart.sh (Termux:Boot). Rode o script de novo para regerar.
export PATH="\$PREFIX/bin:\$PATH"
mkdir -p "$ROOT/logs"
echo "[\$(date '+%F %T')] boot: Termux:Boot executou o script" >> "$ROOT/logs/boot.log"
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
sleep 15
echo "[\$(date '+%F %T')] boot: iniciando painel" >> "$ROOT/logs/boot.log"
nohup bash "$ROOT/scripts/termux/start.sh" >> "$ROOT/logs/boot.log" 2>&1 &
EOF
chmod +x "$BOOTFILE"

echo "Autostart gravado em: $BOOTFILE"
echo "Shebang: $(head -1 "$BOOTFILE")"

# Deixa claro se o Termux:Boot esta instalado (nao faz parte do Termux).
if [ -x /system/bin/pm ] && /system/bin/pm list packages 2>/dev/null | grep -q 'package:com.termux.boot'; then
  echo "Termux:Boot: instalado."
else
  echo "ATENCAO: nao consegui confirmar o app Termux:Boot. Instale-o pelo F-Droid."
fi

echo ""
echo "Falta (fora do Termux):"
echo "  1) Instale o app Termux:Boot (F-Droid) e ABRA-O uma vez (a tela e vazia; e normal)."
echo "  2) Bateria: marca 'Sem restricoes' para Termux E para Termux:Boot."
echo "  3) Xiaomi/Samsung/Huawei: permita 'Autoinicio'/'Autostart' para o Termux:Boot."
echo ""
echo "Testar sem reiniciar:"
echo "  bash $BOOTFILE && sleep 3 && tail -n 20 $ROOT/logs/boot.log"
echo ""
echo "Depois de ligar o celular, confira:"
echo "  tail -n 20 $ROOT/logs/boot.log      # deve ter a linha 'Termux:Boot executou o script'"
echo "  bash scripts/termux/start.sh        # deve dizer 'O painel ja esta rodando'"
