const crypto = require('crypto');
const db = require('./db');

const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 dias

function hashPassword(pw) {
  return crypto.createHash('sha256').update('panel:' + pw).digest('hex');
}

/* remove aspas e espaços que costumam sobrar ao colar a senha no Railway */
function clean(pw) {
  let s = String(pw == null ? '' : pw).trim();
  if ((s.startsWith('"') && s.endsWith('"') && s.length > 1) || (s.startsWith("'") && s.endsWith("'") && s.length > 1)) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function expectedPassword() {
  const raw = process.env.ADMIN_PASSWORD;
  if (raw === undefined || raw === '') return 'admin';
  return clean(raw);
}

function passwordIssues() {
  const raw = process.env.ADMIN_PASSWORD;
  if (!raw) return [];
  const out = [];
  if (raw !== raw.trim()) out.push('espaços sobrando');
  if (/^["'].*["']$/.test(raw.trim())) out.push('aspas');
  if (/[\r\n]/.test(raw)) out.push('quebra de linha');
  if (/^\[cole aqui\]$/i.test(raw.trim())) out.push('está com o texto de exemplo [cole aqui]');
  return out;
}
function login(password) {
  if (!password) return null;
  if (clean(password) !== expectedPassword()) return null;
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, created_at) VALUES (?, ?)').run(token, Date.now());
  return token;
}

function valid(token) {
  if (!token) return false;
  const row = db.prepare('SELECT created_at FROM sessions WHERE token = ?').get(token);
  if (!row) return false;
  if (Date.now() - row.created_at > SESSION_TTL) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return false;
  }
  return true;
}

function logout(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token || '');
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  if (valid(cookies.sid)) return next();
  res.status(401).json({ error: 'Sessão expirada, entre novamente' });
}

module.exports = { login, logout, valid, requireAuth, parseCookies, passwordIssues, expectedPassword };
