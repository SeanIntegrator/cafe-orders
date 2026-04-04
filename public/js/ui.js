/** Lightweight UI utilities shared across modules. */

export function showToast(message, type) {
  const el = document.createElement('div');
  el.className = `demo-toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

const STATUS_ROOT_CLASSES = [
  'connection-status--connected',
  'connection-status--reconnecting',
  'connection-status--failed',
];
const STATUS_DOT_CLASSES = ['status-dot--connected', 'status-dot--reconnecting', 'status-dot--failed'];

const LABELS = {
  connected: 'LIVE',
  reconnecting: 'Reconnecting…',
  failed: 'Connection lost — refresh',
};

/**
 * @param {'connected' | 'reconnecting' | 'failed'} state
 */
export function setConnectionStatus(state) {
  const root = document.getElementById('connection-status');
  const dot = document.getElementById('connection-status-dot');
  const label = document.getElementById('connection-status-label');
  if (!root || !dot || !label) return;

  root.classList.remove(...STATUS_ROOT_CLASSES);
  dot.classList.remove(...STATUS_DOT_CLASSES);

  if (state === 'connected') {
    root.classList.add('connection-status--connected');
    dot.classList.add('status-dot--connected');
  } else if (state === 'failed') {
    root.classList.add('connection-status--failed');
    dot.classList.add('status-dot--failed');
  } else {
    root.classList.add('connection-status--reconnecting');
    dot.classList.add('status-dot--reconnecting');
  }

  label.textContent = LABELS[state] ?? LABELS.reconnecting;
}
