require('dotenv').config();

const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const { db, uploadsDir } = require('./db');
const { requireAuth, requireApiKey } = require('./lib/auth');
const { upload } = require('./lib/upload');
const { pingHost, lookupHost, isSafeHost } = require('./lib/ping');
const { getFileRecord, sendStoredFileStream } = require('./lib/files');

const app = express();
const port = Number(process.env.PORT || 3000);
const host = '0.0.0.0';
const appPassword = process.env.APP_PASSWORD || 'changeme';
const sessionSecret = process.env.SESSION_SECRET || 'change-this-secret';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));
app.use(session({ secret: sessionSecret, resave: false, saveUninitialized: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function renderPage(res, view, params = {}) {
  const viewPath = path.join(__dirname, 'views', `${view}.ejs`);
  const body = require('ejs').render(fs.readFileSync(viewPath, 'utf8'), params);
  const layoutPath = path.join(__dirname, 'views', 'layout.ejs');
  const html = require('ejs').render(fs.readFileSync(layoutPath, 'utf8'), {
    title: params.title || 'Mossbox',
    body,
    authed: !!params.authed,
  });
  res.send(html);
}

app.get('/', (_req, res) => res.redirect('/drop'));
app.get('/login', (req, res) => renderPage(res, 'login', { title: 'Login', error: req.query.error, authed: false }));
app.post('/login', (req, res) => {
  if ((req.body.password || '') === appPassword) {
    req.session.authenticated = true;
    return res.redirect('/drop');
  }
  return res.redirect('/login?error=Invalid+password');
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/drop', requireAuth, (_req, res) => {
  const files = db.prepare('SELECT * FROM files ORDER BY id DESC LIMIT 50').all();
  renderPage(res, 'drop', { title: 'Drop', files, authed: true });
});
app.post('/drop/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send('No file');
  db.prepare('INSERT INTO files (stored_name, original_name, mime_type, size_bytes) VALUES (?, ?, ?, ?)')
    .run(req.file.filename, req.file.originalname, req.file.mimetype, req.file.size);
  res.redirect('/drop');
});
app.post('/drop/:id/delete', requireAuth, (req, res) => {
  const file = getFileRecord(req.params.id);
  if (file) {
    const filePath = require('./lib/files').getStoredFilePath(file);
    db.prepare('DELETE FROM files WHERE id = ?').run(req.params.id);
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }
  res.redirect('/drop');
});
app.post('/api/files/upload', requireApiKey, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const info = db.prepare('INSERT INTO files (stored_name, original_name, mime_type, size_bytes) VALUES (?, ?, ?, ?)')
    .run(req.file.filename, req.file.originalname, req.file.mimetype, req.file.size);
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(info.lastInsertRowid);
  res.json({ ok: true, file: row, contentUrl: `/api/files/${row.id}/content`, webDownloadUrl: `/files/${row.id}` });
});

app.get('/api/files', requireApiKey, (_req, res) => {
  const files = db.prepare('SELECT * FROM files ORDER BY id DESC LIMIT 100').all();
  res.json({ ok: true, files });
});
app.get('/api/files/:id', requireApiKey, (req, res) => {
  const file = getFileRecord(req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, file, contentUrl: `/api/files/${file.id}/content` });
});
app.get('/api/files/:id/content', requireApiKey, (req, res) => {
  const file = getFileRecord(req.params.id);
  if (!file) return res.status(404).json({ error: 'Not found' });
  return sendStoredFileStream(res, file, { jsonErrors: true });
});
app.get('/files/:id', requireAuth, (req, res) => {
  const file = getFileRecord(req.params.id);
  if (!file) return res.status(404).send('Not found');
  return sendStoredFileStream(res, file, { jsonErrors: false });
});

app.get('/notes', requireAuth, (req, res) => {
  const filter = (req.query.filter || 'all').toLowerCase();
  let sql = 'SELECT * FROM notes';
  if (filter === 'notes') sql += " WHERE type = 'note'";
  else if (filter === 'todos') sql += " WHERE type = 'todo'";
  else if (filter === 'open') sql += " WHERE type = 'todo' AND is_done = 0";
  else if (filter === 'done') sql += " WHERE type = 'todo' AND is_done = 1";
  sql += ' ORDER BY id DESC LIMIT 100';
  const notes = db.prepare(sql).all();
  renderPage(res, 'notes', { title: 'Notes', notes, authed: true, currentFilter: filter });
});
app.post('/notes/create', requireAuth, (req, res) => {
  const type = req.body.type === 'todo' ? 'todo' : 'note';
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).send('Content required');
  db.prepare('INSERT INTO notes (type, content, is_done) VALUES (?, ?, ?)').run(type, content, 0);
  res.redirect('/notes');
});
app.post('/notes/:id/toggle', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (row && row.type === 'todo') {
    db.prepare('UPDATE notes SET is_done = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.is_done ? 0 : 1, req.params.id);
  }
  res.redirect('/notes');
});
app.post('/notes/:id/delete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
  res.redirect('/notes');
});
app.post('/api/notes', requireApiKey, (req, res) => {
  const type = req.body.type === 'todo' ? 'todo' : 'note';
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Content required' });
  const info = db.prepare('INSERT INTO notes (type, content, is_done) VALUES (?, ?, ?)').run(type, content, 0);
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid);
  res.json({ ok: true, note: row });
});

app.get('/api/notes', requireApiKey, (_req, res) => {
  const notes = db.prepare('SELECT * FROM notes ORDER BY id DESC LIMIT 100').all();
  res.json({ ok: true, notes });
});
app.post('/api/notes/:id/toggle', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (row && row.type === 'todo') {
    db.prepare('UPDATE notes SET is_done = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.is_done ? 0 : 1, req.params.id);
  }
  res.redirect('/notes');
});

app.get('/bookmarks', requireAuth, (req, res) => {
  const query = (req.query.q || '').trim();
  let bookmarks;
  if (query) {
    const like = `%${query}%`;
    bookmarks = db.prepare(`SELECT * FROM bookmarks
      WHERE url LIKE ? OR COALESCE(title, '') LIKE ? OR COALESCE(note, '') LIKE ? OR COALESCE(fetched_title, '') LIKE ?
      ORDER BY id DESC LIMIT 100`).all(like, like, like, like);
  } else {
    bookmarks = db.prepare('SELECT * FROM bookmarks ORDER BY id DESC LIMIT 100').all();
  }
  renderPage(res, 'bookmarks', { title: 'Bookmarks', bookmarks, authed: true, query });
});
app.post('/bookmarks/create', requireAuth, async (req, res) => {
  const url = (req.body.url || '').trim();
  const title = (req.body.title || '').trim();
  const note = (req.body.note || '').trim();
  if (!url) return res.status(400).send('URL required');
  let fetchedTitle = '';
  let finalUrl = '';
  try {
    const response = await fetch(url, { redirect: 'follow' });
    finalUrl = response.url;
    const text = await response.text();
    const match = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    fetchedTitle = match ? match[1].trim() : '';
  } catch {}
  db.prepare('INSERT INTO bookmarks (url, title, note, fetched_title, final_url) VALUES (?, ?, ?, ?, ?)').run(url, title, note, fetchedTitle, finalUrl);
  res.redirect('/bookmarks');
});
app.post('/bookmarks/:id/delete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM bookmarks WHERE id = ?').run(req.params.id);
  res.redirect('/bookmarks');
});
app.post('/api/bookmarks', requireApiKey, async (req, res) => {
  const url = (req.body.url || '').trim();
  const title = (req.body.title || '').trim();
  const note = (req.body.note || '').trim();
  if (!url) return res.status(400).json({ error: 'URL required' });
  let fetchedTitle = '';
  let finalUrl = '';
  try {
    const response = await fetch(url, { redirect: 'follow' });
    finalUrl = response.url;
    const text = await response.text();
    const match = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    fetchedTitle = match ? match[1].trim() : '';
  } catch {}
  const info = db.prepare('INSERT INTO bookmarks (url, title, note, fetched_title, final_url) VALUES (?, ?, ?, ?, ?)').run(url, title, note, fetchedTitle, finalUrl);
  const row = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(info.lastInsertRowid);
  res.json({ ok: true, bookmark: row });
});

app.get('/api/bookmarks', requireApiKey, (_req, res) => {
  const bookmarks = db.prepare('SELECT * FROM bookmarks ORDER BY id DESC LIMIT 100').all();
  res.json({ ok: true, bookmarks });
});

app.get('/tools', requireAuth, (_req, res) => {
  renderPage(res, 'tools', { title: 'Tools', fetchResult: '', pingResult: '', dnsResult: '', authed: true });
});
app.post('/tools/fetch', requireAuth, async (req, res) => {
  const url = (req.body.url || '').trim();
  const method = (req.body.method || 'GET').toUpperCase();
  const body = req.body.body || '';
  let output = '';
  try {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http/https URLs are allowed');
    const response = await fetch(url, {
      method,
      body: method === 'GET' ? undefined : String(body).slice(0, 5000),
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    const headers = Array.from(response.headers.entries()).map(([k, v]) => `${k}: ${v}`).join('\n');
    const text = await response.text();
    output = `STATUS: ${response.status} ${response.statusText}\nFINAL URL: ${response.url}\n\nHEADERS\n${headers}\n\nBODY PREVIEW\n${text.slice(0, 4000)}`;
  } catch (error) {
    output = `ERROR: ${error.message}`;
  }
  renderPage(res, 'tools', { title: 'Tools', fetchResult: output, pingResult: '', dnsResult: '', authed: true });
});
app.post('/tools/ping', requireAuth, async (req, res) => {
  const hostValue = (req.body.host || '').trim();
  let output = '';
  if (!hostValue || !isSafeHost(hostValue)) {
    output = 'ERROR: Invalid host format';
  } else {
    const result = await pingHost(hostValue);
    output = `${result.ok ? 'OK' : 'FAIL'}\n\n${result.stdout || ''}${result.stderr || ''}`.trim();
  }
  renderPage(res, 'tools', { title: 'Tools', fetchResult: '', pingResult: output, dnsResult: '', authed: true });
});
app.post('/tools/dns', requireAuth, async (req, res) => {
  const hostValue = (req.body.host || '').trim();
  let output = '';
  if (!hostValue || !isSafeHost(hostValue)) {
    output = 'ERROR: Invalid host format';
  } else {
    const result = await lookupHost(hostValue);
    output = result.error
      ? `ERROR: ${result.error}`
      : `HOST: ${result.host}\n\n${result.addresses.map(a => `${a.address} (IPv${a.family})`).join('\n') || 'No addresses'}`;
  }
  renderPage(res, 'tools', { title: 'Tools', fetchResult: '', pingResult: '', dnsResult: output, authed: true });
});

app.listen(port, host, () => {
  console.log(`Mossbox listening on http://${host}:${port}`);
});
