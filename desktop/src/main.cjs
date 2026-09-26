const { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, dialog } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { homedir } = require('node:os');
const pty = require('node-pty');
const { cliEnvironment, runCLI, parseMachines, terminalSize, validName } = require('./cli.cjs');

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
  let creating;
  let creation = null;
  let quitting = false;
  let commands = new AbortController();
  const sessions = new Map();
  const destructions = new Map();

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
      for (const box of list) {
        if (creation?.status === 'creating' && creation.name === box.name) { box.ready = false; box.status = 'creating'; }
        if (destructions.get(box.name)?.confirmed) { box.ready = false; box.status = 'destroying'; }
      }
      machines = new Map(list.map(box => [box.name, box]));
      for (const [name, session] of sessions) {
        if (!machines.has(name)) { session.process.kill(); sessions.delete(name); }
      }
      return list;
    }).finally(() => { listing = null; });
    return listing;
  });
  handle('boxes:creation', () => creation);
  handle('boxes:open-preview', async name => {
    const box = machines.get(name);
    if (!box?.previewURL) throw new Error('This box has no web preview URL.');
    if (destructions.get(name)?.confirmed) throw new Error('This box is being destroyed.');
    await shell.openExternal(box.previewURL);
  });
  handle('boxes:destroy', (name, identity) => {
    const box = machines.get(name);
    if (!box || box.identity !== identity) throw new Error('This box has changed. Refresh and select it again.');
    if (signingIn) throw new Error('Finish signing in before destroying a box.');
    if (creation?.status === 'creating' && creation.name === name) throw new Error('Wait for this box to finish being created.');
    if (destructions.has(name)) return destructions.get(name).promise;
    const owner = window;
    const operation = { confirmed: false };
    operation.promise = (async () => {
      const result = await dialog.showMessageBox(owner, {
        type: 'warning', title: 'Destroy box', message: `Destroy “${name}”?`,
        detail: 'This permanently deletes the remote VM and its files, and stops all running sessions. Save any work you want to keep first. This cannot be undone.',
        buttons: ['Cancel', 'Destroy box'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (result.response !== 1 || owner.isDestroyed()) return false;
      // Recheck after confirmation so an old selection cannot delete a box
      // that has since been replaced under the same name.
      const current = parseMachines(await runCLI(cliPath, ['list', '--json'], { cwd, env }));
      const target = current.find(machine => machine.name === name);
      if (!target || target.identity !== identity) throw new Error('This box has changed. Refresh and select it again.');
      operation.confirmed = true;
      send('app:refresh');
      await runCLI(cliPath, ['destroy', name, '--force'], { cwd, env, timeout: 5 * 60 * 1000 });
      sessions.get(name)?.process.kill();
      sessions.delete(name);
      machines.delete(name);
      return true;
    })().finally(() => { destructions.delete(name); send('app:refresh'); });
    destructions.set(name, operation);
    return operation.promise;
  });
  handle('boxes:create', name => {
    if (!validName(name) || name.length > 63) throw new Error('Use up to 63 lowercase letters, numbers, and single hyphens between words.');
    if (creating) throw new Error('A box is already being created. Wait for it to finish.');
    if (signingIn) throw new Error('Finish signing in before creating a box.');
    if (destructions.has(name)) throw new Error('Wait for this box to finish being destroyed.');
    creation = { name, status: 'creating', message: `Creating ${name}… You can keep working while it gets ready.` };
    const started = creation;
    creating = (async () => {
      // Check fresh state: create can resume an existing box, which is not what
      // the New box action promises. Never sync the desktop's home directory.
      const current = parseMachines(await runCLI(cliPath, ['list', '--json'], { cwd, env }));
      if (current.some(box => box.name === name)) throw new Error(`A box named ${name} already exists. Choose another name or select it in the sidebar.`);
      await runCLI(cliPath, ['create', name, '--no-sync'], { cwd, env, timeout: 10 * 60 * 1000 });
      creation = { name, status: 'complete', message: `${name} is ready.` };
    })().catch(error => {
      creation = { name, status: 'error', message: error.message };
    }).finally(() => {
      creating = null;
      send('boxes:creation', creation);
    });
    send('boxes:creation', started);
    return started;
  });
  handle('session:connect', (name, cols, rows) => {
    const box = machines.get(name);
    if (creation?.status === 'creating' && creation.name === name) throw new Error('This box is still being created.');
    if (destructions.get(name)?.confirmed) throw new Error('This box is being destroyed.');
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
    if (creating) throw new Error('Wait for your new box to finish before changing accounts.');
    if (destructions.size) throw new Error('Wait for box destruction to finish before changing accounts.');
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
  app.on('before-quit', event => {
    if (creating || destructions.size) {
      // Finish mutations before exit so quitting cannot abandon an in-flight
      // request. Closing a window still leaves other remote sessions running.
      event.preventDefault();
      if (!quitting) {
        quitting = true;
        void Promise.allSettled([creating, ...[...destructions.values()].map(operation => operation.promise)]).then(() => { quitting = false; app.quit(); });
      }
      return;
    }
    disposeSessions();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  createWindow();
}

module.exports = { startApp };
if (require.main === module) startApp().catch(error => { console.error(error); app.quit(); });
