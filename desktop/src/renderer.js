import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import './styles.css';
import { boxSVG, creatorBadge, boxState, stateLabel } from '../../backend/src/box-art.ts';

const api = window.boxhaven;
const $ = id => document.getElementById(id);
const terminals = new Map();
let boxes = [];
let selected = null;
let loading = false;
let loaded = false;
let listError = '';
let creation = null;
let createdSelection = null;
let refreshAgain = false;
let catalog = null;
let catalogLoading = false;
let catalogRequest = 0;
let renameTarget = null;
let actionTarget = null;
function badgeElement(box) {
  const badge = creatorBadge(box); const element = document.createElement('span');
  if (badge) { element.className = 'creator-badge'; element.textContent = badge.initials; element.title = `Created by ${badge.label}`; element.setAttribute('aria-label', element.title); element.style.background = badge.color; }
  return element;
}
function openActions(name, anchor) {
  actionTarget = name; updateActions();
  const rect = anchor.getBoundingClientRect(); const menu = $('box-menu');
  menu.style.left = `${Math.min(rect.left, innerWidth - 185)}px`; menu.style.top = `${Math.min(rect.bottom + 4, innerHeight - 100)}px`;
  menu.showPopover();
}
function updateActions() {
  const box = boxes.find(box => box.name === (actionTarget || selected));
  const busy = !box || destroying.has(box.name) || box.status === 'destroying';
  $('rename-box').disabled = busy || renameBusy || creation?.status === 'creating';
  $('destroy-box').disabled = busy || (creation?.status === 'creating' && creation.name === box?.name);
  $('destroy-box').textContent = box && (destroying.has(box.name) || box.status === 'destroying') ? 'Destroying…' : 'Destroy box…';
}
let renameBusy = false;
const destroying = new Set();
const openingPreview = new Set();
const cleanError = error => error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');

function renderList() {
  $('count').textContent = boxes.length;
  $('boxes').replaceChildren();
  const query = $('search').value.toLowerCase();
  const visible = boxes.filter(box => `${box.name} ${box.team}`.toLowerCase().includes(query));
  for (const box of visible) {
    const wrapper = document.createElement('div'); wrapper.className = 'box-item';
    const row = document.createElement('button');
    row.className = 'box-row';
    row.dataset.name = box.name;
    row.setAttribute('aria-current', String(box.name === selected));
    row.setAttribute('aria-label', `${box.name}, ${box.status}`);
    const glyph = document.createElement('span');
    glyph.className = 'mini-box'; glyph.innerHTML = boxSVG(box); glyph.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.className = 'box-text';
    const title = document.createElement('strong'); title.textContent = box.name;
    const subtitle = document.createElement('small');
    const dot = document.createElement('i'); dot.className = `dot ${boxState(box)}`;
    subtitle.append(dot, `${stateLabel(box)} · ${box.team}`);
    text.append(title, subtitle); row.append(glyph, text, badgeElement(box));
    row.onclick = () => selectBox(box.name);
    const actions = document.createElement('button'); actions.className = 'row-actions'; actions.textContent = '•••'; actions.setAttribute('aria-label', `Actions for ${box.name}`); actions.onclick = () => openActions(box.name, actions);
    wrapper.append(row, actions); $('boxes').append(wrapper);
  }
  if (!visible.length && (query || !loaded)) {
    const note = document.createElement('p'); note.className = 'list-note';
    note.textContent = query ? 'No results' : 'Loading…';
    $('boxes').append(note);
  }
}

function renderHeader() {
  const box = boxes.find(box => box.name === selected);
  const session = terminals.get(selected);
  const showTerminal = Boolean(box && session);
  $('session-header').hidden = !box;
  $('provider-expiry').hidden = !box?.providerExpiresAt;
  $('provider-expiry').textContent = box?.providerExpiresAt ? `${box.provider} will delete this sandbox on ${new Date(box.providerExpiresAt).toLocaleString()}. Save work you need to keep before then.` : '';
  $('terminals').hidden = !showTerminal;
  $('welcome').hidden = showTerminal;
  $('empty-guide').hidden = Boolean(box) || !loaded || boxes.length > 0 || Boolean(listError);
  $('welcome-title').hidden = !$('empty-guide').hidden;
  if (!box) {
    $('welcome-title').textContent = listError ? 'Not connected' : loaded ? 'Select a box' : 'Loading…';
    return;
  }
  $('box-name').textContent = box.name;
  $('box-portrait').innerHTML = boxSVG(box); $('box-creator').replaceChildren(badgeElement(box));
  updateActions();
  $('box-meta').textContent = [box.team, box.provider, box.region, box.size].filter(Boolean).join('  /  ');
  $('open-preview').disabled = !box.previewURL || box.status === 'destroying' || openingPreview.has(box.name);
  $('open-preview').title = box.previewURL || 'No preview URL is configured for this box.';
  $('connection-state').textContent = box.status === 'destroying' ? 'Destroying box' : session?.status || (box.ready ? 'Ready to connect' : box.status === 'creating' ? 'Preparing box' : 'Recovery required');
  $('reconnect').hidden = !box.ready || Boolean(session?.live);
  if (!session) {
    $('welcome-title').textContent = box.status === 'destroying' ? 'Destroying…' : box.status === 'creating' ? 'Creating…' : 'Recovery required';
  }
}

function fitSession(name) {
  const session = terminals.get(name);
  if (!session || selected !== name || session.element.hidden) return;
  const size = session.fit.proposeDimensions();
  if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
  session.terminal.resize(Math.min(500, Math.max(2, size.cols)), Math.min(300, Math.max(1, size.rows)));
}

async function connectBox(name) {
  let session = terminals.get(name);
  if (session?.live) return;
  if (!session) {
    const element = document.createElement('div'); element.className = 'terminal-pane'; element.dataset.name = name;
    $('terminals').append(element);
    const terminal = new Terminal({
      fontFamily: '"SF Mono", Menlo, Monaco, Consolas, monospace', fontSize: 13, lineHeight: 1.3,
      cursorBlink: true, cursorStyle: 'bar', scrollback: 10000, allowProposedApi: false, screenReaderMode: true,
      theme: { background: '#faf9f5', foreground: '#243a31', cursor: '#34745d', selectionBackground: '#cddfce', black: '#25372f', red: '#a43732', green: '#2d7048', yellow: '#916321', blue: '#35658b', magenta: '#805386', cyan: '#28777a', white: '#747a71', brightBlack: '#69756b', brightRed: '#b43931', brightGreen: '#337b50', brightYellow: '#956320', brightBlue: '#3a6e9b', brightMagenta: '#875b94', brightCyan: '#26787c', brightWhite: '#536357' },
    });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element);
    session = { name, terminal, fit, element, live: false, status: 'Opening session…' };
    terminals.set(name, session);
    terminal.onData(data => { if (session.live) api.write(session.name, data).catch(error => terminal.writeln(`\r\n${cleanError(error)}`)); });
    terminal.onResize(({ cols, rows }) => { if (session.live) api.resize(session.name, cols, rows).catch(() => {}); });
  } else session.terminal.write('\r\n\x1b[90mReconnecting…\x1b[0m\r\n');
  session.live = true; session.status = 'Opening session…';
  renderHeader(); fitSession(name); renderList();
  try {
    await api.connect(name, session.terminal.cols, session.terminal.rows);
    if (session.live) session.status = 'Terminal open';
  } catch (error) {
    session.live = false; session.status = 'Couldn’t connect';
    session.terminal.writeln(`\r\n\x1b[31m${cleanError(error)}\x1b[0m\r\n`);
  }
  renderHeader(); renderList();
  if (selected === name) session.terminal.focus();
}

function selectBox(name) {
  if (selected !== name) $('action-error').hidden = true;
  selected = name;
  localStorage.setItem('boxhaven.selected-box', name);
  for (const [key, session] of terminals) session.element.hidden = key !== name;
  renderList(); renderHeader();
  if (boxes.find(box => box.name === name)?.ready) void connectBox(name);
  fitSession(name);
  terminals.get(name)?.terminal.focus();
}

async function refresh() {
  if (loading) { refreshAgain = true; return; }
  loading = true; $('refresh').disabled = true;
  try {
    boxes = await api.list(); loaded = true; listError = '';
    $('list-error').hidden = true;
    $('fleet-status').textContent = `${boxes.filter(box => box.status === 'online').length} online`;
    for (const [name, session] of terminals) {
      if (!boxes.some(box => box.name === name)) { session.terminal.dispose(); session.element.remove(); terminals.delete(name); }
    }
    if (selected && !boxes.some(box => box.name === selected)) selected = null;
    if (createdSelection && boxes.some(box => box.name === createdSelection)) {
      const name = createdSelection; createdSelection = null;
      $('search').value = ''; selectBox(name);
    }
    if (!selected) {
      const previous = localStorage.getItem('boxhaven.selected-box');
      if (boxes.some(box => box.name === previous)) selectBox(previous);
    } else if (boxes.find(box => box.name === selected)?.ready && !terminals.has(selected)) selectBox(selected);
  } catch (error) {
    listError = cleanError(error);
    $('list-error').textContent = listError; $('list-error').hidden = false;
    $('fleet-status').textContent = loaded ? 'Refresh failed' : 'Not connected';
  } finally {
    loading = false; $('refresh').disabled = false;
    renderList(); renderHeader();
    if (refreshAgain) { refreshAgain = false; void refresh(); }
  }
}

function renderCreation() {
  const busy = creation?.status === 'creating';
  if (busy) {
    $('new-box-name').value = creation.name;
    for (const key of ['provider']) {
      const field = $(`create-${key}`);
      if (![...field.options].some(option => option.value === creation.settings[key])) field.add(new Option(creation.settings[key], creation.settings[key]));
      field.value = creation.settings[key];
    }
    $('create-region').value = creation.settings.region;
  }
  $('new-box-name').disabled = busy;
  $('create-box').disabled = busy || catalogLoading || !catalog || !$('create-size').value;
  $('create-provider').disabled = busy || !$('create-provider').options.length;
  $('create-region').disabled = busy || catalogLoading;
  for (const radio of $('create-size').querySelectorAll('input')) radio.disabled = busy || catalogLoading || !catalog;
  $('create-box').textContent = busy ? 'Creating box…' : 'Create box';
  $('create-form').setAttribute('aria-busy', String(busy));
  $('create-status').textContent = busy ? '' : creation?.message || '';
  $('creation-notice').hidden = !creation || creation.status === 'complete';
  $('creation-notice').textContent = busy ? `Creating ${creation.name}…` : creation ? `${creation.name}: creation failed` : '';
}
function showCreate() {
  $('create-portrait').innerHTML = boxSVG({ provider: 'preview', provider_id: 'new-box' });
  if (creation?.status !== 'creating') {
    creation = null;
    $('create-form').reset();
    void loadCatalog('', '');
  }
  renderCreation();
  $('create-dialog').showModal();
  if (!creation) $('new-box-name').focus();
}
api.onCreation(state => {
  creation = state; renderCreation();
  if (state.status === 'complete') {
    createdSelection = state.name;
    $('create-dialog').close();
  }
  void refresh();
});
$('new-box').onclick = showCreate;
$('create-first-box').onclick = showCreate;
$('creation-notice').onclick = () => { renderCreation(); $('create-dialog').showModal(); };
$('close-create').onclick = () => $('create-dialog').close();
$('create-form').onsubmit = async event => {
  event.preventDefault();
  $('create-box').disabled = true;
  try {
    creation = await api.create($('new-box-name').value, { provider: $('create-provider').value, region: $('create-region').value.trim(), size: $('create-size').value });
  } catch (error) {
    creation = { name: $('new-box-name').value, status: 'error', message: cleanError(error) };
  }
  renderCreation();
};
void api.creation().then(state => { if (!creation) { creation = state; renderCreation(); } }).catch(() => {});


function selectedSize() {
  for (const radio of $('create-size').querySelectorAll('input')) radio.checked = radio.value === $('create-size').value;
  const choice = catalog?.choices.find(choice => choice.value === $('create-size').value);
  $('size-summary').hidden = !choice;
  $('size-description').hidden = !choice?.description;
  $('size-description').textContent = choice?.description || '';
  if (choice) {
    $('size-hardware').textContent = [choice.cpus == null ? '' : `${choice.cpus} vCPU`, choice.memoryGB == null ? '' : `${choice.memoryGB} GB RAM`, choice.diskGB == null || choice.diskGB === 0 ? 'provider-managed storage' : `${choice.diskGB} GB disk`].filter(Boolean).join(' · ');
    const money = (value, digits) => new Intl.NumberFormat(undefined, { style: 'currency', currency: choice.currency, minimumFractionDigits: 2, maximumFractionDigits: digits }).format(value);
    $('size-price').textContent = choice.hourly === null ? 'Price unavailable' : `${money(choice.hourly, 4)}/hr · ~${money(choice.monthly, 2)}/mo`;
  }
  renderCreation();
}
async function loadCatalog(provider, region) {
  const request = ++catalogRequest;
  const previous = $('create-size').value || 'small';
  catalog = null; catalogLoading = true;
  $('catalog-status').textContent = 'Loading settings…'; $('retry-catalog').hidden = true;
  $('size-summary').hidden = true; renderCreation();
  try {
    const result = await api.catalog(provider, region);
    if (request !== catalogRequest) return;
    catalog = result;
    $('create-provider').replaceChildren(...result.providers.map(provider => new Option(provider.label, provider.name)));
    $('create-provider').value = result.provider;
    $('create-region').value = result.region;
    $('create-regions').replaceChildren(...result.regions.map(region => new Option(region, region)));
    $('create-size').replaceChildren();
    for (const choice of result.choices) {
      const label = document.createElement('label'); label.className = 'size-choice';
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'size'; radio.value = choice.value; radio.required = true;
      radio.onchange = () => { $('create-size').value = choice.value; selectedSize(); };
      const name = document.createElement('strong'); name.textContent = choice.value;
      const spec = document.createElement('span'); spec.textContent = [choice.cpus == null ? '' : `${choice.cpus} vCPU`, choice.memoryGB == null ? '' : `${choice.memoryGB} GB`].filter(Boolean).join(' · ');
      const price = document.createElement('span'); price.className = 'choice-price'; price.textContent = choice.hourly == null ? '—' : `${new Intl.NumberFormat(undefined,{ style:'currency', currency:choice.currency, maximumFractionDigits:4 }).format(choice.hourly)}/hr`;
      label.append(radio, name, spec, price); $('create-size').append(label);
    }
    $('create-size').value = result.choices.some(choice => choice.value === previous) ? previous : '';
    $('catalog-status').textContent = result.choices.length ? '' : 'No sizes available';
  } catch (error) {
    if (request !== catalogRequest) return;
    $('catalog-status').textContent = cleanError(error); $('retry-catalog').hidden = false;
  } finally {
    if (request === catalogRequest) { catalogLoading = false; selectedSize(); }
  }
}
$('create-provider').onchange = () => loadCatalog($('create-provider').value, '');
$('create-region').oninput = () => { catalogRequest++; catalog = null; catalogLoading = false; $('size-summary').hidden = true; renderCreation(); };
$('create-region').onchange = () => loadCatalog($('create-provider').value, $('create-region').value.trim());
$('create-size').onchange = selectedSize;
$('retry-catalog').onclick = () => loadCatalog($('create-provider').value, $('create-region').value.trim());

api.onRenamed(({ name, next }) => {
  const session = terminals.get(name);
  if (session) { terminals.delete(name); session.name = next; session.element.dataset.name = next; terminals.set(next, session); }
  boxes = boxes.map(box => box.name === name ? { ...box, name: next } : box);
  if (selected === name) { selected = next; localStorage.setItem('boxhaven.selected-box', next); }
  renderList(); renderHeader();
});
$('rename-box').onclick = () => {
  $('box-menu').hidePopover();
  renameTarget = boxes.find(box => box.name === actionTarget);
  if (!renameTarget) return;
  $('rename-name').value = renameTarget.name; $('rename-status').textContent = '';
  $('rename-dialog').showModal(); $('rename-name').select();
};
$('close-rename').onclick = () => $('rename-dialog').close();
$('rename-form').onsubmit = async event => {
  event.preventDefault();
  if (!renameTarget || renameBusy) return;
  renameBusy = true; $('save-name').disabled = true; $('rename-name').disabled = true;
  $('rename-status').textContent = ''; $('save-name').textContent = 'Saving…'; renderHeader();
  try { await api.rename(renameTarget.name, renameTarget.identity, $('rename-name').value); $('rename-dialog').close(); }
  catch (error) { $('rename-status').textContent = cleanError(error); }
  finally { renameBusy = false; $('save-name').disabled = false; $('rename-name').disabled = false; $('save-name').textContent = 'Save'; renderHeader(); void refresh(); }
};

api.onData(({ name, data }) => {
  const session = terminals.get(name);
  if (session) session.terminal.write(data, () => { void api.ack(session.name, data.length).catch(() => {}); });
  else void api.ack(name, data.length).catch(() => {});
});
api.onExit(({ name, exitCode }) => {
  const session = terminals.get(name);
  if (!session) return;
  session.live = false; session.status = exitCode === 0 ? 'Detached' : 'Disconnected';
  session.terminal.writeln('\r\n\x1b[90mConnection closed.\x1b[0m');
  renderList(); renderHeader();
});
api.onRefresh(refresh);
api.onSearch(() => $('search').focus());
$('refresh').onclick = refresh;
$('open-preview').onclick = async () => {
  const name = selected;
  openingPreview.add(name); $('action-error').hidden = true; renderHeader();
  try { await api.openPreview(name); }
  catch (error) { showActionError(name, error); }
  finally { openingPreview.delete(name); renderHeader(); }
};
function showActionError(name, error) {
  $('action-error').textContent = `${name}: ${cleanError(error)}`; $('action-error').hidden = false;
}
$('destroy-box').onclick = async () => {
  $('box-menu').hidePopover();
  const box = boxes.find(box => box.name === actionTarget);
  if (!box) return;
  const name = box.name;
  destroying.add(name); $('action-error').hidden = true; renderHeader();
  try {
    if (await api.destroy(name, box.identity)) {
      const session = terminals.get(name);
      session?.terminal.dispose(); session?.element.remove(); terminals.delete(name);
      boxes = boxes.filter(box => box.name !== name);
      if (selected === name) { selected = null; localStorage.removeItem('boxhaven.selected-box'); }
    }
  } catch (error) { showActionError(name, error); }
  finally { destroying.delete(name); renderList(); renderHeader(); void refresh(); }
};
$('search').oninput = renderList;
$('box-actions').onclick = event => { event.preventDefault(); openActions(selected, $('box-actions')); };
$('box-menu').addEventListener('toggle', event => $('box-actions').setAttribute('aria-expanded', String(event.newState === 'open')));
$('close-connections').onclick = async () => {
  try { await Promise.all([...terminals.keys()].map(name => api.detach(name))); $('login-status').textContent = 'Local connections closed.'; }
  catch (error) { $('login-status').textContent = cleanError(error); }
};
$('reconnect').onclick = () => { if (selected) void connectBox(selected); };
$('settings').onclick = () => $('settings-dialog').showModal();
$('close-settings').onclick = () => $('settings-dialog').close();
$('login-form').onsubmit = async event => {
  event.preventDefault(); $('login').disabled = true;
  $('login-status').textContent = 'Waiting for browser sign-in…';
  try {
    await api.login($('backend-url').value);
    selected = null;
    for (const session of terminals.values()) { session.terminal.dispose(); session.element.remove(); }
    terminals.clear(); localStorage.removeItem('boxhaven.selected-box');
    $('login-status').textContent = ''; $('settings-dialog').close(); await refresh();
  } catch (error) { $('login-status').textContent = cleanError(error); }
  finally { $('login').disabled = false; }
};
new ResizeObserver(() => fitSession(selected)).observe($('terminals'));
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); $('search').focus(); }
});
renderList(); void refresh();
setInterval(refresh, 15000);
