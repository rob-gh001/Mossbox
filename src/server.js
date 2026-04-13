const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { requireAuth } = require('./lib/auth');
const { upload } = require('./lib/upload');
const { pingHost } = require('./lib/ping');

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
app.post('/api/files/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send('No file');
  db.prepare('INSERT INTO files (stored_name, original_name, mime_type, size_bytes) VALUES (?, ?, ?, ?)')
    .run(req.file.filename, req.file.originalname, req.file.mimetype, req.file.size);
  res.redirect('/drop');
});
app.get('/files/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).send('Not found');
  const filePath = path.join(__dirname, '..', 'storage', 'uploads', row.stored_name);
  return res.download(filePath, row.original_name);
});

app.get('/notes', requireAuth, (_req, res) => {
  const notes = db.prepare('SELECT * FROM notes ORDER BY id DESC LIMIT 100').all();
  renderPage(res, 'notes', { title: 'Notes', notes, authed: true });
});
app.post('/api/notes', requireAuth, (req, res) => {
  const type = req.body.type === 'todo' ? 'todo' : 'note';
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).send('Content required');
  db.prepare('INSERT INTO notes (type, content, is_done) VALUES (?, ?, ?)').run(type, content, 0);
  res.redirect('/notes');
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
app.post('/api/bookmarks', requireAuth, async (req, res) => {
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
