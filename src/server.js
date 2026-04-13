const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const { db, uploadsDir } = require('./db');
const { requireAuth, requireApiKey } = require('./lib/auth');
const { upload } = require('./lib/upload');
const { pingHost } = require('./lib/ping');
const { getFileRecord, sendStoredFileStream } = require('./lib/files');

const app = express();
const port = Number(process.env.PORT || 3000);
const host = '0.0.0.0';
const appPassword = process.env.APP_PASSWORD || 'changeme';
const sessionSecret = process.env.SESSION_SECRET || 'dev-secret';

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

app.get('/notes', requireAuth, (_req, res) => {
  const notes = db.prepare('SELECT * FROM notes ORDER BY id DESC LIMIT 100').all();
  renderPage(res, 'notes', { title: 'Notes', notes, authed: true });
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

app.get('/bookmarks', requireAuth, (_req, res) => {
  const bookmarks = db.prepare('SELECT * FROM bookmarks ORDER BY id DESC LIMIT 100').all();
  renderPage(res, 'bookmarks', { title: 'Bookmarks', bookmarks, authed: true });
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
  renderPage(res, 'tools', { title: 'Tools', fetchResult: '', pingResult: '', authed: true });
});
app.post('/tools/fetch', requireAuth, async (req, res) => {
  const url = (req.body.url || '').trim();
  const method = (req.body.method || 'GET').toUpperCase();
  const body = req.body.body || '';
  let output = '';
  try {
    const response = await fetch(url, { method, body: method === 'GET' ? undefined : body, redirect: 'follow' });
    const text = await response.text();
    output = `STATUS: ${response.status} ${response.statusText}\nFINAL URL: ${response.url}\n\n${text.slice(0, 4000)}`;
  } catch (error) {
    output = `ERROR: ${error.message}`;
  }
  renderPage(res, 'tools', { title: 'Tools', fetchResult: output, pingResult: '', authed: true });
});
app.post('/tools/ping', requireAuth, async (req, res) => {
  const hostValue = (req.body.host || '').trim();
  const result = await pingHost(hostValue);
  const output = `${result.ok ? 'OK' : 'FAIL'}\n\n${result.stdout || ''}${result.stderr || ''}`.trim();
  renderPage(res, 'tools', { title: 'Tools', fetchResult: '', pingResult: output, authed: true });
});

app.listen(port, host, () => {
  console.log(`Mossbox listening on http://${host}:${port}`);
});
