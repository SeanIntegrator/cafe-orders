/** Entry point — socket setup, init sequence, and demo data. */

import { loadModifierCategories, loadLiveOrders } from './api.js';
import { addOrUpdateOrder, updateTimers } from './board.js';
import './modal.js'; // registers modal event listeners
import './history.js'; // Today's orders / recall modal

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

// Toggle completion state when clicking a line item
document.getElementById('board-container').addEventListener('click', (event) => {
  const line = event.target.closest('.line-item');
  if (!line) return;
  line.classList.toggle('completed');
});

setInterval(updateTimers, 1000);

// Load modifier categories first so milk chip ordering is correct, then load live orders
loadModifierCategories().then(() => loadLiveOrders(addOrUpdateOrder)).then(() => {
  // Demo cards — populate both rows so the layout is always visible during development
  setTimeout(() => {
    addOrUpdateOrder({
      id: 'demo-001',
      reference_id: 'A1',
      state: 'COMPLETED',
      note: 'Allergy Egg',
      tenders: [{ type: 'CARD' }],
      fulfillments: [{ type: 'DINE_IN', pickup_details: { recipient: { display_name: 'Sarah' } } }],
      line_items: [
        { name: 'Latte', quantity: '1', variation_name: 'Large', modifiers: [{ name: 'Oat' }, { name: 'Extra shot' }] },
        { name: 'Almond Croissant', quantity: '2' },
      ],
      total_money: { amount: 1050, currency: 'GBP' },
    });

    addOrUpdateOrder({
      id: 'demo-002',
      reference_id: 'A2',
      state: 'OPEN',
      fulfillments: [{ type: 'PICKUP', pickup_details: { recipient: { display_name: 'James' } } }],
      line_items: [
        { name: 'Cappuccino', quantity: '1', modifiers: [{ name: 'Skinny' }] },
        { name: 'Latte', quantity: '1', variation_name: 'Small', modifiers: [{ name: 'Coconut' }] },
      ],
      total_money: { amount: 870, currency: 'GBP' },
    });

    addOrUpdateOrder({
      id: 'demo-003',
      reference_id: 'A3',
      state: 'OPEN',
      note: 'Iced, not too sweet',
      fulfillments: [{ type: 'PICKUP', pickup_details: { recipient: { display_name: 'Amelia' } } }],
      line_items: [
        { name: 'Iced Latte', quantity: '1', modifiers: [{ name: 'Coconut' }] },
        { name: 'Pain au Chocolat', quantity: '1' },
      ],
      total_money: { amount: 920, currency: 'GBP' },
    });

    addOrUpdateOrder({
      id: 'demo-004',
      reference_id: 'A4',
      state: 'OPEN',
      fulfillments: [{ type: 'DINE_IN', pickup_details: { recipient: { display_name: 'Lewis' } } }],
      line_items: [
        { name: 'Iced Matcha Latte', quantity: '1', modifiers: [{ name: 'Oat' }, { name: 'White chocolate' }] },
        { name: 'Savory Pain Suisse', quantity: '1' },
      ],
      total_money: { amount: 1180, currency: 'GBP' },
    });

    addOrUpdateOrder({
      id: 'demo-005',
      reference_id: 'A5',
      state: 'OPEN',
      note: 'Extra hot',
      fulfillments: [{ type: 'DINE_IN', pickup_details: { recipient: { display_name: 'Nina' } } }],
      line_items: [
        { name: 'Mocha', quantity: '1', modifiers: [{ name: 'Almond' }] },
        { name: 'Croissant', quantity: '1' },
        { name: 'Espresso', quantity: '1' },
      ],
      total_money: { amount: 1020, currency: 'GBP' },
    });

    addOrUpdateOrder({
      id: 'demo-006',
      reference_id: 'A6',
      state: 'OPEN',
      fulfillments: [{ type: 'PICKUP', pickup_details: { recipient: { display_name: 'Ollie' } } }],
      line_items: [
        { name: 'Chai Latte', quantity: '1', modifiers: [{ name: 'Soy' }, { name: 'Extra shot' }] },
        { name: 'Pain au Chocolat', quantity: '2' },
      ],
      total_money: { amount: 1240, currency: 'GBP' },
    });

    addOrUpdateOrder({
      id: 'demo-007',
      reference_id: 'A7',
      state: 'OPEN',
      fulfillments: [{ type: 'DINE_IN', pickup_details: { recipient: { display_name: 'Marco' } } }],
      line_items: [
        { name: 'Pistachio swirl', quantity: '1' },
        { name: 'Flat White', quantity: '2' },
        { name: 'Plain Croissant', quantity: '1' },
      ],
      total_money: { amount: 960, currency: 'GBP' },
    });

    addOrUpdateOrder({
      id: 'demo-008',
      reference_id: 'A8',
      state: 'OPEN',
      note: 'Table 4',
      fulfillments: [{ type: 'DINE_IN', pickup_details: { recipient: { display_name: 'Jess' } } }],
      line_items: [
        { name: 'Flat White', quantity: '1', modifiers: [{ name: 'Oat' }, { name: 'Extra shot' }] },
        { name: 'Latte', quantity: '1', variation_name: 'Large', modifiers: [{ name: 'Coconut' }] },
        { name: 'Ham and Cheese Croissant', quantity: '1' },
        { name: 'Plain Croissant', quantity: '2' },
      ],
      total_money: { amount: 1420, currency: 'GBP' },
    });

    addOrUpdateOrder({
      id: 'demo-009',
      reference_id: 'A9',
      state: 'OPEN',
      fulfillments: [{ type: 'DINE_IN', pickup_details: { recipient: { display_name: 'Sam' } } }],
      line_items: [
        { name: 'Iced Matcha Latte', quantity: '1', modifiers: [{ name: 'Soy' }, { name: 'Vanilla' }] },
        { name: 'Tea', quantity: '1', modifiers: [{ name: 'Oat' }] },
        { name: 'Pain au Chocolat', quantity: '1' },
        { name: 'Almond Croissant', quantity: '1' },
      ],
      total_money: { amount: 1180, currency: 'GBP' },
    });
  }, 800);
});
