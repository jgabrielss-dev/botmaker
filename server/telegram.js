const API = 'https://api.telegram.org';

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

async function sendMedia(token, chatId, node) {
  const media = (node.media || '').trim();
  const reply_markup = keyboardFor(node);
  const text = node.text || '';
  const isVideo = node.media_type === 'video' || /\.(mp4|webm|mov|mkv)(\?|$)/i.test(media);
  const method = isVideo ? 'sendVideo' : 'sendPhoto';
  const field = isVideo ? 'video' : 'photo';

  const payload = {
    chat_id: chatId,
    [field]: media,
    caption: text || undefined,
    reply_markup
  };
  try {
    return await call(method, { ...payload, parse_mode: 'HTML' }, token);
  } catch (e) {
    if (/parse|Entities|unsupported/i.test(e.description || '')) {
      const { parse_mode, ...rest } = payload;
      return await call(method, rest, token);
    }
    // fallback: envia a midia sem legenda e o texto em seguida
    await call(method, { chat_id: chatId, [field]: media, reply_markup }, token);
    if (text) await sendText(token, chatId, text, reply_markup);
  }
}

async function sendNode(token, chatId, node) {
  const media = (node.media || '').trim();
  if (media) return sendMedia(token, chatId, node);
  return sendText(token, chatId, node.text || '', keyboardFor(node));
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

module.exports = { call, sendNode, sendText, sendPixMessage, setWebhook, deleteWebhook, getMe, keyboardFor };
