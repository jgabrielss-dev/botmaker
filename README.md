# Painel de Bots Telegram — Fluxos Visuais + Pix (Mercado Pago)

Sistema completo para gerenciar **múltiplos bots do Telegram** com construtor de fluxos
(nós e trilhas), integração **Pix via Mercado Pago**, trava de pagamento, cron de
lembretes e painel **100% mobile** (feito para usar no celular).

## Stack

| Camada | Tecnologia |
|---|---|
| Front-end | HTML5 + Tailwind CSS (CDN) + JavaScript Vanilla (mobile-first) |
| Back-end | Node.js + Express |
| Banco | SQLite via `node:sqlite` nativo (sem compilação) — arquivo persistente |
| Deploy | Railway / Render / qualquer host Node 22.5+ com HTTPS |

## Estrutura de arquivos

```
telegram/
├── package.json
├── .env.example          # chaves do Mercado Pago (placeholders) + variáveis de operação
├── .gitignore
├── README.md
├── public/
│   └── index.html        # painel mobile (login, bots, builder de fluxos, clientes, Pix)
└── server/
    ├── index.js          # app Express, webhook Telegram /tg/:botId, webhook MP /mp/webhook
    ├── db.js             # SQLite (node:sqlite) e schema
    ├── auth.js           # login por senha + cookie de sessão HttpOnly
    ├── api.js            # REST do painel (/api/bots, /api/flows, /api/clients, /api/payments)
    ├── engine.js         # máquina de estados: entrada de nó, Pix, avanço, webhooks
    ├── telegram.js       # chamadas da API do Telegram (mensagens, mídia, botões, setWebhook)
    ├── mercadopago.js    # criação de Pix (/v1/payments) e consulta de status
    └── jobs.js           # inatividade (15s), sincronia de pagamentos (60s), lembrete (1h)
```

## 1. Rodar localmente

```bash
npm install
copy .env.example .env      # Windows: copie e edite (use .env real, nunca versione)
# edite o .env: ADMIN_PASSWORD, BASE_URL (opcional local), chaves do Mercado Pago
npm start
# abra http://localhost:3000
```

> Localmente os webhooks do Telegram/MP não funcionam (precisam de URL pública HTTPS),
> mas **sem `BASE_URL` o servidor entra em polling local** (`getUpdates`) e o bot
> responde normalmente na sua máquina. Para validar a lógica rode também o auto-teste: `npm test`.

## 2. Configuração (.env)

```env
MERCADO_PAGO_ACCESS_TOKEN=[cole aqui]
MERCADO_PAGO_PUBLIC_KEY=[cole aqui]
ADMIN_PASSWORD=[cole aqui]
BASE_URL=https://seu-app.up.railway.app
PORT=3000
DATA_DIR=./data
```

| Variável | Obrigatória | Descrição |
|---|---|---|
| `MERCADO_PAGO_ACCESS_TOKEN` | Sim | Access Token de produção (APP_USR-...) usado em `POST /v1/payments` |
| `MERCADO_PAGO_PUBLIC_KEY` | Sim | Public Key (usada se você quiser checkout no front) |
| `ADMIN_PASSWORD` | Sim | Senha do painel |
| `BASE_URL` | Sim (produção) | URL pública HTTPS da app — é nela que os webhooks são registrados |
| `DATA_DIR` | Não | Pasta do SQLite. Em produção use o volume (ex.: `/data`) |
| `PORT` | Não | Porta HTTP (3000 por padrão; Railway/Render definem sozinhos) |

**Segurança:** nunca commite o `.env`. Como as chaves do Mercado Pago apareceram em
texto, gere novas chaves no painel do Mercado Pago (Suas integrações → suas credenciais)
antes de publicar.

## 3. Deploy no Railway (mais rápido)

1. Crie um repositório no GitHub com este projeto e suba os arquivos.
2. Em [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**.
3. **Não precisa de domínio próprio**: Railway gera um gratuito. Na tela do projeto,
   clique no serviço → aba **Networking** → **Generate Domain** → copie o endereço
   (ex.: `xxx.up.railway.app`). Sem essa ação, não existe link público.
4. **Volumes** (aba do serviço): **+ New → Volume → Mount Path = `/data`** e depois
   **Deploy → Redeploy** (sem isso o `/data` não existe e o `DATA_DIR=/data` não serve).
   Se a opção não existir na sua conta, não cadastre `DATA_DIR` (o app sobe em pasta
   temporária, mas os dados são apagados a cada deploy).
5. **Shared variables / Variables** do serviço:
   - `ADMIN_PASSWORD` = sua senha
   - `BASE_URL` = `https://xxx.up.railway.app` (sem barra no final)
   - `MERCADO_PAGO_ACCESS_TOKEN` = `[sua chave]`
   - `MERCADO_PAGO_PUBLIC_KEY` = `[sua chave]`
   - `DATA_DIR` = `/data` **(somente com volume montado)**
   - `NODE_VERSION` = `22.5.0` (opcional, de segurança)
6. Build: nada extra (o `npm install` automático basta).
   O `engines.node >= 22.5` do `package.json` já força o Node compatível com `node:sqlite`.
7. Deploy automático. Abra `https://xxx.up.railway.app`, faça login com `ADMIN_PASSWORD`.

**Logs**: Deployments → clique no último deploy → aba **Logs**. O esperado é:
`Banco de dados em: /data/app.db` e `Painel rodando na porta 3000`.
Se aparecer `ERRO: Node ... exige Node >= 22.5`, adicione `NODE_VERSION=22.5.0`.
Sem volume, o app ainda sobe (usa pasta temporária) mas **apaga os dados a cada deploy**.

Teste depois de publicar: `https://SEU-DOMINIO/api/health` — mostra `dataDir`, se o
`BASE_URL`/token do MP foram lidos e quantos bots/fluxos existem no banco.

### ⚠️ Não use Vercel

O Vercel é **serverless**: só executa funções avulsas (não um servidor Express rodando),
o sistema de arquivos é **somente leitura** (sem volume) e o SQLite não persistiria.
Por isso o `/api/login` retorna **404** lá. Use Railway, Render ou qualquer host Node
com processo contínuo + disco (Railway/Render) ou PostgreSQL.

## 4. Deploy no Render

1. **New → Web Service** → conecte o repositório.
2. Build Command: `npm install` — Start Command: `npm start`.
3. **Disk**: crie um disco e monte em `/data`.
4. Environment: mesmas variáveis do passo 5 acima (`DATA_DIR=/data`).
5. Use a URL pública gerada (`.onrender.com`) como `BASE_URL` e reinicie o serviço.

## 5. Configuração no painel (pelo celular)

1. **Aba Bots** → cole o token do **BotFather** → *Adicionar bot*.
   O webhook `https://SEU-DOMINIO/tg/{id}` é registrado automaticamente (com secret).
2. **Aba Fluxos** → escolha o bot → *+ Novo* → abra o fluxo.
3. Monte os nós:
   - **ID**: chave do nó (ex.: `inicio`, `pay`, `obrigado`)
   - **Mensagem**: texto (aceita `<b>`, `<i>`, `<code>`)
   - **URL de mídia**: foto ou vídeo enviados pelo bot
   - **Inatividade (s)**: se o usuário não interagir, o fluxo avança sozinho
   - **Nó da inatividade**: *outro nó* para onde a inatividade leva (vazio = usar o *próximo nó*).
     O próprio nó nunca é alvo (sem loop)
   - **Valor Pix**: `> 0` trava o nó e gera o Pix Copia e Cola + QR Code
   - **Botões inline**: cada botão leva ao nó escolhido
   - **Próximo nó**: usado quando não há botão (ou depois do pagamento aprovado)
   - **Nó do lembrete**: nó usado pelo cron de 1 hora **sempre que não houver caminho**
     (fim de linha ou Pix travado)
   - **Mensagem de lembrete**: texto usado apenas se o *Nó do lembrete* estiver vazio
   - Defina o **nó inicial** no topo e toque em **Ativar**.
4. **Aba Clientes**: veja em que nó cada usuário está (Ativo / Aguardando Pix / Concluído).
5. **Aba Pix**: histórico de pagamentos com status.

## 6. Mercado Pago — webhooks

- O sistema já envia `notification_url` (`https://SEU-DOMINIO/mp/webhook`) em cada cobrança.
- Por segurança, cadastre também em **Seu account → Configurações → Webhooks**:
  - URL: `https://SEU-DOMINIO/mp/webhook`
  - Evento: **Pagamentos**
- Quando o status chega como `approved`, o usuário é desbloqueado e avança para o próximo nó.

## 7. Comportamentos automáticos (jobs)

| Job | Intervalo | O que faz |
|---|---|---|
| Inatividade | 15s | Avança para o *nó da inatividade* (ou o próximo nó) quando o timer do nó expira |
| Sincronia de pagamentos | 60s | Confere status no MP (rede de segurança caso o webhook retraie) |
| Lembrete/recuperação | 1h | Quando não há caminho (Pix travado ou fim de linha): vai para o *nó do lembrete*; sem nó definido, envia o texto de lembrete |

## 8. Variáveis do Telegram

- Cada bot tem um `secret_token` próprio: o endpoint `/tg/:id` valida o header
  `X-Telegram-Bot-Api-Secret-Token`, impedindo falsificação de updates.
- Comandos: `/start` reinicia o fluxo no nó inicial.
- **Polling local**: bot sem webhook registrado (ex.: rodando na sua máquina sem `BASE_URL`)
  é atendido por `getUpdates` a cada 2s — funciona sem domínio/HTTPS.
