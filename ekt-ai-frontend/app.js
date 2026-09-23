/* Session credentials stay inside the API client; saved views never restore live proposals. */
const api = new window.EktApi();
const view = window.EktView;
const isDemo = window.EKT_DEMO === true;
const saved = new window.EktSavedStore({ mode: isDemo ? 'demo' : 'live' });
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = String(text); return node; };
const state = { ready: false, busy: false, confirming: false, city: '', selection: null, proposal: null, proposalTimer: null, confirmationProposal: null, cart: null, products: new Map(), invalidProposals: new Set() };
const fmt = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 8 }).format(value);
const scrollDown = () => { $('messages').scrollTop = $('messages').scrollHeight; };
const motionTimers = new WeakMap();
let selectedHistoryId = null;
let savedNoticeTimer;
const historyListVersions = new WeakMap();
let shownHistoryVersion = '', shownFavoritesVersion = '';
let recentProducts = [];
function replayMotion(node, className) {
  if (!node || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  clearTimeout(motionTimers.get(node));
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
  motionTimers.set(node, setTimeout(() => node.classList.remove(className), 750));
}

// The hidden select remains the source of city values; the visible control owns interaction.
const cityPickerState = { open: false, activeIndex: 0, search: '', searchAt: 0 };
const cityOptions = () => Array.from($('cityOptions').querySelectorAll('[role="option"]'));
function highlightCity(index) {
  const options = cityOptions(); if (!options.length) return;
  cityPickerState.activeIndex = (index + options.length) % options.length;
  options.forEach((option, i) => option.classList.toggle('is-active', i === cityPickerState.activeIndex));
  $('cityTrigger').setAttribute('aria-activedescendant', options[cityPickerState.activeIndex].id);
  options[cityPickerState.activeIndex].scrollIntoView?.({ block: 'nearest' });
}
function renderCityPicker() {
  const source = Array.from($('activeCity').querySelectorAll('option'));
  const selected = source.find(option => option.value === state.city);
  $('cityValue').textContent = selected?.textContent || 'Все города';
  $('cityOptions').replaceChildren();
  source.forEach((option, index) => {
    const button = el('button', 'city-option'); button.type = 'button'; button.id = 'city-option-' + index;
    button.setAttribute('role', 'option'); button.setAttribute('tabindex', '-1');
    button.setAttribute('aria-selected', String(option.value === state.city)); button.dataset.value = option.value;
    const check = el('span', 'city-option-check', '✓'); check.setAttribute('aria-hidden', 'true');
    button.append(el('span', 'city-option-text', option.textContent), check);
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => chooseCity(option.value);
    $('cityOptions').append(button);
  });
  $('cityMenuHint').textContent = source.length === 1 ? 'Города появятся после поиска товара.' : 'Покажем наличие на складах выбранного города.';
  if (cityPickerState.open) highlightCity(Math.max(0, source.findIndex(option => option.value === state.city)));
}
function positionCityMenu() {
  if (!$('cityTrigger').getBoundingClientRect || !Number.isFinite(window.innerWidth)) return;
  const rect = $('cityTrigger').getBoundingClientRect();
  const width = Math.min(288, window.innerWidth - 24);
  const top = rect.bottom + 10;
  $('cityMenu').style.left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)) + 'px';
  $('cityMenu').style.top = top + 'px';
  $('cityMenu').style.maxHeight = Math.max(60, window.innerHeight - top - 12) + 'px';
}
function closeCityPicker({ restoreFocus = false } = {}) {
  cityPickerState.open = false; cityPickerState.search = '';
  $('cityMenu').hidden = true; $('cityTrigger').setAttribute('aria-expanded', 'false');
  $('cityTrigger').removeAttribute('aria-activedescendant');
  if (restoreFocus && !$('cityTrigger').disabled) $('cityTrigger').focus();
}
function isCompactSidebar() { return Number.isFinite(window.innerWidth) && window.innerWidth <= 980; }
function restoreSidebar() {
  const sidebar = $('sidebar'), dialog = $('sidebarDialog');
  if (dialog.open) return false;
  const moved = sidebar.parentElement === dialog;
  if (moved) document.querySelector('.layout').insertBefore(sidebar, document.querySelector('.chat'));
  $('sidebarToggle').setAttribute('aria-expanded', 'false');
  return moved;
}
function closeSidebar({ restoreFocus = true } = {}) {
  const dialog = $('sidebarDialog');
  if (!dialog.open) return;
  dialog.close();
  restoreSidebar();
  if (restoreFocus && isCompactSidebar()) $('sidebarToggle').focus();
}
function openSidebar() {
  const dialog = $('sidebarDialog');
  if (!isCompactSidebar() || dialog.open) return;
  closeCityPicker();
  dialog.append($('sidebar'));
  $('sidebarToggle').setAttribute('aria-expanded', 'true');
  dialog.showModal();
  $('sidebarClose').focus();
}
function openCityPicker() {
  if ($('cityTrigger').disabled) return;
  cityPickerState.open = true; cityPickerState.search = '';
  $('cityMenu').hidden = false;
  $('cityTrigger').setAttribute('aria-expanded', 'true'); positionCityMenu();
  renderCityPicker();
}
function chooseCity(city) {
  const selected = Array.from($('activeCity').querySelectorAll('option')).find(option => option.value === city);
  if ($('cityTrigger').disabled || !selected) return;
  const changed = state.city !== city;
  selected.selected = true;
  if (changed) $('activeCity').dispatchEvent(new window.Event('change', { bubbles: true }));
  closeCityPicker({ restoreFocus: true });
}

function setBusy(busy, label = 'Подбираем ответ') {
  state.busy = busy;
  document.body.classList.toggle('ui-busy', busy);
  const disabled = busy || !state.ready || state.confirming;
  $('sendButton').disabled = disabled; $('fileInput').disabled = disabled;
  $('newChat').disabled = busy || state.confirming;
  if ($('activeCity')) $('activeCity').disabled = busy || state.confirming;
  $('cityTrigger').disabled = busy || state.confirming;
  if (busy || state.confirming) closeCityPicker();
  $('sendButton').classList.toggle('is-busy', busy);
  document.querySelectorAll('[data-draft]').forEach(button => { button.disabled = disabled; });
  document.querySelectorAll('.draft-variant').forEach(button => { button.disabled = disabled; });
  $('typingIndicator').classList.toggle('hidden', !busy);
  $('typingIndicator').setAttribute('aria-label', label);
  $('typingLabel').textContent = label;
  $('composerStatus').textContent = busy ? label + '…' : state.ready ? isDemo ? 'Демо-каталог · корзина хранится только в этой вкладке' : 'Добавление в корзину — только после вашего подтверждения' : 'Подключение к сервису не установлено';
  $('messages').setAttribute('aria-busy', String(busy));
  syncProposalButtons();
  syncSavedDraftButtons();
}
function safeError(error) {
  return error instanceof window.EktApiError ? error.message : 'Не удалось выполнить действие. Попробуйте ещё раз.';
}
function textValue(value, fallback = 'Не указано') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(item => textValue(item, '')).filter(Boolean).join('; ') || fallback;
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}: ${textValue(v, '—')}`).join('; ') || fallback;
  return fallback;
}
function linkTarget(url) {
  return isDemo && url === '#cart' ? '#cart' : view.safeLink(url);
}
function appendLink(parent, label, url, className = 'message-link') {
  const href = linkTarget(url); if (!href) return;
  const link = el('a', className, label); link.href = href;
  if (isDemo && href === '#cart') link.onclick = event => { event.preventDefault(); openCart(); };
  else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  parent.append(link);
}
function addMessage(role, text, extras = {}) {
  $('welcome').classList.add('hidden');
  const row = el('div', 'message-row ' + role);
  if (role !== 'user') { const avatar = el('div', 'mini-avatar', 'e'); avatar.setAttribute('aria-hidden', 'true'); row.append(avatar); }
  const stack = el('div', 'message-stack'); const label = el('div', 'message-label');
  label.append(el('span', '', role === 'user' ? 'Вы' : 'EKT Ассистент'), el('time', 'message-time', new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })));
  stack.append(label, el('div', 'bubble' + (extras.error ? ' error-bubble' : ''), text));
  if (Array.isArray(extras.products) && extras.products.length) {
    const grid = el('div', 'products-grid'); extras.products.forEach((product, index) => {
      if (product && product.id !== undefined) { const card = productCard(product); card.style.setProperty('--reveal-index', Math.min(index, 5)); grid.append(card); }
    }); stack.append(grid);
  }
  if (Array.isArray(extras.alternatives)) extras.alternatives.forEach(alternative => {
    if (!alternative?.candidate) return;
    const block = el('section', 'alternative-block'); block.append(el('h3', 'alternative-title', 'Вариант замены'), productCard(alternative.candidate));
    if (alternative.details) block.append(el('p', 'reason', textValue(alternative.details)));
    if (Array.isArray(alternative.comparison) && alternative.comparison.length) block.append(comparisonTable(alternative.comparison)); stack.append(block);
  });
  renderWarnings(stack, extras.warnings);
  if (extras.proposal) stack.append(proposalCard(extras.proposal));
  if (extras.cartUrl) appendLink(stack, 'Открыть актуальную корзину ↗', extras.cartUrl);
  if (extras.retry) { const button = el('button', 'small-button retry-button', 'Попробовать снова'); button.type = 'button'; button.onclick = extras.retry; stack.append(button); }
  row.append(stack); $('messages').append(row); scrollDown(); return stack;
}
function renderWarnings(parent, warnings) {
  if (!Array.isArray(warnings) || !warnings.length) return;
  const box = el('div', 'notice'); box.setAttribute('role', 'status');
  warnings.forEach(warning => {
    const text = typeof warning === 'string' ? warning : typeof warning?.message === 'string' ? warning.message : '';
    if (!text) return;
    // Contract warnings are customer-facing; suppress common diagnostic/secret payloads.
    box.append(el('p', '', /traceback|stack trace|authorization|password|api[_ -]?key|bearer\s|basic\s+[a-z\d+/=]+|csrf|access[_ -]?token/i.test(text) ? 'Некоторые данные требуют дополнительной проверки.' : text.slice(0, 1200)));
  });
  if (box.childNodes.length) parent.append(box);
}
function productIllustration(product) {
  const visual = el('div', 'product-visual');
  const placeholder = () => {
    const box = el('div', 'product-placeholder');
    box.innerHTML = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="m24 6 16 9v18l-16 9-16-9V15l16-9Z" stroke="currentColor" stroke-width="1.5"/><path d="m8 15 16 9 16-9M24 24v18M16 10.5l16 9" stroke="currentColor" stroke-width="1.5"/></svg>';
    box.append(el('span', '', 'Нет фото'));
    visual.replaceChildren(box);
  };
  const imageUrl = view.image(product);
  if (!imageUrl) { placeholder(); return visual; }
  const image = el('img', 'product-image');
  image.alt = product.name || 'Фото товара'; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
  image.onerror = placeholder; image.src = imageUrl; visual.append(image);
  return visual;
}
function registerCities(products) {
  const control = $('activeCity'); if (!control) return;
  const known = new Set(Array.from(control.querySelectorAll('option'), option => option.value));
  for (const product of products) for (const city of view.cities(product.stock)) {
    if (known.has(city)) continue;
    const option = el('option', '', city); option.value = city; control.append(option); known.add(city);
  }
  renderCityPicker();
}
function updateStock(card, product) {
  const availability = view.stock(product.stock, state.city);
  const stock = card.querySelector('.stock');
  stock.className = 'stock' + (availability.quantity === 0 ? ' empty' : availability.quantity === null ? ' unknown' : '');
  stock.textContent = availability.label + (availability.quantity !== null && view.unit(product) ? ' ' + view.unit(product) : '');
  const button = card.querySelector('.small-button.add');
  if (button) button.textContent = availability.quantity === 0 ? 'Подобрать замену' : 'Выбрать количество';
  const breakdown = card.querySelector('.stock-breakdown');
  if (!breakdown) return;
  const rows = view.stockEntries(product.stock);
  const summary = el('summary', 'stock-heading', 'Наличие по городам и складам');
  const list = el('div', 'stock-list');
  for (const item of rows) {
    const selected = state.city && item.city.toLocaleLowerCase('ru-RU') === state.city.toLocaleLowerCase('ru-RU');
    const row = el('div', 'stock-row' + (selected ? ' selected' : ''));
    const place = [item.city, item.warehouse].filter(Boolean).join(' · ') || 'Склад без названия';
    const amount = item.quantity === null ? 'Уточняется' : item.quantity === 0 ? 'Нет в наличии' : fmt(item.quantity) + (view.unit(product) ? ' ' + view.unit(product) : '');
    row.append(el('span', 'stock-place', place), el('span', 'stock-amount' + (item.quantity === 0 ? ' empty' : ''), amount));
    list.append(row);
  }
  breakdown.replaceChildren(summary, list); breakdown.classList.toggle('hidden', rows.length === 0);
}
function refreshStock() {
  document.querySelectorAll('.product-card').forEach(card => {
    const product = state.products.get(card.dataset.productId);
    if (product) updateStock(card, product);
  });
}
function productCard(product) {
  state.products.set(String(product.id), product);
  const card = el('article', 'product-card'), main = el('div', 'product-main'), info = el('div', 'product-info');
  card.dataset.productId = String(product.id);
  const toolbar = el('div', 'product-card-toolbar'); toolbar.append(bookmarkButton(product)); card.append(toolbar);
  const category = typeof product.category === 'string' ? product.category : product.category?.name;
  if (category) info.append(el('span', 'product-category', category));
  info.append(el('div', 'product-id', product.article ? 'Арт. ' + product.article : 'Артикул не указан'), el('h3', '', product.name || 'Товар'));
  const price = el('div', 'product-price', view.money(product.price));
  if (view.unit(product)) price.append(el('span', 'product-unit', ' / ' + view.unit(product)));
  info.append(price, el('div', 'stock'));
  main.append(productIllustration(product), info); card.append(main);
  const facts = view.facts(product.facts).filter(([name]) => !/certificate|сертификат|imageUrl|image_url/i.test(name));
  if (facts.length) {
    const quick = el('div', 'product-facts-preview');
    facts.slice(0, 3).forEach(([name, value]) => quick.append(el('span', '', name + ': ' + value)));
    card.append(quick);
  }
  const breakdown = el('details', 'stock-breakdown'); card.append(breakdown);
  const certificates = el('div', 'certificates');
  const documents = view.certificates(product);
  if (documents.length) documents.forEach(document => appendLink(certificates, document.name + ' ↗', document.url, 'certificate-link'));
  else certificates.append(el('span', 'certificate-empty', 'Сертификат не указан'));
  card.append(certificates);
  const specs = el('div', 'specs hidden'); specs.id = 'specs-' + (window.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
  facts.forEach(([name, value]) => { const line = el('div', 'spec-row'); line.append(el('span', '', name), el('span', '', textValue(value))); specs.append(line); });
  if (!facts.length) specs.append(el('p', 'certificate-empty', 'Характеристики не указаны'));
  const source = el('div', 'product-source'); source.append(el('span', '', 'Источник: '));
  if (typeof product.source === 'string' && view.safeLink(product.source) && /^(https?:\/\/|\/)/.test(product.source)) appendLink(source, 'Открыть источник ↗', product.source, 'source-link');
  else if (product.source && typeof product.source === 'object') { source.append(el('span', '', textValue(product.source.name || product.source.label || product.source.updatedAt || '', 'Каталог'))); appendLink(source, 'Открыть источник ↗', product.source.url, 'source-link'); }
  else source.append(el('span', '', typeof product.source === 'string' ? product.source : 'не указан'));
  specs.append(source); appendLink(specs, 'Карточка товара ↗', product.productUrl, 'source-link');
  const actions = el('div', 'product-actions'), details = el('button', 'small-button', 'Характеристики'); details.type = 'button'; details.setAttribute('aria-expanded', 'false'); details.setAttribute('aria-controls', specs.id);
  details.onclick = () => { const expanded = !specs.classList.toggle('hidden'); specs.classList.toggle('specs-reveal', expanded); details.setAttribute('aria-expanded', String(expanded)); details.textContent = expanded ? 'Скрыть характеристики' : 'Характеристики'; };
  const select = el('button', 'small-button add', 'Выбрать количество'); select.type = 'button';
  select.onclick = () => {
    const availability = view.stock(product.stock, state.city);
    if (availability.quantity === 0) sendMessage(`Подбери доступную замену для товара ${product.name}; артикул: ${product.article || product.id}.`);
    else openSelection(product);
  };
  actions.append(details, select); card.append(actions, specs); updateStock(card, product); return card;
}
function comparisonTable(rows) {
  const wrapper = el('div', 'comparison'), table = el('table'); table.append(el('caption', '', 'Сравнение с запрошенным товаром'));
  const thead = el('thead'), heading = el('tr'); ['Параметр', 'Запрошено', 'Предложено', 'Оценка'].forEach(text => { const th = el('th', '', text); th.scope = 'col'; heading.append(th); }); thead.append(heading); table.append(thead);
  const tbody = el('tbody'); rows.forEach(row => {
    const tr = el('tr', row.verdict === 'different' ? 'comparison-difference' : '');
    tr.append(el('th', '', textValue(row.field)), el('td', '', textValue(row.requested, 'Неизвестно')), el('td', '', textValue(row.offered, 'Неизвестно')));
    tr.append(el('td', 'verdict verdict-' + (['match','different','unknown'].includes(row.verdict) ? row.verdict : 'unknown'), { match: 'Совпадает', different: 'Отличается', unknown: 'Неизвестно' }[row.verdict] || 'Неизвестно')); tbody.append(tr);
  }); table.append(tbody); wrapper.append(table); return wrapper;
}
const proposalFields = [ ['id','Предложение'], ['productId','ID товара'], ['productName','Товар'], ['productArticle','Артикул'], ['quantity','Количество'], ['city','Город'], ['unitPrice','Цена за единицу'], ['totalAmount','Итого'], ['expiresAt','Действует до'] ];
function proposalDetails(proposal) {
  const list = el('dl', 'proposal-summary');
  proposalFields.forEach(([key, label]) => { list.append(el('dt', '', label), el('dd', key === 'totalAmount' ? 'proposal-total' : '', ['unitPrice','totalAmount'].includes(key) ? view.money(proposal[key]) : textValue(proposal[key], 'Не указано'))); });
  return list;
}
function isCurrentProposal(proposal) {
  if (!proposal || state.invalidProposals.has(String(proposal.id)) || state.proposal?.id !== proposal.id || !view.proposalValid(proposal)) return false;
  const product = state.products.get(String(proposal.productId));
  if (!product) return true;
  const multiple = view.orderMultiple(product); return multiple !== null && view.isMultiple(Number(proposal.quantity), multiple);
}
function proposalCard(proposal) {
  const card = el('section', 'proposal-card'); card.append(el('h3', '', 'Предложение для корзины'), proposalDetails(proposal));
  const button = el('button', 'primary-button proposal-open', 'Проверить и подтвердить'); button.type = 'button'; button.dataset.proposalId = String(proposal.id); button.disabled = !isCurrentProposal(proposal);
  button.onclick = () => openConfirmation(proposal); card.append(button);
  if (!isCurrentProposal(proposal)) card.append(el('p', 'error', 'Предложение неполное или недействительно. Запросите новое.'));
  return card;
}
function syncProposalButtons() {
  document.querySelectorAll('.proposal-open').forEach(button => { button.disabled = state.busy || state.confirming || !state.proposal || button.dataset.proposalId !== String(state.proposal.id) || !isCurrentProposal(state.proposal); });
  $('confirmAdd').disabled = state.busy || state.confirming || !isCurrentProposal(state.confirmationProposal) || state.confirmationProposal?.id !== state.proposal?.id;
}
function invalidateProposal(message) {
  const explain = message && state.proposal && !state.invalidProposals.has(String(state.proposal.id));
  if (state.proposal) state.invalidProposals.add(String(state.proposal.id));
  if (state.proposalTimer) clearTimeout(state.proposalTimer); state.proposalTimer = null;
  syncProposalButtons();
  if (explain) document.querySelectorAll('.proposal-open').forEach(button => {
    if (button.dataset.proposalId !== String(state.proposal.id)) return;
    const card = button.closest('.proposal-card');
    const notice = card.querySelector('.proposal-notice') || el('p', 'error proposal-notice');
    notice.setAttribute('role', 'status'); notice.textContent = message; card.append(notice);
  });
  if ($('confirmDialog').open && message) { $('confirmError').textContent = message; $('confirmError').classList.remove('hidden'); }
}
function receiveProposal(proposal) {
  invalidateProposal(); state.proposal = proposal && typeof proposal === 'object' ? proposal : null;
  syncProposalButtons();
  if (isCurrentProposal(state.proposal)) {
    const delay = new Date(state.proposal.expiresAt).getTime() - Date.now();
    state.proposalTimer = setTimeout(() => invalidateProposal('Срок предложения истёк. Запросите новое предложение.'), Math.min(delay, 2147483647));
  }
}
function prepareDraft(prefix) {
  const input = $('messageInput');
  if (!state.ready || state.busy || state.confirming || input.readOnly) return;
  let content = input.value;
  const previous = Array.from(document.querySelectorAll('[data-draft]'), button => button.dataset.draft.trimEnd())
    .find(value => content.startsWith(value));
  if (previous) content = content.slice(previous.length).replace(/^[ \t]*/, '');
  input.value = prefix + content;
  input.focus();
  input.setSelectionRange?.(input.value.length, input.value.length);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  showDraftVariants(prefix);
}
function showDraftVariants(prefix) {
  const analog = prefix.startsWith('Подобрать аналог');
  const search = prefix.startsWith('Найти товар') || prefix.startsWith('Помогите подобрать');
  $('draftVariants').classList.toggle('hidden', !analog && !search);
  if (!analog && !search) return;
  $('draftVariantsTitle').textContent = analog ? 'Для чего нужна замена?' : 'Что хотите найти?';
  $('draftVariantsHint').textContent = 'Выберите вариант, допишите детали и отправьте запрос.';
  const options = analog ? [
    ['По артикулу', 'артикул '], ['По характеристикам', 'товар с характеристиками: ']
  ] : [
    ['Автоматы и защита', 'автоматический выключатель, параметры: '],
    ['Кабели и провода', 'кабель, сечение и длина: '],
    ['Освещение', 'лампа, цоколь и мощность: ']
  ];
  for (const product of recentProducts.slice(0, 3)) options.push([
    (analog ? 'Замена: ' : 'Найти: ') + product.name,
    `${product.name}${product.article ? '; артикул ' + product.article : ''}${analog ? '; важные характеристики: ' : '; количество и город: '}`
  ]);
  $('draftVariantOptions').replaceChildren();
  for (const [label, detail] of options) {
    const button = el('button', 'draft-variant', label); button.type = 'button';
    button.onclick = () => {
      if (!state.ready || state.busy || state.confirming || $('messageInput').readOnly) return;
      const input = $('messageInput');
      const content = input.value.startsWith(prefix.trimEnd()) ? input.value.slice(prefix.trimEnd().length).trim() : input.value.trim();
      input.value = !content ? prefix + detail : input.value.includes(detail.trim()) ? input.value : input.value.trimEnd() + '\n' + detail;
      $('draftVariants').classList.add('hidden'); input.focus(); input.setSelectionRange?.(input.value.length, input.value.length);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    };
    $('draftVariantOptions').append(button);
  }
}
async function sendMessage(text, { includeCity = true } = {}) {
  if (!state.ready || state.busy || state.confirming || !text.trim()) return;
  const explicitCity = text.match(/^\s*Город для проверки наличия:\s*([^\n]+)/im)?.[1]?.replace(/\.$/, '').trim();
  const message = text.trim() + (includeCity && state.city && !explicitCity ? '\nГород для проверки наличия: ' + state.city + '.' : '');
  let historyId = null;
  try { historyId = saved.begin(text.trim(), explicitCity || state.city); }
  catch (_) { savedNotice('Этот запрос не удалось сохранить в истории.'); }
  renderSavedPanels();
  addMessage('user', message); $('messageInput').value = ''; $('attachment').classList.add('hidden');
  $('draftVariants').classList.add('hidden');
  invalidateProposal(); setBusy(true);
  try {
    const response = await api.chat(message);
    if (!response || typeof response.reply !== 'string') throw new Error('Invalid chat response');
    const products = [...response.products, ...response.alternatives.map(x => x?.candidate).filter(Boolean)];
    recentProducts = Array.from(new Map(products.filter(item => item?.id !== undefined && item.name).map(item => [String(item.id), item])).values());
    for (const product of products) if (product?.id !== undefined) state.products.set(String(product.id), product);
    registerCities(products);
    receiveProposal(response.proposal);
    addMessage('assistant', response.reply, response);
    saved.finish(historyId, response);
  } catch (error) {
    const explanation = safeError(error);
    saved.finish(historyId, { reply: explanation }, { error: true });
    addMessage('assistant', explanation, { error: true, retry: () => sendMessage(message, { includeCity: false }) });
  }
  finally { renderSavedPanels(); setBusy(false); }
}
function openSelection(product) {
  if (!state.ready || state.busy || state.confirming) return;
  state.selection = product;
  $('selectionProduct').textContent = `${product.name || 'Товар'} · ${product.article || product.id}`;
  const multiple = view.orderMultiple(product);
  $('quantityInput').value = multiple ?? ''; $('quantityInput').step = multiple ?? 'any'; $('quantityInput').min = multiple ?? '0';
  $('cityInput').value = state.city || view.stock(product.stock).city || '';
  $('multipleHint').textContent = multiple === null ? 'Кратность заказа не распознана. Уточните её в чате.' : `Шаг заказа: ${fmt(multiple)}${view.unit(product) ? ' ' + view.unit(product) : ''}. Наличие и цена будут проверены перед подтверждением.`;
  $('requestProposal').disabled = multiple === null; $('selectionError').classList.add('hidden'); $('selectionDialog').showModal();
}
async function requestProposal() {
  if (!state.selection || state.busy) return;
  const product = state.selection, quantity = Number($('quantityInput').value), multiple = view.orderMultiple(product), city = $('cityInput').value.trim();
  if (!Number.isFinite(quantity) || quantity <= 0 || !multiple || !view.isMultiple(quantity,multiple) || !city) { $('selectionError').textContent = !city ? 'Укажите город для проверки остатка.' : `Количество должно быть положительным и кратным ${multiple ? fmt(multiple) : 'указанному значению'}.`; $('selectionError').classList.remove('hidden'); return; }
  const available = view.stock(product.stock, city);
  if (available.quantity !== null && quantity > available.quantity) {
    $('selectionError').textContent = `В городе ${city} доступно ${fmt(available.quantity)}${view.unit(product) ? ' ' + view.unit(product) : ''}. Уменьшите количество или выберите другой город.`;
    $('selectionError').classList.remove('hidden'); return;
  }
  $('selectionDialog').close();
  await sendMessage(`Подготовь предложение для добавления в корзину. Товар: ${product.name}; артикул: ${product.article || 'не указан'}; ID: ${product.id}; количество: ${quantity}; город: ${city}.`, { includeCity: false });
}
function openConfirmation(proposal) {
  if (state.busy || state.confirming) return;
  state.confirmationProposal = proposal;
  $('proposalSummary').replaceChildren(proposalDetails(proposal));
  $('confirmError').classList.add('hidden'); $('confirmDialog').showModal();
  if (!isCurrentProposal(proposal)) { $('confirmError').textContent = 'Предложение больше недействительно. Запросите новое в чате.'; $('confirmError').classList.remove('hidden'); }
  syncProposalButtons();
}
async function confirmProposal() {
  if (state.busy || state.confirming || !state.ready || !isCurrentProposal(state.confirmationProposal) || !$('confirmDialog').open) return;
  const proposal = state.confirmationProposal; state.confirming = true; setBusy(false); syncProposalButtons();
  $('confirmAdd').textContent = 'Добавляем…'; $('confirmError').classList.add('hidden');
  try {
    const response = await api.confirm(proposal.id);
    acceptCart(response.cart); invalidateProposal(); $('confirmDialog').close();
    if (!response.alreadyConfirmed) replayMotion($('cartTrigger'), 'cart-updated');
    addMessage('assistant', response.alreadyConfirmed ? 'Это предложение уже было подтверждено. Откройте актуальную корзину.' : 'Товар добавлен. Откройте актуальную корзину для проверки и оформления.', { cartUrl: response.cart.cartUrl });
  } catch (error) {
    if (error.status === 409 || error.status === 404 || error.ambiguous) invalidateProposal();
    $('confirmError').textContent = safeError(error); $('confirmError').classList.remove('hidden');
    if (error.ambiguous) { const link = linkTarget(state.cart?.cartUrl); if (link) appendLink($('confirmError'), 'Проверить корзину ↗', link); }
  } finally { state.confirming = false; $('confirmAdd').textContent = 'Да, добавить в корзину'; setBusy(false); syncProposalButtons(); }
}
function acceptCart(cart) {
  if (!cart || !Array.isArray(cart.items) || !Number.isSafeInteger(cart.totalMinor) || cart.totalMinor < 0 || !linkTarget(cart.cartUrl)) throw new Error('Invalid cart');
  state.cart = cart; $('cartCount').textContent = cart.items.length;
}
function renderCart() {
  const container = $('cartContents'); container.replaceChildren();
  if (!state.cart) return;
  if (!state.cart.items.length) container.append(el('p','empty-cart','Найдите товар и подтвердите добавление, чтобы он появился здесь.'));
  state.cart.items.forEach(item => {
    const row = el('div','cart-item'), description = el('div');
    description.append(el('strong','',item.productName || item.name || item.product?.name || item.productArticle || item.article || 'Товар'), el('span','',`Количество: ${textValue(item.quantity)}${item.unit ? ' ' + item.unit : ''}`));
    if (item.city) description.append(el('span','',item.city));
    const total = Number.isSafeInteger(item.totalMinor) ? view.cartTotal(item.totalMinor) : view.money(item.totalAmount);
    row.append(description,el('strong','',total)); container.append(row);
  });
  const total = el('div','cart-total'); total.append(el('span','','Итого'),el('span','',view.cartTotal(state.cart.totalMinor))); container.append(total);
  $('checkoutLink').href = linkTarget(state.cart.cartUrl); $('checkoutLink').classList.remove('hidden');
  $('cartDisclaimer').textContent = isDemo ? 'Это демонстрационная корзина. Реальный заказ не создаётся; после обновления страницы она очистится.' : 'Состав и сумма получены от сервера. Оформление продолжится по ссылке на корзину.';
  if (isDemo) { $('checkoutLink').textContent = 'Продолжить подбор'; $('checkoutLink').removeAttribute('target'); $('checkoutLink').onclick = event => { event.preventDefault(); $('cartDialog').close(); $('messageInput').focus(); }; }
}
async function openCart() {
  if (!state.ready || state.confirming) return;
  $('cartContents').replaceChildren(el('p','empty-cart','Обновляем корзину…')); $('checkoutLink').classList.add('hidden');
  if (!$('cartDialog').open) $('cartDialog').showModal();
  try { acceptCart(await api.cart()); renderCart(); }
  catch (error) { $('cartContents').replaceChildren(el('p','error',safeError(error))); }
}
async function uploadAttachment(file) {
  if (!file || !state.ready || state.busy || state.confirming) return;
  setBusy(true,'Распознаём документ');
  try {
    const response = await api.attachment(file);
    if (!response || !Array.isArray(response.items) || !Array.isArray(response.uncertainties)) throw new Error('Invalid extraction');
    const lines = response.items.map(item => {
      const name = [item.article, item.name].filter(value => typeof value === 'string' && value.trim()).join(' — ');
      if (!name) return null;
      const quantity = typeof item.quantity === 'number' || typeof item.quantity === 'string' ? `; количество: ${item.quantity}${item.unit ? ' ' + item.unit : ''}` : '';
      return `${item.source_row !== undefined ? 'Строка ' + item.source_row + ': ' : ''}${name}${quantity}`;
    }).filter(Boolean);
    $('attachment').replaceChildren(el('strong','','Проверьте распознанные позиции перед отправкой'));
    if (lines.length) $('messageInput').value = [$('messageInput').value.trim(),lines.join('\n')].filter(Boolean).join('\n');
    else $('attachment').append(el('p','','Позиции не распознаны. Введите название или артикул вручную.'));
    const uncertainItems = response.items.filter(item => item.uncertainty && item.uncertainty !== 'none');
    uncertainItems.forEach(item => $('attachment').append(el('p','','Требует проверки: ' + textValue(item.article || item.name || item.source_row) + ' — ' + textValue(item.uncertainty))));
    if (response.uncertainties.length) $('attachment').append(el('p','','Неоднозначности: ' + textValue(response.uncertainties)));
    $('attachment').classList.remove('hidden'); $('messageInput').focus();
  } catch (error) { addMessage('assistant',safeError(error),{error:true}); }
  finally { $('fileInput').value = ''; setBusy(false); }
}

// Local snapshots are rendered separately from the live catalog and cart state.
function savedDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
}
function savedNotice(message) {
  clearTimeout(savedNoticeTimer);
  $('savedNotice').textContent = message;
  $('savedNotice').classList.remove('hidden');
  savedNoticeTimer = setTimeout(() => $('savedNotice').classList.add('hidden'), 5500);
}
function syncSavedDraftButtons() {
  const disabled = !state.ready || state.busy || state.confirming || $('messageInput').readOnly;
  document.querySelectorAll('[data-saved-draft]').forEach(button => { button.disabled = Boolean(disabled); });
  $('reuseHistory').disabled = Boolean(disabled || !selectedHistoryId);
}
function fillSavedDraft(text, { city = '' } = {}) {
  if (!state.ready || state.busy || state.confirming || $('messageInput').readOnly) return;
  const input = $('messageInput'), query = String(text).trim();
  if (!query) return;
  if (city && city !== state.city) {
    if (!Array.from($('activeCity').querySelectorAll('option')).some(option => option.value === city)) {
      const option = el('option', '', city); option.value = city; $('activeCity').append(option);
    }
    chooseCity(city);
  }
  input.value = input.value.trim() && input.value.trim() !== query ? input.value.trimEnd() + '\n\n' + query : query;
  ['historyDialog', 'historyListDialog', 'favoritesDialog'].forEach(id => { if ($(id).open) $(id).close(); });
  input.focus(); input.setSelectionRange?.(input.value.length, input.value.length);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  savedNotice('Запрос в поле ввода. Проверьте его и нажмите «Отправить».');
}
function updateBookmark(button) {
  const active = saved.hasFavorite(button.dataset.bookmarkId);
  button.setAttribute('aria-pressed', String(active));
  button.setAttribute('aria-label', (active ? 'Убрать из избранного: ' : 'Сохранить в избранное: ') + button.dataset.productName);
  button.title = active ? 'Убрать из избранного' : 'Сохранить в избранное';
  button.querySelector('.bookmark-label').textContent = active ? 'Сохранено' : 'Сохранить';
}
function bookmarkButton(product) {
  const button = el('button', 'bookmark-button'); button.type = 'button';
  button.dataset.bookmarkId = String(product.id); button.dataset.productName = product.name || 'Товар';
  button.innerHTML = '<svg class="icon" width="18" height="18" aria-hidden="true"><use href="#i-bookmark"/></svg><span class="bookmark-label"></span>';
  updateBookmark(button);
  button.onclick = () => {
    const savedDialog = button.closest('#favoritesDialog, #historyDialog');
    try {
      const active = saved.toggleFavorite(product);
      renderSavedPanels();
      const message = active ? 'Товар сохранён в избранное.' : 'Товар убран из избранного.';
      if ($('favoritesDialog').open) $('favoritesDialogStatus').textContent = message;
      else if ($('historyDialog').open) $('historyDialogStatus').textContent = message;
      else savedNotice(message);
      if (savedDialog) {
        const replacement = Array.from(savedDialog.querySelectorAll('[data-bookmark-id]')).find(item => item.dataset.bookmarkId === String(product.id));
        (replacement || savedDialog.querySelector('button')).focus();
      }
    } catch (error) {
      const message = error.message || 'Не удалось сохранить товар.';
      if ($('favoritesDialog').open) $('favoritesDialogStatus').textContent = message;
      else if ($('historyDialog').open) $('historyDialogStatus').textContent = message;
      else savedNotice(message);
    }
  };
  return button;
}
function archivedProduct(product, at, city = '') {
  const card = el('article', 'saved-product'); card.dataset.savedProductId = String(product.id);
  const head = el('div', 'saved-product-head');
  head.append(el('h3', 'saved-product-name', product.name || 'Товар'), bookmarkButton(product)); card.append(head);
  card.append(el('p', 'saved-product-meta', 'Артикул: ' + (product.article || 'не указан')));
  card.append(el('div', 'saved-product-price', 'Цена в сохранённом ответе: ' + view.money(product.price)));
  card.append(el('p', 'saved-product-meta', 'Остаток в сохранённом ответе: ' + view.stock(product.stock, city).label));
  card.append(el('p', 'saved-product-meta', 'Сохранено ' + savedDate(at) + ' · цена и наличие могли измениться'));
  const facts = view.facts(product.facts).filter(([name]) => !/certificate|сертификат|imageUrl|image_url/i.test(name));
  if (facts.length) {
    const details = el('details', 'saved-product-details'); details.append(el('summary', '', 'Сохранённые характеристики'));
    facts.forEach(([name, value]) => { const line = el('div', 'spec-row'); line.append(el('span', '', name), el('span', '', textValue(value))); details.append(line); });
    card.append(details);
  }
  const actions = el('div', 'saved-product-actions');
  const refresh = el('button', 'secondary-button', 'Проверить цену и наличие'); refresh.type = 'button'; refresh.dataset.savedDraft = '';
  refresh.onclick = () => fillSavedDraft(`Проверь актуальную цену и наличие: ${product.name || 'Товар'}; артикул ${product.article || 'не указан'}; код товара ${product.id}.`);
  actions.append(refresh); appendLink(actions, 'Карточка товара ↗', product.productUrl, 'source-link'); card.append(actions);
  return card;
}
function removeHistory(id) {
  saved.removeHistory(id);
  if (selectedHistoryId === id) { selectedHistoryId = null; if ($('historyDialog').open) $('historyDialog').close(); }
  renderSavedPanels(); savedNotice('Запрос удалён из истории.');
}
function historyRows(container, entries) {
  const version = JSON.stringify(entries.map(({ id, title, createdAt, status }) => ({ id, title, createdAt, status })));
  if (historyListVersions.get(container) === version) return;
  const focused = document.activeElement;
  const focusedRow = container.contains(focused) ? focused.closest?.('.history-entry') : null;
  const focusedId = focusedRow?.dataset.historyId;
  const focusSelector = focused?.classList?.contains('history-delete') ? '.history-delete' : '.history-open';
  historyListVersions.set(container, version);
  container.replaceChildren();
  entries.forEach(entry => {
    const row = el('div', 'history-entry'); row.dataset.historyId = entry.id;
    const open = el('button', 'history-open'); open.type = 'button'; open.setAttribute('aria-haspopup', 'dialog'); open.title = entry.title;
    const suffix = { pending: ' · Ожидаем ответ', interrupted: ' · Без ответа', error: ' · Ошибка запроса' }[entry.status] || '';
    open.append(el('span', 'history-entry-title', entry.title), el('span', 'history-entry-meta', savedDate(entry.createdAt) + suffix));
    open.onclick = () => openHistory(entry.id);
    const remove = el('button', 'history-delete'); remove.type = 'button'; remove.title = 'Удалить из истории'; remove.setAttribute('aria-label', 'Удалить запрос: ' + entry.title);
    remove.innerHTML = '<svg class="icon" width="16" height="16" aria-hidden="true"><use href="#i-trash"/></svg>';
    remove.onclick = () => {
      const nextId = entries[entries.indexOf(entry) + 1]?.id || entries[entries.indexOf(entry) - 1]?.id;
      removeHistory(entry.id);
      const next = Array.from(container.querySelectorAll('.history-entry')).find(item => item.dataset.historyId === nextId);
      (next?.querySelector('.history-open') || (container.id === 'allHistoryList' ? $('historyListTitle') : $('allHistoryTrigger'))).focus();
    };
    row.append(open, remove); container.append(row);
  });
  if (focusedId) {
    const row = Array.from(container.children).find(item => item.dataset.historyId === focusedId);
    (row?.querySelector(focusSelector) || container.querySelector('.history-open') || $('historyListTitle')).focus();
  }
}
function renderHistoryRecord(entry) {
  const version = JSON.stringify(entry);
  if (shownHistoryVersion === version) { syncSavedDraftButtons(); return; }
  shownHistoryVersion = version;
  $('historyTitle').textContent = entry.title;
  const body = $('historyContents'); body.replaceChildren();
  const user = el('section', 'archive-message'); user.append(el('div', 'archive-role', 'Вы'), el('p', 'bubble', entry.query));
  if (entry.city) user.append(el('p', 'saved-product-meta', 'Город: ' + entry.city));
  user.append(el('time', 'archive-time', savedDate(entry.createdAt))); body.append(user);
  const reply = el('section', 'archive-message'); reply.append(el('div', 'archive-role', 'EKT Ассистент'));
  if (entry.reply) reply.append(el('p', 'bubble' + (entry.status === 'error' ? ' error-bubble' : ''), entry.reply));
  else reply.append(el('p', 'archive-status', entry.status === 'pending' ? 'Ответ ещё загружается.' : 'Ответ не был сохранён. Можно вставить запрос в поле и отправить его снова.'));
  entry.products.forEach(product => reply.append(archivedProduct(product, entry.createdAt, entry.city)));
  entry.alternatives.forEach(alternative => {
    const block = el('section', 'saved-alternative'); block.append(el('h3', 'alternative-title', 'Вариант замены'), archivedProduct(alternative.candidate, entry.createdAt, entry.city));
    if (alternative.details) block.append(el('p', 'reason', textValue(alternative.details)));
    if (alternative.comparison?.length) block.append(comparisonTable(alternative.comparison)); reply.append(block);
  });
  renderWarnings(reply, entry.warnings);
  if (entry.proposal) {
    const proposal = el('section', 'proposal-card archive-proposal');
    proposal.append(el('h3', '', 'Предложение на момент запроса'), proposalDetails(entry.proposal), el('p', 'stock-hint', 'Сохранено для просмотра. Для покупки запросите новое предложение.'));
    reply.append(proposal);
  }
  body.append(reply); syncSavedDraftButtons();
}
function openHistory(id) {
  if (state.confirming) return;
  const entry = saved.history().find(item => item.id === id); if (!entry) return;
  if ($('historyListDialog').open) $('historyListDialog').close();
  selectedHistoryId = id; $('historyDialogStatus').textContent = ''; renderHistoryRecord(entry);
  if (!$('historyDialog').open) $('historyDialog').showModal();
}
function renderFavorites() {
  const container = $('favoritesContents');
  const entries = saved.favorites();
  const version = JSON.stringify(entries);
  if (shownFavoritesVersion === version) { syncSavedDraftButtons(); return; }
  shownFavoritesVersion = version;
  const expanded = Array.from(container.querySelectorAll('.saved-product-details[open]')).map(item => item.closest('.saved-product').dataset.savedProductId);
  const focused = document.activeElement;
  const focusedId = container.contains(focused) && focused.closest?.('.saved-product')?.dataset.savedProductId;
  const focusSelector = focused?.classList?.contains('bookmark-button') ? '.bookmark-button' : '[data-saved-draft]';
  container.replaceChildren();
  if (!entries.length) container.append(el('p', 'saved-empty', 'Здесь будут товары, которые вы отметите закладкой. Найдите товар и нажмите «Сохранить» на карточке.'));
  else entries.forEach(entry => container.append(archivedProduct(entry.product, entry.savedAt)));
  for (const card of container.querySelectorAll('.saved-product')) if (expanded.includes(card.dataset.savedProductId)) card.querySelector('details')?.setAttribute('open', '');
  if (focusedId) {
    const card = Array.from(container.children).find(item => item.dataset.savedProductId === focusedId);
    (card?.querySelector(focusSelector) || container.querySelector('button') || $('favoritesTitle')).focus();
  }
  syncSavedDraftButtons();
}
function renderSavedPanels() {
  const entries = saved.history(), count = saved.favorites().length;
  historyRows($('historyList'), entries.slice(0, 5));
  $('historyEmpty').classList.toggle('hidden', entries.length > 0);
  historyRows($('allHistoryList'), entries);
  if (!entries.length && !$('allHistoryList').children.length) $('allHistoryList').append(el('p', 'saved-empty', 'Ваши запросы появятся здесь после отправки сообщения.'));
  $('favoritesCount').textContent = String(count); $('mobileFavoritesCount').textContent = String(count);
  const persistent = saved.status().persistent;
  const fallback = 'Хранение в браузере недоступно. Пока сохраняем только в этой вкладке.';
  $('savedStorageHint').textContent = persistent ? 'Сохраняется в этом браузере' : fallback;
  $('mobileStorageHint').textContent = fallback;
  $('mobileStorageHint').classList.toggle('hidden', persistent);
  $('historyListDescription').textContent = persistent ? 'История хранится только в этом браузере.' : fallback;
  $('favoritesDescription').textContent = 'Сохранённые варианты. Проверьте цену и наличие перед покупкой.' + (persistent ? '' : ' ' + fallback);
  document.querySelectorAll('[data-bookmark-id]').forEach(updateBookmark);
  if ($('favoritesDialog').open) renderFavorites();
  if ($('historyDialog').open && selectedHistoryId) {
    const record = entries.find(item => item.id === selectedHistoryId);
    if (record) renderHistoryRecord(record);
    else { selectedHistoryId = null; $('historyDialog').close(); }
  }
  syncSavedDraftButtons();
}
function openHistoryList() {
  if (state.confirming) return;
  renderSavedPanels(); if (!$('historyListDialog').open) $('historyListDialog').showModal();
}
function openFavorites() {
  if (state.confirming) return;
  $('favoritesDialogStatus').textContent = ''; renderFavorites(); if (!$('favoritesDialog').open) $('favoritesDialog').showModal();
}
async function initialize() {
  if (state.busy || state.ready) return;
  if (location.protocol === 'file:' && !isDemo) {
    setBusy(false);
    $('connectionLabel').textContent = 'Предпросмотр';
    $('composerStatus').textContent = 'Предпросмотр: для чата и корзины откройте страницу на сервере';
    $('messageInput').placeholder = 'Чат заработает после подключения сервера';
    $('messageInput').readOnly = true;
    $('cartTrigger').disabled = true;
    return;
  }
  setBusy(true,'Подключаемся');
  try {
    const session = await api.session(); acceptCart(session.cart); state.ready = true;
    $('connectionLabel').textContent = isDemo ? 'Демо-каталог' : 'Подключено';
  } catch (error) { $('connectionLabel').textContent = 'Нет подключения'; addMessage('assistant',safeError(error),{error:true,retry:initialize}); }
  finally { setBusy(false); document.querySelector('.chat-status').classList.toggle('connected',state.ready); }
}
$('chatForm').addEventListener('submit',event=>{ event.preventDefault(); sendMessage($('messageInput').value); });
$('messageInput').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sendMessage($('messageInput').value);}});
document.querySelectorAll('[data-draft]').forEach(button=>button.onclick=()=>prepareDraft(button.dataset.draft));
$('closeDraftVariants').onclick = () => { $('draftVariants').classList.add('hidden'); $('messageInput').focus(); };
$('newChat').onclick=()=>{if(!state.busy&&!state.confirming)$('messageInput').focus();};
$('fileInput').addEventListener('change',event=>uploadAttachment(event.target.files?.[0]));
$('requestProposal').onclick=requestProposal;
$('confirmAdd').onclick=confirmProposal;
$('cartTrigger').onclick=openCart;
$('sidebarToggle').onclick = () => $('sidebarDialog').open ? closeSidebar() : openSidebar();
$('sidebarClose').onclick = () => closeSidebar();
$('sidebarDialog').addEventListener('cancel', event => { event.preventDefault(); closeSidebar(); });
$('sidebarDialog').addEventListener('close', () => {
  if (restoreSidebar() && isCompactSidebar()) $('sidebarToggle').focus();
});
$('sidebar').addEventListener('click', event => {
  if (event.target.closest?.('[data-draft], #newChat, #favoritesTrigger, #allHistoryTrigger, .history-open')) closeSidebar();
}, true);
window.addEventListener('resize', () => {
  if (isCompactSidebar()) {
    if (!$('sidebarDialog').open && $('sidebar').contains(document.activeElement)) $('sidebarToggle').focus();
    return;
  }
  if (!$('sidebarDialog').open) {
    if (document.activeElement === $('sidebarToggle')) $('sidebar').querySelector('button:not(.sidebar-close):not([disabled])')?.focus();
    return;
  }
  const focusedInside = $('sidebarDialog').contains(document.activeElement);
  closeSidebar({ restoreFocus: false });
  if (focusedInside) $('sidebar').querySelector('button:not(.sidebar-close):not([disabled])')?.focus();
});
$('favoritesTrigger').onclick = openFavorites;
$('mobileFavoritesTrigger').onclick = openFavorites;
$('allHistoryTrigger').onclick = openHistoryList;
$('mobileHistoryTrigger').onclick = openHistoryList;
$('reuseHistory').onclick = () => {
  const entry = saved.history().find(item => item.id === selectedHistoryId);
  if (entry) fillSavedDraft(entry.query + (entry.city && !/^\s*Город для проверки наличия:/im.test(entry.query) ? '\nГород для проверки наличия: ' + entry.city + '.' : ''), { city: entry.city });
};
$('deleteHistory').onclick = () => { if (selectedHistoryId) removeHistory(selectedHistoryId); };
window.addEventListener('storage', event => {
  if (event.key !== saved.key && event.key !== null) return;
  saved.reload(); renderSavedPanels();
});
if ($('activeCity')) $('activeCity').addEventListener('change', () => {
  state.city = $('activeCity').value || '';
  invalidateProposal('Город изменён. Запросите новое предложение для выбранного города.');
  refreshStock();
  renderCityPicker();
});
$('cityTrigger').onclick = () => cityPickerState.open ? closeCityPicker() : openCityPicker();
$('cityTrigger').addEventListener('keydown', event => {
  if ($('cityTrigger').disabled || event.isComposing) return;
  if (event.key === 'Escape') { event.preventDefault(); closeCityPicker(); return; }
  if (event.key === 'Tab') { closeCityPicker(); return; }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!cityPickerState.open) { openCityPicker(); if (event.key === 'ArrowUp') highlightCity(cityOptions().length - 1); }
    else highlightCity(cityPickerState.activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
    return;
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault(); if (!cityPickerState.open) openCityPicker();
    highlightCity(event.key === 'Home' ? 0 : cityOptions().length - 1); return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (cityPickerState.open) chooseCity(cityOptions()[cityPickerState.activeIndex]?.dataset.value);
    else openCityPicker();
    return;
  }
  if (event.key?.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault(); if (!cityPickerState.open) openCityPicker();
    const now = Date.now();
    cityPickerState.search = (now - cityPickerState.searchAt < 700 ? cityPickerState.search : '') + event.key.toLocaleLowerCase('ru-RU');
    cityPickerState.searchAt = now;
    const index = cityOptions().findIndex(option => option.textContent.toLocaleLowerCase('ru-RU').startsWith(cityPickerState.search));
    if (index >= 0) highlightCity(index);
  }
});
document.addEventListener('click', event => {
  if (cityPickerState.open && !$('cityPicker').contains(event.target)) closeCityPicker();
});
$('cityPicker').addEventListener('focusout', event => {
  if (!$('cityPicker').contains(event.relatedTarget)) closeCityPicker();
});
window.addEventListener('resize', () => { if (cityPickerState.open) positionCityMenu(); });
$('decreaseQty').onclick=()=>{const m=view.orderMultiple(state.selection);if(m)$('quantityInput').value=Math.max(m,Math.round((Number($('quantityInput').value)-m)*1e8)/1e8);};
$('increaseQty').onclick=()=>{const m=view.orderMultiple(state.selection);if(m)$('quantityInput').value=Math.round((Number($('quantityInput').value)+m)*1e8)/1e8;};
function closeDialog(dialog){if(dialog.id==='confirmDialog'&&state.confirming)return;if(dialog.id==='sidebarDialog'){closeSidebar();return;}dialog.close();}
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>closeDialog($(button.dataset.close)));
document.querySelectorAll('dialog').forEach(dialog=>{dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeDialog(dialog);});});
$('confirmDialog').addEventListener('cancel',event=>{if(state.confirming)event.preventDefault();});
$('confirmDialog').addEventListener('close',()=>{state.confirmationProposal=null;syncProposalButtons();});
renderCityPicker();
renderSavedPanels();
initialize();
