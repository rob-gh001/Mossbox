function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  return res.redirect('/login');
}

function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY || '';
  if (!expected) {
    return res.status(500).json({ error: 'API key not configured' });
  }
  const auth = req.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const headerKey = req.get('x-api-key') || '';
  const presented = bearer || headerKey;
  if (presented && presented === expected) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { requireAuth, requireApiKey };
