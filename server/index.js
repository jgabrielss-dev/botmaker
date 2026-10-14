/* Painel de Bots Telegram - servidor Express.

   Roda em qualquer host com Node >= 22.5 (usa o modulo nativo node:sqlite)
   E tambem DENTRO do celular Android (Termux), sem precisar de URL publica:
   sem BASE_URL o Telegram entra em modo polling (getUpdates) e o Pix e
   confirmado pelo job de 60s. Veja o README, secao "Rodar no celular". */

/* 1) Versao minima do Node (o modulo node:sqlite entrou no 22.5) */
{
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) {
    console.error(
      `ERRO: Node ${process.versions.node} detectado. Este projeto exige Node >= 22.5 (usa o modulo nativo node:sqlite). ` +
        `No celular (Termux) rode: pkg install nodejs`
    );
    process.exit(1);
  }
}

/* 2) O node:sqlite saiu de tras da flag --experimental-sqlite no Node 22.13 / 23.4.
      Em versoes 22.5-22.12 reexecutamos automaticamente com a flag. */
{
  let ok = true;
  try {
    require('node:sqlite');
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    if (process.env.__SQLITE_REEXEC === '1' || process.execArgv.includes('--experimental-sqlite')) {
      console.error('ERRO: modulo node:sqlite indisponivel. Atualize o Node (>= 22.13) ou rode com --experimental-sqlite.');
      process.exit(1);
    }
    const { spawnSync } = require('child_process');
    const args = [...process.execArgv, '--experimental-sqlite', __filename, ...process.argv.slice(2)];
    const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, __SQLITE_REEXEC: '1' } });
    process.exit(r.status == null ? 1 : r.status);
  }
}

require('dotenv').config();
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const api = require('./api');
const db = require('./db');
const auth = require('./auth');
const E = require('./engine');
const { startJobs } = require('./jobs');
const { startPolling } = require('./poll');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');

/* Valida a assinatura do webhook do Mercado Pago quando o segredo estiver
   configurado (MERCADO_PAGO_WEBHOOK_SECRET). Header x-signature:
   "ts=1704908010,v1=<hmac>"; manifesto: id:<data.id>;request-id:<req>;ts:<ts>; */
function verifyMpSignature(req, dataId, secret) {
  const sig = String(req.get('x-signature') || '');
  if (!sig) return false;
  const parts = {};
  sig.split(',').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  if (!parts.ts || !parts.v1) return false;
  const reqId = String(req.get('x-request-id') || '');
  const manifest = `id:${dataId};request-id:${reqId};ts:${parts.ts};`;
  const hmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(parts.v1));
  } catch (e) {
    return false;
  }
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* Uploads exigem sessao (nao sao mais estaticos publicos). Arquivos sao servidos
   por nome aleatorio, mas ainda assim ficam atras do login. */
app.get('/uploads/:file', auth.requireAuth, (req, res) => {
  const file = path.basename(String(req.params.file || ''));
  if (!file || file.startsWith('.')) return res.sendStatus(400);
  res.sendFile(path.join(db.DATA_DIR, 'uploads', file), (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

/* Webhook do Telegram - um endpoint por bot */
app.post('/tg/:botId', async (req, res) => {
  const bot = E.getBot(Number(req.params.botId));
  if (!bot) return res.sendStatus(404);
  const secret = req.get('x-telegram-bot-api-secret-token');
  if (bot.secret && secret !== bot.secret) return res.sendStatus(403);
  res.sendStatus(200);
  try {
    await E.handleUpdate(bot, req.body || {});
  } catch (e) {
    console.error('update error bot=' + bot.id, e);
  }
});

/* Webhook do Mercado Pago */
app.post('/mp/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const q = req.query || {};
    const id = q['data.id'] || q.id || (req.body && req.body.data && req.body.data.id) || (req.body && req.body.data);
    if (!id) return;

    // quando o segredo esta configurado, exige a assinatura do Mercado Pago
    const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
    if (secret && !verifyMpSignature(req, id, secret)) {
      console.warn('mp webhook: assinatura invalida, ignorado');
      return;
    }

    // so consultamos pagamentos que NOS criamos (ignora ids arbitrarios)
    const local = db.prepare('SELECT id FROM payments WHERE mp_id = ?').get(String(id));
    if (!local) return;

    const mp = require('./mercadopago');
    const info = await mp.getPayment(id);
    if (info && info.status === 'approved') await E.onPaymentApproved(info.id);
  } catch (e) {
    console.error('mp webhook error:', e.message);
  }
});

app.use('/api', api);
/* Rota desconhecida em /api deve devolver JSON 404 (e nao o index.html). */
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

/* Enderecos da rede local (uteis para abrir o painel de outro aparelho) */
function lanUrls(port) {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${port}`);
    }
  }
  return out;
}

app.listen(PORT, () => {
  const webhookMode = /^https:\/\//.test(BASE_URL);
  console.log('');
  console.log('  🤖 Painel de Bots no ar');
  console.log('  Neste aparelho : http://localhost:' + PORT);
  lanUrls(PORT).forEach((u) => console.log('  Mesma Wi-Fi     : ' + u));
  console.log('  Telegram        : ' + (webhookMode ? 'webhook ' + BASE_URL : 'polling local (sem URL publica)'));
  console.log('  Dados           : ' + db.DATA_DIR);
  console.log('  Node            : ' + process.version);
  console.log('');
  if (!webhookMode) {
    console.log('  Modo celular: Telegram via getUpdates; Pix confirmado pelo job de 60s.');
  }
  if (!process.env.MERCADO_PAGO_ACCESS_TOKEN) {
    console.log('  AVISO: defina MERCADO_PAGO_ACCESS_TOKEN no .env para gerar Pix.');
  }
  if (auth.usingGeneratedPassword()) {
    console.log('');
    console.log('  SENHA DO PAINEL : ' + auth.expectedPassword());
    console.log('  (gerada automaticamente; defina ADMIN_PASSWORD no .env para escolher a sua)');
  }
  startJobs();
  startPolling();
});
