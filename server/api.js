const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const auth = require('./auth');
const tg = require('./telegram');
const E = require('./engine');

const router = express.Router();

/* ---------- Auth ---------- */
router.post('/login', (req, res) => {
  const token = auth.login((req.body && req.body.password) || '');
  if (!token) {
    const issues = auth.passwordIssues();
    const expectedLen = auth.expectedPassword().length;
    const givenLen = String((req.body && req.body.password) || '').length;
    return res.status(401).json({
      error: 'Senha incorreta',
      debug: {
        digitada: givenLen + ' caracteres',
        gravada: expectedLen + ' caracteres',
        avisos: issues
      }
    });
  }
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 7}; SameSite=Lax`);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  const cookies = auth.parseCookies(req);
  auth.logout(cookies.sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

router.get('/health', (req, res) =>
  res.json({
    ok: true,
    dataDir: process.env.DATA_DIR || '(padrao)',
    baseUrl: process.env.BASE_URL || null,
    adminPassword: !!process.env.ADMIN_PASSWORD,
    mpToken: (process.env.MERCADO_PAGO_ACCESS_TOKEN || '').startsWith('[cole') ? 'placeholder' : !!process.env.MERCADO_PAGO_ACCESS_TOKEN,
    bots: db.prepare('SELECT COUNT(*) c FROM bots').get().c,
    flows: db.prepare('SELECT COUNT(*) c FROM flows').get().c,
    debug: {
      node: process.version,
      railway: process.env.RAILWAY_ENVIRONMENT || null,
      service: process.env.RAILWAY_SERVICE_NAME || null,
      envCount: Object.keys(process.env).length,
      found: ['ADMIN_PASSWORD', 'BASE_URL', 'MERCADO_PAGO_ACCESS_TOKEN', 'MERCADO_PAGO_PUBLIC_KEY', 'DATA_DIR'].filter(
        (k) => process.env[k] !== undefined
      )
    },
    warnings: [
      ...auth.passwordIssues().map((i) => 'ADMIN_PASSWORD: ' + i),
      process.env.BASE_URL && /xxx\.|exemplo|example/i.test(process.env.BASE_URL)
        ? 'BASE_URL parece ser o texto de exemplo, troque pelo dominio real'
        : null,
      process.env.BASE_URL && !/^https:\/\//.test(process.env.BASE_URL) ? 'BASE_URL precisa comecar com https://' : null,
      process.env.DATA_DIR && !process.env.DATA_DIR.startsWith('/')
        ? `DATA_DIR="${process.env.DATA_DIR}" e relativa: os dados sao apagados a cada deploy (use /data com volume)`
        : null,
      process.env.DATA_DIR && process.env.DATA_DIR !== '/data' && process.env.DATA_DIR.startsWith('/')
        ? `DATA_DIR="${process.env.DATA_DIR}" (o volume costuma ser /data, minusculo)`
        : null
    ].filter(Boolean)
  })
);

router.use(auth.requireAuth);

router.get('/me', (req, res) => res.json({ ok: true }));

/* ---------- Bots ---------- */
router.get('/bots', (req, res) => {
  const rows = db.prepare('SELECT * FROM bots ORDER BY id DESC').all();
  res.json(rows);
});

router.post('/bots', async (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  const name = String((req.body && req.body.name) || '').trim() || 'Bot';
  const m = token.match(/^\d+:[A-Za-z0-9_-]+$/);
  if (!m) return res.status(400).json({ error: 'Token inválido. Cole o token completo do BotFather (ex.: 123456:ABC-DEF...)' });

  let me;
  try {
    me = await tg.getMe(token);
  } catch (e) {
    return res.status(400).json({ error: 'Token recusado pelo Telegram: ' + e.message });
  }

  const secret = crypto.randomBytes(18).toString('base64url');
  const now = Date.now();
  let id;
  try {
    const info = db
      .prepare('INSERT INTO bots (name, token, secret, created_at) VALUES (?, ?, ?, ?)')
      .run(name + (me.username ? ' (@' + me.username + ')' : ''), token, secret, now);
    id = info.lastInsertRowid;
  } catch (e) {
    return res.status(400).json({ error: 'Esse token já está cadastrado.' });
  }

  const bot = E.getBot(id);
  try {
    const url = await tg.setWebhook(bot, process.env.BASE_URL || '');
    db.prepare('UPDATE bots SET webhook_url = ? WHERE id = ?').run(url, id);
  } catch (e) {
    return res.json({ ...E.getBot(id), warning: 'Bot salvo, mas webhook falhou: ' + e.message });
  }
  res.json(E.getBot(id));
});

router.delete('/bots/:id', async (req, res) => {
  const bot = E.getBot(Number(req.params.id));
  if (!bot) return res.status(404).json({ error: 'Bot não encontrado' });
  await tg.deleteWebhook(bot).catch(() => {});
  db.prepare('DELETE FROM bots WHERE id = ?').run(bot.id);
  db.prepare('DELETE FROM clients WHERE bot_id = ?').run(bot.id);
  res.json({ ok: true });
});

router.post('/bots/:id/webhook', async (req, res) => {
  const bot = E.getBot(Number(req.params.id));
  if (!bot) return res.status(404).json({ error: 'Bot não encontrado' });
  if (!process.env.BASE_URL) return res.status(400).json({ error: 'BASE_URL não configurada no .env' });
  try {
    const url = await tg.setWebhook(bot, process.env.BASE_URL);
    db.prepare('UPDATE bots SET webhook_url = ? WHERE id = ?').run(url, bot.id);
    res.json({ ok: true, url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/bots/:id/flow', (req, res) => {
  const bot = E.getBot(Number(req.params.id));
  if (!bot) return res.status(404).json({ error: 'Bot não encontrado' });
  let row = bot.flow_id ? db.prepare('SELECT * FROM flows WHERE id = ?').get(bot.flow_id) : null;
  if (!row) {
    // cada bot tem UM unico fluxo: cria automaticamente se ainda nao existir
    const info = db
      .prepare('INSERT INTO flows (bot_id, name, data, created_at) VALUES (?, ?, ?, ?)')
      .run(bot.id, 'Fluxo', JSON.stringify({ start: '', order: [], nodes: {} }), Date.now());
    db.prepare('UPDATE bots SET flow_id = ? WHERE id = ?').run(info.lastInsertRowid, bot.id);
    row = db.prepare('SELECT * FROM flows WHERE id = ?').get(info.lastInsertRowid);
  }
  res.json(flowJson(row));
});

/* ---------- Fluxos ---------- */
function flowJson(row) {
  let data;
  try {
    data = JSON.parse(row.data || '{}');
  } catch (e) {
    data = { start: '', nodes: {} };
  }
  return { id: row.id, bot_id: row.bot_id, name: row.name, data, created_at: row.created_at };
}

router.get('/flows', (req, res) => {
  const botId = req.query.bot_id ? Number(req.query.bot_id) : null;
  const rows = botId
    ? db.prepare('SELECT * FROM flows WHERE bot_id = ? ORDER BY id DESC').all(botId)
    : db.prepare('SELECT * FROM flows ORDER BY id DESC').all();
  res.json(rows.map(flowJson));
});

router.post('/flows', (req, res) => {
  const botId = Number(req.body && req.body.bot_id);
  if (!E.getBot(botId)) return res.status(400).json({ error: 'Bot inválido' });
  const name = String((req.body && req.body.name) || 'Fluxo');
  const data = JSON.stringify(req.body && req.body.data ? req.body.data : { start: '', nodes: {} });
  const info = db
    .prepare('INSERT INTO flows (bot_id, name, data, created_at) VALUES (?, ?, ?, ?)')
    .run(botId, name, data, Date.now());
  const count = db.prepare('SELECT COUNT(*) c FROM flows WHERE bot_id = ?').get(botId).c;
  if (count === 1) db.prepare('UPDATE bots SET flow_id = ? WHERE id = ?').run(info.lastInsertRowid, botId);
  const row = db.prepare('SELECT * FROM flows WHERE id = ?').get(info.lastInsertRowid);
  res.json(flowJson(row));
});

router.get('/flows/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM flows WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Fluxo não encontrado' });
  res.json(flowJson(row));
});

router.put('/flows/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM flows WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Fluxo não encontrado' });
  const name = req.body && req.body.name ? String(req.body.name) : row.name;
  const data = req.body && req.body.data ? JSON.stringify(req.body.data) : row.data;
  db.prepare('UPDATE flows SET name = ?, data = ? WHERE id = ?').run(name, data, row.id);
  res.json(flowJson(db.prepare('SELECT * FROM flows WHERE id = ?').get(row.id)));
});

router.delete('/flows/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM flows WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Fluxo não encontrado' });
  db.prepare('DELETE FROM flows WHERE id = ?').run(row.id);
  db.prepare('UPDATE bots SET flow_id = NULL WHERE flow_id = ?').run(row.id);
  res.json({ ok: true });
});

router.post('/flows/:id/activate', (req, res) => {
  const row = db.prepare('SELECT * FROM flows WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Fluxo não encontrado' });
  db.prepare('UPDATE bots SET flow_id = ? WHERE id = ?').run(row.id, row.bot_id);
  res.json({ ok: true });
});

/* ---------- Clientes / Pagamentos ---------- */
router.get('/clients', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, b.name AS bot_name FROM clients c LEFT JOIN bots b ON b.id = c.bot_id ORDER BY c.updated_at DESC LIMIT 300`
    )
    .all();
  res.json(rows);
});

router.get('/payments', (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*, b.name AS bot_name FROM payments p LEFT JOIN bots b ON b.id = p.bot_id ORDER BY p.id DESC LIMIT 300`
    )
    .all();
  res.json(rows);
});

/* ---------- Grupos (convites de uso unico) ---------- */
router.get('/groups', (req, res) => {
  const botId = req.query.bot_id ? Number(req.query.bot_id) : null;
  const rows = botId
    ? db.prepare('SELECT * FROM groups WHERE bot_id = ? ORDER BY id DESC').all(botId)
    : db.prepare('SELECT * FROM groups ORDER BY id DESC').all();
  res.json(rows);
});

router.post('/groups', async (req, res) => {
  const botId = Number(req.body && req.body.bot_id);
  const bot = E.getBot(botId);
  if (!bot) return res.status(400).json({ error: 'Bot inválido' });
  const chatId = String((req.body && req.body.chat_id) || '').trim();
  if (!chatId) return res.status(400).json({ error: 'Informe o ID (-100...) ou @usuario do grupo' });

  try {
    const me = await tg.getMe(bot.token);
    const chat = await tg.getChat(bot.token, chatId);
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup'))
      return res.status(400).json({ error: 'Esse chat não é um grupo/supergupo' });
    const member = await tg.getChatMember(bot.token, chatId, me.id);
    if (member.status !== 'administrator' && member.status !== 'creator')
      return res.status(400).json({ error: 'O bot não é administrador desse grupo' });
    if (member.can_invite_users === false)
      return res.status(400).json({ error: 'O bot não tem permissão de "Adicionar novos membros" nas administrações do grupo' });

    const title = String(chat.title || chat.username || chatId).slice(0, 80);
    const info = db
      .prepare('INSERT INTO groups (bot_id, chat_id, title, created_at) VALUES (?,?,?,?)')
      .run(botId, chatId, title, Date.now());
    res.json(db.prepare('SELECT * FROM groups WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: 'Telegram recusou: ' + e.message });
  }
});

router.delete('/groups/:id', (req, res) => {
  const info = db.prepare('DELETE FROM groups WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true, removed: info.changes });
});

/* ---------- Upload de midia local (arquivo do aparelho) ---------- */
const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'application/pdf': '.pdf',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg'
};

router.post('/uploads', express.raw({ type: () => true, limit: '40mb' }), (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || !buf.length) return res.status(400).json({ error: 'Arquivo vazio' });
  const mime = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
  const ext = MIME_EXT[mime];
  // extensao vem SEMPRE do mime (nunca do nome do arquivo) para nao servir html
  if (!ext) return res.status(400).json({ error: 'Formato não suportado: ' + (mime || 'desconhecido') });

  const type = mime.startsWith('image/') ? 'photo' : mime.startsWith('video/') ? 'video' : 'document';
  const file = crypto.randomBytes(12).toString('hex') + ext;
  const dir = path.join(db.DATA_DIR, 'uploads');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), buf);
  } catch (e) {
    return res.status(500).json({ error: 'Falha ao gravar: ' + e.message });
  }
  res.json({ ok: true, file, name: String(req.query.name || file).slice(-80), mime, type, size: buf.length });
});

module.exports = router;
