const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const rootDir = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script data-source="([^"]+)">([\s\S]*?)<\/script>/g)].map(([,filename,source]) => ({filename,source}));
assert.deepEqual(scripts.map(item => item.filename), ['api.js', 'view-model.js', 'app.js'], 'delivered HTML must embed all scripts in order');
const emptyCart = () => ({ items: [], totalMinor: 0, cartUrl: 'https://demo.example/cart' });
const initialSession = () => ({ csrfToken: 'memory-only-csrf', cart: emptyCart() });
const product = () => ({
  id: 42, name: 'Автомат 160 А', article: '200300285_', productUrl: 'https://ekt.kz/product/42',
  price: { amount: 1250.5, currency: 'KZT' }, stock: { quantity: 18, city: 'Астана' },
  facts: { orderMultiple: 3, 'Номинальный ток': '160 А' }, source: 'Каталог ekt.kz'
});
const proposal = (id = 'proposal-42') => ({
  id, productId: 42, productName: 'Автомат 160 А', productArticle: '200300285_',
  quantity: 3, city: 'Астана', unitPrice: { amount: 1250.5, currency: 'KZT' },
  totalAmount: { amount: 3751.5, currency: 'KZT' }, expiresAt: new Date(Date.now() + 120000).toISOString()
});
const chatReply = (offered = proposal()) => ({
  reply: 'Проверьте выбранный товар и предложение.', products: [product()], alternatives: [],
  proposal: offered, warnings: []
});
const addedCart = () => ({
  items: [{ productId: '42', name: 'Автомат 160 А', quantity: 3, city: 'Астана', unitPriceMinor: 125050 }],
  totalMinor: 375150, cartUrl: 'https://demo.example/cart?revision=1'
});
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const settle = () => new Promise(resolve => setImmediate(resolve));

function makeUi(t, fixtures, protocol = 'https:') {
  const { window } = parseHTML(html);
  const { document } = window;
  const calls = [];
  const unexpected = [];
  const timers = new Set();
  const location = { href: protocol === 'file:' ? 'file:///isolated/index.html' : 'https://demo.example/index.html', protocol };
  window.location = location;
  window.fetch = async (url, options) => {
    calls.push({ url, options });
    const next = fixtures.shift();
    if (!next) {
      unexpected.push(url);
      throw new Error('Unexpected mocked request: ' + url);
    }
    if (next.path && next.path !== url) {
      unexpected.push(`${url}, expected ${next.path}`);
      throw new Error('Unexpected mocked request order');
    }
    return next.run ? next.run(url, options) : response(next.body, next.status);
  };
  // linkedom supplies real DOM/event dispatch, but does not implement modal layout or focus.
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.showModal = function () { this.open = true; this.setAttribute('open', ''); };
    dialog.close = function () { this.open = false; this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  });
  window.HTMLElement.prototype.focus = function () {};
  const context = vm.createContext({
    window, document, location, URL, AbortController, FormData, File, console,
    setTimeout: (callback, delay) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); }
  });
  t.after(() => {
    timers.forEach(clearTimeout);
    assert.deepEqual(unexpected, [], 'all requests must follow the declared API flow');
    assert.equal(fixtures.length, 0, 'all expected requests should be made');
  });
  for (const script of scripts) vm.runInContext(script.source, context, { filename: script.filename });
  const $ = id => document.getElementById(id);
  return {
    window, document, $, calls,
    count: route => calls.filter(call => call.url === route).length,
    async send(message) {
      $('messageInput').value = message;
      $('chatForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await settle();
    },
    async click(selector) {
      const button = document.querySelector(selector);
      assert.ok(button, 'missing element ' + selector);
      button.click();
      await settle();
      return button;
    }
  };
}

test('search, product and alternatives, exact proposal review, explicit confirmation, and cart flow', async t => {
  const offered = proposal();
  const searchReply = chatReply(offered);
  searchReply.alternatives = [{
    candidate: { ...product(), id: 43, name: 'Аналог 160 А', article: 'ALT-160' },
    details: 'Тот же номинальный ток, другой производитель.',
    comparison: [
      { field: 'Номинальный ток', requested: '160 А', offered: '160 А', verdict: 'match' },
      { field: 'Производитель', requested: 'Марка А', offered: 'Марка Б', verdict: 'different' },
      { field: 'Сертификат', requested: 'Требуется', offered: 'Не указан', verdict: 'unknown' }
    ]
  }];
  let finishConfirmation;
  const pendingConfirmation = new Promise(resolve => { finishConfirmation = resolve; });
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: searchReply },
    { path: '/api/cart/confirm', run: () => pendingConfirmation },
    { path: '/api/cart', body: addedCart() }
  ]);
  await settle();
  assert.match(ui.$('connectionLabel').textContent, /Подключено/);
  assert.equal(ui.count('/api/session'), 1);
  assert.equal(ui.$('confirmAdd').disabled, true);
  await ui.send('Нужен автомат 160 А в Астане');
  assert.equal(ui.document.querySelectorAll('.product-card').length, 2);
  assert.match(ui.document.querySelector('.alternative-block').textContent, /Тот же номинальный ток, другой производитель/);
  const comparison = ui.document.querySelector('.comparison');
  assert.match(comparison.textContent, /Номинальный ток/);
  assert.match(comparison.textContent, /Совпадает/);
  assert.match(comparison.textContent, /Отличается/);
  assert.match(comparison.textContent, /Неизвестно/);
  await ui.click('.product-actions .small-button');
  assert.equal(ui.document.querySelector('.specs').classList.contains('hidden'), false);
  assert.match(ui.document.querySelector('.specs').textContent, /160 А/);
  assert.equal(ui.count('/api/cart/confirm'), 0);
  assert.equal(ui.$('cartCount').textContent, '0');
  assert.deepEqual(JSON.parse(ui.calls[1].options.body), { message: 'Нужен автомат 160 А в Астане' });

  await ui.click('.proposal-open');
  assert.equal(ui.$('confirmDialog').open, true);
  const labels = Array.from(ui.$('proposalSummary').querySelectorAll('dt'), item => item.textContent);
  const values = Array.from(ui.$('proposalSummary').querySelectorAll('dd'), item => item.textContent);
  assert.deepEqual(labels, ['Предложение', 'ID товара', 'Товар', 'Артикул', 'Количество', 'Город', 'Цена за единицу', 'Итого', 'Действует до']);
  assert.deepEqual(values, [offered.id, '42', offered.productName, offered.productArticle, '3', 'Астана',
    ui.window.EktView.money(offered.unitPrice), ui.window.EktView.money(offered.totalAmount), offered.expiresAt]);
  assert.equal(ui.$('confirmAdd').disabled, false);
  assert.equal(ui.count('/api/cart/confirm'), 0);

  ui.$('confirmAdd').click();
  ui.$('confirmAdd').click();
  await settle();
  assert.equal(ui.count('/api/cart/confirm'), 1, 'double click must not duplicate confirmation');
  assert.equal(ui.$('confirmAdd').disabled, true);
  const confirm = ui.calls.find(call => call.url === '/api/cart/confirm');
  assert.deepEqual(JSON.parse(confirm.options.body), { proposalId: offered.id });
  assert.equal(confirm.options.headers['X-CSRF-Token'], 'memory-only-csrf');
  assert.equal(confirm.options.credentials, 'include');
  finishConfirmation(response({ cart: addedCart(), alreadyConfirmed: false }));
  await settle();
  assert.equal(ui.$('cartCount').textContent, '1');
  assert.equal(ui.$('confirmDialog').open, false);
  assert.equal(ui.document.querySelector('.proposal-open').disabled, true);
  assert.equal(ui.$('confirmAdd').disabled, true);
  assert.ok(Array.from(ui.document.querySelectorAll('.message-link')).some(link => link.href === addedCart().cartUrl));
  ui.$('confirmAdd').click();
  await settle();
  assert.equal(ui.count('/api/cart/confirm'), 1, 'completed proposals must not be confirmed twice');
  await ui.click('#cartTrigger');
  assert.match(ui.$('cartContents').textContent, /Автомат 160 А/);
  assert.match(ui.$('cartContents').textContent, /Цена за единицу: 1\s?250,5/);
  assert.equal(ui.$('checkoutLink').href, addedCart().cartUrl);
  assert.equal(ui.count('/api/session'), 1);
  for (const call of ui.calls) assert.equal(call.options.credentials, 'include');
});

test('HTTP 409 disables the stale proposal; only a newly reviewed proposal can be confirmed', async t => {
  const first = proposal('first');
  const second = proposal('second');
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: chatReply(first) },
    { path: '/api/cart/confirm', status: 409, body: { error: { code: 'STOCK_CHANGED', message: 'private warehouse detail' } } },
    { path: '/api/chat', body: chatReply(second) },
    { path: '/api/cart/confirm', body: { cart: addedCart(), alreadyConfirmed: false } }
  ]);
  await settle();
  await ui.send('Нужно 3 штуки');
  const oldButton = ui.document.querySelector('.proposal-open');
  await ui.click('.proposal-open');
  await ui.click('#confirmAdd');
  assert.match(ui.$('confirmError').textContent, /новое предложение/);
  assert.doesNotMatch(ui.$('confirmError').textContent, /private warehouse/);
  assert.equal(oldButton.disabled, true);
  assert.equal(ui.$('confirmAdd').disabled, true);
  ui.$('confirmAdd').click();
  await settle();
  assert.equal(ui.count('/api/cart/confirm'), 1);
  await ui.click('[data-close="confirmDialog"]');
  await ui.send('Подготовь новое предложение');
  assert.equal(oldButton.disabled, true);
  assert.equal(ui.$('confirmAdd').disabled, true, 'new proposal has not yet been displayed in the confirmation dialog');
  await ui.click('.proposal-open[data-proposal-id="second"]');
  assert.match(ui.$('proposalSummary').textContent, /second/);
  await ui.click('#confirmAdd');
  const ids = ui.calls.filter(call => call.url === '/api/cart/confirm').map(call => JSON.parse(call.options.body).proposalId);
  assert.deepEqual(ids, ['first', 'second']);
});

test('proxy timeout after confirmation disables repeat clicks and links to the current cart for review', async t => {
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: chatReply() },
    { path: '/api/cart/confirm', status: 504, body: { error: { code: 'PROXY_TIMEOUT', message: 'internal upstream details' } } },
    { path: '/api/cart', body: addedCart() }
  ]);
  await settle();
  await ui.send('Нужно 3 штуки');
  await ui.click('.proposal-open');
  await ui.click('#confirmAdd');
  assert.equal(ui.$('confirmAdd').disabled, true);
  assert.equal(ui.document.querySelector('.proposal-open').disabled, true);
  assert.match(ui.$('confirmError').textContent, /Проверьте корзину/);
  assert.equal(ui.$('confirmError').querySelector('a').href, emptyCart().cartUrl);
  assert.doesNotMatch(ui.$('confirmError').textContent, /internal upstream/);
  ui.$('confirmAdd').click();
  await settle();
  assert.equal(ui.count('/api/cart/confirm'), 1);
  await ui.click('[data-close="confirmDialog"]');
  await ui.click('#cartTrigger');
  assert.match(ui.$('cartContents').textContent, /Автомат 160 А/);
});

test('replacing a proposal while its dialog is open cannot confirm an undisplayed new proposal', async t => {
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: chatReply(proposal('displayed-old')) },
    { path: '/api/chat', body: chatReply(proposal('undisplayed-new')) }
  ]);
  await settle();
  await ui.send('Первое предложение');
  await ui.click('.proposal-open');
  assert.match(ui.$('proposalSummary').textContent, /displayed-old/);
  await ui.send('Измени предложение');
  assert.equal(ui.$('confirmAdd').disabled, true);
  ui.$('confirmAdd').click();
  await settle();
  assert.equal(ui.count('/api/cart/confirm'), 0);
});

test('file extraction preserves the draft and waits for customer review without sending chat or changing cart', async t => {
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/attachments', body: {
      items: [{ source_row: 2, article: '200300285_', name: 'Автомат', quantity: 3, unit: 'шт', uncertainty: 'none' },
        { source_row: 3, article: 'CABLE-2', name: 'Кабель', quantity: 6, unit: 'м', uncertainty: 'Проверьте сечение' }],
      uncertainties: ['Строка 3 распознана не полностью']
    } }
  ]);
  await settle();
  ui.$('messageInput').value = 'Доставить в Астану';
  const file = new File(['sample pdf payload'], 'specification.pdf', { type: 'application/pdf' });
  Object.defineProperty(ui.$('fileInput'), 'files', { configurable: true, value: [file] });
  ui.$('fileInput').dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  await settle();
  assert.match(ui.$('messageInput').value, /^Доставить в Астану\n/);
  assert.match(ui.$('messageInput').value, /200300285_ — Автомат; количество: 3 шт/);
  assert.match(ui.$('messageInput').value, /CABLE-2 — Кабель/);
  assert.match(ui.$('attachment').textContent, /Проверьте распознанные позиции/);
  assert.match(ui.$('attachment').textContent, /Проверьте сечение/);
  assert.equal(ui.$('attachment').classList.contains('hidden'), false);
  assert.equal(ui.count('/api/chat'), 0);
  assert.equal(ui.count('/api/cart/confirm'), 0);
  const upload = ui.calls.find(call => call.url === '/api/attachments');
  assert.ok(upload.options.body instanceof FormData);
  assert.deepEqual([...upload.options.body.keys()], ['file']);
  assert.equal(upload.options.body.get('file').name, 'specification.pdf');
  assert.equal(upload.options.headers['Content-Type'], undefined);
});

test('quantity controls honor orderMultiple and invalid quantity cannot request a proposal', async t => {
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: chatReply(null) },
    { path: '/api/chat', body: chatReply(proposal()) }
  ]);
  await settle();
  await ui.send('Покажи автомат');
  await ui.click('.product-actions .add');
  assert.equal(ui.$('selectionDialog').open, true);
  assert.equal(String(ui.$('quantityInput').value), '3');
  assert.equal(String(ui.$('quantityInput').step), '3');
  assert.equal(ui.$('cityInput').value, 'Астана');
  ui.$('quantityInput').value = '4';
  await ui.click('#requestProposal');
  assert.equal(ui.count('/api/chat'), 1, 'invalid order multiple must not reach chat API');
  assert.equal(ui.$('selectionDialog').open, true);
  assert.match(ui.$('selectionError').textContent, /кратное 3/);
  ui.$('quantityInput').value = '3';
  await ui.click('#increaseQty');
  assert.equal(String(ui.$('quantityInput').value), '6');
  await ui.click('#decreaseQty');
  assert.equal(String(ui.$('quantityInput').value), '3');
  await ui.click('#requestProposal');
  assert.equal(ui.count('/api/chat'), 2);
  assert.equal(ui.count('/api/cart/confirm'), 0);
  assert.match(JSON.parse(ui.calls[2].options.body).message, /количество: 3; город: Астана/);
});

test('fractional catalog order multiples are blocked by the integer-only cart API', async t => {
  const fractional = { ...product(), facts: { orderMultiple: 0.5 } };
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: { ...chatReply(null), products: [fractional] } }
  ]);
  await settle();
  await ui.send('Покажи кабель');
  await ui.click('.product-actions .add');
  assert.equal(ui.$('requestProposal').disabled, true);
  assert.match(ui.$('multipleHint').textContent, /Дробная кратность/);
  assert.equal(ui.count('/api/chat'), 1);
});

test('pending attachment upload blocks proposal opening and confirmation until extraction completes', async t => {
  let finishUpload;
  const pendingUpload = new Promise(resolve => { finishUpload = resolve; });
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: chatReply(proposal()) },
    { path: '/api/attachments', run: () => pendingUpload }
  ]);
  await settle();
  await ui.send('Подготовь предложение');
  const openButton = ui.document.querySelector('.proposal-open');
  assert.equal(openButton.disabled, false);
  const file = new File(['pending document'], 'specification.pdf', { type: 'application/pdf' });
  Object.defineProperty(ui.$('fileInput'), 'files', { configurable: true, value: [file] });
  ui.$('fileInput').dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  await settle();
  assert.equal(ui.count('/api/attachments'), 1);
  assert.equal(openButton.disabled, true);
  assert.equal(ui.$('confirmAdd').disabled, true);
  openButton.click();
  ui.$('confirmAdd').click();
  await settle();
  assert.ok(!ui.$('confirmDialog').open, 'busy UI must not open the confirmation dialog');
  assert.equal(ui.count('/api/cart/confirm'), 0);
  finishUpload(response({
    items: [{ source_row: 2, article: '200300285_', name: 'Автомат', quantity: 3, unit: 'шт', uncertainty: 'none' }],
    uncertainties: []
  }));
  await settle();
  assert.equal(openButton.disabled, false);
  assert.match(ui.$('messageInput').value, /200300285_ — Автомат/);
  assert.equal(ui.count('/api/chat'), 1, 'extraction must remain an unsent draft');
  assert.equal(ui.count('/api/cart/confirm'), 0);
  await ui.click('.proposal-open');
  assert.equal(ui.$('confirmDialog').open, true);
  assert.equal(ui.$('confirmAdd').disabled, false);
  assert.equal(ui.count('/api/cart/confirm'), 0);
});


test('isolated local HTML keeps the styled welcome screen and never attempts backend requests', async t => {
  const ui = makeUi(t, [], 'file:');
  await settle();
  assert.equal(ui.$('welcome').classList.contains('hidden'), false);
  assert.equal(ui.$('connectionLabel').textContent, 'Предпросмотр');
  assert.equal(ui.$('sendButton').disabled, true);
  assert.equal(ui.$('fileInput').disabled, true);
  assert.equal(ui.$('cartTrigger').disabled, true);
  assert.equal(ui.document.querySelectorAll('.error-bubble').length, 0);
  assert.match(ui.document.querySelector('style[data-source="styles.css"]').textContent, /\.icon\{width:20px;height:20px/);
  assert.equal(ui.document.querySelector('.header-right .icon').getAttribute('width'), '20');
  assert.equal(ui.document.querySelector('link[rel="stylesheet"]'), null);
  assert.equal(ui.document.querySelector('script[src]'), null);
  assert.equal(ui.calls.length, 0);
});
