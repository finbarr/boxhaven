const { app, BrowserWindow, ipcMain, Menu, nativeImage } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { homedir } = require('node:os');
const pty = require('node-pty');
const { cliEnvironment, runCLI, parseMachines, terminalSize } = require('./cli.cjs');

async function startApp({ cliPath, cwd = homedir(), userData } = {}) {
  app.setName('BoxHaven');
  if (userData) app.setPath('userData', userData);
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  await app.whenReady();
  const root = join(__dirname, '..');
  cliPath ||= join(root, 'bin', 'bh');
  const env = cliEnvironment();
  const page = pathToFileURL(join(root, 'dist', 'index.html')).href;
  const icon = nativeImage.createFromPath(join(root, 'assets', 'icon.png'));
  if (process.platform === 'darwin') app.dock.setIcon(icon);
  let window;
  let machines = new Map();
  let listing;
  let signingIn;
  let commands = new AbortController();
  const sessions = new Map();

  function send(channel, message) {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, message);
  }
  function disposeSessions() {
    commands.abort();
    for (const session of sessions.values()) session.process.kill();
    sessions.clear();
  }
  function handle(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('Untrusted request.');
      return handler(...args);
    });
  }
  handle('boxes:list', () => {
    listing ||= runCLI(cliPath, ['list', '--json'], { cwd, env, signal: commands.signal }).then(output => {
      const list = parseMachines(output);
      machines = new Map(list.map(box => [box.name, box]));
      for (const [name, session] of sessions) {
        if (!machines.has(name)) { session.process.kill(); sessions.delete(name); }
      }
      return list;
    }).finally(() => { listing = null; });
    return listing;
  });
  handle('session:connect', (name, cols, rows) => {
    const box = machines.get(name);
    if (!box?.ready) throw new Error('This box is not ready to connect. Refresh its status and try again.');
    const size = terminalSize(cols, rows);
    if (sessions.has(name)) return;
    const process = pty.spawn(cliPath, ['connect', name], { name: 'xterm-256color', ...size, cwd, env });
    const session = { process, pending: 0 };
    sessions.set(name, session);
    process.onData(data => {
      if (sessions.get(name) !== session) return;
      session.pending += data.length;
      if (session.pending > 256 * 1024) process.pause();
      send('session:data', { name, data });
    });
    process.onExit(({ exitCode }) => {
      if (sessions.get(name) !== session) return;
      sessions.delete(name);
      send('session:exit', { name, exitCode });
    });
  });
  handle('session:write', (name, data) => {
    if (typeof data !== 'string' || data.length > 1024 * 1024) throw new Error('Invalid terminal input.');
    sessions.get(name)?.process.write(data);
  });
  handle('session:resize', (name, cols, rows) => {
    const size = terminalSize(cols, rows);
    sessions.get(name)?.process.resize(size.cols, size.rows);
  });
  handle('session:ack', (name, count) => {
    const session = sessions.get(name);
    if (!session || !Number.isInteger(count) || count < 0 || count > 8 * 1024 * 1024) return;
    session.pending = Math.max(0, session.pending - count);
    if (session.pending < 64 * 1024) session.process.resume();
  });
  handle('session:detach', name => { sessions.get(name)?.process.kill(); });
  handle('account:login', backend => {
    if (signingIn) return signingIn;
    if (sessions.size) throw new Error('Detach your open sessions before signing in to another account.');
    if (typeof backend !== 'string') throw new Error('Invalid backend URL.');
    const args = ['login'];
    if (backend.trim()) {
      const url = new URL(backend.trim());
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Enter an HTTP or HTTPS backend URL.');
      args.push('--backend-url', url.href.replace(/\/$/, ''));
    }
    signingIn = runCLI(cliPath, args, { cwd, env, timeout: 10 * 60 * 1000, signal: commands.signal }).then(() => { machines.clear(); }).finally(() => { signingIn = null; });
    return signingIn;
  });

  function createWindow() {
    commands = new AbortController();
    window = new BrowserWindow({
      title: 'BoxHaven', width: 1240, height: 820, minWidth: 760, minHeight: 480,
      backgroundColor: '#151719', icon,
      titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 },
      ...(process.platform !== 'darwin' ? { titleBarOverlay: { color: '#1c1e21', symbolColor: '#bfc1c6', height: 48 } } : {}),
      webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.on('render-process-gone', disposeSessions);
    window.on('closed', () => { disposeSessions(); window = null; });
    window.loadURL(page);
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'BoxHaven', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Refresh Boxes', accelerator: 'CmdOrCtrl+R', click: () => send('app:refresh') },
      { label: 'Find a Box', accelerator: 'CmdOrCtrl+K', click: () => send('app:search') },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' },
    ] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
  ]));
  app.on('second-instance', () => { if (!window) createWindow(); window.show(); window.focus(); });
  app.on('activate', () => { if (!window) createWindow(); });
  app.on('before-quit', disposeSessions);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  createWindow();
}

module.exports = { startApp };
if (require.main === module) startApp().catch(error => { console.error(error); app.quit(); });
