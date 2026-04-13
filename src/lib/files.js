const fs = require('fs');
const path = require('path');
const { db, uploadsDir } = require('../db');

function getFileRecord(id) {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id);
}

function getStoredFilePath(fileRecord) {
  if (!fileRecord) return null;
  return path.join(uploadsDir, fileRecord.stored_name);
}

function fileExists(fileRecord) {
  const filePath = getStoredFilePath(fileRecord);
  return !!filePath && fs.existsSync(filePath);
}

function sendStoredFileStream(res, fileRecord, options = {}) {
  const filePath = getStoredFilePath(fileRecord);
  if (!filePath || !fs.existsSync(filePath)) {
    if (options.jsonErrors) return res.status(404).json({ error: 'File missing on disk' });
    return res.status(404).send('File missing on disk');
  }

  res.status(200);
  if (fileRecord.mime_type) res.type(fileRecord.mime_type);
  res.setHeader('Content-Length', String(fileRecord.size_bytes || fs.statSync(filePath).size));
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileRecord.original_name)}"`);

  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    if (!res.headersSent) {
      if (options.jsonErrors) res.status(500).json({ error: 'Stream failed', detail: err.message });
      else res.status(500).send('Stream failed');
    } else {
      res.destroy(err);
    }
  });
  stream.pipe(res);
}

module.exports = {
  getFileRecord,
  getStoredFilePath,
  fileExists,
  sendStoredFileStream,
};
