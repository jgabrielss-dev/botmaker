const db = require('./db');
const E = require('./engine');
const tg = require('./telegram');

const HOUR = 1000 * 60 * 60;

/* 1) Avanco automatico por inatividade */
function tickInactivity() {
  const now = Date.now();
  const rows = db.prepare("SELECT * FROM clients WHERE status = 'active' AND node_key != ''").all();
  for (const client of rows) {
    try {
      const bot = E.getBot(client.bot_id);
      if (!bot) continue;
      const flow = E.getFlow(bot, client.flow_id);
      const node = E.getNode(flow, client.node_key);
      if (!node) continue;
      const wait = Number(node.wait || 0);
      if (wait <= 0) continue;
      // destino da inatividade: NO DE LEMBRETE do proprio no (onde o cliente vai quando
      // o tempo definido passa sem resposta), senao o campo legado wait_node, senao o proximo.
      // Nunca volta para o proprio no.
      const target = String(node.reminder_node || node.wait_node || node.next || '').trim();
      if (!target || target === client.node_key) continue;
      if (now - client.last_activity < wait * 1000) continue;
      E.updateClient(client.id, { last_activity: now, updated_at: now });
      E.advance(bot, client, flow, target).catch((e) => console.error('inactivity advance:', e.message));
    } catch (e) {
      console.error('inactivity error:', e.message);
    }
  }
}

/* 2) Sincroniza pagamentos pendentes (rede de seguranca do webhook) */
async function tickPayments() {
  const rows = db
    .prepare("SELECT * FROM payments WHERE status = 'pending' AND created_at < ?")
    .all(Date.now() - 60 * 1000)
    .slice(0, 20);
  for (const p of rows) {
    try {
      if (!p.mp_id) continue;
      const info = await require('./mercadopago').getPayment(p.mp_id);
      if (!info) continue;
      if (info.status === 'approved') {
        db.prepare("UPDATE payments SET status = 'approved', updated_at = ? WHERE id = ?").run(Date.now(), p.id);
        await E.onPaymentApproved(p.mp_id);
      } else if (info.status === 'rejected' || info.status === 'cancelled') {
        db.prepare("UPDATE payments SET status = ?, updated_at = ? WHERE id = ?").run(info.status, Date.now(), p.id);
      } else if (Date.now() - p.created_at > E.PIX_TTL) {
        db.prepare("UPDATE payments SET status = 'expired', updated_at = ? WHERE id = ?").run(Date.now(), p.id);
      }
    } catch (e) {
      console.error('payment sync error:', e.message);
    }
  }
}

/* 3) Regua de lembrete / recuperacao - a cada 1 hora */
function tickReminders() {
  const now = Date.now();
  const clients = db.prepare("SELECT * FROM clients WHERE status IN ('active','waiting_payment') AND node_key != ''").all();

  for (const client of clients) {
    try {
      if (now - client.last_reminder < HOUR) continue;
      const bot = E.getBot(client.bot_id);
      if (!bot) continue;
      const flow = E.getFlow(bot, client.flow_id);
      const node = E.getNode(flow, client.node_key);
      if (!node) continue;

      let reason = null;
      if (client.status === 'waiting_payment') {
        const payment = client.payment_id
          ? db.prepare('SELECT * FROM payments WHERE id = ?').get(client.payment_id)
          : null;
        if (payment && payment.status === 'approved') {
          E.updateClient(client.id, { last_reminder: now, updated_at: now });
          E.onPaymentApproved(payment.mp_id);
          continue;
        }
        if (!payment || payment.status === 'pending' || payment.status === 'expired') reason = 'pix';
      } else {
        // caminho livre = botao, proximo no, ou inatividade que leva a outro no
        const hasPath =
          (node.buttons && node.buttons.length > 0) ||
          !!node.next ||
          (Number(node.wait || 0) > 0 && (!!node.reminder_node || !!node.wait_node));
        if (!hasPath) reason = 'end';
      }
      if (!reason) continue;

      E.updateClient(client.id, { last_reminder: now, updated_at: now });

      // Beco sem saida (fim de linha ou Pix travado): o NO DA INATIVIDADE do fluxo
      // recebe o cliente e dali em diante os botoes/next/inatividade dele puxam o
      // usuario de volta para dentro do fluxo.
      const inactivityNode = String((flow.json && flow.json.inactivity_node) || '').trim();
      if (inactivityNode && inactivityNode !== client.node_key && E.getNode(flow, inactivityNode)) {
        E.advance(bot, client, flow, inactivityNode).catch((e) =>
          console.error('inactivity-node advance:', e.message)
        );
        continue;
      }

      const msg =
        node.reminder && node.reminder.trim()
          ? node.reminder
          : reason === 'pix'
          ? '👋 Você ainda não finalizou o pagamento. Estou aqui caso precise de ajuda para concluir o Pix.'
          : '👋 Sentimos sua falta! Continue de onde parou respondendo aqui ou usando os botões.';

      tg.sendText(bot.token, client.chat_id, msg).catch((e) => console.error('reminder error:', e.message));
    } catch (e) {
      console.error('reminder job error:', e.message);
    }
  }
}

function startJobs() {
  setInterval(tickInactivity, 15 * 1000);
  setInterval(() => {
    tickPayments().catch((e) => console.error(e));
  }, 60 * 1000);
  setInterval(tickReminders, 30 * 60 * 1000);
  tickInactivity();
  tickReminders();
  tickPayments().catch((e) => console.error(e));
  console.log('Jobs agendados: inatividade (15s), pagamentos (60s), lembretes (30min).');
}

module.exports = { startJobs, tickInactivity, tickPayments, tickReminders };
