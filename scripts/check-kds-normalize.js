#!/usr/bin/env node
/**
 * Fixtures for lib/kds-normalize — merged notes, modifiers shape, kds_prep, ex-list sort hints.
 */

process.env.KDS_MODIFIER_OPTION_IDS_EX = 'MOD_EX_1,MOD_EX_2';

const assert = require('assert');
const {
  normalizeKdsOrder,
  mergedLineNote,
  MAX_CUSTOMER_NOTE_LEN,
} = require('../lib/kds-normalize');

assert.strictEqual(mergedLineNote('hello', ''), 'hello');
assert.strictEqual(mergedLineNote('', 'pos note'), 'pos note');
assert.strictEqual(mergedLineNote('a', 'a'), 'a');

const long = 'x'.repeat(MAX_CUSTOMER_NOTE_LEN + 50);
assert.strictEqual(mergedLineNote(long, 'tail').length, MAX_CUSTOMER_NOTE_LEN);

const posOrder = normalizeKdsOrder({
  id: 'order_pos',
  state: 'OPEN',
  line_items: [
    {
      name: 'Latte',
      quantity: 1,
      note: 'Extra hot, oat',
      modifiers: [
        { name: 'Double shot', catalog_object_id: 'MOD_EX_1' },
        { name: 'Oat', catalog_object_id: 'MILK_1' },
      ],
    },
  ],
});

const li = posOrder.line_items[0];
assert.strictEqual(li.customer_note, 'Extra hot, oat');
assert.strictEqual(li.note, 'Extra hot, oat');
assert.ok(li.modifiers.some((m) => m.name === 'Double shot' && m.kds_sort_order === 2));
assert.ok(li.kds_prep && li.kds_prep.version === 1);
assert.ok(Array.isArray(li.kds_prep.beans) && li.kds_prep.beans.length >= 1);

const appStyle = normalizeKdsOrder({
  id: 'order_app',
  state: 'OPEN',
  line_items: [
    {
      name: 'Cappuccino',
      quantity: 1,
      customer_note: 'Table 4',
      modifiers: [{ name: 'Single shot', catalog_object_id: 'SHOT_1' }],
    },
  ],
});

assert.strictEqual(appStyle.line_items[0].customer_note, 'Table 4');

const cortadoNoteOnly = normalizeKdsOrder({
  id: 'order_cortado',
  state: 'OPEN',
  line_items: [
    {
      name: 'Cortado',
      quantity: 1,
      customer_note: 'Single shot',
      note: 'Single shot',
      modifiers: [],
    },
  ],
});
const cortadoLi = cortadoNoteOnly.line_items[0];
assert.strictEqual(
  cortadoLi.kds_prep.shotInfo.totalShots,
  1,
  'POS note-only Single shot should yield totalShots 1'
);
assert.strictEqual(cortadoLi.kds_prep.shotInfo.isNonStandard, true);
assert.strictEqual(cortadoLi.kds_prep.beans[0].shots, 1);
assert.strictEqual(cortadoLi.kds_prep.beans[0].isGhost, false);

console.log('kds-normalize: OK');
process.exit(0);
