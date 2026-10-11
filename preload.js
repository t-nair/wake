const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
})
