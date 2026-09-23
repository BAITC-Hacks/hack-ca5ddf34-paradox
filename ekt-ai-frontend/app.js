/* UI state contains no session identifier, chat history payload, or API credentials. */
const api = new window.EktApi();
const view = window.EktView;
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = String(text); return node; };
const state = { ready: false, busy: false, confirming: false, selection: null, proposal: null, proposalTimer: null, confirmationProposal: null, cart: null, products: new Map(), invalidProposals: new Set() };
const fmt = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 8 }).format(value);
const scrollDown = () => { $('messages').scrollTop = $('messages').scrollHeight; };

function setBusy(busy, label = 'Подбираем ответ') {
  state.busy = busy;
  const disabled = busy || !state.ready || state.confirming;
  $('sendButton').disabled = disabled; $('fileInput').disabled = disabled;
  $('catalogTrigger').disabled = disabled; $('newChat').disabled = busy || state.confirming;
  document.querySelectorAll('[data-prompt]').forEach(button => { button.disabled = disabled; });
  $('typingIndicator').classList.toggle('hidden', !busy);
  $('typingIndicator').setAttribute('aria-label', label);
  $('typingLabel').textContent = label;
  $('composerStatus').textContent = busy ? label + '…' : state.ready ? 'Данные каталога · проверяйте характеристики перед покупкой' : 'Подключение к сервису не установлено';
  $('messages').setAttribute('aria-busy', String(busy));
  syncProposalButtons();
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
function appendLink(parent, label, url, className = 'message-link') {
  const href = view.safeLink(url); if (!href) return;
  const link = el('a', className, label); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; parent.append(link);
}
function addMessage(role, text, extras = {}) {
  $('welcome').classList.add('hidden');
  const row = el('div', 'message-row ' + role);
  if (role !== 'user') { const avatar = el('div', 'mini-avatar', 'e'); avatar.setAttribute('aria-hidden', 'true'); row.append(avatar); }
  const stack = el('div', 'message-stack'); const label = el('div', 'message-label');
  label.append(el('span', '', role === 'user' ? 'Вы' : 'EKT Ассистент'), el('time', 'message-time', new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })));
  stack.append(label, el('div', 'bubble' + (extras.error ? ' error-bubble' : ''), text));
  if (Array.isArray(extras.products) && extras.products.length) {
    const grid = el('div', 'products-grid'); extras.products.forEach(product => { if (product && product.id !== undefined) grid.append(productCard(product)); }); stack.append(grid);
  }
  if (Array.isArray(extras.alternatives)) extras.alternatives.forEach(alternative => {
    if (!alternative?.candidate) return;
    const block = el('section', 'alternative-block'); block.append(el('h3', 'alternative-title', 'Предложенный аналог'), productCard(alternative.candidate));
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
  const visual = el('div', 'product-visual'); visual.setAttribute('aria-hidden', 'true');
  visual.innerHTML = /кабел|провод/i.test(product.name || '')
    ? '<svg viewBox="35 20 175 125" fill="none"><ellipse cx="113" cy="130" rx="69" ry="8" fill="#000" opacity=".07"/><path d="M82 108C34 84 50 31 100 33C151 34 175 95 136 117C101 137 63 100 78 66C91 38 127 51 132 73C138 96 112 105 100 88" stroke="#343a43" stroke-width="17" stroke-linecap="round"/><path d="m130 114 40-13" stroke="#292f36" stroke-width="16" stroke-linecap="round"/><path d="m166 101 24-14" stroke="#529d81" stroke-width="7" stroke-linecap="round"/><path d="m168 104 28-3" stroke="#528fcb" stroke-width="7" stroke-linecap="round"/><path d="m167 108 23 10" stroke="#aa8a55" stroke-width="7" stroke-linecap="round"/></svg>'
    : '<svg viewBox="65 10 115 136" fill="none"><ellipse cx="122" cy="133" rx="54" ry="7" fill="#000" opacity=".07"/><path d="m81 24 12-7h63l9 9v100l-12 8H89l-8-8V24Z" fill="#c8cccf"/><rect x="81" y="28" width="74" height="99" rx="4" fill="#e6e8e7"/><path d="M106 30v95m25-95v95" stroke="#c4c9c7"/><rect x="90" y="41" width="11" height="9" rx="2" fill="#9fa8a8"/><rect x="114" y="41" width="11" height="9" rx="2" fill="#9fa8a8"/><rect x="138" y="41" width="10" height="9" rx="2" fill="#9fa8a8"/><rect x="89" y="62" width="58" height="33" rx="3" fill="#313b42"/><path d="M92 73h52v12H92z" fill="#526773"/><path d="M96 102h44" stroke="#4a8491" stroke-width="3"/><path d="M96 109h30" stroke="#a5adad" stroke-width="2"/></svg>';
  return visual;
}
function productCard(product) {
  state.products.set(String(product.id), product);
  const card = el('article', 'product-card'), main = el('div', 'product-main'), info = el('div', 'product-info');
  info.append(el('h3', '', product.name || 'Товар'), el('div', 'product-id', product.article || 'Артикул не указан'), el('div', 'product-price', view.money(product.price)));
  const availability = view.stock(product.stock);
  info.append(el('div', 'stock' + (availability.quantity === 0 ? ' empty' : availability.quantity === null ? ' unknown' : ''), availability.label));
  main.append(productIllustration(product), info); card.append(main);
  const specs = el('div', 'specs hidden'); specs.id = 'specs-' + (window.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
  const facts = view.facts(product.facts);
  facts.forEach(([name, value]) => { const line = el('div', 'spec-row'); line.append(el('span', '', name), el('span', '', textValue(value))); specs.append(line); });
  if (!facts.length) specs.append(el('p', 'certificate', 'Характеристики не указаны в ответе каталога'));
  const source = el('div', 'product-source'); source.append(el('span', '', 'Источник: '));
  if (typeof product.source === 'string' && view.safeLink(product.source) && /^(https?:\/\/|\/)/.test(product.source)) appendLink(source, 'Открыть источник ↗', product.source, 'source-link');
  else if (product.source && typeof product.source === 'object') { source.append(el('span', '', textValue(product.source.name || product.source.label || product.source.updatedAt || '', 'Каталог'))); appendLink(source, 'Открыть источник ↗', product.source.url, 'source-link'); }
  else source.append(el('span', '', typeof product.source === 'string' ? product.source : 'не указан'));
  specs.append(source); appendLink(specs, 'Карточка товара ↗', product.productUrl, 'source-link');
  const actions = el('div', 'product-actions'), details = el('button', 'small-button', 'Характеристики'); details.type = 'button'; details.setAttribute('aria-expanded', 'false'); details.setAttribute('aria-controls', specs.id);
  details.onclick = () => { const expanded = !specs.classList.toggle('hidden'); details.setAttribute('aria-expanded', String(expanded)); details.textContent = expanded ? 'Скрыть характеристики' : 'Характеристики'; };
  const select = el('button', 'small-button add', 'В корзину'); select.type = 'button'; select.onclick = () => openSelection(product);
  actions.append(details, select); card.append(actions, specs); return card;
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
  if (state.proposal) state.invalidProposals.add(String(state.proposal.id));
  if (state.proposalTimer) clearTimeout(state.proposalTimer); state.proposalTimer = null;
  syncProposalButtons();
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
async function sendMessage(text) {
  if (!state.ready || state.busy || state.confirming || !text.trim()) return;
  addMessage('user', text.trim()); $('messageInput').value = ''; $('attachment').classList.add('hidden');
  invalidateProposal(); setBusy(true);
  try {
    const response = await api.chat(text.trim());
    if (!response || typeof response.reply !== 'string') throw new Error('Invalid chat response');
    for (const product of [...(Array.isArray(response.products) ? response.products : []), ...(Array.isArray(response.alternatives) ? response.alternatives.map(x => x?.candidate).filter(Boolean) : [])]) if (product?.id !== undefined) state.products.set(String(product.id), product);
    receiveProposal(response.proposal);
    addMessage('assistant', response.reply, response);
  } catch (error) { addMessage('assistant', safeError(error), { error: true, retry: () => sendMessage(text) }); }
  finally { setBusy(false); }
}
function openSelection(product) {
  if (!state.ready || state.busy || state.confirming) return;
  state.selection = product;
  $('selectionProduct').textContent = `${product.name || 'Товар'} · ${product.article || product.id}`;
  const multiple = view.orderMultiple(product);
  const supportedMultiple = Number.isSafeInteger(multiple) ? multiple : null;
  $('quantityInput').value = supportedMultiple ?? ''; $('quantityInput').step = supportedMultiple ?? '1'; $('quantityInput').min = supportedMultiple ?? '1';
  $('cityInput').value = view.stock(product.stock).city || '';
  $('multipleHint').textContent = multiple === null ? 'Кратность заказа не распознана. Уточните её в чате.' : supportedMultiple === null ? 'Дробная кратность заказа не поддерживается корзиной прототипа.' : `Кратность заказа: ${fmt(multiple)}. Наличие и цена будут проверены сервером.`;
  $('requestProposal').disabled = supportedMultiple === null; $('selectionError').classList.add('hidden'); $('selectionDialog').showModal();
}
async function requestProposal() {
  if (!state.selection || state.busy) return;
  const product = state.selection, quantity = Number($('quantityInput').value), multiple = view.orderMultiple(product), city = $('cityInput').value.trim();
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isSafeInteger(multiple) || !view.isMultiple(quantity,multiple) || !city) { $('selectionError').textContent = !city ? 'Укажите город для проверки остатка.' : `Укажите целое количество, кратное ${Number.isSafeInteger(multiple) ? fmt(multiple) : 'поддерживаемому значению'}.`; $('selectionError').classList.remove('hidden'); return; }
  $('selectionDialog').close();
  await sendMessage(`Подготовь предложение для добавления в корзину. Товар: ${product.name}; артикул: ${product.article || 'не указан'}; ID: ${product.id}; количество: ${quantity}; город: ${city}.`);
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
    addMessage('assistant', response.alreadyConfirmed ? 'Это предложение уже было подтверждено. Откройте актуальную корзину.' : 'Товар добавлен. Откройте актуальную корзину для проверки и оформления.', { cartUrl: response.cart.cartUrl });
  } catch (error) {
    if (error.status === 409 || error.status === 404 || error.ambiguous) invalidateProposal();
    $('confirmError').textContent = safeError(error); $('confirmError').classList.remove('hidden');
    if (error.ambiguous) { const link = view.safeLink(state.cart?.cartUrl); if (link) appendLink($('confirmError'), 'Проверить корзину ↗', link); }
  } finally { state.confirming = false; $('confirmAdd').textContent = 'Да, добавить в корзину'; setBusy(false); syncProposalButtons(); }
}
function acceptCart(cart) {
  if (!cart || !Array.isArray(cart.items) || !Number.isSafeInteger(cart.totalMinor) || cart.totalMinor < 0 || !view.safeLink(cart.cartUrl)) throw new Error('Invalid cart');
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
    const unitPrice = Number.isSafeInteger(item.unitPriceMinor) && item.unitPriceMinor >= 0
      ? view.money({ amount: item.unitPriceMinor / 100, currency: 'KZT' }) : 'Цена не указана';
    description.append(el('span','',`Цена за единицу: ${unitPrice}`));
    row.append(description); container.append(row);
  });
  const total = el('div','cart-total'); total.append(el('span','','Итого'),el('span','',view.cartTotal(state.cart.totalMinor))); container.append(total);
  $('checkoutLink').href = view.safeLink(state.cart.cartUrl); $('checkoutLink').classList.remove('hidden'); $('cartDisclaimer').textContent = 'Состав и сумма получены от сервера. Оформление продолжится по ссылке на корзину.';
}
async function openCart() {
  if (!state.ready || state.confirming) return;
  $('cartContents').replaceChildren(el('p','empty-cart','Обновляем корзину…')); $('checkoutLink').classList.add('hidden'); $('cartDialog').showModal();
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
async function initialize() {
  if (state.busy || state.ready) return;
  if (location.protocol === 'file:') {
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
    $('connectionLabel').textContent = 'Подключено к каталогу';
  } catch (error) { $('connectionLabel').textContent = 'Нет подключения'; addMessage('assistant',safeError(error),{error:true,retry:initialize}); }
  finally { setBusy(false); document.querySelector('.chat-status').classList.toggle('connected',state.ready); }
}
$('chatForm').addEventListener('submit',event=>{ event.preventDefault(); sendMessage($('messageInput').value); });
$('messageInput').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sendMessage($('messageInput').value);}});
document.querySelectorAll('[data-prompt]').forEach(button=>button.onclick=()=>sendMessage(button.dataset.prompt));
$('catalogTrigger').onclick=()=>sendMessage('Помоги выбрать электротехнику. Какие данные нужны для поиска товара?');
$('newChat').onclick=()=>{if(!state.busy&&!state.confirming)$('messageInput').focus();};
$('fileInput').addEventListener('change',event=>uploadAttachment(event.target.files?.[0]));
$('requestProposal').onclick=requestProposal;
$('confirmAdd').onclick=confirmProposal;
$('cartTrigger').onclick=openCart;
$('decreaseQty').onclick=()=>{const m=view.orderMultiple(state.selection);if(m)$('quantityInput').value=Math.max(m,Math.round((Number($('quantityInput').value)-m)*1e8)/1e8);};
$('increaseQty').onclick=()=>{const m=view.orderMultiple(state.selection);if(m)$('quantityInput').value=Math.round((Number($('quantityInput').value)+m)*1e8)/1e8;};
function closeDialog(dialog){if(dialog.id==='confirmDialog'&&state.confirming)return;dialog.close();}
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>closeDialog($(button.dataset.close)));
document.querySelectorAll('dialog').forEach(dialog=>{dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeDialog(dialog);});});
$('confirmDialog').addEventListener('cancel',event=>{if(state.confirming)event.preventDefault();});
$('confirmDialog').addEventListener('close',()=>{state.confirmationProposal=null;syncProposalButtons();});
initialize();
