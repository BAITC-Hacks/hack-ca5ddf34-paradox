const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePromise = import(pathToFileURL(path.join(__dirname, '..', 'dev-server.mjs')));
const listen = async server => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};
const close = server => new Promise(resolve => {
  server.close(resolve);
  server.closeAllConnections();
});
async function fixture(t, handler, options = {}) {
  const { createDevServer } = await modulePromise;
  const backend = http.createServer(handler);
  const backendUrl = await listen(backend);
  const frontend = createDevServer({ backendUrl, ...options });
  const url = await listen(frontend);
  t.after(async () => { await close(frontend); await close(backend); });
  return { frontend, backend, backendUrl, url };
}
function rawRequest(url, requestPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({ hostname: target.hostname, port: target.port, path: requestPath, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}
async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('same-origin proxy preserves session cookies, CSRF confirmation, JSON bodies and cart routes', async t => {
  const seen = [];
  const { url, backendUrl } = await fixture(t, async (request, response) => {
    seen.push({ url: request.url, method: request.method, headers: request.headers, body: (await readBody(request)).toString() });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/session') response.setHeader('Set-Cookie', [
      'ekt_session=server-session; HttpOnly; SameSite=Lax; Path=/',
      'preference=ru; Path=/'
    ]);
    response.end(JSON.stringify({ ok: true }));
  });
  const session = await rawRequest(url, '/api/session');
  assert.equal(session.status, 200);
  assert.deepEqual(session.headers['set-cookie'], [
    'ekt_session=server-session; HttpOnly; SameSite=Lax; Path=/', 'preference=ru; Path=/'
  ]);
  const body = JSON.stringify({ proposalId: 'reviewed-proposal' });
  const confirmed = await rawRequest(url, '/api/cart/confirm', {
    method: 'POST', body, headers: {
      Cookie: 'ekt_session=server-session', 'X-CSRF-Token': 'memory-token',
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      Connection: 'keep-alive, x-remove-me', 'X-Remove-Me': 'hop-only'
    }
  });
  assert.equal(confirmed.status, 200);
  await rawRequest(url, '/api/chat?lang=ru');
  await rawRequest(url, '/api/cart');
  await rawRequest(url, '/cart?revision=1');
  await rawRequest(url, '/cart/details');
  assert.deepEqual(seen.map(item => item.url), ['/api/session', '/api/cart/confirm', '/api/chat?lang=ru', '/api/cart', '/cart?revision=1', '/cart/details']);
  assert.equal(seen[1].method, 'POST');
  assert.equal(seen[1].headers.cookie, 'ekt_session=server-session');
  assert.equal(seen[1].headers['x-csrf-token'], 'memory-token');
  assert.equal(seen[1].headers.host, new URL(backendUrl).host);
  assert.equal(seen[1].headers['x-remove-me'], undefined);
  assert.equal(seen[1].body, body);
});

test('multipart attachment data and boundary pass through byte for byte', async t => {
  let actual;
  const { url } = await fixture(t, async (request, response) => {
    actual = { method: request.method, path: request.url, type: request.headers['content-type'], body: await readBody(request) };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ items: [], uncertainties: [] }));
  });
  const boundary = 'ekt-test-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="specification.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 0xff, 0xc0]),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const response = await rawRequest(url, '/api/attachments', { method: 'POST', body, headers: {
    'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length
  } });
  assert.equal(response.status, 200);
  assert.equal(actual.method, 'POST');
  assert.equal(actual.path, '/api/attachments');
  assert.equal(actual.type, `multipart/form-data; boundary=${boundary}`);
  assert.deepEqual(actual.body, body);
});

test('static frontend is self-contained and private or traversal paths are never served', async t => {
  let proxied = 0;
  const { url } = await fixture(t, (_request, response) => { proxied++; response.end(); });
  const page = await rawRequest(url, '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body.toString(), /<style data-source="styles.css">/);
  assert.match(page.body.toString(), /<script data-source="app.js">/);
  const css = await rawRequest(url, '/styles.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
  const head = await rawRequest(url, '/index.html', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['content-length']), page.body.length);
  for (const route of ['/.env', '/.git/config', '/README.md', '/dev-server.mjs', '/src/index.template.html', '/api-keys', '/cartoon']) {
    assert.equal((await rawRequest(url, route)).status, 404, route);
  }
  for (const route of ['/../.env', '/%2e%2e/.env', '/api/%2e%2e/.env', '/%5c.env', '/%00', '/%xx', '//evil.example/api/session']) {
    assert.equal((await rawRequest(url, route)).status, 400, route);
  }
  assert.equal((await rawRequest(url, '/', { method: 'POST' })).status, 405);
  assert.equal(proxied, 0);
});

test('upstream HTTP 409 and redirect responses keep their status and headers', async t => {
  const { url } = await fixture(t, (request, response) => {
    if (request.url === '/cart') { response.writeHead(302, { Location: '/cart/review' }); response.end(); return; }
    response.writeHead(409, { 'Content-Type': 'application/json', Connection: 'x-internal', 'X-Internal': 'private-hop' });
    response.end(JSON.stringify({ error: { code: 'STOCK_CHANGED', message: 'Stock changed.' } }));
  });
  const conflict = await rawRequest(url, '/api/cart/confirm', { method: 'POST', body: '{}' });
  assert.equal(conflict.status, 409);
  assert.equal(JSON.parse(conflict.body).error.code, 'STOCK_CHANGED');
  assert.equal(conflict.headers['x-internal'], undefined);
  const redirect = await rawRequest(url, '/cart');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, '/cart/review');
});

test('connection failures and upstream timeouts return safe JSON without target details', async t => {
  const { url, backend } = await fixture(t, () => {}, { timeoutMs: 50 });
  const timeout = await rawRequest(url, '/api/session');
  assert.equal(timeout.status, 504);
  assert.equal(JSON.parse(timeout.body).error.code, 'PROXY_TIMEOUT');
  assert.doesNotMatch(timeout.body.toString(), /127\.0\.0\.1|ECONN|stack/i);
  await close(backend);
  const unavailable = await rawRequest(url, '/api/session');
  assert.equal(unavailable.status, 502);
  assert.equal(JSON.parse(unavailable.body).error.code, 'PROXY_UNAVAILABLE');
  assert.doesNotMatch(unavailable.body.toString(), /127\.0\.0\.1|ECONN|stack/i);
});

test('backend configuration accepts only explicit HTTP(S) origins without embedded secrets', async () => {
  const { createDevServer } = await modulePromise;
  for (const backendUrl of ['not a url', 'file:///tmp/file', 'https://user:secret@example.com', 'http://example.com/api', 'http://example.com?key=secret']) {
    assert.throws(() => createDevServer({ backendUrl }), /BACKEND_URL/);
  }
  assert.throws(() => createDevServer({ timeoutMs: 0 }), /timeoutMs/);
});
