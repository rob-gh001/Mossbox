const { execFile } = require('child_process');
const dns = require('dns').promises;

function isSafeHost(value) {
  return /^[a-zA-Z0-9._:-]+$/.test(value || '');
}

function pingHost(host) {
  return new Promise((resolve) => {
    execFile('ping', ['-c', '1', host], { timeout: 10000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout, stderr, code: error && typeof error.code === 'number' ? error.code : 0 });
    });
  });
}

async function lookupHost(host) {
  const out = { host, addresses: [], error: '' };
  try {
    const addrs = await dns.lookup(host, { all: true });
    out.addresses = addrs;
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

module.exports = { pingHost, lookupHost, isSafeHost };
