const API = 'https://api.telegram.org';
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function call(method, payload, token) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error(`telegram ${method}: ${data.description || res.status}`);
    err.description = data.description || '';
    throw err;
  }
  return data.result;
}

function keyboardFor(node) {
  const buttons = Array.isArray(node.buttons) ? node.buttons : [];
  if (!buttons.length) return undefined;
  return {
    inline_keyboard: buttons
      .filter((b) => b && b.to)
      .map((b) => [{ text: b.label || '▶️', callback_data: 'go:' + b.to }])
  };
}

async function sendText(token, chatId, text, reply_markup, opts = {}) {
  const payload = {
    chat_id: chatId,
    text: text || '',
    reply_markup,
    disable_web_page_preview: opts.linkPreview === false
  };
  try {
    return await call('sendMessage', { ...payload, parse_mode: 'HTML' }, token);
  } catch (e) {
    if (/parse|Entities|unsupported/i.test(e.description || '')) {
      const { parse_mode, ...rest } = payload;
      return await call('sendMessage', rest, token);
    }
    throw e;
  }
}

/* ---------------- Midias (varias URLs e/ou arquivos locais) ---------------- */

function mediaItems(node) {
  const m = node.media;
  if (Array.isArray(m)) {
    return m
      .filter((x) => x && (x.url || x.file))
      .map((x) => ({
        kind: x.file ? 'file' : 'url',
        url: x.url || '',
        file: x.file || '',
        name: x.name || '',
        type: x.type === 'video' ? 'video' : x.type === 'document' ? 'document' : 'photo'
      }));
  }
  const s = typeof m === 'string' ? m.trim() : '';
  if (!s) return [];
  return [{ kind: 'url', url: s, name: '', type: node.media_type === 'video' ? 'video' : 'photo' }];
}

function pickMethod(type, ref) {
  if (type === 'document') return { method: 'sendDocument', field: 'document' };
  if (type === 'video' || /\.(mp4|webm|mov|mkv)(\?|$)/i.test(ref || '')) return { method: 'sendVideo', field: 'video' };
  return { method: 'sendPhoto', field: 'photo' };
}

function isParseError(e) {
  return /parse|Entities|unsupported/i.test((e && (e.description || e.message)) || '');
}

async function sendUrlItem(token, chatId, item, caption, reply_markup) {
  const { method, field } = pickMethod(item.type, item.url);
  const base = { chat_id: chatId, [field]: item.url, reply_markup };
  const payload = caption ? { ...base, caption, parse_mode: 'HTML' } : base;
  try {
    return await call(method, payload, token);
  } catch (e) {
    if (caption && isParseError(e)) {
      const { parse_mode, ...rest } = payload;
      return await call(method, rest, token);
    }
    throw e;
  }
}

async function sendFileItem(token, chatId, item, caption, reply_markup) {
  const buf = fs.readFileSync(path.join(db.DATA_DIR, 'uploads', item.file));
  const { method, field } = pickMethod(item.type, item.name || item.file);
  const mime = item.type === 'video' ? 'video/mp4' : item.type === 'document' ? 'application/pdf' : 'image/jpeg';
  const ext = path.extname(item.file) || '.bin';
  const rawName = String(item.name || '').replace(/[^\w.\- ]+/g, '_').trim();
  const fileName = (rawName || 'arquivo') + (rawName.includes('.') ? '' : ext);

  const build = (withCaption) => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append(field, new Blob([buf], { type: mime }), fileName);
    if (withCaption && caption) form.append('caption', caption);
    if (withCaption && caption) form.append('parse_mode', 'HTML');
    if (reply_markup) form.append('reply_markup', JSON.stringify(reply_markup));
    return form;
  };

  const post = async (form) => {
    const res = await fetch(`${API}/bot${token}/${method}`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      const err = new Error(`telegram ${method}: ${data.description || res.status}`);
      err.description = data.description || '';
      throw err;
    }
    return data.result;
  };

  try {
    return await post(build(true));
  } catch (e) {
    if (caption && isParseError(e)) return await post(build(false));
    throw e;
  }
}

async function sendItem(token, chatId, item, caption, reply_markup) {
  if (item.kind === 'file') return sendFileItem(token, chatId, item, caption, reply_markup);
  return sendUrlItem(token, chatId, item, caption, reply_markup);
}

async function sendNode(token, chatId, node) {
  const items = mediaItems(node);
  const text = node.text || '';
  const reply_markup = keyboardFor(node);
  if (!items.length) return sendText(token, chatId, text, reply_markup);

  let textSent = false;
  let sentAny = false;
  let lastErr = null;

  for (let i = 0; i < items.length; i++) {
    const caption = i === 0 && text && !textSent ? text : '';
    const markup = i === 0 ? reply_markup : undefined;
    try {
      await sendItem(token, chatId, items[i], caption, markup);
      sentAny = true;
      if (caption) textSent = true;
    } catch (e) {
      lastErr = e;
      // fallback: envia a midia sem legenda e o texto em seguida
      try {
        await sendItem(token, chatId, items[i], '', undefined);
        sentAny = true;
        if (caption) {
          await sendText(token, chatId, text, reply_markup);
          textSent = true;
        }
      } catch (e2) {
        lastErr = e2;
      }
    }
  }

  if (!sentAny) {
    if (text) return sendText(token, chatId, text, reply_markup);
    throw lastErr || new Error('sendNode: nenhuma midia enviada');
  }
  return { sent: true };
}

async function sendPixMessage(bot, chatId, payment, node) {
  const token = bot.token;
  const valor = Number(payment.amount || 0).toFixed(2);
  const qr = payment.qr_code || '';
  const ticket = payment.ticket_url || '';
  const markup = keyboardFor(node);
  const lines = [
    ' PIX GERADO ',
    '',
    '💰 Valor: <b>R$ ' + valor + '</b>',
    '',
    '💳 <b>Pix Copia e Cola:</b>',
    '<code>' + qr + '</code>',
    ticket ? '\n🔗 Link: ' + ticket : '',
    '',
    '✅ O acesso é liberado automaticamente assim que o pagamento for aprovado.'
  ].filter(Boolean);
  const text = lines.join('\n');

  if (payment.qr_base64) {
    try {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('photo', new Blob([Buffer.from(payment.qr_base64, 'base64')], { type: 'image/png' }), 'pix.png');
      form.append('caption', text);
      form.append('parse_mode', 'HTML');
      if (markup) form.append('reply_markup', JSON.stringify(markup));
      const res = await fetch(`${API}/bot${token}/sendPhoto`, { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (data.ok) return data.result;
    } catch (e) {
      console.error('qr photo failed:', e.message);
    }
  }
  return sendText(token, chatId, text, markup);
}

async function setWebhook(bot, baseUrl) {
  const url = `${baseUrl.replace(/\/+$/, '')}/tg/${bot.id}`;
  const payload = { url, allowed_updates: ['message', 'callback_query'] };
  if (bot.secret) payload.secret_token = bot.secret;
  await call('setWebhook', payload, bot.token);
  return url;
}

async function deleteWebhook(bot) {
  await call('deleteWebhook', { drop_pending_updates: false }, bot.token).catch(() => {});
}

async function getMe(token) {
  return call('getMe', {}, token);
}

async function getChat(token, chatId) {
  return call('getChat', { chat_id: chatId }, token);
}

async function getChatMember(token, chatId, userId) {
  return call('getChatMember', { chat_id: chatId, user_id: userId }, token);
}

/* Convite de uso unico: member_limit = 1 (uma pessoa so) */
async function createOneTimeInvite(token, chatId, name) {
  const res = await call(
    'createChatInviteLink',
    { chat_id: chatId, member_limit: 1, name: name || undefined },
    token
  );
  return res.invite_link;
}

module.exports = {
  call,
  sendNode,
  sendText,
  sendPixMessage,
  setWebhook,
  deleteWebhook,
  getMe,
  getChat,
  getChatMember,
  createOneTimeInvite,
  keyboardFor,
  mediaItems
};
