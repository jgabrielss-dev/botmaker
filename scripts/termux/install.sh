# Instalacao no Termux (Android).
# Rode dentro do Termux, na pasta do projeto:
#   bash scripts/termux/install.sh
set -e

if [ -z "${TERMUX_VERSION:-}" ] && [ ! -d /data/data/com.termux ]; then
  echo "Aviso: isto parece nao ser o Termux (Android). O 'pkg' abaixo pode falhar."
fi

echo "== Atualizando a lista de pacotes do Termux (rapido) =="
# Atualiza apenas os indices. O 'pkg upgrade -y' completo e OPCIONAL e costuma
# travar em espelhos lentos; rode manualmente se quiser:  pkg upgrade -y
pkg update -y || true

echo "== Instalando Node.js e git =="
pkg install -y nodejs git

echo "== Versoes =="
node -v
npm -v

echo "== Testando o modulo nativo node:sqlite =="
node -e "require('node:sqlite'); console.log('node:sqlite OK')"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  if [ ! -f .env.example ]; then
    echo "ERRO: nao encontrei .env.example na pasta do projeto."
    echo "Pasta atual: $ROOT"
    echo "Rode este script de dentro de ~/botmaker."
    exit 1
  fi

  cp .env.example .env
  echo ""
  echo "Criei um .env a partir do exemplo. Edite com: nano .env"
  echo "Preencha ADMIN_PASSWORD e as chaves do Mercado Pago. Deixe BASE_URL VAZIO."
fi

echo "== Instalando dependencias do projeto =="
npm install --omit=dev

echo ""
echo "Pronto! Inicie o painel com:"
echo "  bash scripts/termux/start.sh"
