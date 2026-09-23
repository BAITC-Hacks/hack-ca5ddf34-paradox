const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const rootDir = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script data-source="([^"]+)">([\s\S]*?)<\/script>/g)].map(([,filename,source]) => ({filename,source}));
assert.deepEqual(scripts.map(item => item.filename), ['api.js', 'view-model.js', 'saved-store.js', 'app.js'], 'delivered HTML must embed all scripts in order');
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
  items: [{ productId: 42, productName: 'Автомат 160 А', quantity: 3, city: 'Астана', totalMinor: 375150 }],
  totalMinor: 375150, cartUrl: 'https://demo.example/cart?revision=1'
});
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const settle = () => new Promise(resolve => setImmediate(resolve));

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
function makeUi(t, fixtures, protocol = 'https:', sourceHtml = html, storage = memoryStorage()) {
  const { window } = parseHTML(sourceHtml);
  const loadedScripts = [...sourceHtml.matchAll(/<script data-source="([^"]+)">([\s\S]*?)<\/script>/g)].map(([,filename,source]) => ({filename,source}));
  const { document } = window;
  const calls = [];
  const unexpected = [];
  const timers = new Set();
  const location = { href: protocol === 'file:' ? 'file:///isolated/index.html' : 'https://demo.example/index.html', protocol };
  window.location = location;
  window.localStorage = storage;
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
  for (const script of loadedScripts) vm.runInContext(script.source, context, { filename: script.filename });
  const $ = id => document.getElementById(id);
  return {
    window, document, $, calls,
    count: route => calls.filter(call => call.url === route).length,
    async chooseCity(city) {
      $('cityTrigger').click();
      const option = Array.from($('cityOptions').querySelectorAll('[role="option"]')).find(option => option.dataset.value === city);
      assert.ok(option, 'city from catalog must be selectable');
      option.click();
      await settle();
    },
    async cityKey(key) {
      const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'key', { value: key });
      $('cityTrigger').dispatchEvent(event);
      await settle();
    },
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

test('compact sidebar opens, dismisses and returns to the desktop layout without losing its controls', async t => {
  const ui = makeUi(t, [{ path: '/api/session', body: initialSession() }]);
  await settle();
  const panel = ui.$('sidebar'), home = panel.parentElement, trigger = ui.$('sidebarToggle');
  ui.window.innerWidth = 760;
  let focused = null;
  Object.defineProperty(ui.document, 'activeElement', { configurable: true, get: () => focused });
  trigger.focus = () => { focused = trigger; };
  ui.$('newChat').focus = () => { focused = ui.$('newChat'); };
  ui.$('sidebarClose').focus = () => { focused = ui.$('sidebarClose'); };
  await ui.click('#sidebarToggle');
  assert.equal(ui.$('sidebarDialog').open, true);
  assert.equal(panel.parentElement, ui.$('sidebarDialog'));
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(focused, ui.$('sidebarClose'));
  const cancel = new ui.window.Event('cancel', { cancelable: true });
  ui.$('sidebarDialog').dispatchEvent(cancel); await settle();
  assert.equal(ui.$('sidebarDialog').open, false);
  assert.equal(panel.parentElement, home);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(focused, trigger);
  await ui.click('#sidebarToggle');
  ui.$('sidebarDialog').getBoundingClientRect = () => ({ left: 0, right: 304, top: 0, bottom: 700 });
  const outside = new ui.window.Event('click', { bubbles: true });
  Object.defineProperties(outside, { clientX: { value: 500 }, clientY: { value: 100 } });
  ui.$('sidebarDialog').dispatchEvent(outside); await settle();
  assert.equal(ui.$('sidebarDialog').open, false, 'the native backdrop dismisses the drawer');
  await ui.click('#sidebarToggle');
  ui.window.innerWidth = 1200; ui.window.dispatchEvent(new ui.window.Event('resize')); await settle();
  assert.equal(panel.parentElement, home);
  assert.equal(ui.$('sidebarDialog').open, false);
  assert.equal(ui.document.querySelectorAll('#sidebar').length, 1);
  assert.equal(focused, ui.$('newChat'));
  await ui.click('#sidebarToggle');
  assert.equal(ui.$('sidebarDialog').open, false, 'desktop navigation does not open the compact drawer');
  ui.window.innerWidth = 390; ui.window.dispatchEvent(new ui.window.Event('resize'));
  assert.equal(focused, trigger, 'shrinking a focused desktop menu must leave a visible focus target');
  await ui.click('#sidebarToggle'); await ui.click('#sidebarClose');
  assert.equal(panel.parentElement, home);
  assert.equal(ui.calls.length, 1, 'opening and resizing navigation must not send any business requests');
});

test('sidebar shortcuts and saved panels remain usable from the compact menu', async t => {
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: chatReply(null) }
  ]);
  await settle(); await ui.send('Автомат 160 А');
  await ui.click('.product-card .bookmark-button');
  const panel = ui.$('sidebar'), historyEntry = ui.$('historyList').firstElementChild;
  ui.window.innerWidth = 600;
  await ui.click('#sidebarToggle'); await ui.click('#catalogTrigger');
  assert.equal(ui.$('sidebarDialog').open, false);
  assert.equal(ui.$('messageInput').value, 'Помогите подобрать: ');
  assert.equal(ui.count('/api/chat'), 1);
  await ui.click('#sidebarToggle'); await ui.click('#favoritesTrigger');
  assert.equal(ui.$('sidebarDialog').open, false);
  assert.equal(ui.$('favoritesDialog').open, true);
  assert.equal(ui.$('favoritesCount').textContent, '1');
  assert.match(ui.$('favoritesContents').textContent, /Автомат 160 А/);
  await ui.click('[data-close="favoritesDialog"]');
  await ui.click('#sidebarToggle'); await ui.click('#historyList .history-open');
  assert.equal(ui.$('sidebarDialog').open, false);
  assert.equal(ui.$('historyDialog').open, true);
  assert.equal(ui.$('historyList').firstElementChild, historyEntry, 'menu movement must keep the actual history DOM');
  assert.equal(ui.$('sidebar'), panel);
  assert.equal(ui.count('/api/cart/confirm'), 0);
});

test('history restores questions and results after reload without restoring purchase actions or sending requests', async t => {
  const storage = memoryStorage();
  const reply = { ...chatReply(), alternatives: [{ candidate: { ...product(), id: 43, name: 'Сохранённый аналог' }, details: 'Другой производитель', comparison: [] }] };
  const first = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: reply }
  ], 'https:', html, storage);
  await settle(); await first.send('Найти товар: Кабель для склада');
  assert.equal(first.$('historyList').querySelector('.history-entry-title').textContent, 'Кабель для склада');
  const serialized = storage.getItem('ekt:saved:v1:live');
  assert.doesNotMatch(serialized, /memory-only-csrf|csrfToken|cartUrl/);
  const restored = makeUi(t, [{ path: '/api/session', body: initialSession() }], 'https:', html, storage);
  await settle();
  await restored.click('#mobileHistoryTrigger');
  assert.equal(restored.$('historyListDialog').open, true);
  await restored.click('#allHistoryList .history-open');
  assert.equal(restored.$('historyListDialog').open, false);
  assert.equal(restored.$('historyDialog').open, true);
  assert.match(restored.$('historyContents').textContent, /Кабель для склада/);
  assert.match(restored.$('historyContents').textContent, /Сохранённый аналог/);
  assert.equal(restored.$('historyContents').querySelectorAll('.saved-product').length, 2);
  assert.equal(restored.$('historyContents').querySelectorAll('.proposal-open, .small-button.add').length, 0);
  assert.ok(restored.$('historyContents').querySelector('.archive-proposal'));
  assert.equal(restored.$('confirmAdd').disabled, true);
  restored.$('confirmAdd').click(); await settle();
  assert.equal(restored.count('/api/cart/confirm'), 0);
  restored.$('messageInput').value = 'Мой черновик';
  await restored.click('#reuseHistory');
  assert.equal(restored.$('messageInput').value, 'Мой черновик\n\nНайти товар: Кабель для склада');
  assert.equal(restored.count('/api/chat'), 0);
  await restored.click('#historyList .history-open');
  await restored.click('#deleteHistory');
  assert.equal(restored.$('historyDialog').open, false);
  assert.equal(restored.$('historyList').children.length, 0);
  assert.equal(JSON.parse(storage.getItem('ekt:saved:v1:live')).history.length, 0);
  assert.equal(restored.$('cartCount').textContent, '0');
});

test('favorites synchronize bookmark buttons, survive reload and prepare a reviewed lookup without changing cart', async t => {
  const storage = memoryStorage();
  const first = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: { ...chatReply(null), alternatives: [{ candidate: product(), details: 'Та же позиция', comparison: [] }] } }
  ], 'https:', html, storage);
  await settle(); await first.send('Нужен автомат');
  const buttons = Array.from(first.document.querySelectorAll('.product-card .bookmark-button'));
  assert.equal(buttons.length, 2);
  buttons[0].click(); await settle();
  assert.equal(first.$('favoritesCount').textContent, '1');
  assert.equal(first.$('mobileFavoritesCount').textContent, '1');
  assert.ok(buttons.every(button => button.getAttribute('aria-pressed') === 'true'));
  assert.equal(first.count('/api/chat'), 1);
  assert.equal(first.count('/api/cart/confirm'), 0);
  const restored = makeUi(t, [{ path: '/api/session', body: initialSession() }], 'https:', html, storage);
  await settle(); await restored.click('#mobileFavoritesTrigger');
  assert.equal(restored.$('favoritesDialog').open, true);
  assert.match(restored.$('favoritesContents').textContent, /Автомат 160 А/);
  assert.match(restored.$('favoritesContents').textContent, /могли измениться/);
  assert.equal(restored.$('favoritesContents').querySelector('.small-button.add'), null);
  await restored.click('#favoritesContents [data-saved-draft]');
  assert.equal(restored.$('favoritesDialog').open, false);
  assert.match(restored.$('messageInput').value, /Проверь актуальную цену и наличие.*200300285_/);
  assert.equal(restored.count('/api/chat'), 0);
  await restored.click('#favoritesTrigger');
  await restored.click('#favoritesContents .bookmark-button');
  assert.equal(restored.$('favoritesCount').textContent, '0');
  assert.match(restored.$('favoritesContents').textContent, /Здесь будут товары/);
  assert.equal(JSON.parse(storage.getItem('ekt:saved:v1:live')).favorites.length, 0);
  assert.equal(JSON.parse(storage.getItem('ekt:saved:v1:live')).history.length, 1, 'removing a bookmark must not delete history');
  assert.equal(restored.$('cartCount').textContent, '0');
});

test('reading an old result never replaces current product rules or makes an old proposal actionable', async t => {
  const fresh = { ...product(), facts: { orderMultiple: 2 } };
  const offered = { ...proposal('fresh-proposal'), quantity: 2, totalAmount: { amount: 2501, currency: 'KZT' } };
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: chatReply(proposal('old-proposal')) },
    { path: '/api/chat', body: { ...chatReply(offered), products: [fresh] } }
  ]);
  await settle(); await ui.send('Первый подбор'); await ui.send('Уточнённый подбор');
  const oldEntry = Array.from(ui.$('historyList').querySelectorAll('.history-open')).find(button => button.textContent.includes('Первый подбор'));
  oldEntry.click(); await settle();
  assert.match(ui.$('historyContents').textContent, /old-proposal/);
  assert.equal(ui.$('historyContents').querySelectorAll('.proposal-open').length, 0);
  await ui.click('[data-close="historyDialog"]');
  assert.equal(ui.document.querySelector('[data-proposal-id="old-proposal"]').disabled, true);
  await ui.click('[data-proposal-id="fresh-proposal"]');
  assert.equal(ui.$('confirmAdd').disabled, false, 'archive rendering must not overwrite the current order multiple');
  assert.match(ui.$('proposalSummary').textContent, /fresh-proposal/);
  assert.equal(ui.count('/api/chat'), 2);
  assert.equal(ui.count('/api/cart/confirm'), 0);
});

test('saved panels render stored text literally and remain usable when persistent storage is blocked', async t => {
  const storage = { getItem: () => { throw new Error('Blocked'); }, setItem: () => { throw new Error('Blocked'); } };
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: { ...chatReply(null), reply: '<img src=x onerror="alert(1)">', products: [{ ...product(), name: '<img src=x onerror="alert(2)">' }] } }
  ], 'https:', html, storage);
  await settle(); await ui.send('Характеристика I < 10 A');
  await ui.click('.product-card .bookmark-button');
  await ui.click('#historyList .history-open');
  assert.match(ui.$('historyContents').textContent, /I < 10 A/);
  assert.equal(ui.$('historyContents').querySelector('img, script, [onerror]'), null);
  assert.match(ui.$('savedStorageHint').textContent, /только в этой вкладке/);
  assert.equal(ui.$('favoritesCount').textContent, '1');
  assert.equal(ui.count('/api/cart/confirm'), 0);
});

test('query variants offer editable choices and known product names without automatic catalog requests', async t => {
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: chatReply(null) }
  ]);
  await settle(); await ui.click('.suggestion');
  assert.equal(ui.$('draftVariants').classList.contains('hidden'), false);
  assert.match(ui.$('draftVariantOptions').textContent, /Кабели и провода/);
  const cable = Array.from(ui.$('draftVariantOptions').children).find(button => button.textContent === 'Кабели и провода');
  cable.click(); await settle();
  assert.match(ui.$('messageInput').value, /^Найти товар: кабель, сечение и длина:/);
  assert.equal(ui.count('/api/chat'), 0);
  assert.equal(ui.document.querySelectorAll('.product-card').length, 0);
  await ui.send('Автомат 160 А');
  await ui.click('.sidebar-prompt[data-draft="Подобрать аналог для: "]');
  assert.match(ui.$('draftVariantsTitle').textContent, /замена/);
  const related = Array.from(ui.$('draftVariantOptions').children).find(button => button.textContent === 'Замена: Автомат 160 А');
  assert.ok(related, 'variants can refer to a real product from the most recent response');
  ui.$('messageInput').value += 'мой текст';
  related.click(); await settle();
  assert.match(ui.$('messageInput').value, /мой текст\nАвтомат 160 А; артикул 200300285_/);
  assert.equal(ui.count('/api/chat'), 1);
  assert.equal(ui.count('/api/cart/confirm'), 0);
});

test('reusing a saved request restores its city without conflicting location instructions', async t => {
  const item = { ...product(), stock: { total: 30, byCity: { Астана: 15, Алматы: 15 } } };
  const reply = { ...chatReply(null), products: [item] };
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: reply },
    { path: '/api/chat', body: reply },
    { path: '/api/chat', body: reply }
  ]);
  await settle(); await ui.send('Найди товар');
  await ui.chooseCity('Астана'); await ui.send('Нужно 3 штуки');
  await ui.chooseCity('Алматы');
  await ui.click('#historyList .history-open'); await ui.click('#reuseHistory');
  assert.equal(ui.$('cityValue').textContent, 'Астана');
  assert.match(ui.$('messageInput').value, /Город для проверки наличия: Астана/);
  assert.equal(ui.count('/api/chat'), 2);
  await ui.send(ui.$('messageInput').value);
  const message = JSON.parse(ui.calls.at(-1).options.body).message;
  assert.equal((message.match(/Город для проверки наличия:/g) || []).length, 1);
  assert.doesNotMatch(message, /Алматы/);
});

test('unrelated updates leave open saved characteristics and their DOM intact', async t => {
  const storage = memoryStorage();
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: chatReply(null) }
  ], 'https:', html, storage);
  await settle(); await ui.send('Нужен автомат');
  await ui.click('.product-card .bookmark-button');
  await ui.click('#favoritesTrigger');
  const details = ui.$('favoritesContents').querySelector('details'); details.setAttribute('open', '');
  const record = JSON.parse(storage.getItem('ekt:saved:v1:live'));
  record.history[0].title = 'Изменено в другом окне';
  storage.setItem('ekt:saved:v1:live', JSON.stringify(record));
  const event = new ui.window.Event('storage'); Object.defineProperty(event, 'key', { value: 'ekt:saved:v1:live' });
  ui.window.dispatchEvent(event); await settle();
  assert.equal(ui.$('favoritesContents').querySelector('details'), details);
  assert.equal(details.hasAttribute('open'), true);
  assert.equal(ui.count('/api/chat'), 1);
});

test('quick actions prepare editable drafts, preserve user text and only submit after an explicit send', async t => {
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: { reply: 'Уточните характеристики.', products: [], alternatives: [], proposal: null, warnings: [] } }
  ]);
  await settle();
  const input = ui.$('messageInput');
  let focusCount = 0, selection;
  input.focus = () => { focusCount++; };
  input.setSelectionRange = (start, end) => { selection = [start, end]; };
  const shortcuts = [
    ...Array.from(ui.document.querySelectorAll('.sidebar-prompt')),
    ...Array.from(ui.document.querySelectorAll('.suggestion')),
    ui.$('catalogTrigger')
  ];
  const expected = ['Найти товар: ', 'Подобрать аналог для: ', 'Условия покупки: ',
    'Найти товар: ', 'Подобрать аналог для: ', 'Условия покупки: ', 'Помогите подобрать: '];
  assert.equal(shortcuts.length, expected.length);
  for (let index = 0; index < shortcuts.length; index++) {
    input.value = '';
    shortcuts[index].click();
    await settle();
    assert.equal(input.value, expected[index]);
    assert.deepEqual(selection, [input.value.length, input.value.length]);
  }
  assert.equal(focusCount, shortcuts.length);
  assert.equal(ui.count('/api/chat'), 0);
  assert.equal(ui.document.querySelectorAll('.message-row, .product-card').length, 0);
  assert.equal(ui.$('welcome').classList.contains('hidden'), false);
  const details = 'Реле давления РД-5\nКоличество: 2 шт, Алматы';
  input.value = details;
  shortcuts[0].click();
  assert.equal(input.value, 'Найти товар: ' + details);
  shortcuts[0].click();
  assert.equal(input.value, 'Найти товар: ' + details, 'repeated click must not duplicate the prefix');
  shortcuts[1].click();
  assert.equal(input.value, 'Подобрать аналог для: ' + details, 'switching intent preserves all user text');
  assert.equal(ui.count('/api/chat'), 0);
  input.value += '\nНужно сравнение размеров';
  const reviewedDraft = input.value;
  ui.$('chatForm').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(ui.count('/api/chat'), 1);
  assert.deepEqual(JSON.parse(ui.calls.at(-1).options.body), { message: reviewedDraft });
  assert.equal(input.value, '');
  assert.equal(ui.$('cartCount').textContent, '0');
  assert.equal(ui.count('/api/cart/confirm'), 0);
});

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
  assert.equal(ui.$('cartTrigger').classList.contains('cart-updated'), false);
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
  assert.equal(ui.$('cityTrigger').disabled, true);
  const confirm = ui.calls.find(call => call.url === '/api/cart/confirm');
  assert.deepEqual(JSON.parse(confirm.options.body), { proposalId: offered.id });
  assert.equal(confirm.options.headers['X-CSRF-Token'], 'memory-only-csrf');
  assert.equal(confirm.options.credentials, 'include');
  finishConfirmation(response({ cart: addedCart(), alreadyConfirmed: false }));
  await settle();
  assert.equal(ui.$('cartCount').textContent, '1');
  assert.equal(ui.$('cartTrigger').classList.contains('cart-updated'), true);
  assert.equal(ui.$('cityTrigger').disabled, false);
  assert.equal(ui.$('confirmDialog').open, false);
  assert.equal(ui.document.querySelector('.proposal-open').disabled, true);
  assert.equal(ui.$('confirmAdd').disabled, true);
  assert.ok(Array.from(ui.document.querySelectorAll('.message-link')).some(link => link.href === addedCart().cartUrl));
  ui.$('confirmAdd').click();
  await settle();
  assert.equal(ui.count('/api/cart/confirm'), 1, 'completed proposals must not be confirmed twice');
  await ui.click('#cartTrigger');
  assert.match(ui.$('cartContents').textContent, /Автомат 160 А/);
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
  assert.match(ui.$('selectionError').textContent, /кратным 3/);
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
  assert.equal(ui.$('cityTrigger').disabled, true);
  assert.equal(ui.$('sendButton').classList.contains('is-busy'), true);
  assert.equal(openButton.disabled, true);
  assert.ok(Array.from(ui.document.querySelectorAll('[data-draft]')).every(button => button.disabled));
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
  assert.equal(ui.$('cityTrigger').disabled, false);
  assert.equal(ui.$('sendButton').classList.contains('is-busy'), false);
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
  assert.match(ui.document.querySelector('style[data-source="styles.css"]').textContent, /\.icon\s*\{\s*width:\s*20px;\s*height:\s*20px/);
  assert.equal(ui.document.querySelector('.header-right .icon').getAttribute('width'), '20');
  assert.equal(ui.document.querySelector('link[rel="stylesheet"]'), null);
  assert.equal(ui.document.querySelector('script[src]'), null);
  assert.equal(ui.calls.length, 0);
});

test('city selection preserves warehouse rows, shows local zero and invalidates an earlier proposal', async t => {
  const item = { ...product(), unit: 'шт', stock: {
    total: 200, byCity: { Астана: 0, Алматы: 200 },
    stores: [{ city: 'Астана', name: 'Склад 1', quantity: 0 }, { city: 'Алматы', name: 'Склад 2', quantity: 200 }]
  } };
  const offered = { ...proposal(), city: 'Алматы' };
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: { ...chatReply(offered), products: [item] } },
    { path: '/api/chat', body: { ...chatReply(null), products: [item] } }
  ]);
  await settle();
  await ui.send('Найди автомат');
  assert.match(ui.document.querySelector('.stock').textContent, /Всего по складам · 200/);
  assert.equal(ui.document.querySelectorAll('.stock-row').length, 2);
  assert.match(ui.document.querySelector('.stock-list').textContent, /Астана/);
  assert.match(ui.document.querySelector('.stock-list').textContent, /Алматы/);
  await ui.click('.proposal-open');
  assert.equal(ui.$('confirmAdd').disabled, false);
  await ui.chooseCity('Астана');
  assert.equal(ui.$('confirmAdd').disabled, true);
  assert.match(ui.$('confirmError').textContent, /Город изменён/);
  assert.match(ui.document.querySelector('.stock').textContent, /Нет в наличии · Астана/);
  assert.doesNotMatch(ui.document.querySelector('.stock').textContent, /200/);
  await ui.click('[data-close="confirmDialog"]');
  await ui.click('.small-button.add');
  assert.equal(ui.count('/api/cart/confirm'), 0);
  assert.match(JSON.parse(ui.calls.at(-1).options.body).message, /Подбери доступную замену/);
  assert.match(JSON.parse(ui.calls.at(-1).options.body).message, /Город для проверки наличия: Астана/);
});

test('custom city menu separates keyboard navigation from selection and explains invalidated proposals', async t => {
  const item = { ...product(), stock: { total: 200, byCity: { Астана: 0, Алматы: 200 } } };
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: { ...chatReply(proposal()), products: [item] } }
  ]);
  await settle();
  await ui.click('#cityTrigger');
  assert.equal(ui.$('cityMenu').hidden, false);
  assert.equal(ui.$('cityOptions').children.length, 1, 'no city should be invented before catalog data arrives');
  assert.match(ui.$('cityMenuHint').textContent, /после поиска/);
  await ui.cityKey('Escape');
  assert.equal(ui.$('cityMenu').hidden, true);
  assert.equal(ui.$('cityTrigger').hasAttribute('aria-activedescendant'), false);
  await ui.send('Найди автомат');
  await ui.cityKey('ArrowDown');
  assert.equal(ui.$('cityTrigger').getAttribute('aria-expanded'), 'true');
  await ui.cityKey('End');
  const active = ui.$(ui.$('cityTrigger').getAttribute('aria-activedescendant'));
  assert.equal(active.dataset.value, 'Алматы');
  assert.equal(ui.$('cityValue').textContent, 'Все города', 'arrow navigation alone must not commit a city');
  assert.equal(ui.document.querySelector('.proposal-open').disabled, false);
  await ui.cityKey('Escape');
  assert.equal(ui.$('cityValue').textContent, 'Все города');
  await ui.cityKey('А');
  await ui.cityKey('л');
  await ui.cityKey('Enter');
  assert.equal(ui.$('cityValue').textContent, 'Алматы');
  assert.equal(ui.$('activeCity').value, 'Алматы');
  assert.equal(ui.$('cityMenu').hidden, true);
  assert.equal(ui.$('cityOptions').querySelector('[aria-selected="true"]').dataset.value, 'Алматы');
  assert.match(ui.document.querySelector('.stock').textContent, /Алматы/);
  assert.equal(ui.document.querySelector('.proposal-open').disabled, true);
  assert.match(ui.document.querySelector('.proposal-notice').textContent, /Город изменён/);
  assert.equal(ui.count('/api/cart/confirm'), 0);
  await ui.cityKey(' ');
  await ui.cityKey('Home');
  await ui.cityKey('Enter');
  assert.equal(ui.$('cityValue').textContent, 'Все города');
  assert.match(ui.document.querySelector('.stock').textContent, /Всего по складам/);
  await ui.click('#cityTrigger');
  await ui.click('.chat-heading');
  assert.equal(ui.$('cityMenu').hidden, true, 'outside click closes the menu');
  await ui.click('#cityTrigger');
  await ui.cityKey('Tab');
  assert.equal(ui.$('cityMenu').hidden, true, 'Tab dismisses without changing the selection');
  assert.equal(ui.count('/api/chat'), 1, 'city selection only filters the displayed stock');
});

test('pending requests close and lock the city picker until the response is displayed', async t => {
  let finishSearch;
  const pending = new Promise(resolve => { finishSearch = resolve; });
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', run: () => pending }
  ]);
  await settle();
  await ui.click('#cityTrigger');
  await ui.send('Найди автомат');
  assert.equal(ui.$('cityMenu').hidden, true);
  assert.equal(ui.$('cityTrigger').disabled, true);
  assert.equal(ui.$('sendButton').classList.contains('is-busy'), true);
  await ui.cityKey('ArrowDown');
  assert.equal(ui.$('cityMenu').hidden, true);
  finishSearch(response(chatReply(null)));
  await settle();
  assert.equal(ui.$('cityTrigger').disabled, false);
  assert.equal(ui.$('sendButton').classList.contains('is-busy'), false);
  await ui.chooseCity('Астана');
  assert.equal(ui.$('cityValue').textContent, 'Астана');
  assert.equal(ui.count('/api/cart/confirm'), 0);
});

test('product certificates are usable links, unsafe URLs are ignored, and missing photos use a neutral placeholder', async t => {
  const withDocument = { ...product(), certificates: [
    { name: 'Сертификат соответствия', url: 'https://demo.example/certificates/42.pdf' },
    { name: 'Invalid', url: 'javascript:alert(1)' }
  ] };
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: { ...chatReply(null), products: [withDocument, { ...product(), id: 43 }] } }
  ]);
  await settle(); await ui.send('Покажи сертификат');
  const links = ui.document.querySelectorAll('.certificate-link');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://demo.example/certificates/42.pdf');
  assert.equal(links[0].target, '_blank');
  assert.match(links[0].rel, /noopener/);
  assert.match(ui.document.querySelector('.certificate-empty').textContent, /Сертификат не указан/);
  assert.equal(ui.document.querySelectorAll('.product-placeholder').length, 2);
  assert.equal(ui.document.querySelectorAll('.product-image').length, 0);
});

test('known selected-city stock limits proposal requests without borrowing stock from another city', async t => {
  const ui = makeUi(t, [
    { path: '/api/session', body: initialSession() },
    { path: '/api/chat', body: { ...chatReply(null), products: [{ ...product(), stock: { total: 206, byCity: { Астана: 6, Алматы: 200 } } }] } }
  ]);
  await settle(); await ui.send('Нужен автомат');
  await ui.chooseCity('Астана');
  await ui.click('.small-button.add');
  assert.equal(ui.$('cityInput').value, 'Астана');
  ui.$('quantityInput').value = '9';
  await ui.click('#requestProposal');
  assert.equal(ui.count('/api/chat'), 1);
  assert.match(ui.$('selectionError').textContent, /доступно 6/);
  assert.equal(ui.count('/api/cart/confirm'), 0);
});

test('downloaded offline demo supports search, comparison, explicit confirmation and the same-tab cart with zero network calls', async t => {
  const demoHtml = fs.readFileSync(path.join(rootDir, 'demo.html'), 'utf8');
  const ui = makeUi(t, [], 'file:', demoHtml);
  ui.window.matchMedia = () => ({ matches: true });
  await settle();
  assert.equal(ui.$('messageInput').hasAttribute('readonly'), false);
  assert.match(ui.$('connectionLabel').textContent, /Демо-каталог/);
  assert.ok(ui.document.querySelector('.demo-banner'));
  await ui.click('.sidebar-prompt');
  assert.equal(ui.$('messageInput').value, 'Найти товар: ');
  assert.equal(ui.document.querySelectorAll('.product-card').length, 0);
  assert.equal(ui.$('welcome').classList.contains('hidden'), false);
  await ui.send(ui.$('messageInput').value + 'Автомат 160 А в Астане');
  assert.equal(ui.document.querySelectorAll('.product-card').length, 2);
  assert.ok(ui.document.querySelector('.comparison'));
  await ui.chooseCity('Астана');
  assert.match(ui.document.querySelector('.products-grid .stock').textContent, /Нет в наличии/);
  await ui.click('.alternative-block .small-button.add');
  assert.equal(ui.$('cityInput').value, 'Астана');
  await ui.click('#requestProposal');
  assert.equal(ui.$('cartCount').textContent, '0');
  await ui.click('.proposal-open');
  assert.match(ui.$('proposalSummary').textContent, /Астана/);
  await ui.click('#confirmAdd');
  assert.equal(ui.$('cartCount').textContent, '1');
  assert.equal(ui.$('cartTrigger').classList.contains('cart-updated'), false, 'reduced-motion preference skips the cart animation');
  await ui.click('.message-link[href="#cart"]');
  assert.equal(ui.$('cartDialog').open, true);
  assert.match(ui.$('cartContents').textContent, /B160/);
  assert.match(ui.$('cartDisclaimer').textContent, /Реальный заказ не создаётся/);
  assert.deepEqual(ui.calls, []);
});
