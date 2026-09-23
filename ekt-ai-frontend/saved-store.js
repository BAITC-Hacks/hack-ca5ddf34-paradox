/* Local display snapshots. This store never restores sessions, carts or executable proposals. */
(function (global) {
  'use strict';

  const HISTORY_LIMIT = 30, FAVORITES_LIMIT = 50, STORAGE_LIMIT = 1200000;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const secretKey = value => /(?:token|secret|password|passwd|authorization|credential|csrf|session|cookie|api[_ -]?key|private[_ -]?key|cart|payment|cardnumber|cvv|cvc|rawhtml|html|script|^__proto__$|^prototype$|^constructor$)/i.test(String(value));
  const clone = value => JSON.parse(JSON.stringify(value));

  function text(value, limit = 500) {
    if (typeof value !== 'string') return '';
    return value.slice(0, limit * 3)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\b(?:Bearer|Basic)\s+[a-z\d._~+\/-]+=*/ig, '[скрыто]')
      .replace(/\b(?:csrf[_ -]?token|session[_ -]?id|password|api[_ -]?key|access[_ -]?token|authorization)\s*[:=]\s*[^\s,;]+/ig, '[скрыто]')
      .trim().slice(0, limit);
  }

  function scalar(value, limit = 500) {
    if (typeof value === 'string') return text(value, limit);
    if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
    return typeof value === 'boolean' || value === null ? value : null;
  }

  function identity(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    return typeof value === 'string' && value.trim() ? text(value, 120) : null;
  }

  function url(value) {
    if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
    const raw = value.trim();
    if (!raw || /^\/\//.test(raw) || /^(?!https?:)[a-z][a-z\d+.-]*:/i.test(raw)) return null;
    if (!/^https?:\/\//i.test(raw) && !/^(?:\/(?!\/)|\.{1,2}\/)/.test(raw) && !/^[^\s:?#]+[/.][^\s]*(?:[?#].*)?$/.test(raw)) return null;
    try {
      const base = global.location && /^https?:/.test(global.location.href) ? global.location.href : 'https://local.invalid/';
      const parsed = new URL(raw, base);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      if (!/^https?:\/\//i.test(raw) && parsed.origin !== new URL(base).origin) return null;
      if ([...parsed.searchParams.keys()].some(secretKey)) return null;
      return /^https?:\/\//i.test(raw) ? parsed.href : raw;
    } catch (_) { return null; }
  }

  function urlField(key) { return /(?:url|href|^link$|^image$)/i.test(key); }

  // Facts may have catalog-specific names, but nesting, fields and values are bounded.
  // Metadata records whose key/name/label identify a secret are discarded as a whole.
  function data(value, depth = 0, key = '', budget = { nodes: 160, characters: 10000 }) {
    if (depth > 4 || --budget.nodes < 0 || budget.characters <= 0) return null;
    if (urlField(key) || (typeof value === 'string' && /^(?:https?:\/\/|javascript:|vbscript:|data:|file:|blob:|ftp:|\/\/)/i.test(value))) {
      const link = url(value);
      if (!link || link.length > budget.characters) return null;
      budget.characters -= link.length;
      return link;
    }
    if (Array.isArray(value)) return value.slice(0, 30).map(item => data(item, depth + 1, '', budget)).filter(item => item !== null);
    if (!object(value)) {
      const result = scalar(value, Math.min(500, budget.characters));
      if (typeof result === 'string') budget.characters -= result.length;
      return result;
    }
    if (['key', 'name', 'label', 'field'].some(field => typeof value[field] === 'string' && secretKey(value[field]))) return null;
    const result = {};
    for (const [name, item] of Object.entries(value).slice(0, 50)) {
      if (secretKey(name)) continue;
      const safeName = text(name, 100);
      if (!safeName || secretKey(safeName)) continue;
      const safe = data(item, depth + 1, safeName, budget);
      if (safe !== null) result[safeName] = safe;
    }
    return result;
  }

  function price(value) {
    if (!object(value)) return typeof value === 'number' || typeof value === 'string' ? scalar(value, 80) : null;
    const result = {};
    for (const key of ['amount', 'amountMinor', 'currency']) if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = scalar(value[key], 20);
    return result;
  }

  function stockRow(value) {
    if (!object(value)) return typeof value === 'number' || typeof value === 'string' ? scalar(value, 80) : null;
    const result = {};
    for (const key of ['quantity', 'available', 'total', 'city', 'warehouse', 'warehouseName', 'storeName', 'name']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = scalar(value[key], 120);
    }
    return result;
  }

  function stock(value) {
    if (Array.isArray(value)) return value.slice(0, 30).map(stockRow).filter(item => item !== null);
    if (!object(value)) return stockRow(value);
    const result = stockRow(value);
    for (const key of ['stores', 'byCity']) {
      if (Array.isArray(value[key])) result[key] = value[key].slice(0, 30).map(stockRow).filter(item => item !== null);
      else if (object(value[key])) {
        result[key] = {};
        for (const [name, row] of Object.entries(value[key]).slice(0, 30)) {
          const label = text(name, 100);
          if (label && !secretKey(label)) result[key][label] = stockRow(row);
        }
      }
    }
    return result;
  }

  function certificates(value) {
    const values = Array.isArray(value) ? value.slice(0, 12) : value ? [value] : [];
    const result = [];
    for (const item of values) {
      const link = url(typeof item === 'string' ? item : object(item) ? item.url || item.href || item.fileUrl || item.file_url || item.link || item.value : null);
      if (!link || result.some(entry => entry.url === link)) continue;
      const name = object(item) ? text(item.name || item.label || item.title, 120) : '';
      result.push({ name: name || 'Сертификат', url: link });
    }
    return result;
  }

  function product(value) {
    if (!object(value)) return null;
    const id = identity(value.id);
    if (id === null || id === '') return null;
    const result = {
      id, name: text(value.name, 240), article: text(value.article, 120),
      price: price(value.price), stock: stock(value.stock), facts: data(value.facts),
      source: typeof value.source === 'string' ? data(value.source) : object(value.source) ? { name: text(value.source.name, 180), url: url(value.source.url) } : '',
      productUrl: url(value.productUrl), imageUrl: url(value.imageUrl || (object(value.image) ? value.image.url : value.image)),
      unit: text(value.unit, 40), certificates: certificates(value.certificates)
    };
    return result;
  }

  function proposal(value) {
    if (!object(value)) return null;
    return {
      id: identity(value.id), productId: identity(value.productId), productName: text(value.productName, 240),
      productArticle: text(value.productArticle, 120), quantity: scalar(value.quantity, 80), city: text(value.city, 120),
      unitPrice: price(value.unitPrice), totalAmount: price(value.totalAmount), expiresAt: text(value.expiresAt, 80)
    };
  }

  function response(value) {
    const raw = object(value) ? value : {};
    const alternatives = (Array.isArray(raw.alternatives) ? raw.alternatives : []).slice(0, 6).map(item => {
      if (!object(item)) return null;
      const candidate = product(item.candidate);
      if (!candidate) return null;
      return {
        candidate, details: typeof item.details === 'string' ? text(item.details, 1600) : data(item.details),
        comparison: (Array.isArray(item.comparison) ? item.comparison : []).slice(0, 20).filter(object).map(row => ({
          field: text(row.field, 120), requested: scalar(row.requested, 240), offered: scalar(row.offered, 240),
          verdict: ['match', 'different', 'unknown'].includes(row.verdict) ? row.verdict : 'unknown'
        }))
      };
    }).filter(Boolean);
    return {
      reply: text(raw.reply, 6000),
      products: (Array.isArray(raw.products) ? raw.products : []).slice(0, 8).map(product).filter(Boolean),
      alternatives, proposal: proposal(raw.proposal),
      warnings: (Array.isArray(raw.warnings) ? raw.warnings : []).slice(0, 12).map(item => text(typeof item === 'string' ? item : object(item) ? item.message : '', 500)).filter(Boolean)
    };
  }

  function title(query) {
    let value = query.split(/\r?\n/).filter(line => !/^\s*\[?\s*(?:citycontext|город(?: для поиска| поиска)?|контекст города)\s*[:=]/i.test(line))[0] || query;
    value = value.replace(/^Найти товар:\s*/i, '').replace(/^Подобрать аналог для:\s*/i, 'Аналог: ');
    value = value.replace(/\s*\[?citycontext\s*:[^\]\n]*\]?/ig, '').trim();
    return text(value, 64) || 'Запрос без названия';
  }

  function timestamp(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  }

  function restoreHistory(value, restorePending) {
    if (!object(value) || identity(value.id) === null || typeof value.query !== 'string' || !timestamp(value.createdAt)) return null;
    const query = text(value.query, 4000);
    return {
      id: String(identity(value.id)), title: title(query), query, city: text(value.city, 120), createdAt: timestamp(value.createdAt),
      status: value.status === 'pending' ? (restorePending ? 'interrupted' : 'pending') : ['complete', 'error', 'interrupted'].includes(value.status) ? value.status : 'interrupted',
      ...response(value)
    };
  }

  class EktSavedStore {
    #storage = null;
    #persistent = false;
    #history = [];
    #favorites = [];
    #counter = 0;
    #serialized = null;

    constructor(options = {}) {
      options = object(options) ? options : {};
      Object.defineProperty(this, 'key', { value: 'ekt:saved:v1:' + (options.mode === 'demo' ? 'demo' : 'live'), enumerable: true });
      try {
        this.#storage = options.storage === undefined ? global.localStorage : options.storage;
        if (!this.#storage || typeof this.#storage.getItem !== 'function' || typeof this.#storage.setItem !== 'function') this.#storage = null;
      } catch (_) { this.#storage = null; }
      this.#persistent = Boolean(this.#storage);
      this.reload({ restorePending: true });
    }

    status() { return { persistent: this.#persistent }; }
    history() { return clone(this.#history); }
    favorites() { return clone(this.#favorites); }

    #disableStorage() { this.#persistent = false; this.#storage = null; }

    #persist() {
      if (!this.#storage) return;
      try {
        let serialized = JSON.stringify({ version: 1, history: this.#history, favorites: this.#favorites });
        while (serialized.length > STORAGE_LIMIT && this.#history.length > 1) {
          this.#history.pop();
          serialized = JSON.stringify({ version: 1, history: this.#history, favorites: this.#favorites });
        }
        if (serialized.length > STORAGE_LIMIT) throw new Error('Storage snapshot is too large');
        if (serialized !== this.#serialized) this.#storage.setItem(this.key, serialized);
        this.#serialized = serialized;
        this.#persistent = true;
      } catch (_) { this.#disableStorage(); }
    }

    begin(query, city = '') {
      const cleanQuery = text(query, 4000);
      if (!cleanQuery) throw new Error('Введите запрос для сохранения в истории.');
      this.reload();
      const id = Date.now().toString(36) + '-' + (++this.#counter).toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      this.#history.unshift({ id, title: title(cleanQuery), query: cleanQuery, city: text(city, 120), createdAt: new Date().toISOString(), status: 'pending', ...response(null) });
      this.#history = this.#history.slice(0, HISTORY_LIMIT);
      this.#persist();
      return id;
    }

    finish(id, value, options = {}) {
      this.reload();
      const entry = this.#history.find(item => item.id === String(id));
      if (!entry) return;
      Object.assign(entry, response(value), { status: options.error ? 'error' : 'complete' });
      this.#persist();
    }

    removeHistory(id) {
      this.reload();
      this.#history = this.#history.filter(item => item.id !== String(id));
      this.#persist();
    }

    hasFavorite(id) { return id !== null && id !== undefined && this.#favorites.some(item => String(item.product.id) === String(id)); }

    toggleFavorite(value) {
      const snapshot = product(value);
      if (!snapshot) throw new Error('Не удалось сохранить товар: отсутствует идентификатор.');
      this.reload();
      const index = this.#favorites.findIndex(item => String(item.product.id) === String(snapshot.id));
      if (index >= 0) {
        this.#favorites.splice(index, 1); this.#persist(); return false;
      }
      if (this.#favorites.length >= FAVORITES_LIMIT) throw new Error('В избранном уже 50 товаров. Удалите один, чтобы сохранить новый.');
      this.#favorites.unshift({ product: snapshot, savedAt: new Date().toISOString() });
      this.#persist();
      return true;
    }

    reload({ restorePending = false } = {}) {
      if (!this.#storage) return;
      try {
        const serialized = this.#storage.getItem(this.key);
        if (serialized === null || serialized === undefined) { this.#history = []; this.#favorites = []; this.#serialized = null; this.#persistent = true; return; }
        if (typeof serialized !== 'string' || serialized.length > STORAGE_LIMIT) throw new Error('Invalid storage');
        const state = JSON.parse(serialized);
        if (!object(state) || state.version !== 1 || !Array.isArray(state.history) || !Array.isArray(state.favorites)) throw new Error('Invalid storage schema');
        const seenHistory = new Set(), seenFavorites = new Set();
        this.#history = state.history.slice(0, HISTORY_LIMIT).map(item => restoreHistory(item, restorePending)).filter(item => {
          if (!item || seenHistory.has(item.id)) return false;
          seenHistory.add(item.id); return true;
        }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        this.#favorites = state.favorites.slice(0, FAVORITES_LIMIT).map(item => {
          const saved = object(item) ? product(item.product) : null;
          const savedAt = object(item) ? timestamp(item.savedAt) : null;
          if (!saved || !savedAt || seenFavorites.has(String(saved.id))) return null;
          seenFavorites.add(String(saved.id)); return { product: saved, savedAt };
        }).filter(Boolean).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
        this.#serialized = serialized;
        this.#persistent = true;
        // Re-save the sanitized snapshot, including interrupted requests, once loaded.
        this.#persist();
      } catch (_) { this.#disableStorage(); }
    }
  }

  global.EktSavedStore = EktSavedStore;
})(window);
