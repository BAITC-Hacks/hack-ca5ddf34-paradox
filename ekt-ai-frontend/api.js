(function (root) {
  'use strict';

  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const FILE_TYPES = Object.freeze({
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg'
  });
  const ALLOWED_ERROR_CODES = new Set([
    'BAD_REQUEST', 'INVALID_INPUT', 'INVALID_FILE', 'FILE_TOO_LARGE',
    'PROPOSAL_NOT_FOUND', 'PROPOSAL_EXPIRED', 'PROPOSAL_STALE',
    'PRICE_CHANGED', 'STOCK_CHANGED', 'INSUFFICIENT_STOCK',
    'INVALID_QUANTITY', 'INVALID_ORDER_MULTIPLE', 'ORDER_MULTIPLE_CHANGED',
    'CSRF_INVALID', 'CSRF_REJECTED', 'SESSION_EXPIRED',
    'UPSTREAM_UNAVAILABLE', 'CATALOG_UNAVAILABLE', 'MODEL_UNAVAILABLE',
    'RATE_LIMITED'
  ]);

  class EktApiError extends Error {
    constructor(message, code, status = 0, ambiguous = false) {
      super(message);
      this.name = 'EktApiError';
      this.code = code;
      this.status = status;
      this.ambiguous = ambiguous;
    }
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function validCart(value) {
    if (!isRecord(value) || !Array.isArray(value.items) ||
        !value.items.every(isRecord) || !Number.isSafeInteger(value.totalMinor) ||
        value.totalMinor < 0 || typeof value.cartUrl !== 'string') return false;
    const raw = value.cartUrl.trim();
    if (!raw || /[\u0000-\u001f\u007f\\]/.test(raw)) return false;
    try {
      const base = root.location && root.location.href;
      const url = new URL(raw, base);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false;
      // Same-origin paths keep the browser's session when the development proxy serves /cart.
      return /^https?:\/\//i.test(raw) || Boolean(base && url.origin === new URL(base).origin);
    } catch (_) {
      return false;
    }
  }

  function invalidResponse() {
    return new EktApiError('Сервис прислал неполный ответ. Попробуйте ещё раз позже.', 'INVALID_RESPONSE');
  }

  function uncertainConfirmation() {
    return new EktApiError(
      'Не удалось узнать результат добавления. Проверьте корзину перед повторным подтверждением.',
      'CONFIRMATION_UNCERTAIN', 0, true
    );
  }

  function httpError(status, body) {
    const messages = {
      400: ['Проверьте введённые данные и попробуйте ещё раз.', 'BAD_REQUEST'],
      401: ['Сессия завершилась. Обновите страницу и повторите действие.', 'SESSION_EXPIRED'],
      403: ['Не удалось подтвердить сессию. Обновите страницу и запросите новое предложение.', 'CSRF_REJECTED'],
      404: ['Предложение больше не найдено. Запросите новое предложение в чате.', 'PROPOSAL_NOT_FOUND'],
      409: ['Цена, наличие или кратность заказа изменились. Запросите новое предложение в чате.', 'PROPOSAL_STALE'],
      413: ['Файл слишком большой. Максимальный размер — 10 МБ.', 'FILE_TOO_LARGE'],
      415: ['Выберите PDF, DOCX, XLSX или JPEG.', 'INVALID_FILE'],
      429: ['Слишком много запросов. Попробуйте немного позже.', 'RATE_LIMITED'],
      502: ['Каталог или ассистент временно недоступен. Попробуйте ещё раз позже.', 'UPSTREAM_UNAVAILABLE']
    };
    const [message, fallback] = messages[status] || ['Сервис временно недоступен. Попробуйте ещё раз позже.', 'SERVICE_UNAVAILABLE'];
    const serverCode = isRecord(body) && isRecord(body.error) ? body.error.code : null;
    // Never display the server's message: it may contain upstream details or credentials.
    const code = ALLOWED_ERROR_CODES.has(serverCode) ? serverCode : fallback;
    return new EktApiError(message, code, status);
  }

  class EktApi {
    #csrfToken = null;
    #sessionValue = null;
    #sessionRequest = null;
    #timeoutMs;

    constructor({ timeoutMs = 20000 } = {}) {
      this.#timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000;
    }

    async #request(path, { method = 'GET', json, form, csrf = false, confirming = false } = {}) {
      if (root.location && root.location.protocol === 'file:') {
        throw new EktApiError('Для подключения к ассистенту откройте сайт через сервер с API.', 'API_CONNECTION_REQUIRED');
      }
      if (typeof root.fetch !== 'function') {
        throw new EktApiError('Не удалось подключиться к сервису. Откройте сайт в современном браузере.', 'API_CONNECTION_REQUIRED');
      }

      const controller = new AbortController();
      const headers = { Accept: 'application/json' };
      const options = { method, credentials: 'include', headers, signal: controller.signal };
      if (json !== undefined) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(json);
      }
      if (form !== undefined) options.body = form;
      if (csrf) headers['X-CSRF-Token'] = this.#csrfToken;

      let timeout;
      try {
        const operation = (async () => {
          const response = await root.fetch(path, options);
          // A server/proxy failure can arrive after the cart was already changed.
          // Never encourage an unreviewed retry when confirmation outcome is unknown.
          if (confirming && response.status >= 500) throw uncertainConfirmation();
          let body;
          try {
            body = await response.json();
          } catch (_) {
            if (!response.ok) throw httpError(response.status, null);
            throw confirming ? uncertainConfirmation() : invalidResponse();
          }
          if (!response.ok) throw httpError(response.status, body);
          if (!isRecord(body)) throw confirming ? uncertainConfirmation() : invalidResponse();
          return body;
        })();
        const deadline = new Promise((_, reject) => {
          timeout = setTimeout(() => {
            // Reject before abort, so native fetch's AbortError cannot mask the timeout.
            reject(confirming ? uncertainConfirmation() : new EktApiError(
              'Сервис отвечает слишком долго. Попробуйте ещё раз.', 'REQUEST_TIMEOUT'
            ));
            controller.abort();
          }, this.#timeoutMs);
        });
        return await Promise.race([operation, deadline]);
      } catch (error) {
        if (error instanceof EktApiError) throw error;
        if (confirming) throw uncertainConfirmation();
        throw new EktApiError('Не удалось связаться с сервисом. Проверьте подключение и попробуйте ещё раз.', 'CONNECTION_ERROR');
      } finally {
        clearTimeout(timeout);
      }
    }

    session() {
      if (this.#sessionValue) return Promise.resolve(this.#sessionValue);
      if (this.#sessionRequest) return this.#sessionRequest;
      this.#sessionRequest = this.#request('/api/session').then(value => {
        if (typeof value.csrfToken !== 'string' || !value.csrfToken.trim() || !validCart(value.cart)) {
          throw invalidResponse();
        }
        this.#csrfToken = value.csrfToken;
        this.#sessionValue = value;
        return value;
      }).finally(() => { this.#sessionRequest = null; });
      return this.#sessionRequest;
    }

    async chat(message) {
      if (typeof message !== 'string' || !message.trim()) {
        throw new EktApiError('Введите сообщение для ассистента.', 'INVALID_INPUT', 400);
      }
      await this.session();
      const value = await this.#request('/api/chat', { method: 'POST', json: { message } });
      if (typeof value.reply !== 'string' || !Array.isArray(value.products) ||
          !Array.isArray(value.alternatives) || !Array.isArray(value.warnings) ||
          !(value.proposal === null || isRecord(value.proposal))) throw invalidResponse();
      return value;
    }

    async cart() {
      await this.session();
      const value = await this.#request('/api/cart');
      if (!validCart(value)) throw invalidResponse();
      return value;
    }

    async confirm(proposalId) {
      if (typeof proposalId !== 'string' || !proposalId.trim()) {
        throw new EktApiError('Запросите предложение в чате перед подтверждением.', 'INVALID_INPUT', 400);
      }
      await this.session();
      const value = await this.#request('/api/cart/confirm', {
        method: 'POST', json: { proposalId }, csrf: true, confirming: true
      });
      if (!validCart(value.cart) || typeof value.alreadyConfirmed !== 'boolean') {
        throw uncertainConfirmation();
      }
      return value;
    }

    async attachment(file) {
      if (!file || typeof file.name !== 'string' || typeof file.size !== 'number' ||
          !Number.isFinite(file.size) || file.size <= 0) {
        throw new EktApiError('Выберите непустой файл PDF, DOCX, XLSX или JPEG.', 'INVALID_FILE', 400);
      }
      if (file.size > MAX_FILE_SIZE) {
        throw new EktApiError('Файл слишком большой. Максимальный размер — 10 МБ.', 'FILE_TOO_LARGE', 400);
      }
      const extension = file.name.toLowerCase().split('.').pop();
      const expectedType = Object.hasOwn(FILE_TYPES, extension) ? FILE_TYPES[extension] : null;
      if (!expectedType || (file.type && file.type !== expectedType)) {
        throw new EktApiError('Поддерживаются только PDF, DOCX, XLSX и JPEG.', 'INVALID_FILE', 400);
      }
      const form = new FormData();
      form.append('file', file);
      await this.session();
      const value = await this.#request('/api/attachments', { method: 'POST', form });
      if (!Array.isArray(value.items) || !value.items.every(isRecord) || !Array.isArray(value.uncertainties)) {
        throw invalidResponse();
      }
      return value;
    }
  }

  root.EktApi = EktApi;
  root.EktApiError = EktApiError;
})(window);
