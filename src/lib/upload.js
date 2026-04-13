const path = require('path');
const multer = require('multer');
const { uploadsDir } = require('../db');

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safe = `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`;
    cb(null, safe);
  },
});

const upload = multer({ storage });

module.exports = { upload };
