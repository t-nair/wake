const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
  ready: () => ipcRenderer.send('ready'),
  dismiss: (key) => ipcRenderer.send('dismiss', key),
  pin: (key, on) => ipcRenderer.send('pin', key, on),
  minimize: () => ipcRenderer.send('minimize'),
  resize: (w, h) => ipcRenderer.send('resize', w, h),
})
