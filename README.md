# Painel de Bots Telegram — Fluxos Visuais + Pix (Mercado Pago)

Sistema completo para gerenciar **múltiplos bots do Telegram** com construtor de fluxos
(nós e trilhas), integração **Pix via Mercado Pago**, trava de pagamento, cron de
lembretes, **mídia múltipla (URLs e/ou arquivos locais)**, **convites de grupo de uso
único** e painel **100% mobile** (feito para usar no celular).

> **Sem pagar hospedagem.** O app roda **dentro do seu celular Android** (via Termux),
> em segundo plano. Enquanto o celular estiver com internet, os bots funcionam — e
> **não precisa de domínio, HTTPS ou volume**. Veja a **seção 2**.

## Stack

| Camada | Tecnologia |
|---|---|
| Front-end | HTML5 + Tailwind CSS (CDN) + JavaScript Vanilla (mobile-first) • **PWA instalável** |
| Back-end | Node.js + Express |
| Banco | SQLite via `node:sqlite` nativo (sem compilação) — arquivo persistente |
| Onde roda | **Celular Android (Termux, grátis)** • PC • Railway / Render • qualquer VPS Node 22.5+ |

## Estrutura de arquivos

```
telegram/
├── package.json
├── .env.example          # chaves do Mercado Pago (placeholders) + variáveis de operação
├── .gitignore
├── README.md
├── public/
│   ├── index.html              # painel mobile (login, bots, builder de fluxos, grupos, clientes, Pix)
│   ├── manifest.webmanifest    # PWA: instalar o painel na tela inicial
│   ├── sw.js                   # service worker (sem cache)
│   └── icon-192.png / icon-512.png
├── scripts/
│   ├── selftest.js             # auto-teste do backend (fetch mockado)
│   └── termux/                 # rodar no celular Android
│       ├── install.sh          # instala Node + dependências
│       ├── start.sh            # sobe o painel em segundo plano (wake-lock)
│       ├── stop.sh             # para o painel
│       └── enable-autostart.sh # sobe sozinho quando o celular liga
└── server/
    ├── index.js          # app Express, webhook Telegram /tg/:botId, webhook MP /mp/webhook, /uploads
    ├── db.js             # SQLite (node:sqlite) e schema (bots, flows, clients, payments, groups)
    ├── auth.js           # login por senha + cookie de sessão HttpOnly
    ├── api.js            # REST do painel (/api/bots, /api/flows, /api/groups, /api/uploads, ...)
    ├── engine.js         # máquina de estados: entrada de nó, Pix, avanço, webhooks
    ├── telegram.js       # API do Telegram (mensagens, mídia múltipla, botões, convites, webhook)
    ├── mercadopago.js    # criação de Pix (/v1/payments) e consulta de status
    ├── poll.js           # polling local (getUpdates) p/ bots sem webhook
    └── jobs.js           # inatividade (15s), sincronia de pagamentos (60s), lembretes (30min)
```

## 1. Rodar no PC (teste local)

```bash
npm install
copy .env.example .env      # Windows: copie e edite (use .env real, nunca versione)
# edite o .env: ADMIN_PASSWORD, BASE_URL (opcional), chaves do Mercado Pago
npm start
# abra http://localhost:3000
```

> Sem `BASE_URL` o servidor entra em **polling local** (`getUpdates`) e o bot responde
> normalmente na sua máquina — **não precisa de URL pública**. O Pix é confirmado pelo
> job de 60s. Para validar a lógica rode também o auto-teste: `npm test`.

## 2. Rodar no celular (Android + Termux) — grátis, sem servidor

A ideia: o **próprio celular** roda o servidor em segundo plano. O painel é acessado no
navegador do celular (`http://localhost:3000`) e pode ser **instalado como app**.
Como usa **polling**, não precisa de domínio, HTTPS nem IP público — basta internet.

**Pré-requisitos**

- Android. Instale o **Termux** pelo **F-Droid** (a versão da Play Store é antiga/descontinuada).
  Baixe em: `https://f-droid.org/packages/com.termux/`
- (Opcional, para subir sozinho ao ligar) o app **Termux:Boot**, também pelo F-Droid.

**Passo a passo**

1. Abra o Termux e baixe o projeto:
   ```bash
   pkg install -y git
   git clone https://github.com/jgabrielss-dev/botmaker
   cd botmaker
   ```
   *(se o código já estiver no celular, basta entrar na pasta do projeto)*

2. Instale Node.js e as dependências:
   ```bash
   bash scripts/termux/install.sh
   ```
   Isso roda `pkg install nodejs` (Node 24, já com `node:sqlite`) e `npm install`.

3. Preencha o `.env` (o instalador já criou um a partir do exemplo):
   ```bash
   nano .env
   ```
   - `ADMIN_PASSWORD` = sua senha do painel
   - `MERCADO_PAGO_ACCESS_TOKEN` e `MERCADO_PAGO_PUBLIC_KEY` = suas chaves do Mercado Pago
   - **`BASE_URL=` (deixe vazio!)** → modo celular (polling + Pix pelo job de 60s)
   - Salve com `Ctrl+O`, `Enter` e saia com `Ctrl+X`.

4. Suba o painel (em segundo plano, com wake-lock):
   ```bash
   bash scripts/termux/start.sh
   ```

5. Abra no navegador do celular: **`http://localhost:3000`** e faça login.

6. **Instale como app:** no Chrome, menu **⋮ → Adicionar à tela inicial**. O painel
   abre em tela cheia, como um app.

**Manter rodando 24h (importante)**

O Android suspende apps em segundo plano. Para o painel não cair:

- O `start.sh` já ativa o **wake-lock** do Termux (`termux-wake-lock`).
- **Desative a otimização de bateria** para o Termux (e para o Termux:Boot):
  *Configurações → Apps → Termux → Bateria → Sem restrições*.
- Em alguns aparelhos (Xiaomi, Samsung, Huawei…), fixe o Termux na tela de recentes
  (“bloquear”/“travar” o app) e permita **autoinício**.
- **Autostart ao ligar o celular:** rode `bash scripts/termux/enable-autostart.sh`,
  instale o app **Termux:Boot** e abra-o uma vez.

**Comandos úteis**

```bash
tail -f logs/server.log        # ver o log ao vivo
bash scripts/termux/stop.sh    # parar o painel
bash scripts/termux/start.sh   # subir de novo
```

**Observações**

- Os dados (SQLite + uploads) ficam em `~/botmaker/data`.
- **Android 16:** se o painel não abrir com o Termux em segundo plano, traga o Termux
  para a frente por um instante. Como alternativa, acesse de outro aparelho na mesma
  Wi-Fi: o `start.sh`/log mostra o endereço `http://<ip-do-celular>:3000`.
- **iOS:** não é possível rodar o servidor no iPhone (não existe Termux). Dá pra usar o
  painel só como PWA apontando para um servidor (seção 4 ou 1).

## 3. Configuração (.env)

```env
MERCADO_PAGO_ACCESS_TOKEN=[cole aqui]
MERCADO_PAGO_PUBLIC_KEY=[cole aqui]
ADMIN_PASSWORD=[cole aqui]
BASE_URL=                 # vazio = modo celular/polling
PORT=3000
DATA_DIR=./data
```

| Variável | Obrigatória | Descrição |
|---|---|---|
| `MERCADO_PAGO_ACCESS_TOKEN` | Sim (p/ Pix) | Access Token de produção (APP_USR-...) usado em `POST /v1/payments` |
| `MERCADO_PAGO_PUBLIC_KEY` | Sim (p/ Pix) | Public Key (usada se você quiser checkout no front) |
| `ADMIN_PASSWORD` | Sim | Senha do painel (padrão `admin` se ausente) |
| `BASE_URL` | Não | URL pública HTTPS. **Vazio = modo celular**: polling no Telegram + Pix confirmado pelo job. Preenchida = webhook |
| `DATA_DIR` | Não | Pasta do SQLite/uploads. No celular use `./data` |
| `PORT` | Não | Porta HTTP (padrão 3000) |

**Segurança:** nunca commite o `.env`. Se as chaves do Mercado Pago já apareceram em
texto, gere novas no painel do Mercado Pago (Suas integrações → suas credenciais).

## 4. Deploy pago/alternativo (Railway, Render, VPS)

Só é necessário se você quiser o bot rodando 24h **fora** do celular.

### Railway (pago)

1. Crie um repositório no GitHub com este projeto e suba os arquivos.
2. Em [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**.
3. Aba **Networking → Generate Domain** e copie o endereço (`xxx.up.railway.app`).
4. **Volumes** (aba do serviço): **+ New → Volume → Mount Path = `/data`** e **Redeploy**.
5. **Variables** do serviço:
   - `ADMIN_PASSWORD`, `BASE_URL=https://xxx.up.railway.app`
   - `MERCADO_PAGO_ACCESS_TOKEN`, `MERCADO_PAGO_PUBLIC_KEY`
   - `DATA_DIR=/data` (somente com volume) e `NODE_VERSION=22.5.0`
6. Deploy automático. Abra o domínio e faça login.

**Logs:** Deployments → último deploy → **Logs**. O esperado é `Banco de dados em: /data/app.db`
e `Painel de Bots no ar`. Teste `https://SEU-DOMINIO/api/health`.

### Render

1. **New → Web Service** → conecte o repositório.
2. Build `npm install` — Start `npm start`.
3. **Disk** montado em `/data` (é recurso pago — no plano free os dados são apagados).
4. Environment: mesmas variáveis acima (`DATA_DIR=/data`), `BASE_URL` = URL `.onrender.com`.

> No plano **free** do Render o serviço **dorme** após 15 min sem tráfego, o que pausa os
> jobs e o polling. Para uso realmente free e sempre no ar, prefira o **celular (seção 2)**
> ou um VPS sempre-ligado (grátis: Oracle Cloud Always Free / Google Cloud e2-micro).

### ⚠️ Não use Vercel

O Vercel é **serverless**: executa funções avulsas (não um servidor Express), o sistema de
arquivos é **somente leitura** e não há processo contínuo para os jobs/polling. Por isso o
`/api/login` retorna **404** lá. Use Termux, Railway, Render ou qualquer host Node com
processo contínuo + disco.

## 5. Configuração no painel (pelo celular)

1. **Aba Bots** → cole o token do **BotFather** → *Adicionar bot*.
   - **No modo celular (sem `BASE_URL`):** o bot entra em **polling** automaticamente
     (funciona sem URL pública).
   - Com `BASE_URL`: o webhook `https://SEU-DOMINIO/tg/{id}` é registrado com secret.
2. No card do bot, toque em **🔀 Abrir fluxo deste bot**: cada bot tem **um único fluxo**
   (criado automaticamente ao abrir a primeira vez).
3. Monte os nós:
   - **ID**: chave do nó (ex.: `inicio`, `pay`, `obrigado`)
   - **Mensagem**: texto (aceita `<b>`, `<i>`, `<code>`)
   - **Mídias**: *várias* URLs e/ou arquivos do aparelho (📎) — foto/vídeo/pdf/áudio.
     O texto do nó vira legenda da **primeira** mídia; os arquivos locais ficam em
     `DATA_DIR/uploads/` e vão ao Telegram como multipart
   - **Inatividade (s)**: contagem regressiva de resposta do usuário neste nó
   - **Nó de retorno**: para onde o cliente vai quando o tempo de inatividade deste nó
     expira sem resposta (vazio = usar o *próximo nó*).
   - **Este é o nó da inatividade**: marcador do **fluxo** (só 1). Recebe o cliente
     quando o fluxo fica **sem caminho** (fim de linha ou Pix travado) — o cron traz pra cá.
   - **Valor Pix**: `> 0` trava o nó e gera o Pix Copia e Cola + QR Code
   - **Botões inline**: cada botão leva ao nó escolhido
   - **Próximo nó**: usado quando não há botão (ou depois do pagamento aprovado)
   - **Mensagem de lembrete**: texto enviado pela régua **só quando o fluxo não tem pra
     onde levar o cliente** e não há nó da inatividade marcado
   - **Convite de uso único**: grupo (aba 📢 Grupos) cujo link de **1 pessoa só**
     (`member_limit=1`) é enviado **depois** da mensagem deste nó
   - Defina o **nó inicial** no topo e toque em **Ativar**.
4. **Aba Grupos**: cadastre os grupos onde o bot é **administrador** (com permissão de
   "adicionar membros") — validados via `getChatMember`.
5. **Aba Clientes**: veja em que nó cada usuário está (Ativo / Aguardando Pix / Concluído).
6. **Aba Pix**: histórico de pagamentos com status.

## 6. Mercado Pago — pagamentos

- **Modo celular (sem `BASE_URL`):** não há webhook. O status do Pix é conferido pelo
  **job de 60s** (rede de segurança) e também quando o cliente responde no bot.
- **Com `BASE_URL`:** o sistema envia `notification_url` (`https://SEU-DOMINIO/mp/webhook`)
  em cada cobrança. Cadastre também em **Sua conta → Configurações → Webhooks** a URL
  `https://SEU-DOMINIO/mp/webhook` (evento **Pagamentos**).
- Quando o status chega como `approved`, o usuário é desbloqueado e avança para o próximo nó.

## 7. Comportamentos automáticos (jobs)

| Job | Intervalo | O que faz |
|---|---|---|
| Inatividade | 15s | Quando o timer do nó expira, avança para o *nó de retorno* daquele nó (ou `wait_node` legado, ou o próximo nó) |
| Sincronia de pagamentos | 60s | Confere o status no MP (rede de segurança do modo celular e do webhook) |
| Lembrete/recuperação | checado a cada 30min (1x por hora por cliente) | **Beco sem saída** (Pix travado ou fim de linha): leva o cliente para o *nó da inatividade*; sem marcador, reenvia o *texto de lembrete* do nó atual |

## 8. Variáveis do Telegram

- Cada bot tem um `secret_token` próprio: o endpoint `/tg/:id` valida o header
  `X-Telegram-Bot-Api-Secret-Token`, impedindo falsificação de updates.
- Comandos: `/start` reinicia o fluxo no nó inicial.
- **Polling local**: bot sem webhook registrado (ex.: rodando no celular/PC) é atendido
  por `getUpdates` a cada 2s — funciona sem domínio/HTTPS.
