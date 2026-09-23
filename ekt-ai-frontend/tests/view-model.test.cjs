const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const window = { location: { href: 'https://shop.test/assistant', origin: 'https://shop.test' } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'view-model.js'), 'utf8'), { window, URL, Intl, Date });
const view = window.EktView;
const normalized = value => value.replace(/[\u00a0\u202f]/g, ' ');
const plain = value => JSON.parse(JSON.stringify(value));
const now = Date.parse('2026-09-23T09:00:00Z');
const proposal = () => ({ id: 'p-1', productId: 515291, productName: 'Автомат', productArticle: '200300285_', quantity: 2, city: 'Астана', unitPrice: { amount: 100, currency: 'KZT' }, totalAmount: { amount: 200, currency: 'KZT' }, expiresAt: '2026-09-23T09:05:00Z' });

test('missing and malformed prices never become free products', () => {
  for (const value of [undefined, null, '', ' ', false, true, [], {}, Infinity, NaN, '1,000', { amount: null }, { value: 12 }, { amountMinor: 1.5 }, { amount: 1, currency: 'tenge' }]) {
    assert.equal(view.money(value), 'Не указана');
  }
  assert.equal(view.money(0), '0');
  assert.equal(view.money('0'), '0');
  assert.equal(normalized(view.money(1250.5)), '1 250,5');
  assert.equal(normalized(view.money({ amountMinor: 125050 })), '1 250,5');
  assert.match(view.money({ amount: 0, currency: 'KZT' }), /₸|KZT/);
  assert.equal(view.money({ amount: 50, amountMinor: 4999 }), 'Не указана');
});

test('cart totals use documented minor units and never invent currency', () => {
  assert.equal(normalized(view.cartTotal(123450)), '1 234,5');
  assert.equal(view.cartTotal(0), '0');
  assert.equal(view.cartTotal(undefined), 'Не указана');
  assert.equal(view.cartTotal(false), 'Не указана');
  assert.equal(view.cartTotal(-100), 'Не указана');
});

test('unknown stock remains distinct from zero; decimal strings are supported', () => {
  for (const value of [null, undefined, false, '', 'available', -1, { quantity: null }, { available: true }]) assert.equal(view.stock(value).quantity, null);
  assert.equal(view.stock(0).quantity, 0);
  assert.equal(view.stock({ quantity: '2.5' }).quantity, 2.5);
  assert.match(view.stock({ quantity: 0 }).label, /Нет в наличии/);
  assert.match(view.stock({}).label, /уточняется/);
});

test('city stock never uses unrelated totals or another city', () => {
  assert.equal(view.stock(100, 'Астана').quantity, null);
  assert.equal(view.stock({ quantity: 100 }, 'Астана').quantity, null);
  assert.equal(view.stock({ city: 'Алматы', quantity: 100 }, 'Астана').quantity, null);
  assert.equal(view.stock({ total: 200, byCity: { Алматы: 200, Астана: 0 } }, 'Астана').quantity, 0);
  assert.equal(view.stock({ total: 200, stores: [{ city: 'Алматы', quantity: 200 }] }, 'Астана').quantity, null);
  assert.equal(view.stock({ stores: [{ city: 'Астана', quantity: 5 }, { city: 'Астана', quantity: 3 }] }, 'Астана').quantity, null);
  assert.equal(view.stock({ stores: [{ city: ' АСТАНА ', quantity: '7' }] }, 'Астана').quantity, 7);
  assert.equal(view.stock({ byCity: { Астана: { quantity: '7.5' } } }, 'Астана').quantity, 7.5);
});

test('facts preserve order increment and omit unknown objects', () => {
  assert.deepEqual(plain(view.facts({ orderMultiple: 5, current: '160 А', certificate: null, unknown: [{ value: 'x' }] })), [['Кратность заказа', '5'], ['current', '160 А']]);
  assert.deepEqual(plain(view.facts([{ name: 'Ток', value: '160 А' }, { key: 'orderMultiple', value: 0.5 }, { label: 'Наличие сертификата', value: false }, { label: 'Нет значения' }])), [['Ток', '160 А'], ['Кратность заказа', '0,5'], ['Наличие сертификата', 'Нет']]);
});

test('order multiple is defaulted only when absent, with decimal steps supported', () => {
  assert.equal(view.orderMultiple({ facts: {} }), 1);
  assert.equal(view.orderMultiple({ facts: { orderMultiple: '0.5' } }), 0.5);
  assert.equal(view.orderMultiple({ facts: [{ key: 'orderMultiple', value: 2 }] }), 2);
  for (const value of [null, false, 0, -2, '', 'unknown']) assert.equal(view.orderMultiple({ facts: { orderMultiple: value } }), null);
  assert.equal(view.isMultiple(0.3, 0.1), true);
  assert.equal(view.isMultiple(1.5, 0.5), true);
  assert.equal(view.isMultiple(1.6, 0.5), false);
  assert.equal(view.isMultiple(0, 0.5), false);
  assert.equal(view.isMultiple(0.0000000001, 1), false);
  assert.equal(view.isMultiple(1, null), false);
});

test('links reject execution, embedded credentials and relative cross-origin targets', () => {
  assert.equal(view.safeLink('/cart'), 'https://shop.test/cart');
  assert.equal(view.safeLink('products/1'), 'https://shop.test/products/1');
  assert.equal(view.safeLink('https://ekt.kz/cart'), 'https://ekt.kz/cart');
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'https://user:secret@shop.test/cart', '//evil.test/cart', 'https://shop.test\\@evil.test', 'java\nscript:alert(1)', '', null]) assert.equal(view.safeLink(value), null);
});

test('confirmation requires all proposal fields, current expiration and explicit prices', () => {
  assert.equal(view.proposalValid(proposal(), now), true);
  assert.equal(view.proposalValid({ ...proposal(), quantity: 1.5 }, now), true);
  for (const key of Object.keys(proposal())) {
    const incomplete = proposal();
    delete incomplete[key];
    assert.equal(view.proposalValid(incomplete, now), false, key);
  }
  for (const quantity of [0, -1, null, false, '', Infinity]) assert.equal(view.proposalValid({ ...proposal(), quantity }, now), false);
  for (const unitPrice of [null, false, {}, { value: 100 }, { amount: -1 }]) assert.equal(view.proposalValid({ ...proposal(), unitPrice }, now), false);
  assert.equal(view.proposalValid({ ...proposal(), unitPrice: 0, totalAmount: 0 }, now), true);
  assert.equal(view.proposalValid({ ...proposal(), expiresAt: '2026-09-23T09:00:00Z' }, now), false);
  assert.equal(view.proposalValid({ ...proposal(), expiresAt: 'invalid' }, now), false);
});
