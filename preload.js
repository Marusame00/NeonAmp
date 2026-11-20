'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('neonamp', {
  init: () => ipcRenderer.invoke('app:init'),
  addFiles: () => ipcRenderer.invoke('library:addFiles'),
  addFolder: () => ipcRenderer.invoke('library:addFolder'),
  inspect: (paths) => ipcRenderer.invoke('library:inspect', paths),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
  updatePlayer: (payload) => ipcRenderer.send('player:update', payload),
  updateOverlay: (settings) => ipcRenderer.send('overlay:update', settings),
  persist: (payload) => ipcRenderer.send('state:persist', payload),
  openOverlay: () => ipcRenderer.invoke('overlay:open'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  revealData: () => ipcRenderer.invoke('app:revealData'),
  onServer: (cb) => {
    const listener = (_event, info) => cb(info);
    ipcRenderer.on('server:changed', listener);
    return () => ipcRenderer.removeListener('server:changed', listener);
  }
});
