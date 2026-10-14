# Atualiza o painel no PC/Linux/macOS para a ultima versao do GitHub.
# Rode na pasta do projeto:
#   bash scripts/update.sh
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== Baixando atualizacoes (git pull) =="
if [ -d .git ]; then
  git pull --ff-only || echo "Aviso: 'git pull' falhou; seguindo com o codigo atual."
else
  echo "Aviso: esta pasta nao e um repositorio git (sem .git); pulei o git pull."
fi

echo "== Atualizando dependencias =="
npm install

echo ""
echo "Pronto! Agora suba o painel com:  npm start"
