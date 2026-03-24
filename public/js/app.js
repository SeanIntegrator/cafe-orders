/** Entry point — socket setup, init sequence, and demo data. */

import { loadModifierCategories, loadLiveOrders } from './api.js';
import { addOrUpdateOrder, updateTimers } from './board.js';
import './history.js';

/* global io */
const socket = io();

socket.on('connect', () => {
  console.log('Connected to server');
  loadModifierCategories();
});

socket.on('new-order', (payload) => {
  console.log('Received new-order event from server:', payload);
  const list = Array.isArray(payload) ? payload : [payload];
  list.forEach((item) => {
    const order = item?.order ?? item;
    if (order?.id) addOrUpdateOrder(order);
  });
});

socket.on('orderUpdated', () => {
  loadLiveOrders(addOrUpdateOrder);
});

// Toggle completion state when clicking a line item
document.getElementById('board-container').addEventListener('click', (event) => {
  const line = event.target.closest('.line-item');
  if (!line) return;
  line.classList.toggle('completed');
});

setInterval(updateTimers, 1000);

// Modifier order for milk chips on cards, then live Square orders only
loadModifierCategories().then(() => loadLiveOrders(addOrUpdateOrder));
