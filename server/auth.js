const crypto = require('crypto');
const db = require('./db');

const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 dias

function hashPassword(pw) {
  return crypto.createHash('sha256').update('panel:' + pw).digest('hex');
}

function login(password) {
  const expected = process.env.ADMIN_PASSWORD || 'admin';
  if (!password || hashPassword(password) !== hashPassword(expected)) return null;
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
  res.status(401).json({ error: 'unauthorized' });
}

module.exports = { login, logout, valid, requireAuth, parseCookies };
