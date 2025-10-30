const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('db', {
    upsert:   (date, content) => ipcRenderer.invoke('entry:upsert', { date, content }),
    get:      (date)          => ipcRenderer.invoke('entry:getByDate', date),
    del:      (date)          => ipcRenderer.invoke('entry:deleteByDate', date),
    listYM:   (ym)            => ipcRenderer.invoke('entry:listMonth', ym),   // 'YYYY-MM'
    listByYearMonth: (ym)      => ipcRenderer.invoke('entry:listByYearMonth', ym),
    search:   (q)             => ipcRenderer.invoke('entry:search', q),
    listRecent: (limit = 15)  => ipcRenderer.invoke('entry:listRecent', limit),
    deleteByDate: (date)      => ipcRenderer.invoke('entry:deleteByDate', date),
});

contextBridge.exposeInMainWorld('electronAPI', {
    quitApp: () => ipcRenderer.invoke('app:quit')
});