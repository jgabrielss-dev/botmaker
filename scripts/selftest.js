/* Auto-teste do backend com fetch mockado (Telegram + Mercado Pago) */
process.env.DATA_DIR = require('os').tmpdir() + '/tpanel-selftest-' + Date.now();
process.env.MERCADO_PAGO_ACCESS_TOKEN = 'APP_USR-teste';
process.env.BASE_URL = 'https://exemplo.up.railway.app';
process.env.ADMIN_PASSWORD = 'teste123';

const assert = require('assert');
const db = require('../server/db');
const E = require('../server/engine');
const jobs = require('../server/jobs');

let mpStatus = 'pending';
const calls = [];
const json = (o) => ({ ok: true, status: 200, json: async () => o });

global.fetch = async (url, opts) => {
  const u = String(url);
  calls.push({ url: u, body: opts && opts.body });
  if (u.includes('api.telegram.org')) return json({ ok: true, result: { message_id: 1 } });
  if (u.includes('meradopago') || u.includes('mercadopago.com/v1/payments/999')) {
    return json({ id: 999, status: mpStatus, transaction_amount: 10.5 });
  }
  if (u.includes('mercadopago.com/v1/payments')) {
    return json({
      id: 999,
      status: 'pending',
      transaction_amount: 10.5,
      point_of_interaction: { transaction_data: { qr_code: 'PIX-COLAE-COLA', qr_code_base64: 'aGVsbG8=', ticket_url: 'https://mp/t' } }
    });
  }
  return json({});
};

(async () => {
  const info = db.prepare('INSERT INTO bots (name, token, secret, created_at) VALUES (?, ?, ?, ?)').run('Bot Teste', '123:abc', 'sec', Date.now());
  const botId = Number(info.lastInsertRowid);

  const data = {
    start: 'inicio',
    order: ['inicio', 'pay', 'fim'],
    nodes: {
      inicio: { text: 'Bem-vindo!', wait: 0, price: 0, buttons: [{ label: 'Comprar', to: 'pay' }], next: '' },
      pay: { text: 'Pague agora', wait: 0, price: 10.5, buttons: [], next: 'fim', reminder: 'Lembrete: Pix pendente' },
      fim: { text: 'Obrigado!', wait: 0, price: 0, buttons: [], next: '' }
    }
  };
  const f = db.prepare('INSERT INTO flows (bot_id, name, data, created_at) VALUES (?, ?, ?, ?)').run(botId, 'Fluxo 1', JSON.stringify(data), Date.now());
  const flowId = Number(f.lastInsertRowid);
  db.prepare('UPDATE bots SET flow_id = ? WHERE id = ?').run(flowId, botId);

  const bot = E.getBot(botId);

  // 1) /start entra no nó inicial
  await E.handleUpdate(bot, { message: { chat: { id: 555 }, text: '/start' } });
  let c = E.getClient(botId, 555);
  assert.strictEqual(c.node_key, 'inicio');
  assert.strictEqual(c.status, 'active');
  console.log('1. /start -> nó inicio OK');

  // 2) callback de botão vai para o nó pay e trava no Pix
  await E.handleUpdate(bot, { callback_query: { id: '1', data: 'go:pay', message: { chat: { id: 555 } } } });
  c = E.getClient(botId, 555);
  assert.strictEqual(c.node_key, 'pay');
  assert.strictEqual(c.status, 'waiting_payment');
  const pay = db.prepare('SELECT * FROM payments WHERE bot_id = ?').get(botId);
  assert.ok(pay && pay.mp_id === '999' && pay.amount === 10.5 && pay.qr_code === 'PIX-COLAE-COLA');
  console.log('2. nó Pix gerou pagamento Mercado Pago OK');

  // 3) callback enquanto aguarda pagamento nao avanca
  await E.handleUpdate(bot, { callback_query: { id: '2', data: 'go:fim', message: { chat: { id: 555 } } } });
  c = E.getClient(botId, 555);
  assert.strictEqual(c.node_key, 'pay');
  assert.strictEqual(c.status, 'waiting_payment');
  console.log('3. trava de pagamento OK');

  // 4) webhook do Mercado Pago aprovado -> avanca para 'fim'
  mpStatus = 'approved';
  await E.onPaymentApproved('999');
  c = E.getClient(botId, 555);
  assert.strictEqual(c.node_key, 'fim');
  assert.strictEqual(c.status, 'active');
  console.log('4. pagamento aprovado avanca o fluxo OK');

  // 5) no fim de linha (sem botoes/next) -> lembrete de 1h
  db.prepare('UPDATE clients SET last_reminder = 0 WHERE id = ?').run(c.id);
  jobs.tickReminders();
  c = E.getClient(botId, 555);
  assert.ok(c.last_reminder > 0, 'lembrete deveria ter sido enviado');
  const remMsg = calls.filter((x) => x.url.includes('sendMessage')).map((x) => JSON.parse(x.body).text).pop();
  assert.ok(remMsg.includes('Sentimos sua falta'), 'mensagem de lembrete: ' + remMsg);
  console.log('5. cron de lembrete 1h OK');

  // 6) inatividade avanca sozinho
  const data2 = { start: 'a', order: ['a', 'b'], nodes: { a: { text: 'A', wait: 5, price: 0, buttons: [], next: 'b' }, b: { text: 'B', wait: 0, price: 0, buttons: [], next: '' } } };
  db.prepare('INSERT INTO flows (bot_id, name, data, created_at) VALUES (?, ?, ?, ?)').run(botId, 'Fluxo 2', JSON.stringify(data2), Date.now());
  const flow2 = db.prepare('SELECT * FROM flows WHERE bot_id = ? ORDER BY id DESC').get(botId);
  db.prepare('UPDATE bots SET flow_id = ? WHERE id = ?').run(flow2.id, botId);
  await E.handleUpdate(E.getBot(botId), { message: { chat: { id: 777 }, text: '/start' } });
  let c2 = E.getClient(botId, 777);
  assert.strictEqual(c2.node_key, 'a');
  db.prepare('UPDATE clients SET last_activity = ? WHERE id = ?').run(Date.now() - 60000, c2.id);
  jobs.tickInactivity();
  c2 = E.getClient(botId, 777);
  assert.strictEqual(c2.node_key, 'b');
  console.log('6. avanco por inatividade OK');

  // 7) senha de login
  const auth = require('../server/auth');
  assert.ok(auth.login('teste123'));
  assert.strictEqual(auth.login('errada'), null);
  console.log('7. autenticacao OK');

  // 8) senha com aspas/espacos coladas no Railway ainda entra
  process.env.ADMIN_PASSWORD = '  "Segredo 123"  ';
  assert.ok(auth.login('Segredo 123'), 'deveria aceitar sem aspas/espacos');
  assert.ok(auth.login(' Segredo 123 '), 'deveria ignorar espacos do usuario');
  assert.strictEqual(auth.login('errada'), null);
  assert.ok(auth.passwordIssues().length >= 1, 'deveria apontar aspas/espacos');
  delete process.env.ADMIN_PASSWORD;
  assert.ok(auth.login('admin'), 'padrao admin deveria valer sem a variavel');
  console.log('8. normalizacao de senha OK');

  // 9) inatividade usa o campo proprio "no da inatividade"
  const data3 = {
    start: 'a',
    order: ['a', 'b', 'c'],
    nodes: {
      a: { text: 'A', wait: 5, price: 0, buttons: [{ label: 'ir', to: 'b' }], next: '', wait_node: 'c' },
      b: { text: 'B', wait: 0, price: 0, buttons: [], next: '' },
      c: { text: 'C', wait: 0, price: 0, buttons: [], next: '' }
    }
  };
  db.prepare('INSERT INTO flows (bot_id, name, data, created_at) VALUES (?,?,?,?)').run(botId, 'Fluxo 3', JSON.stringify(data3), Date.now());
  const flow3 = db.prepare('SELECT * FROM flows WHERE bot_id = ? ORDER BY id DESC').get(botId);
  db.prepare('UPDATE bots SET flow_id = ? WHERE id = ?').run(flow3.id, botId);
  await E.handleUpdate(E.getBot(botId), { message: { chat: { id: 888 }, text: '/start' } });
  let c3 = E.getClient(botId, 888);
  assert.strictEqual(c3.node_key, 'a');
  db.prepare('UPDATE clients SET last_activity = ? WHERE id = ?').run(Date.now() - 60000, c3.id);
  jobs.tickInactivity();
  c3 = E.getClient(botId, 888);
  assert.strictEqual(c3.node_key, 'c', 'inatividade deveria ir para o no "c" (campo proprio) e nao para "b"');
  console.log('9. inatividade leva para o NO DA INATIVIDADE OK');

  // 10) inatividade nunca volta para o proprio no
  const d3 = JSON.parse(flow3.data);
  d3.nodes.c = { text: 'C', wait: 5, price: 0, buttons: [], next: '', wait_node: 'c' };
  db.prepare('UPDATE flows SET data = ? WHERE id = ?').run(JSON.stringify(d3), flow3.id);
  db.prepare('UPDATE clients SET last_activity = ? WHERE id = ?').run(Date.now() - 60000, c3.id);
  jobs.tickInactivity();
  c3 = E.getClient(botId, 888);
  assert.strictEqual(c3.node_key, 'c', 'nao deveria voltar para o proprio no');
  console.log('10. inatividade ignora self-loop OK');

  // 11) cron de 1h leva para o NO DO LEMBRETE quando nao ha caminho
  db.prepare('UPDATE flows SET data = ? WHERE id = ?').run(
    JSON.stringify({
      start: 'presa',
      order: ['presa', 'resgate'],
      nodes: {
        presa: { text: 'Sem caminho', wait: 0, price: 0, buttons: [], next: '', reminder: 'texto antigo', reminder_node: 'resgate' },
        resgate: { text: 'Voltou! Use os botoes', wait: 0, price: 0, buttons: [{ label: 'continuar', to: 'presa' }], next: '' }
      }
    }),
    flow3.id
  );
  db.prepare("UPDATE clients SET status = 'active', node_key = 'presa', last_reminder = 0, payment_id = NULL WHERE id = ?").run(c3.id);
  jobs.tickReminders();
  c3 = E.getClient(botId, 888);
  assert.strictEqual(c3.node_key, 'resgate', 'cron deveria levar para o no do lembrete e nao enviar o texto do no');
  const remMsg11 = calls.filter((x) => x.url.includes('sendMessage')).map((x) => JSON.parse(x.body).text);
  assert.ok(!remMsg11.includes('texto antigo'), 'nao deveria usar o texto de lembrete quando ha no de lembrete');
  console.log('11. cron de 1h leva para o NO DO LEMBRETE OK');

  // 12) no com caminho de inatividade NAO e fim de linha (cron nao dispara)
  const d12 = JSON.parse(db.prepare('SELECT data FROM flows WHERE id = ?').get(flow3.id).data);
  d12.nodes.presa = { text: 'Sem caminho', wait: 30, price: 0, buttons: [], next: '', wait_node: 'resgate', reminder_node: 'resgate' };
  db.prepare('UPDATE flows SET data = ? WHERE id = ?').run(JSON.stringify(d12), flow3.id);
  db.prepare("UPDATE clients SET node_key = 'presa', last_reminder = 0 WHERE id = ?").run(c3.id);
  jobs.tickReminders();
  c3 = E.getClient(botId, 888);
  assert.strictEqual(c3.node_key, 'presa', 'no com saida por inatividade nao e fim de linha');
  assert.strictEqual(c3.last_reminder, 0, 'cron nao deveria disparar quando ha caminho');
  console.log('12. inatividade conta como caminho OK');

  // 13) so roda polling em bot sem webhook
  const poll = require('../server/poll');
  assert.strictEqual(poll.pollable({ webhook_url: '' }), true, 'bot sem webhook deve usar polling');
  assert.strictEqual(poll.pollable({ webhook_url: 'https://x/tg/1' }), false, 'bot com webhook nao deve usar polling');
  console.log('13. polling local somente sem webhook OK');

  console.log('\nTODOS OS TESTES PASSARAM');
  process.exit(0);
})().catch((e) => {
  console.error('FALHOU:', e);
  process.exit(1);
});
