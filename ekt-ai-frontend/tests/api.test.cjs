const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
const cart = () => ({ items: [], totalMinor: 0, cartUrl: 'https://demo.example/cart' });
const session = () => ({ csrfToken: 'csrf-in-memory', cart: cart() });
const reply = () => ({ reply: 'Найден товар', products: [], alternatives: [], proposal: null, warnings: [] });

function harness(responses, options = {}) {
  const calls = [];
  class MockFormData {
    constructor() { this.entries = []; }
    append(key, value) { this.entries.push([key, value]); }
  }
  const window = {
    location: { protocol: options.protocol || 'https:', href: 'https://demo.example/' },
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (typeof next === 'function') return next(url, init);
      if (!next) throw new Error('Unexpected fetch');
      return { ok: next.status === undefined || next.status < 400, status: next.status || 200,
        json: async () => next.body };
    }
  };
  vm.runInNewContext(source, { window, URL, AbortController, FormData: MockFormData, setTimeout, clearTimeout });
  return { api: new window.EktApi({ timeoutMs: options.timeoutMs || 1000 }), calls, window };
}

test('session requests coalesce; cookies accompany every request and chat contains only message', async () => {
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const { api, calls } = harness([
    () => first,
    { body: reply() },
    { body: cart() }
  ]);
  const a = api.session();
  const b = api.session();
  assert.equal(a, b);
  release({ ok: true, status: 200, json: async () => session() });
  await Promise.all([a, b]);
  await api.session();
  await api.chat('Нужен автомат 160 А в Астане');
  await api.cart();
  assert.deepEqual(calls.map(call => call.url), ['/api/session', '/api/chat', '/api/cart']);
  assert.equal(calls[1].init.body, JSON.stringify({ message: 'Нужен автомат 160 А в Астане' }));
  assert.equal(calls[1].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].init.headers['X-CSRF-Token'], undefined);
  for (const { init } of calls) assert.equal(init.credentials, 'include');
});

test('confirmation sends only the proposal ID and the in-memory CSRF token', async () => {
  const { api, calls } = harness([{ body: session() }, { body: { cart: cart(), alreadyConfirmed: false } }]);
  const result = await api.confirm('proposal-7');
  assert.equal(result.alreadyConfirmed, false);
  assert.equal(calls[1].url, '/api/cart/confirm');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.body, '{"proposalId":"proposal-7"}');
  assert.equal(calls[1].init.headers['X-CSRF-Token'], 'csrf-in-memory');
  assert.equal(calls[1].init.credentials, 'include');
});

test('same-origin cart paths work through session, confirmation and cart refresh without URL rewriting', async () => {
  const relativeCart = { ...cart(), cartUrl: '/cart?revision=2' };
  const { api } = harness([
    { body: { ...session(), cart: relativeCart } },
    { body: { cart: relativeCart, alreadyConfirmed: false } },
    { body: relativeCart }
  ]);
  assert.equal((await api.session()).cart.cartUrl, relativeCart.cartUrl);
  assert.equal((await api.confirm('proposal-7')).cart.cartUrl, relativeCart.cartUrl);
  assert.equal((await api.cart()).cartUrl, relativeCart.cartUrl);
});

test('409 requests a fresh proposal without automatically retrying confirmation', async () => {
  const { api, calls } = harness([{ body: session() }, {
    status: 409, body: { error: { code: 'STOCK_CHANGED', message: 'internal warehouse state' } }
  }]);
  await assert.rejects(api.confirm('proposal-7'), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'STOCK_CHANGED');
    assert.match(error.message, /новое предложение/);
    assert.equal(error.ambiguous, false);
    assert.doesNotMatch(error.message, /internal warehouse/);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('server messages and arbitrary error codes never escape as UI errors', async () => {
  const { api } = harness([{ body: session() }, {
    status: 502, body: { error: { code: 'Authorization: secret-token', message: 'database password=secret-token' } }
  }]);
  await assert.rejects(api.chat('Автомат'), error => {
    assert.equal(error.code, 'UPSTREAM_UNAVAILABLE');
    assert.equal(error.status, 502);
    assert.doesNotMatch(JSON.stringify(error) + error.message + error.stack, /secret-token|database|Authorization/);
    return true;
  });
});

test('network failure during confirmation is ambiguous and is never retried', async () => {
  const { api, calls } = harness([{ body: session() }, () => { throw new Error('private upstream details'); }]);
  await assert.rejects(api.confirm('proposal-7'), error => {
    assert.equal(error.code, 'CONFIRMATION_UNCERTAIN');
    assert.equal(error.ambiguous, true);
    assert.doesNotMatch(error.message, /private upstream/);
    return true;
  });
  assert.equal(calls.filter(call => call.url === '/api/cart/confirm').length, 1);
});

test('confirmation timeout aborts once and reports uncertainty', async () => {
  const { api, calls } = harness([{ body: session() }, () => new Promise(() => {})], { timeoutMs: 10 });
  await assert.rejects(api.confirm('proposal-7'), error => error.code === 'CONFIRMATION_UNCERTAIN' && error.ambiguous);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.signal.aborted, true);
});

test('confirmation 5xx (including proxy timeout) requires cart review and is never retried', async () => {
  for (const status of [500, 502, 503, 504]) {
    const { api, calls } = harness([{ body: session() }, {
      status, body: { error: { code: 'PROXY_TIMEOUT', message: 'internal target' } }
    }]);
    await assert.rejects(api.confirm('proposal-7'), error => {
      assert.equal(error.code, 'CONFIRMATION_UNCERTAIN');
      assert.equal(error.ambiguous, true);
      assert.match(error.message, /Проверьте корзину/);
      return true;
    });
    assert.equal(calls.filter(call => call.url === '/api/cart/confirm').length, 1);
  }
});

test('ordinary request timeout is safe and distinct from ambiguous confirmation', async () => {
  const { api } = harness([() => new Promise(() => {})], { timeoutMs: 10 });
  await assert.rejects(api.session(), error => error.code === 'REQUEST_TIMEOUT' && !error.ambiguous);
});

test('invalid session is rejected without caching; a later explicit attempt can succeed', async () => {
  const { api, calls } = harness([{ body: { csrfToken: 'token', cart: {} } }, { body: session() }]);
  await assert.rejects(api.session(), error => error.code === 'INVALID_RESPONSE');
  assert.equal((await api.session()).csrfToken, 'csrf-in-memory');
  assert.equal(calls.length, 2);
});

test('unsafe cart links and malformed totals are rejected', async () => {
  for (const malformed of [
    { ...cart(), cartUrl: 'javascript:alert(1)' },
    { ...cart(), cartUrl: 'https://user:password@example.com/cart' },
    { ...cart(), cartUrl: '//another.example/cart' },
    { ...cart(), cartUrl: 'https://demo.example\\\\@another.example/cart' },
    { ...cart(), cartUrl: '' },
    { ...cart(), totalMinor: '100' },
    { ...cart(), totalMinor: -1 },
    { ...cart(), items: [null] }
  ]) {
    const { api } = harness([{ body: session() }, { body: malformed }]);
    await assert.rejects(api.cart(), error => error.code === 'INVALID_RESPONSE');
  }
});

test('invalid successful confirmation is ambiguous because the cart may have changed', async () => {
  const { api, calls } = harness([{ body: session() }, { body: { cart: null, alreadyConfirmed: false } }]);
  await assert.rejects(api.confirm('proposal-7'), error => error.code === 'CONFIRMATION_UNCERTAIN' && error.ambiguous);
  assert.equal(calls.length, 2);
});

test('uploads use one multipart file, browser boundary, and no session ID or history', async () => {
  const extracted = { items: [{ source_row: 2, article: '200300285_', name: 'Автомат', quantity: 1, unit: 'шт', uncertainty: 'none' }], uncertainties: [] };
  const { api, calls } = harness([{ body: session() }, { body: extracted }]);
  const file = { name: 'order.PDF', type: 'application/pdf', size: 1024 };
  assert.equal(await api.attachment(file), extracted);
  const upload = calls[1];
  assert.equal(upload.url, '/api/attachments');
  assert.equal(upload.init.method, 'POST');
  assert.equal(upload.init.credentials, 'include');
  assert.equal(upload.init.headers['Content-Type'], undefined);
  assert.equal(upload.init.body.entries.length, 1);
  assert.deepEqual(upload.init.body.entries[0], ['file', file]);
  assert.equal(calls.some(call => call.url === '/api/cart/confirm'), false);
});

test('unsupported, empty, mismatched, and oversized files fail before making requests', async () => {
  const { api, calls } = harness([]);
  for (const file of [
    { name: 'old.xls', type: 'application/vnd.ms-excel', size: 100 },
    { name: 'image.png', type: 'image/png', size: 100 },
    { name: 'fake.pdf', type: 'text/html', size: 100 },
    { name: 'empty.pdf', type: 'application/pdf', size: 0 },
    { name: 'huge.pdf', type: 'application/pdf', size: 10 * 1024 * 1024 + 1 }
  ]) await assert.rejects(api.attachment(file), error => ['INVALID_FILE', 'FILE_TOO_LARGE'].includes(error.code));
  assert.equal(calls.length, 0);
});

test('allowed extensions work with an empty OS-provided MIME type and a 10 MB boundary', async () => {
  for (const extension of ['pdf', 'docx', 'xlsx', 'jpg', 'jpeg']) {
    const { api } = harness([{ body: session() }, { body: { items: [], uncertainties: [] } }]);
    await api.attachment({ name: 'document.' + extension, type: '', size: 10 * 1024 * 1024 });
  }
});

test('opening index directly gives an actionable connection message without fetch', async () => {
  const { api, calls } = harness([], { protocol: 'file:' });
  await assert.rejects(api.session(), error => error.code === 'API_CONNECTION_REQUIRED');
  assert.equal(calls.length, 0);
});

test('invalid messages or missing proposal IDs never send a request', async () => {
  const { api, calls } = harness([]);
  await assert.rejects(api.chat('  '), error => error.code === 'INVALID_INPUT');
  await assert.rejects(api.confirm(''), error => error.code === 'INVALID_INPUT');
  assert.equal(calls.length, 0);
});
