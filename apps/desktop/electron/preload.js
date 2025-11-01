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
    delete:   (date)          => ipcRenderer.invoke('entry:deleteByDate', date),
    saveTemplate: (name, content) => ipcRenderer.invoke('template:upsert', { name, content }),
    getTemplate:  (name)          => ipcRenderer.invoke('template:getByName', name),
});

contextBridge.exposeInMainWorld('electronAPI', {
    quitApp: () => ipcRenderer.invoke('app:quit'),
    exportJournal: (args) => ipcRenderer.invoke('export-journal', args),
    getPath: (name) => ipcRenderer.invoke('get-path', name),
    saveText: ({ content, outputPath }) => ipcRenderer.invoke('save-text', { content, outputPath }),
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
});
