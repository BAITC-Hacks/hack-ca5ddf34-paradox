/* Display adapters for the public EKT API. Unknown values stay unknown. */
(function (global) {
  'use strict';

  const UNKNOWN_PRICE = 'Не указана';
  const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 8 });
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;

  // Explicit decimal strings are accepted; booleans, blank strings and null are not zero.
  function number(value) {
    if (typeof value === 'string') {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null;
      value = Number(value);
    }
    return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
  }

  function amount(value) {
    if (!record(value)) {
      const numeric = number(value);
      return numeric === null ? null : { value: numeric, currency: null };
    }
    const hasMajor = own(value, 'amount');
    const hasMinor = own(value, 'amountMinor');
    if (!hasMajor && !hasMinor) return null;
    const major = hasMajor ? number(value.amount) : null;
    const minor = hasMinor ? number(value.amountMinor) : null;
    if ((hasMajor && major === null) || (hasMinor && (minor === null || !Number.isInteger(minor)))) return null;
    if (hasMajor && hasMinor && Math.abs(major - minor / 100) > 1e-8) return null;
    if (own(value, 'currency') && (!nonempty(value.currency) || !/^[a-z]{3}$/i.test(value.currency))) return null;
    return { value: hasMajor ? major : minor / 100, currency: value.currency ? value.currency.toUpperCase() : null };
  }

  function money(value, options) {
    const parsed = amount(value);
    if (!parsed) return UNKNOWN_PRICE;
    const requestedCurrency = options && options.currency;
    const currency = parsed.currency || (typeof requestedCurrency === 'string' && /^[a-z]{3}$/i.test(requestedCurrency) ? requestedCurrency.toUpperCase() : null);
    if (!currency) return numberFormat.format(parsed.value);
    try {
      return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 8 }).format(parsed.value);
    } catch (_) {
      return UNKNOWN_PRICE;
    }
  }

  function cartTotal(totalMinor) {
    const minor = number(totalMinor);
    return minor !== null && Number.isInteger(minor) && minor >= 0 ? numberFormat.format(minor / 100) : UNKNOWN_PRICE;
  }

  const cityKey = city => typeof city === 'string' ? city.trim().toLocaleLowerCase('ru-RU') : '';
  const cityName = value => record(value) && nonempty(value.city) ? value.city.trim() : '';
  function stockQuantity(value) {
    if (!record(value)) {
      const quantity = number(value);
      return quantity !== null && quantity >= 0 ? quantity : null;
    }
    if (value.customerAccessible === false) return null;
    for (const field of ['availableQuantity', 'quantity', 'available', 'total']) {
      if (!own(value, field)) continue;
      const quantity = number(value[field]);
      if (quantity !== null && quantity >= 0) return quantity;
    }
    return null;
  }

  function stockResult(quantity, city) {
    let label = quantity === null ? 'Наличие уточняется' : quantity === 0 ? 'Нет в наличии' : 'В наличии · ' + numberFormat.format(quantity);
    if (city) label += ' · ' + city;
    return { quantity, city: city || '', label };
  }

  function warehouseName(value) {
    if (!record(value)) return '';
    for (const key of ['warehouse', 'warehouseName', 'storeName', 'name']) {
      if (nonempty(value[key])) return value[key].trim();
    }
    return '';
  }

  function entriesFromStock(value, keyedByCity) {
    if (Array.isArray(value)) return value.filter(record).map(item => ({ city: cityName(item), warehouse: keyedByCity ? '' : warehouseName(item), quantity: stockQuantity(item) }));
    if (!record(value)) return [];
    return Object.entries(value).map(([key, item]) => ({
      city: cityName(item) || (keyedByCity ? key : ''),
      warehouse: keyedByCity ? '' : warehouseName(item),
      quantity: stockQuantity(item)
    }));
  }

  // Warehouse rows remain separate. A missing city total is never derived by summing them.
  function stockEntries(value) {
    const warehouses = Array.isArray(value) ? entriesFromStock(value, false) : record(value) ? entriesFromStock(value.stores, false) : [];
    const byCity = record(value) ? entriesFromStock(value.byCity, true) : [];
    const warehouseCities = new Set(warehouses.map(item => cityKey(item.city)).filter(Boolean));
    const rows = [...warehouses, ...byCity.filter(item => !warehouseCities.has(cityKey(item.city)))];
    if (!rows.length && cityName(value)) rows.push({ city: cityName(value), warehouse: warehouseName(value), quantity: stockQuantity(value) });
    return rows;
  }

  function cities(value) {
    const names = [cityName(value), ...stockEntries(value).map(item => item.city)];
    const seen = new Set();
    return names.filter(name => {
      const key = cityKey(name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function stock(value, requestedCity) {
    const city = nonempty(requestedCity) ? requestedCity.trim() : '';
    const directCity = cityName(value);
    if (city) {
      if (directCity && cityKey(directCity) === cityKey(city)) return stockResult(stockQuantity(value), directCity);
      const byCity = record(value) ? entriesFromStock(value.byCity, true) : [];
      const matches = byCity.filter(item => cityKey(item.city) === cityKey(city));
      if (matches.length === 1) return stockResult(matches[0].quantity, matches[0].city);
      if (matches.length > 1) return stockResult(null, city);
      const stores = Array.isArray(value) ? entriesFromStock(value, false) : record(value) ? entriesFromStock(value.stores, false) : [];
      const warehouses = stores.filter(item => cityKey(item.city) === cityKey(city));
      // Multiple warehouse quantities are not a documented city total; never sum them.
      return warehouses.length === 1 ? stockResult(warehouses[0].quantity, warehouses[0].city) : stockResult(null, city);
    }
    const quantity = stockQuantity(value);
    if (quantity !== null) {
      if (!directCity && stockEntries(value).length) return { quantity, city: '', label: 'Всего по складам · ' + numberFormat.format(quantity) };
      return stockResult(quantity, directCity);
    }
    const entries = Array.isArray(value) ? entriesFromStock(value, false) : record(value)
      ? [...entriesFromStock(value.byCity, true), ...entriesFromStock(value.stores, false)] : [];
    return entries.length === 1 ? stockResult(entries[0].quantity, entries[0].city) : stockResult(null, directCity);
  }

  function scalar(value) {
    if (typeof value === 'string') return value.trim() || null;
    if (typeof value === 'number' && Number.isFinite(value)) return numberFormat.format(value);
    if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
    return null;
  }

  const factLabels = {
    category: 'Категория', brand: 'Бренд', poleCount: 'Число полюсов',
    ratedCurrentA: 'Номинальный ток, А', ratedVoltageV: 'Номинальное напряжение, В',
    breakingCapacityKA: 'Отключающая способность, кА', mounting: 'Монтаж',
    orderMultiple: 'Кратность заказа'
  };
  function factLabel(field) {
    return typeof field === 'string' ? factLabels[field] || field : '';
  }
  function factValue(field, value, fallback = 'Неизвестно') {
    const displayed = scalar(value);
    if (displayed === null) return fallback;
    return field === 'category' && displayed === 'circuit-breaker' ? 'Автоматический выключатель' : displayed;
  }

  function facts(value) {
    const result = [];
    const add = (label, raw) => {
      const displayed = factValue(label, raw, null);
      if (nonempty(label) && displayed !== null) result.push([factLabel(label), displayed]);
    };
    if (Array.isArray(value)) {
      value.forEach(item => {
        if (!record(item)) return;
        add(item.name || item.label || item.key || item.field, item.value);
      });
    } else if (record(value)) {
      Object.entries(value).forEach(([key, item]) => {
        if (record(item) && own(item, 'value')) add(item.name || item.label || key, item.value);
        else if (record(item)) Object.entries(item).forEach(([name, detail]) => add(key + ' · ' + name, detail));
        else add(key, item);
      });
    }
    return result;
  }

  function orderMultiple(product) {
    if (!record(product)) return null;
    const value = product.facts;
    let raw;
    if (record(value) && own(value, 'orderMultiple')) raw = value.orderMultiple;
    else if (Array.isArray(value)) {
      const entries = value.filter(item => record(item) && (item.key === 'orderMultiple' || item.name === 'orderMultiple' || item.label === 'orderMultiple' || item.field === 'orderMultiple'));
      if (entries.length > 1) return null;
      if (!entries.length) return 1;
      raw = entries[0].value;
    } else return 1;
    const increment = number(raw);
    return increment !== null && increment > 0 ? increment : null;
  }

  function isMultiple(quantity, increment) {
    const count = number(quantity);
    const step = number(increment);
    if (count === null || step === null || count <= 0 || step <= 0) return false;
    const ratio = count / step;
    return Number.isFinite(ratio) && Math.round(ratio) >= 1 && Math.abs(ratio - Math.round(ratio)) <= 1e-8;
  }

  function safeLink(value) {
    if (!nonempty(value) || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
    const raw = value.trim();
    try {
      const base = global.location && global.location.href;
      if (!base) return null;
      const url = new URL(raw, base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      const absolute = /^https?:\/\//i.test(raw);
      if (!absolute && url.origin !== new URL(base).origin) return null;
      return url.href;
    } catch (_) {
      return null;
    }
  }

  // Unlike generic links, resource values must look like a URL or a file path.
  // Plain text such as "сертификат есть" must not become a made-up same-origin URL.
  function resourceLink(value) {
    if (!nonempty(value)) return null;
    const raw = value.trim();
    const explicitUrl = /^https?:\/\//i.test(raw);
    const explicitPath = /^(?:\/(?!\/)|\.{1,2}\/)/.test(raw);
    const relativeFile = /^[^\s:?#]+\.(?:pdf|docx?|xlsx?|jpe?g|png|webp|gif|avif|svg)(?:[?#].*)?$/i.test(raw);
    return explicitUrl || explicitPath || relativeFile ? safeLink(raw) : null;
  }

  function certificateField(value) {
    return typeof value === 'string' && /^(?:certificates?|certificate[_ -]?urls?|сертификаты?|ссылка на сертификат)$/i.test(value.trim());
  }

  function certificates(product) {
    if (!record(product)) return [];
    const result = [];
    const seen = new Set();
    const add = (raw, inheritedName, depth) => {
      if (depth > 6) return;
      if (Array.isArray(raw)) { raw.forEach(item => add(item, inheritedName, depth + 1)); return; }
      if (record(raw)) {
        const name = [raw.name, raw.label, raw.title, inheritedName].find(nonempty);
        for (const key of ['url', 'href', 'fileUrl', 'file_url', 'link', 'value']) {
          if (own(raw, key)) add(raw[key], name, depth + 1);
        }
        return;
      }
      const url = resourceLink(raw);
      if (!url || seen.has(url)) return;
      seen.add(url);
      result.push({ name: nonempty(inheritedName) && !certificateField(inheritedName) ? inheritedName.trim() : 'Сертификат', url });
    };
    add(product.certificates, '', 0);
    if (Array.isArray(product.facts)) {
      product.facts.forEach(item => {
        if (!record(item) || ![item.name, item.label, item.key, item.field].some(certificateField)) return;
        add(item.value, item.name || item.label || '', 0);
      });
    } else if (record(product.facts)) {
      Object.entries(product.facts).forEach(([key, value]) => {
        if (certificateField(key)) add(value, '', 0);
      });
    }
    return result;
  }

  function image(product) {
    if (!record(product)) return null;
    const candidates = [product.imageUrl, product.image, ...(Array.isArray(product.images) ? product.images : [])];
    for (const item of candidates) {
      const url = resourceLink(record(item) ? item.url : item);
      if (url) return url;
    }
    return null;
  }

  function unit(product) {
    if (!record(product)) return '';
    if (nonempty(product.unit)) return product.unit.trim();
    const productFacts = product.facts;
    let raw;
    if (record(productFacts)) raw = productFacts.unit;
    else if (Array.isArray(productFacts)) {
      const matches = productFacts.filter(item => record(item) && [item.key, item.name, item.label, item.field].includes('unit'));
      if (matches.length === 1) raw = matches[0].value;
    }
    if (record(raw)) raw = raw.value;
    return nonempty(raw) ? raw.trim() : '';
  }

  function proposalValid(proposal, now) {
    if (!record(proposal)) return false;
    if (!nonempty(proposal.id) || !nonempty(proposal.productName) || !nonempty(proposal.productArticle) || !nonempty(proposal.city)) return false;
    if (!nonempty(proposal.productId) && !(typeof proposal.productId === 'number' && Number.isFinite(proposal.productId))) return false;
    const quantity = number(proposal.quantity);
    const unitPrice = amount(proposal.unitPrice);
    const totalAmount = amount(proposal.totalAmount);
    if (quantity === null || quantity <= 0 || !unitPrice || !totalAmount || unitPrice.value < 0 || totalAmount.value < 0) return false;
    if (!nonempty(proposal.expiresAt)) return false;
    const expires = Date.parse(proposal.expiresAt);
    const current = now === undefined ? Date.now() : now instanceof Date ? now.getTime() : number(now);
    return Number.isFinite(expires) && current !== null && Number.isFinite(current) && expires > current;
  }

  global.EktView = Object.freeze({ money, cartTotal, stock, stockEntries, cities, facts, factLabel, factValue, certificates, image, unit, orderMultiple, isMultiple, safeLink, proposalValid });
})(window);
