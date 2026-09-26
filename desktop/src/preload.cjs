const { contextBridge, ipcRenderer } = require('electron');
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld('boxhaven', {
  list: () => ipcRenderer.invoke('boxes:list'),
  connect: (name, cols, rows) => ipcRenderer.invoke('session:connect', name, cols, rows),
  write: (name, data) => ipcRenderer.invoke('session:write', name, data),
  resize: (name, cols, rows) => ipcRenderer.invoke('session:resize', name, cols, rows),
  ack: (name, count) => ipcRenderer.invoke('session:ack', name, count),
  detach: name => ipcRenderer.invoke('session:detach', name),
  login: backend => ipcRenderer.invoke('account:login', backend),
  onData: callback => subscribe('session:data', callback),
  onExit: callback => subscribe('session:exit', callback),
  onRefresh: callback => subscribe('app:refresh', callback),
  onSearch: callback => subscribe('app:search', callback),
});
