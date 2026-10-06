{
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) {
    console.error(
      `ERRO: Node ${process.versions.node} detectado. Este projeto exige Node >= 22.5 (usa o modulo nativo node:sqlite). ` +
        `Configure a variavel NODE_VERSION=22.5 ou superior nas variaveis do hospedeiro.`
    );
    process.exit(1);
  }
}

require('dotenv').config();
const path = require('path');
const express = require('express');
const api = require('./api');
const E = require('./engine');
const { startJobs } = require('./jobs');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

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
    const mp = require('./mercadopago');
    const info = await mp.getPayment(id);
    if (info && info.status === 'approved') await E.onPaymentApproved(info.id);
  } catch (e) {
    console.error('mp webhook error:', e.message);
  }
});

app.use('/api', api);

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Painel rodando na porta ${PORT}`);
  if (!process.env.BASE_URL) console.log('AVISO: defina BASE_URL no .env para ativar os webhooks.');
  if (!process.env.MERCADO_PAGO_ACCESS_TOKEN) console.log('AVISO: defina MERCADO_PAGO_ACCESS_TOKEN no .env para gerar Pix.');
  startJobs();
});
