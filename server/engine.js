const db = require('./db');
const tg = require('./telegram');
const mp = require('./mercadopago');

const PIX_TTL = 1000 * 60 * 40; // Pix considerado expirado apos 40 min

function getBot(botId) {
  return db.prepare('SELECT * FROM bots WHERE id = ?').get(botId);
}

function getFlow(bot, flowId) {
  const id = flowId || bot.flow_id;
  if (!id) return null;
  const row = db.prepare('SELECT * FROM flows WHERE id = ?').get(id);
  if (!row) return null;
  try {
    row.json = JSON.parse(row.data || '{}');
  } catch (e) {
    row.json = { start: '', nodes: {} };
  }
  return row;
}

function getNode(flow, key) {
  if (!flow || !flow.json || !key) return null;
  return (flow.json.nodes || {})[key] || null;
}

function getClient(botId, chatId) {
  let row = db.prepare('SELECT * FROM clients WHERE bot_id = ? AND chat_id = ?').get(botId, String(chatId));
  if (!row) {
    const now = Date.now();
    db.prepare(
      'INSERT INTO clients (bot_id, chat_id, status, last_activity, last_reminder, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(botId, String(chatId), 'active', now, 0, now);
    row = db.prepare('SELECT * FROM clients WHERE bot_id = ? AND chat_id = ?').get(botId, String(chatId));
  }
  return row;
}

function updateClient(id, fields) {
  const keys = Object.keys(fields);
  const sql = `UPDATE clients SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => fields[k]), id);
}

async function safeReply(bot, chatId, text, keyboard) {
  try {
    await tg.sendText(bot.token, chatId, text, keyboard);
  } catch (e) {
    console.error('reply error bot=' + bot.id, e.message);
  }
}

/* ---------------- Pagamentos ---------------- */

async function createPayment(bot, client, flow, node, nodeKey) {
  const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '');
  const externalReference = `bot${bot.id}-chat${client.chat_id}-node${nodeKey}-${Date.now()}`;
  const created = await mp.createPixPayment({
    amount: node.price,
    description: (node.text || 'Pagamento').slice(0, 40),
    externalReference,
    notificationUrl: baseUrl ? `${baseUrl}/mp/webhook` : undefined
  });
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO payments (bot_id, chat_id, flow_id, node_key, mp_id, status, amount, qr_code, qr_base64, ticket_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      bot.id,
      String(client.chat_id),
      flow ? flow.id : null,
      nodeKey,
      created.mpId,
      created.status === 'approved' ? 'approved' : 'pending',
      created.amount,
      created.qrCode,
      created.qrBase64,
      created.ticketUrl,
      now,
      now
    );
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(info.lastInsertRowid);
}

async function enterNode(bot, client, flow, nodeKey) {
  const node = getNode(flow, nodeKey);
  if (!node) {
    updateClient(client.id, { status: 'done', node_key: '', flow_id: flow ? flow.id : null, updated_at: Date.now() });
    return;
  }
  const hasPrice = Number(node.price || 0) > 0;
  updateClient(client.id, {
    flow_id: flow.id,
    node_key: nodeKey,
    status: hasPrice ? 'waiting_payment' : 'active',
    payment_id: null,
    last_activity: Date.now(),
    updated_at: Date.now()
  });

  if (hasPrice) {
    try {
      const payment = await createPayment(bot, client, flow, node, nodeKey);
      updateClient(client.id, { payment_id: payment.id, updated_at: Date.now() });
      await tg.sendPixMessage(bot, client.chat_id, payment, node);
    } catch (e) {
      console.error('pix error:', e.message);
      updateClient(client.id, { status: 'active', updated_at: Date.now() });
      await safeReply(bot, client.chat_id, '⚠️ Não foi possível gerar o Pix agora. Tente novamente em instantes.');
    }
    return;
  }
  await tg.sendNode(bot.token, client.chat_id, node);
}

async function advance(bot, client, flow, toKey) {
  if (!toKey) {
    updateClient(client.id, { status: 'done', payment_id: null, updated_at: Date.now() });
    return safeReply(bot, client.chat_id, '✅ Fim do fluxo. Obrigado!');
  }
  await enterNode(bot, client, flow, toKey);
}

async function recheckPayment(bot, client, flow) {
  const payment = client.payment_id
    ? db.prepare('SELECT * FROM payments WHERE id = ?').get(client.payment_id)
    : db
        .prepare("SELECT * FROM payments WHERE bot_id = ? AND chat_id = ? ORDER BY id DESC LIMIT 1")
        .get(bot.id, String(client.chat_id));
  if (!payment) return false;
  if (payment.status === 'approved') return true;

  let info = null;
  if (payment.mp_id) info = await mp.getPayment(payment.mp_id).catch(() => null);
  if (info && info.status === 'approved') {
    db.prepare("UPDATE payments SET status = 'approved', updated_at = ? WHERE id = ?").run(Date.now(), payment.id);
    payment.status = 'approved';
    return true;
  }
  if (Date.now() - payment.created_at > PIX_TTL) {
    db.prepare("UPDATE payments SET status = 'expired', updated_at = ? WHERE id = ?").run(Date.now(), payment.id);
  }
  return false;
}

async function onPaymentApproved(mpId) {
  const payment = db.prepare('SELECT * FROM payments WHERE mp_id = ?').get(String(mpId));
  if (!payment) return;
  db.prepare("UPDATE payments SET status = 'approved', updated_at = ? WHERE id = ?").run(Date.now(), payment.id);
  if (payment.status === 'approved') return;

  const client = getClient(payment.bot_id, payment.chat_id);
  if (!client || (client.status !== 'waiting_payment' || client.payment_id !== payment.id)) return;
  const bot = getBot(payment.bot_id);
  const flow = getFlow(bot, payment.flow_id);
  const node = getNode(flow, payment.node_key);
  await advance(bot, client, flow, node ? node.next : null);
}

/* ---------------- Atualizacoes do Telegram ---------------- */

async function handleUpdate(bot, update) {
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    const client = getClient(bot.id, chatId);
    const flow = getFlow(bot);

    if (!flow) {
      return safeReply(bot, chatId, '⚠️ Nenhum fluxo configurado para este bot ainda.');
    }

    if (text === '/start' || text.split(' ')[0] === '/start') {
      updateClient(client.id, { status: 'active', payment_id: null, last_reminder: Date.now(), updated_at: Date.now() });
      const fresh = getClient(bot.id, chatId);
      return enterNode(bot, fresh, flow, flow.json.start);
    }

    if (client.status === 'waiting_payment') {
      const approved = await recheckPayment(bot, client, flow);
      if (approved) return onPaymentApprovedByClient(bot, client, flow);
      const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(client.payment_id);
      if (payment && payment.status === 'expired') {
        return enterNode(bot, client, flow, client.node_key); // gera novo Pix
      }
      return safeReply(bot, chatId, '⏳ Estamos aguardando a confirmação do seu pagamento.');
    }

    const node = getNode(flow, client.node_key);
    if (node && Number(node.price || 0) > 0) {
      return enterNode(bot, client, flow, client.node_key);
    }
    return safeReply(bot, client.chat_id, '👇 Use os botões para continuar.');
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message ? cq.message.chat.id : (cq.from && cq.from.id);
    const data = cq.data || '';
    try {
      await tg.call('answerCallbackQuery', { callback_query_id: cq.id }, bot.token);
    } catch (e) {}
    if (!data.startsWith('go:')) return;

    const toKey = data.slice(3);
    const client = getClient(bot.id, chatId);
    const flow = getFlow(bot);
    if (!flow) return;

    if (client.status === 'waiting_payment') {
      const approved = await recheckPayment(bot, client, flow);
      if (approved) return onPaymentApprovedByClient(bot, client, flow);
      return safeReply(bot, chatId, '⏳ Pagamento em análise. Assim que confirmar, o acesso é liberado automaticamente.');
    }

    const target = getNode(flow, toKey);
    if (!target) return safeReply(bot, chatId, '⚠️ Nó do fluxo não encontrado.');
    return enterNode(bot, client, flow, toKey);
  }
}

async function onPaymentApprovedByClient(bot, client, flow) {
  const node = getNode(flow, client.node_key);
  updateClient(client.id, { payment_id: null, status: 'active', updated_at: Date.now() });
  await advance(bot, client, flow, node ? node.next : null);
}

module.exports = {
  getBot,
  getFlow,
  getNode,
  getClient,
  updateClient,
  enterNode,
  advance,
  handleUpdate,
  onPaymentApproved,
  recheckPayment,
  PIX_TTL
};
