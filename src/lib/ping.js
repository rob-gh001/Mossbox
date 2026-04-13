const { execFile } = require('child_process');

function pingHost(host) {
  return new Promise((resolve) => {
    execFile('ping', ['-c', '1', host], { timeout: 10000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout, stderr, code: error && typeof error.code === 'number' ? error.code : 0 });
    });
  });
}

module.exports = { pingHost };
