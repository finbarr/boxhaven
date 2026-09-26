import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import './styles.css';

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
const cleanError = error => error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');

function renderList() {
  $('count').textContent = boxes.length;
  $('boxes').replaceChildren();
  const query = $('search').value.toLowerCase();
  const visible = boxes.filter(box => `${box.name} ${box.team}`.toLowerCase().includes(query));
  for (const box of visible) {
    const row = document.createElement('button');
    row.className = 'box-row';
    row.dataset.name = box.name;
    row.setAttribute('aria-current', String(box.name === selected));
    row.setAttribute('aria-label', `${box.name}, ${box.status}`);
    const glyph = document.createElement('span');
    glyph.className = 'mini-box'; glyph.textContent = '⬡'; glyph.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.className = 'box-text';
    const title = document.createElement('strong'); title.textContent = box.name;
    const subtitle = document.createElement('small');
    const dot = document.createElement('i'); dot.className = `dot ${['online', 'offline', 'creating'].includes(box.status) ? box.status : ''}`;
    subtitle.append(dot, `${box.status === '-' ? 'Unknown' : box.status[0].toUpperCase() + box.status.slice(1)} · ${box.team}`);
    text.append(title, subtitle); row.append(glyph, text);
    if (terminals.get(box.name)?.live) {
      const mark = document.createElement('span'); mark.className = 'active-mark'; mark.textContent = '›'; mark.title = 'Terminal open'; row.append(mark);
    }
    row.onclick = () => selectBox(box.name);
    $('boxes').append(row);
  }
  if (!visible.length) {
    const note = document.createElement('p'); note.className = 'list-note';
    note.textContent = query ? 'No matching boxes.' : loaded ? 'Your boxes will appear here.' : 'Loading your boxes…';
    $('boxes').append(note);
  }
}

function renderHeader() {
  const box = boxes.find(box => box.name === selected);
  const session = terminals.get(selected);
  const showTerminal = Boolean(box && session);
  $('session-header').hidden = !box;
  $('session-footer').hidden = !showTerminal;
  $('terminals').hidden = !showTerminal;
  $('welcome').hidden = showTerminal;
  $('empty-guide').hidden = Boolean(box) || !loaded || boxes.length > 0 || Boolean(listError);
  if (!box) {
    $('welcome-title').textContent = listError ? 'Let’s get you connected.' : loaded && !boxes.length ? 'Make room for your next idea.' : 'Your boxes. One place.';
    $('welcome-copy').textContent = listError ? 'Check your connection or open settings to sign in.' : loaded && !boxes.length ? 'Your remote machines will appear here as soon as you create them.' : 'Select a box to pick up where you left off. Your sessions keep running when you step away.';
    return;
  }
  $('box-name').textContent = box.name;
  $('box-meta').textContent = [box.team, box.provider, box.region, box.size].filter(Boolean).join('  /  ');
  $('connection-state').textContent = session?.status || (box.ready ? 'Ready to connect' : box.status === 'creating' ? 'Preparing box' : 'Recovery required');
  $('detach').hidden = !session?.live;
  $('reconnect').hidden = !box.ready || Boolean(session?.live);
  if (!session) {
    $('welcome-title').textContent = box.status === 'creating' ? 'Your box is getting ready.' : 'This box needs attention.';
    $('welcome-copy').textContent = box.status === 'creating' ? 'We’ll connect once setup finishes. You can keep working in another box.' : 'Run bh status for this box to inspect its recovery state.';
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
      theme: { background: '#151719', foreground: '#d3d7df', cursor: '#e4b477', selectionBackground: '#74604488', black: '#292e35', red: '#e78e87', green: '#a1c58d', yellow: '#e4bb7d', blue: '#8cb4de', magenta: '#bd9edc', cyan: '#87c8c8', white: '#dde1e6', brightBlack: '#757f8b' },
    });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element);
    session = { terminal, fit, element, live: false, status: 'Opening session…' };
    terminals.set(name, session);
    terminal.onData(data => { if (session.live) api.write(name, data).catch(error => terminal.writeln(`\r\n${cleanError(error)}`)); });
    terminal.onResize(({ cols, rows }) => { if (session.live) api.resize(name, cols, rows).catch(() => {}); });
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
    $('fleet-status').textContent = `${boxes.filter(box => box.status === 'online').length} online · Updated just now`;
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
    $('fleet-status').textContent = loaded ? 'Refresh failed · Status may be stale' : 'Not connected';
  } finally {
    loading = false; $('refresh').disabled = false;
    renderList(); renderHeader();
    if (refreshAgain) { refreshAgain = false; void refresh(); }
  }
}

function renderCreation() {
  const busy = creation?.status === 'creating';
  if (busy) $('new-box-name').value = creation.name;
  $('new-box-name').disabled = busy;
  $('create-box').disabled = busy;
  $('create-box').textContent = busy ? 'Creating box…' : 'Create box';
  $('create-form').setAttribute('aria-busy', String(busy));
  $('create-status').textContent = creation?.message || '';
  $('creation-notice').hidden = !creation || creation.status === 'complete';
  $('creation-notice').textContent = busy ? `Creating ${creation.name}…` : creation ? `Couldn’t finish creating ${creation.name}. View details.` : '';
}
function showCreate() {
  if (creation?.status !== 'creating') {
    creation = null;
    $('create-form').reset();
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
    creation = await api.create($('new-box-name').value);
  } catch (error) {
    creation = { name: $('new-box-name').value, status: 'error', message: cleanError(error) };
  }
  renderCreation();
};
void api.creation().then(state => { if (!creation) { creation = state; renderCreation(); } }).catch(() => {});

api.onData(({ name, data }) => {
  const session = terminals.get(name);
  if (session) session.terminal.write(data, () => { void api.ack(name, data.length).catch(() => {}); });
  else void api.ack(name, data.length).catch(() => {});
});
api.onExit(({ name, exitCode }) => {
  const session = terminals.get(name);
  if (!session) return;
  session.live = false; session.status = exitCode === 0 ? 'Detached' : 'Disconnected';
  session.terminal.writeln('\r\n\x1b[90mConnection closed. Reconnect to return to your box.\x1b[0m');
  renderList(); renderHeader();
});
api.onRefresh(refresh);
api.onSearch(() => $('search').focus());
$('refresh').onclick = refresh;
$('search').oninput = renderList;
$('detach').onclick = () => { if (selected) void api.detach(selected).catch(error => { $('connection-state').textContent = cleanError(error); }); };
$('reconnect').onclick = () => { if (selected) void connectBox(selected); };
$('settings').onclick = () => $('settings-dialog').showModal();
$('close-settings').onclick = () => $('settings-dialog').close();
$('login-form').onsubmit = async event => {
  event.preventDefault(); $('login').disabled = true;
  $('login-status').textContent = 'Finish signing in in your browser. This can take a moment.';
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
