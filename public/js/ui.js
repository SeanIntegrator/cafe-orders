/** Lightweight UI utilities shared across modules. */

export function showToast(message, type) {
  const el = document.createElement('div');
  el.className = `demo-toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
