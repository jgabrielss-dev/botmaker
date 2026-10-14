# Instalacao no Termux (Android).
# Rode dentro do Termux, na pasta do projeto:
#   bash scripts/termux/install.sh
set -e

if [ -z "${TERMUX_VERSION:-}" ] && [ ! -d /data/data/com.termux ]; then
  echo "Aviso: isto parece nao ser o Termux (Android). O 'pkg' abaixo pode falhar."
fi

echo "== Atualizando pacotes do Termux =="
pkg update -y || true
pkg upgrade -y || true

echo "== Instalando Node.js e git =="
pkg install -y nodejs git

echo "== Versoes =="
node -v
npm -v

echo "== Testando o modulo nativo node:sqlite =="
node -e "require('node:sqlite'); console.log('node:sqlite OK')"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== Instalando dependencias do projeto =="
npm install --omit=dev

if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "Criei um .env a partir do exemplo. Edite com: nano .env"
  echo "Preencha ADMIN_PASSWORD e as chaves do Mercado Pago. Deixe BASE_URL VAZIO."
fi

echo ""
echo "Pronto! Inicie o painel com:"
echo "  bash scripts/termux/start.sh"
