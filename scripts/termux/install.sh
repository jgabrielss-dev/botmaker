# Instalacao no Termux (Android).
# Rode dentro do Termux, na pasta do projeto:
#   bash scripts/termux/install.sh
set -e

if [ -z "${TERMUX_VERSION:-}" ] && [ ! -d /data/data/com.termux ]; then
  echo "Aviso: isto parece nao ser o Termux (Android). O 'pkg' abaixo pode falhar."
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Cria o .env antes de qualquer passo que possa falhar. Assim, mesmo que a
# instalacao pare no meio, o arquivo ja existe para voce editar com 'nano .env'.
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

echo "== Atualizando a lista de pacotes do Termux (rapido) =="
# Atualiza apenas os indices. O 'pkg upgrade -y' completo e OPCIONAL e costuma
# travar em espelhos lentos; rode manualmente se quiser:  pkg upgrade -y
pkg update -y || true

# O Node atual do Termux e compilado contra uma versao nova do OpenSSL.
# Sem atualizar o openssl, o node falha com:
#   CANNOT LINK EXECUTABLE "node": cannot locate symbol "OSSL_PROVIDER_add_conf_parameter"
echo "== Atualizando o OpenSSL (exigido pelo Node atual) =="
pkg upgrade -y openssl || true

echo "== Instalando Node.js e git =="
pkg install -y nodejs git

echo "== Versoes =="
if ! node -v; then
  echo ""
  echo "ERRO: o Node nao carregou (provavel conflito de OpenSSL)."
  echo "Rode:  pkg upgrade -y"
  echo "Depois: bash scripts/termux/install.sh"
  exit 1
fi
npm -v

echo "== Testando o modulo nativo node:sqlite =="
node -e "require('node:sqlite'); console.log('node:sqlite OK')"

echo "== Instalando dependencias do projeto =="
npm install --omit=dev

echo ""
echo "Pronto! Inicie o painel com:"
echo "  bash scripts/termux/start.sh"
