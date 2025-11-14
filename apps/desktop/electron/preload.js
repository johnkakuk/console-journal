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
    saveTemplate: (name, content, schedule) => ipcRenderer.invoke('template:upsert', { name, content, schedule }),
    getTemplate:  (name)          => ipcRenderer.invoke('template:getByName', name),
    listTemplates: ()             => ipcRenderer.invoke('template:list'),
    deleteTemplate: (name)        => ipcRenderer.invoke('template:delete', name),
    writer: {
        list:      () => ipcRenderer.invoke('writer:list'),
        get:       (id) => ipcRenderer.invoke('writer:get', id),
        create:    (payload = {}) => ipcRenderer.invoke('writer:create', payload),
        update:    (payload = {}) => ipcRenderer.invoke('writer:update', payload),
        delete:    (id) => ipcRenderer.invoke('writer:delete', id),
        duplicate: (id, overrides = {}) => ipcRenderer.invoke('writer:duplicate', { id, ...overrides }),
        rename:    (id, title) => ipcRenderer.invoke('writer:rename', { id, title }),
        listFolders:    () => ipcRenderer.invoke('writer:list-folders'),
        createFolder:   (payload = {}) => ipcRenderer.invoke('writer:create-folder', payload),
        renameFolder:   (id, name) => ipcRenderer.invoke('writer:rename-folder', { id, name }),
        deleteFolder:   (id) => ipcRenderer.invoke('writer:delete-folder', id),
        duplicateFolder:(id, overrides = {}) => ipcRenderer.invoke('writer:duplicate-folder', { id, ...overrides }),
        reorderDocuments:(moves = []) => ipcRenderer.invoke('writer:reorder-docs', { moves }),
        reorderFolders:(moves = []) => ipcRenderer.invoke('writer:reorder-folders', { moves })
    }
});

contextBridge.exposeInMainWorld('electronAPI', {
    quitApp: () => ipcRenderer.invoke('app:quit'),
    exportJournal: (args) => ipcRenderer.invoke('export-journal', args),
    getPath: (name) => ipcRenderer.invoke('get-path', name),
    saveText: ({ content, outputPath }) => ipcRenderer.invoke('save-text', { content, outputPath }),
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
});

contextBridge.exposeInMainWorld('settings', {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    set: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),
});
