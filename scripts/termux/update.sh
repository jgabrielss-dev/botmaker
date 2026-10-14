# Atualiza o painel no celular (Android/Termux) para a ultima versao do GitHub
# e o reinicia em segundo plano. Rode dentro do Termux, na pasta do projeto:
#   bash scripts/termux/update.sh
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== Baixando atualizacoes (git pull) =="
if [ -d .git ]; then
  git pull --ff-only || echo "Aviso: 'git pull' falhou; seguindo com o codigo atual."
else
  echo "Aviso: esta pasta nao e um repositorio git (sem .git); pulei o git pull."
fi

echo "== Atualizando dependencias =="
npm install --omit=dev

echo "== Reiniciando o painel =="
bash scripts/termux/stop.sh || true
bash scripts/termux/start.sh

echo ""
echo "Pronto! Atualize a pagina no navegador do celular (http://localhost:3000)."
