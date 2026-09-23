import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/api.js', ['api.js', 'text/javascript; charset=utf-8']],
  ['/view-model.js', ['view-model.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);
const hopByHop = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

function forwardedHeaders(headers) {
  const blocked = new Set(hopByHop);
  for (const token of String(headers.connection || '').split(',')) blocked.add(token.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())));
}

function sendError(response, status, code, message) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify({ error: { code, message } }));
}

function backendOrigin(value) {
  let target;
  try { target = new URL(value); } catch { throw new Error('BACKEND_URL must be an HTTP or HTTPS origin.'); }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password ||
      target.pathname !== '/' || target.search || target.hash) {
    throw new Error('BACKEND_URL must be an HTTP or HTTPS origin without credentials, path, query or fragment.');
  }
  return target;
}

/** Local development only. The browser always calls the frontend origin. */
export function createDevServer({ backendUrl = 'http://127.0.0.1:8000', rootDir = projectRoot, timeoutMs = 30000 } = {}) {
  const target = backendOrigin(backendUrl);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive.');
  const transport = target.protocol === 'https:' ? https : http;
  const requests = new Set();

  function proxy(request, response) {
    const headers = forwardedHeaders(request.headers);
    headers.host = target.host;
    const upstream = transport.request({
      protocol: target.protocol, hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port,
      method: request.method, path: request.url, headers
    });
    requests.add(upstream);
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      requests.delete(upstream);
    };
    const deadline = setTimeout(() => {
      sendError(response, 504, 'PROXY_TIMEOUT', 'Сервер отвечает слишком долго. Попробуйте ещё раз.');
      upstream.destroy();
      cleanup();
    }, timeoutMs);
    deadline.unref();
    upstream.on('response', incoming => {
      response.writeHead(incoming.statusCode || 502, forwardedHeaders(incoming.headers));
      incoming.on('error', () => {
        sendError(response, 502, 'PROXY_UNAVAILABLE', 'Не удалось получить ответ сервера.');
        cleanup();
      });
      incoming.on('end', cleanup);
      incoming.pipe(response);
    });
    upstream.on('error', () => {
      sendError(response, 502, 'PROXY_UNAVAILABLE', 'Backend недоступен. Проверьте, что сервер запущен.');
      cleanup();
    });
    request.once('aborted', () => { upstream.destroy(); cleanup(); });
    response.once('close', () => {
      if (!response.writableEnded) upstream.destroy();
      cleanup();
    });
    request.pipe(upstream);
  }

  const server = http.createServer(async (request, response) => {
    let pathname;
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new Error();
      pathname = decodeURIComponent(request.url.split('?')[0]);
      if (/[\\\u0000]/.test(pathname) || pathname.split('/').some(part => part === '.' || part === '..')) throw new Error();
    } catch {
      sendError(response, 400, 'INVALID_PATH', 'Некорректный путь запроса.');
      return;
    }
    if (pathname === '/api' || pathname.startsWith('/api/') || pathname === '/cart' || pathname.startsWith('/cart/')) {
      proxy(request, response);
      return;
    }
    const asset = staticFiles.get(pathname);
    if (!asset) { sendError(response, 404, 'NOT_FOUND', 'Страница не найдена.'); return; }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      sendError(response, 405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается.');
      return;
    }
    try {
      const content = await readFile(path.join(rootDir, asset[0]));
      if (response.destroyed) return;
      response.writeHead(200, {
        'Content-Type': asset[1], 'Content-Length': content.length,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      sendError(response, 404, 'ASSET_NOT_FOUND', 'Файл интерфейса не найден. Выполните npm run build.');
    }
  });
  server.on('close', () => { for (const upstream of requests) upstream.destroy(); });
  server.headersTimeout = 15000;
  server.requestTimeout = Math.max(timeoutMs + 5000, 30000);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const port = Number(process.env.PORT || 5173);
    const host = process.env.HOST || '127.0.0.1';
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
    const server = createDevServer({ backendUrl: process.env.BACKEND_URL || 'http://127.0.0.1:8000' });
    server.on('error', () => { console.error('Could not start frontend server. Check HOST and PORT.'); process.exitCode = 1; });
    server.listen(port, host, () => { console.log(`Frontend ready at http://${host.includes(':') ? '[' + host + ']' : host}:${port}`); });
    const shutdown = () => {
      server.close(() => process.exit(0));
      const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000);
      deadline.unref();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
