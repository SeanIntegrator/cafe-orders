/**
 * Tracks order IDs that were "Done" on the board but not paid in Square.
 * We hide these from GET /api/orders so they don't reappear on refresh
 * (e.g. in sandbox where you can't actually pay).
 * Works locally (file) and on hosted (in-memory fallback when fs is read-only).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_FILE = path.join(__dirname, '..', 'dismissed-orders.json');
const TMP_FILE = path.join(os.tmpdir(), 'cafe-orders-dismissed.json');

let ids = new Set();
let savePath = PROJECT_FILE;
let persistenceDisabled = false;

function load() {
  for (const file of [PROJECT_FILE, TMP_FILE]) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        ids = new Set(arr);
        savePath = file;
      }
      break;
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('dismissed-orders: load failed', e.message);
    }
  }
}

function save() {
  if (persistenceDisabled) return;
  const payload = JSON.stringify([...ids]);
  for (const file of [savePath, PROJECT_FILE, TMP_FILE]) {
    try {
      fs.writeFileSync(file, payload, 'utf8');
      savePath = file;
      return;
    } catch (e) {
      if (e.code === 'ENOENT') {
        try {
          const dir = path.dirname(file);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(file, payload, 'utf8');
          savePath = file;
          return;
        } catch (_) {}
      }
    }
  }
  persistenceDisabled = true;
  console.warn('dismissed-orders: file write not available, using in-memory only (resets on restart)');
}

function add(orderId) {
  if (!orderId) return;
  ids.add(orderId);
  save();
}

function has(orderId) {
  return ids.has(orderId);
}

// Load on first use
load();

module.exports = {
  add,
  has,
};
