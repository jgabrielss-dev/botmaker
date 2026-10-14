const db = require('./db');
const tg = require('./telegram');
const mp = require('./mercadopago');

const PIX_TTL = 1000 * 60 * 40; // Pix considerado expirado apos 40 min
const PIX_RETRY_COOLDOWN = 1000 * 15; // evita recriar Pix a cada mensagem seguida

function getBot(botId) {
  return db.prepare('SELECT * FROM bots WHERE id = ?').get(botId);
}

function getFlow(bot, flowId) {
  const id = flowId || (bot && bot.flow_id);
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
    // last_reminder comeca em branco so depois desta conversa: assim um cliente novo
    // nao recebe o lembrete de 1h antes mesmo de ter interagido.
    db.prepare(
      'INSERT INTO clients (bot_id, chat_id, status, last_activity, last_reminder, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(botId, String(chatId), 'active', now, now, now);
    row = db.prepare('SELECT * FROM clients WHERE bot_id = ? AND chat_id = ?').get(botId, String(chatId));
  }
  return row;
}

function updateClient(id, fields) {
  const keys = Object.keys(fields);
  const sql = `UPDATE clients SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => fields[k]), id);
}

/* Guarda o chat que o bot viu (para descobrir grupos/IDs sem digitar na mao). */
function touchChat(bot, chat, from) {
  if (!bot || !chat || !chat.id) return;
  const f = from || {};
  const name = [f.first_name, f.last_name].filter(Boolean).join(' ').trim();
  const title = chat.title || name || chat.username || String(chat.id);
  const username = chat.username || f.username || '';
  try {
    db.prepare(
      `INSERT INTO bot_chats (bot_id, chat_id, type, title, username, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(bot_id, chat_id) DO UPDATE SET
         type = excluded.type, title = excluded.title,
         username = excluded.username, updated_at = excluded.updated_at`
    ).run(bot.id, String(chat.id), chat.type || 'private', title, username, Date.now());
  } catch (e) {
    /* nao deixa a captura do chat derrubar o fluxo */
  }
}

/* Quando um grupo vira supergrupo o ID muda. Move clientes/chats do ID antigo
   para o novo (senao o bot tenta responder num ID que nao existe mais). */
function migrateChatId(botId, from, to) {
  if (!from || !to || String(from) === String(to)) return;
  for (const table of ['bot_chats', 'clients']) {
    try {
      db.prepare(`UPDATE ${table} SET chat_id = ? WHERE bot_id = ? AND chat_id = ?`).run(String(to), botId, String(from));
    } catch (e) {
      // ja existe uma linha com o ID novo (conflito de unicidade): descarta a antiga
      try {
        db.prepare(`DELETE FROM ${table} WHERE bot_id = ? AND chat_id = ?`).run(botId, String(from));
      } catch (e2) {
        /* ignora */
      }
    }
  }
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

/* Convite de uso unico do grupo configurado no no (enviado no fim do no) */
async function sendInvite(bot, chatId, node) {
  const gid = Number(node.invite_group || 0);
  if (!gid) return;
  try {
    const group = db.prepare('SELECT * FROM groups WHERE id = ? AND bot_id = ?').get(gid, bot.id);
    if (!group) return;
    const link = await tg.createOneTimeInvite(bot.token, group.chat_id, (group.title || 'Convite').slice(0, 32));
    await tg.sendText(
      bot.token,
      chatId,
      '🔒 <b>Convite de uso único</b>' +
        (group.title ? '\nGrupo: ' + group.title : '') +
        '\nVálido para apenas 1 pessoa:\n<code>' + link + '</code>'
    );
  } catch (e) {
    console.error('invite error bot=' + bot.id, e.message);
  }
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
    updateClient(client.id, { last_pix_at: Date.now() });
    try {
      const payment = await createPayment(bot, client, flow, node, nodeKey);
      updateClient(client.id, { payment_id: payment.id, updated_at: Date.now() });
      await tg.sendPixMessage(bot, client.chat_id, payment, node);
    } catch (e) {
      console.error('pix error:', e.message);
      // Fica 'active' para o usuario poder usar botoes/proximo e nao ficar sem saida.
      updateClient(client.id, { status: 'active', updated_at: Date.now() });
      await safeReply(bot, client.chat_id, '⚠️ Não foi possível gerar o Pix agora. Tente novamente em instantes.');
    }
    return;
  }
  await tg.sendNode(bot.token, client.chat_id, node);
  await sendInvite(bot, client.chat_id, node);
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
  if (!payment) return null;
  // ja aprovado no banco: devolve para destravar o cliente (o cliente pode ter
  // ficado preso em waiting_payment mesmo apos a aprovacao).
  if (payment.status === 'approved') return payment;

  let info = null;
  if (payment.mp_id) info = await mp.getPayment(payment.mp_id).catch(() => null);
  if (info && info.status === 'approved') {
    db.prepare("UPDATE payments SET status = 'approved', updated_at = ? WHERE id = ?").run(Date.now(), payment.id);
    payment.status = 'approved';
    return payment;
  }
  if (Date.now() - payment.created_at > PIX_TTL) {
    db.prepare("UPDATE payments SET status = 'expired', updated_at = ? WHERE id = ?").run(Date.now(), payment.id);
    payment.status = 'expired';
  }
  return null;
}

/* Marca o pagamento como aprovado e DESTRAVA o cliente que o aguardava.
   A atualizacao do cliente e feita em uma unica instrucao condicional, entao
   duas chamadas simultaneas (webhook + job) nunca avancam o fluxo duas vezes. */
async function approveAndAdvance(payment) {
  const client = getClient(payment.bot_id, payment.chat_id);
  if (!client) return false;
  const now = Date.now();
  const upd = db
    .prepare(
      "UPDATE clients SET status = 'active', payment_id = NULL, last_activity = ?, updated_at = ? WHERE id = ? AND status = 'waiting_payment' AND payment_id = ?"
    )
    .run(now, now, client.id, payment.id);
  if (upd.changes === 0) return false; // ja destravado por outra chamada
  const fresh = db.prepare('SELECT * FROM clients WHERE id = ?').get(client.id);
  const bot = getBot(payment.bot_id);
  const flow = getFlow(bot, payment.flow_id);
  const node = getNode(flow, payment.node_key);
  await advance(bot, fresh, flow, node ? node.next : null);
  return true;
}

async function onPaymentApproved(mpId) {
  const payment = db.prepare('SELECT * FROM payments WHERE mp_id = ?').get(String(mpId));
  if (!payment) return false;
  db.prepare("UPDATE payments SET status = 'approved', updated_at = ? WHERE id = ?").run(Date.now(), payment.id);
  return approveAndAdvance(payment);
}

/* ---------------- Atualizacoes do Telegram ---------------- */

async function handleUpdate(bot, update) {
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;

    // grupo virou supergrupo: o ID muda. Migra os registros e encerra.
    if (msg.migrate_to_chat_id) {
      migrateChatId(bot.id, chatId, msg.migrate_to_chat_id);
      return;
    }

    // O fluxo e o Pix sao 1:1. Em grupo/canal apenas registramos o chat (aba Descobrir)
    // e NAO respondemos, para nao gerar "not enough rights".
    if (msg.chat.type && msg.chat.type !== 'private') {
      touchChat(bot, msg.chat, msg.from);
      return;
    }

    const text = (msg.text || '').trim();
    const client = getClient(bot.id, chatId);
    const flow = getFlow(bot);

    const from = msg.from || {};
    touchChat(bot, msg.chat, from);
    if (from.id) {
      updateClient(client.id, {
        first_name: from.first_name || '',
        last_name: from.last_name || '',
        username: from.username || '',
        last_seen: Date.now(),
        updated_at: Date.now()
      });
    }

    if (!flow) {
      return safeReply(bot, chatId, '⚠️ Nenhum fluxo configurado para este bot ainda.');
    }

    if (text === '/start' || text.split(' ')[0] === '/start') {
      updateClient(client.id, { status: 'active', payment_id: null, last_reminder: Date.now(), updated_at: Date.now() });
      const fresh = getClient(bot.id, chatId);
      return enterNode(bot, fresh, flow, flow.json.start);
    }

    if (client.status === 'waiting_payment') {
      const payment = await recheckPayment(bot, client, flow);
      if (payment) return approveAndAdvance(payment);
      const cur = client.payment_id ? db.prepare('SELECT * FROM payments WHERE id = ?').get(client.payment_id) : null;
      if (cur && cur.status === 'expired') {
        return enterNode(bot, client, flow, client.node_key); // gera novo Pix
      }
      return safeReply(bot, chatId, '⏳ Estamos aguardando a confirmação do seu pagamento.');
    }

    const node = getNode(flow, client.node_key);
    if (node && Number(node.price || 0) > 0) {
      // evita recriar o Pix a cada mensagem seguida (protege a API do Mercado Pago)
      if (Date.now() - (client.last_pix_at || 0) < PIX_RETRY_COOLDOWN) {
        return safeReply(bot, chatId, '⏳ Aguarde alguns segundos e tente novamente para gerar outro Pix.');
      }
      return enterNode(bot, client, flow, client.node_key);
    }
    return safeReply(bot, client.chat_id, '👇 Use os botões para continuar.');
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const chat = cq.message ? cq.message.chat : null;
    const chatId = chat ? chat.id : (cq.from && cq.from.id);
    touchChat(bot, chat || { id: chatId, type: 'private' }, cq.from);
    const data = cq.data || '';
    try {
      await tg.call('answerCallbackQuery', { callback_query_id: cq.id }, bot.token);
    } catch (e) {}
    // botoes clicados em grupo/canal sao ignorados (o fluxo e 1:1)
    if (chat && chat.type && chat.type !== 'private') return;
    if (!data.startsWith('go:')) return;

    const toKey = data.slice(3);
    const client = getClient(bot.id, chatId);
    const flow = getFlow(bot);
    if (!flow) return;

    if (client.status === 'waiting_payment') {
      const payment = await recheckPayment(bot, client, flow);
      if (payment) return approveAndAdvance(payment);
      return safeReply(bot, chatId, '⏳ Pagamento em análise. Assim que confirmar, o acesso é liberado automaticamente.');
    }

    const target = getNode(flow, toKey);
    if (!target) return safeReply(bot, chatId, '⚠️ Nó do fluxo não encontrado.');
    return enterNode(bot, client, flow, toKey);
  }
}

/* ------------- Acoes manuais do painel sobre um cliente ------------- */

async function restartClient(botId, chatId) {
  const bot = getBot(botId);
  if (!bot) return false;
  const flow = getFlow(bot);
  if (!flow) return false;
  const client = getClient(botId, chatId);
  updateClient(client.id, { status: 'active', payment_id: null, last_reminder: Date.now(), updated_at: Date.now() });
  const fresh = getClient(botId, chatId);
  await enterNode(bot, fresh, flow, flow.json.start);
  return true;
}

async function unlockClient(botId, chatId) {
  const bot = getBot(botId);
  if (!bot) return false;
  const flow = getFlow(bot);
  const client = getClient(botId, chatId);
  const node = getNode(flow, client.node_key);
  updateClient(client.id, { status: 'active', payment_id: null, updated_at: Date.now() });
  // segue como se o pagamento tivesse sido aprovado
  await advance(bot, client, flow, node ? node.next : null);
  return true;
}

module.exports = {
  getBot,
  getFlow,
  getNode,
  getClient,
  updateClient,
  touchChat,
  enterNode,
  advance,
  handleUpdate,
  onPaymentApproved,
  recheckPayment,
  approveAndAdvance,
  restartClient,
  unlockClient,
  PIX_TTL,
  PIX_RETRY_COOLDOWN
};
