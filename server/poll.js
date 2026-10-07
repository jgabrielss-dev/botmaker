/* Polling local (getUpdates) — usado quando o bot NAO tem webhook registrado.
   Permite testar o bot na maquina local sem URL publica/HTTPS. */
const db = require('./db');
const E = require('./engine');
const tg = require('./telegram');

const offsets = new Map();
const running = new Set();
let enabled = true;
let timer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pollable(bot) {
  return enabled && bot && !bot.webhook_url;
}

async function loop(bot) {
  while (enabled) {
    const still = db.prepare('SELECT * FROM bots WHERE id = ?').get(bot.id);
    if (!pollable(still)) break;
    try {
      const updates = await tg.call(
        'getUpdates',
        { offset: offsets.get(bot.id) || 0, timeout: 10, limit: 100, allowed_updates: ['message', 'callback_query'] },
        still.token
      );
      const list = Array.isArray(updates) ? updates : [];
      let max = offsets.get(bot.id) || 0;
      for (const u of list) {
        max = Math.max(max, Number(u.update_id) + 1);
        try {
          await E.handleUpdate(still, u);
        } catch (e) {
          console.error('polling update error bot=' + still.id, e.message);
        }
      }
      offsets.set(bot.id, max);
      // resposta vazia volta ao Telegram na hora; um respiro evita loop apertado
      if (!list.length) await sleep(100);
    } catch (e) {
      const desc = e.description || e.message || '';
      if (/409|conflict|terminated by other/i.test(desc)) {
        console.warn(`Polling desativado para o bot ${still.id}: outra instancia ja chama getUpdates (ou webhook ativo).`);
        break;
      }
      console.error('polling error bot=' + still.id, desc);
      await sleep(5000);
    }
  }
}

function tick() {
  if (!enabled) return;
  let bots = [];
  try {
    bots = db.prepare('SELECT * FROM bots').all().filter(pollable);
  } catch (e) {
    return;
  }
  for (const bot of bots) {
    if (running.has(bot.id)) continue;
    running.add(bot.id);
    console.log(`Bot ${bot.id} (${bot.name}) em modo polling local (sem webhook).`);
    loop(bot).finally(() => running.delete(bot.id));
  }
}

function startPolling() {
  if (timer) return;
  timer = setInterval(tick, 2000);
  tick();
  console.log('Polling local disponivel para bots sem webhook (testes na maquina local).');
}

function stopPolling() {
  enabled = false;
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startPolling, stopPolling, tick, pollable };
