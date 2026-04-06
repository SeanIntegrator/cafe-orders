#!/usr/bin/env node
/**
 * Assert lib/kds-visibility.js and public/js/kds-visibility.js agree on shouldShowOrderOnKds
 * for a shared fixture set (guards against server/client drift).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const lib = require('../lib/kds-visibility');

function loadBrowserPredicate() {
  const file = path.join(__dirname, '../public/js/kds-visibility.js');
  let code = fs.readFileSync(file, 'utf8');
  code = code.replace(/\r\n/g, '\n').replace(/^export function shouldShowOrderOnKds/m, 'function shouldShowOrderOnKds');
  const sandbox = { exports: {} };
  vm.createContext(sandbox);
  vm.runInNewContext(`${code}\nexports.__shouldShowOrderOnKds = shouldShowOrderOnKds;`, sandbox);
  return sandbox.exports.__shouldShowOrderOnKds;
}

const browserShouldShow = loadBrowserPredicate();

const fixtures = [
  { name: 'no id', order: { state: 'OPEN' }, expected: false },
  { name: 'canceled', order: { id: 'a', state: 'CANCELED' }, expected: false },
  { name: 'open', order: { id: 'b', state: 'OPEN' }, expected: true },
  {
    name: 'completed pos paid no fulfillments',
    order: { id: 'c', state: 'COMPLETED', fulfillments: [], tenders: [{ type: 'CARD' }] },
    expected: true,
  },
  {
    name: 'completed no tenders no ff',
    order: { id: 'd', state: 'COMPLETED', fulfillments: [], tenders: [] },
    expected: true,
  },
  {
    name: 'completed active fulfillment',
    order: {
      id: 'e',
      state: 'COMPLETED',
      fulfillments: [{ state: 'PROPOSED' }],
      tenders: [],
    },
    expected: true,
  },
  {
    name: 'completed all fulfillments done',
    order: {
      id: 'f',
      state: 'COMPLETED',
      fulfillments: [{ state: 'COMPLETED' }],
      tenders: [],
    },
    expected: false,
  },
  { name: 'draft', order: { id: 'g', state: 'DRAFT' }, expected: false },
];

let failed = false;
for (const f of fixtures) {
  const fromLib = lib.kdsShouldDisplayOrder(f.order);
  const fromBrowser = browserShouldShow(f.order);
  if (fromLib !== f.expected) {
    console.error(`FAIL lib ${f.name}: got ${fromLib} expected ${f.expected}`);
    failed = true;
  }
  if (fromBrowser !== f.expected) {
    console.error(`FAIL browser ${f.name}: got ${fromBrowser} expected ${f.expected}`);
    failed = true;
  }
  if (fromLib !== fromBrowser) {
    console.error(`FAIL mismatch ${f.name}: lib ${fromLib} vs browser ${fromBrowser}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
console.log('kds-visibility sync: OK (%d fixtures)', fixtures.length);
