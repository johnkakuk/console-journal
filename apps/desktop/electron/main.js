const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');
const { marked } = require('marked');

marked.setOptions({
    gfm: true,
    breaks: true,
});

function readCssText(cssPath) {
    if (!cssPath) return '';
    const candidates = [];

    // Absolute path provided
    if (path.isAbsolute(cssPath)) candidates.push(cssPath);

    // Relative to the app root (works in dev)
    candidates.push(path.join(app.getAppPath(), cssPath));

    // Relative to this file: ../../../ + cssPath (from apps/desktop/electron → repo root)
    candidates.push(path.resolve(__dirname, '..', '..', '..', cssPath));

    // Packaged build: relative to resources path
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, cssPath));

    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
        } catch (_) {}
    }
    return '';
}

function htmlForExport(markdown, cssText) {
    const body = marked.parse(markdown || '');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Console Journal Export</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;">
<style>${cssText || ''}</style>
</head><body><article class="markdown-body">${body}</article></body></html>`;
}

function normalizeWriterTitle(title) {
    if (typeof title === 'string') {
        const trimmed = title.trim();
        if (trimmed.length) return trimmed;
    }
    return 'Untitled Document';
}

function normalizeWriterFolderName(name) {
    if (typeof name === 'string') {
        const trimmed = name.trim();
        if (trimmed.length) return trimmed;
    }
    return 'New Folder';
}


process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
});

// Dev switch (after app is available)
// const isDev = !app.isPackaged;

app.setName('console-journal');
const dbPath = path.join(app.getPath('userData'), 'app.db');
console.log('DB path:', dbPath);

let db;
function initDB() {
    db = new Database(dbPath);

    // Dump everything we need:
        console.log('process.cwd():', process.cwd());
        console.log('Resolved app.db:', path.resolve('app.db'));
        try { console.log('fs.existsSync(resolved):', fs.existsSync(path.resolve('app.db'))); } catch {}
        console.log('userData:', app.getPath('userData'));

        // GOLD: actual SQLite path(s)
        const dbs = db.pragma('database_list', { simple: false });
        console.log('SQLite database_list:', dbs);

    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,                        -- 'YYYY-MM-DD'
            content TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(date)
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            content TEXT NOT NULL,
            schedule TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS writer_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            folder_id INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS writer_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            parent_id INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_writer_documents_updated_at ON writer_documents (updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_writer_documents_folder ON writer_documents (folder_id);
        -- Optional FTS (enable if your SQLite has FTS5):
        -- CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(content, content='entries', content_rowid='id');
        -- CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
        --     INSERT INTO entries_fts(rowid, content) VALUES (new.id, new.content);
        -- END;
        -- CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
        --     INSERT INTO entries_fts(entries_fts, rowid, content) VALUES('delete', old.id, old.content);
        --     INSERT INTO entries_fts(rowid, content) VALUES (new.id, new.content);
        -- END;
        -- CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
        --     INSERT INTO entries_fts(entries_fts, rowid, content) VALUES('delete', old.id, old.content);
        -- END;
    `);

    const templateColumns = db.prepare(`PRAGMA table_info(templates)`).all();
    if (!templateColumns.some(col => col.name === 'schedule')) {
        db.exec(`ALTER TABLE templates ADD COLUMN schedule TEXT`);
    }

    const folderColumns = db.prepare(`PRAGMA table_info(writer_folders)`).all();
    if (!folderColumns.some(col => col.name === 'parent_id')) {
        db.exec(`
            ALTER TABLE writer_folders ADD COLUMN parent_id INTEGER;
            CREATE INDEX IF NOT EXISTS idx_writer_folders_parent ON writer_folders(parent_id);
        `);
    } else {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_writer_folders_parent ON writer_folders(parent_id);`);
    }

    // Prepared statements
    db._upsertEntry = db.prepare(`
        INSERT INTO entries (date, content)
        VALUES (@date, @content)
        ON CONFLICT(date) DO UPDATE SET
            content = excluded.content,
            updated_at = datetime('now')
        RETURNING id, date, content, created_at, updated_at
    `);
    db._getEntryByDate = db.prepare(`SELECT * FROM entries WHERE date = ?`);
    db._deleteByDate     = db.prepare(`DELETE FROM entries WHERE date = ?`);
    db._listByMonth        = db.prepare(`
        SELECT * FROM entries
        WHERE substr(date,1,7)=?             -- 'YYYY-MM'
        ORDER BY date ASC
    `);
    db._searchLike         = db.prepare(`
        SELECT * FROM entries
        WHERE content LIKE ?
        ORDER BY updated_at DESC
        LIMIT 100
    `);

    db._listRecent = db.prepare(`
        SELECT date, content
        FROM entries
        ORDER BY date DESC
        LIMIT ?
    `);
    db._listByYearMonthPreview = db.prepare(`
        SELECT date, substr(content, 1, 200) AS preview
        FROM entries
        WHERE substr(date, 1, 7) = ?
        ORDER BY date ASC
    `);
    db._upsertTemplate = db.prepare(`
        INSERT INTO templates (name, content, schedule)
        VALUES (@name, @content, @schedule)
        ON CONFLICT(name) DO UPDATE SET
            content = excluded.content,
            schedule = excluded.schedule,
            updated_at = datetime('now')
        RETURNING id, name, content, schedule, created_at, updated_at
    `);
    db._getTemplateByName = db.prepare(`SELECT * FROM templates WHERE name = ?`);
    db._deleteTemplate = db.prepare(`DELETE FROM templates WHERE name = ?`);
    db._listTemplates = db.prepare(`
        SELECT name,
               substr(content, 1, 200) AS preview,
               content,
               schedule,
               created_at,
               updated_at
        FROM templates
        ORDER BY updated_at DESC, name ASC
    `);
    db._getSetting = db.prepare(`SELECT value FROM settings WHERE key = ?`);
    db._setSetting = db.prepare(`
        INSERT INTO settings (key, value)
        VALUES (@key, @value)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        RETURNING key, value
    `);
    db._writerList = db.prepare(`
        SELECT
            id,
            title,
            substr(content, 1, 200) AS preview,
            content,
            folder_id,
            created_at,
            updated_at
        FROM writer_documents
        ORDER BY datetime(updated_at) DESC, id DESC
    `);
    db._writerGet = db.prepare(`SELECT * FROM writer_documents WHERE id = ?`);
    db._writerInsert = db.prepare(`
        INSERT INTO writer_documents (title, content, folder_id)
        VALUES (@title, @content, @folder_id)
        RETURNING id, title, content, folder_id, created_at, updated_at
    `);
    db._writerUpdate = db.prepare(`
        UPDATE writer_documents
        SET title = @title,
            content = @content,
            folder_id = @folder_id,
            updated_at = datetime('now')
        WHERE id = @id
        RETURNING id, title, content, folder_id, created_at, updated_at
    `);
    db._writerDelete = db.prepare(`DELETE FROM writer_documents WHERE id = ?`);
    db._writerRename = db.prepare(`
        UPDATE writer_documents
        SET title = @title,
            updated_at = datetime('now')
        WHERE id = @id
        RETURNING id, title, content, folder_id, created_at, updated_at
    `);
    db._writerListFolders = db.prepare(`
        SELECT id, name, parent_id, created_at, updated_at
        FROM writer_folders
        ORDER BY name COLLATE NOCASE
    `);
    db._writerGetFolder = db.prepare(`SELECT * FROM writer_folders WHERE id = ?`);
    db._writerInsertFolder = db.prepare(`
        INSERT INTO writer_folders (name, parent_id)
        VALUES (@name, @parent_id)
        RETURNING id, name, parent_id, created_at, updated_at
    `);
    db._writerRenameFolder = db.prepare(`
        UPDATE writer_folders
        SET name = @name,
            updated_at = datetime('now')
        WHERE id = @id
        RETURNING id, name, parent_id, created_at, updated_at
    `);
    db._writerDeleteFolder = db.prepare(`DELETE FROM writer_folders WHERE id = ?`);
    db._writerDocsClearFolder = db.prepare(`
        UPDATE writer_documents
        SET folder_id = NULL,
            updated_at = datetime('now')
        WHERE folder_id = @folder_id
    `);
}

function folderNameKey(parentId, name) {
    return `${parentId == null ? 'null' : parentId}::${String(name || '').toLowerCase()}`;
}

function ensureUniqueFolderName(baseName, parentId, existingKeys) {
    const normalized = normalizeWriterFolderName(baseName);
    let attempt = normalized;
    let counter = 2;
    while (existingKeys.has(folderNameKey(parentId, attempt))) {
        attempt = `${normalized} ${counter++}`;
    }
    existingKeys.add(folderNameKey(parentId, attempt));
    return attempt;
}

function buildFolderChildrenMap(folders) {
    const map = new Map();
    for (const folder of folders) {
        const parent = folder.parent_id == null ? null : folder.parent_id;
        if (!map.has(parent)) map.set(parent, []);
        map.get(parent).push(folder);
    }
    return map;
}

function collectFolderDescendants(childrenMap, rootId) {
    const out = [];
    const stack = [rootId];
    while (stack.length) {
        const current = stack.pop();
        out.push(current);
        const kids = childrenMap.get(current) || [];
        for (const child of kids) stack.push(child.id);
    }
    return out;
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1100,
        height: 800,
        backgroundColor: '#0b0f0c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    // Load the app from disk (no bundler/dev server)
    win.loadFile(path.join(__dirname, '..', '..', '..', 'packages', 'ui', 'index.html'));

//     if (isDev) {
//         try { win.webContents.openDevTools({ mode: 'detach' }); } catch {}
//     }
}

app.whenReady()
    .then(() => {
        try {
            initDB();
            createWindow();
        } catch (err) {
            console.error('Startup failure:', err);
        }
    })
    .catch(err => {
        console.error('App initialization error:', err);
    });

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC (strict, argument-validated) ----------
ipcMain.handle('entry:upsert', (evt, { date, content }) => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Bad date');
    if (typeof content !== 'string') throw new Error('Bad content');
    return db._upsertEntry.get({ date, content });
});

ipcMain.handle('entry:getByDate', (evt, date) => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Bad date');
    return db._getEntryByDate.get(date) || null;
});

ipcMain.handle('entry:deleteByDate', (evt, date) => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Bad date');
    return { deleted: db._deleteByDate.run(date).changes };
});

ipcMain.handle('entry:listMonth', (evt, ym) => {
    if (typeof ym !== 'string' || !/^\d{4}-\d{2}$/.test(ym)) throw new Error('Bad month');
    return db._listByMonth.all(ym);
});

ipcMain.handle('entry:search', (evt, q) => {
    if (typeof q !== 'string' || !q.trim()) return [];
    // If you enable FTS5 above, switch to: SELECT e.* FROM entries_fts f JOIN entries e ON e.id=f.rowid WHERE entries_fts MATCH ?;
    return db._searchLike.all(`%${q.replace(/%/g, '')}%`);
});

ipcMain.handle('entry:listRecent', (evt, limit) => {
    let n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) n = 15;
    if (n > 200) n = 200;
    return db._listRecent.all(n);
});

ipcMain.handle('entry:listByYearMonth', (evt, ym) => {
    if (typeof ym !== 'string' || !/^\d{4}-\d{2}$/.test(ym)) throw new Error('Bad month');
    return db._listByMonth.all(ym);
});

ipcMain.handle('template:upsert', (_evt, { name, content, schedule }) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Bad template name');
    if (typeof content !== 'string') throw new Error('Bad template content');

    let schedulePayload = null;
    if (schedule !== null && schedule !== undefined) {
        if (typeof schedule === 'string') {
            try {
                schedulePayload = JSON.parse(schedule);
            } catch (err) {
                throw new Error('Bad template schedule');
            }
        } else if (typeof schedule === 'object' && !Array.isArray(schedule)) {
            schedulePayload = schedule;
        } else {
            throw new Error('Bad template schedule');
        }
    }

    let scheduleJson = null;
    if (schedulePayload) {
        try {
            scheduleJson = JSON.stringify(schedulePayload);
        } catch (err) {
            throw new Error('Unable to serialize schedule');
        }
    }

    return db._upsertTemplate.get({ name: name.trim(), content, schedule: scheduleJson });
});

ipcMain.handle('template:getByName', (_evt, name) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Bad template name');
    return db._getTemplateByName.get(name.trim()) || null;
});

ipcMain.handle('template:list', () => {
    return db._listTemplates.all();
});

ipcMain.handle('template:delete', (_evt, name) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Bad template name');
    return { deleted: db._deleteTemplate.run(name.trim()).changes };
});

ipcMain.handle('writer:list', () => {
    return db._writerList.all().map(row => ({
        ...row,
        folder_id: row.folder_id == null ? null : row.folder_id
    }));
});

ipcMain.handle('writer:get', (_evt, id) => {
    const key = Number(id);
    if (!Number.isInteger(key) || key <= 0) throw new Error('Bad writer document id');
    const row = db._writerGet.get(key);
    return row || null;
});

ipcMain.handle('writer:create', (_evt, payload = {}) => {
    const title = normalizeWriterTitle(payload.title);
    const content = typeof payload.content === 'string' ? payload.content : '';
    const folderId = payload.folderId == null ? null : Number(payload.folderId);
    if (folderId != null && !Number.isInteger(folderId)) throw new Error('Bad folder id');
    return db._writerInsert.get({
        title,
        content,
        folder_id: folderId
    });
});

ipcMain.handle('writer:update', (_evt, payload = {}) => {
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Bad writer document id');
    const title = normalizeWriterTitle(payload.title);
    const content = typeof payload.content === 'string' ? payload.content : '';
    const folderId = payload.folderId == null ? null : Number(payload.folderId);
    if (folderId != null && !Number.isInteger(folderId)) throw new Error('Bad folder id');
    const row = db._writerUpdate.get({
        id,
        title,
        content,
        folder_id: folderId
    });
    if (!row) throw new Error('Writer document not found');
    return row;
});

ipcMain.handle('writer:delete', (_evt, id) => {
    const key = Number(id);
    if (!Number.isInteger(key) || key <= 0) throw new Error('Bad writer document id');
    return { deleted: db._writerDelete.run(key).changes };
});

ipcMain.handle('writer:duplicate', (_evt, payload = {}) => {
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Bad writer document id');
    const source = db._writerGet.get(id);
    if (!source) throw new Error('Document not found');
    const desiredTitle = typeof payload.title === 'string' ? payload.title : '';
    const title = normalizeWriterTitle(desiredTitle || `${source.title} Copy`);
    const folderId = payload.folderId == null ? source.folder_id ?? null : Number(payload.folderId);
    if (folderId != null && !Number.isInteger(folderId)) throw new Error('Bad folder id');
    return db._writerInsert.get({
        title,
        content: source.content || '',
        folder_id: folderId
    });
});

ipcMain.handle('writer:rename', (_evt, payload = {}) => {
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Bad writer document id');
    const title = normalizeWriterTitle(payload.title);
    const row = db._writerRename.get({ id, title });
    if (!row) throw new Error('Document not found');
    return row;
});

ipcMain.handle('writer:list-folders', () => {
    return db._writerListFolders.all().map(row => ({
        ...row,
        parent_id: row.parent_id == null ? null : row.parent_id
    }));
});

ipcMain.handle('writer:create-folder', (_evt, payload = {}) => {
    const parentId = payload.parentId == null ? null : Number(payload.parentId);
    if (parentId != null && (!Number.isInteger(parentId) || parentId <= 0)) throw new Error('Bad folder parent id');
    if (parentId != null) {
        const parent = db._writerGetFolder.get(parentId);
        if (!parent) throw new Error('Parent folder not found');
    }
    const folders = db._writerListFolders.all();
    const existingKeys = new Set(folders.map(f => folderNameKey(f.parent_id, f.name)));
    const desired = typeof payload.name === 'string' ? payload.name : 'New Folder';
    const name = ensureUniqueFolderName(desired, parentId, existingKeys);
    const row = db._writerInsertFolder.get({
        name,
        parent_id: parentId
    });
    return { ...row, parent_id: row.parent_id == null ? null : row.parent_id };
});

ipcMain.handle('writer:rename-folder', (_evt, payload = {}) => {
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Bad folder id');
    const folders = db._writerListFolders.all();
    const target = folders.find(f => f.id === id);
    if (!target) throw new Error('Folder not found');
    const parentId = target.parent_id == null ? null : target.parent_id;
    const normalized = normalizeWriterFolderName(payload.name);
    const existingKeys = new Set(
        folders
            .filter(f => f.id !== id)
            .map(f => folderNameKey(f.parent_id, f.name))
    );
    if (existingKeys.has(folderNameKey(parentId, normalized))) {
        throw new Error('A folder with that name already exists.');
    }
    const row = db._writerRenameFolder.get({ id, name: normalized });
    if (!row) throw new Error('Folder not found');
    return { ...row, parent_id: row.parent_id == null ? null : row.parent_id };
});

ipcMain.handle('writer:delete-folder', (_evt, id) => {
    const key = Number(id);
    if (!Number.isInteger(key) || key <= 0) throw new Error('Bad folder id');
    const folders = db._writerListFolders.all();
    const target = folders.find(f => f.id === key);
    if (!target) throw new Error('Folder not found');
    const childrenMap = buildFolderChildrenMap(folders);
    const cascade = collectFolderDescendants(childrenMap, key);
    const txn = db.transaction(() => {
        for (const folderId of cascade) {
            db._writerDocsClearFolder.run({ folder_id: folderId });
        }
        for (let i = cascade.length - 1; i >= 0; i--) {
            db._writerDeleteFolder.run(cascade[i]);
        }
    });
    txn();
    return { deleted: cascade.length };
});

ipcMain.handle('writer:duplicate-folder', (_evt, payload = {}) => {
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Bad folder id');
    const folders = db._writerListFolders.all();
    const target = folders.find(f => f.id === id);
    if (!target) throw new Error('Folder not found');
    const parentId = target.parent_id == null ? null : target.parent_id;
    const desired = typeof payload.name === 'string' && payload.name.trim().length
        ? payload.name
        : `${target.name} Copy`;
    const existingKeys = new Set(folders.map(f => folderNameKey(f.parent_id, f.name)));
    const childrenMap = buildFolderChildrenMap(folders);
    const created = [];
    const txn = db.transaction(() => {
        const rootName = ensureUniqueFolderName(desired, parentId, existingKeys);
        const createRecursive = (folder, newParentId, overrideName = null) => {
            const nameToUse = overrideName || ensureUniqueFolderName(folder.name, newParentId, existingKeys);
            const row = db._writerInsertFolder.get({ name: nameToUse, parent_id: newParentId });
            created.push(row);
            const children = childrenMap.get(folder.id) || [];
            for (const child of children) {
                createRecursive(child, row.id);
            }
        };
        createRecursive(target, parentId, rootName);
    });
    txn();
    if (!created.length) throw new Error('Unable to duplicate folder');
    const root = created[0];
    return { ...root, parent_id: root.parent_id == null ? null : root.parent_id };
});

ipcMain.handle('settings:get', (_evt, key) => {
    if (typeof key !== 'string' || !key.trim()) throw new Error('Bad settings key');
    const row = db._getSetting.get(key.trim());
    return row ? row.value : null;
});

ipcMain.handle('settings:set', (_evt, { key, value }) => {
    if (typeof key !== 'string' || !key.trim()) throw new Error('Bad settings key');
    if (typeof value !== 'string') throw new Error('Settings value must be string');
    db._setSetting.get({ key: key.trim(), value });
    return { ok: true };
});

ipcMain.handle('app:quit', () => {
    app.quit();
});

ipcMain.handle('export-journal', async (_event, args = {}) => {
    const { markdown, outputPath } = args;
    let { cssPath } = args;

    if (typeof markdown !== 'string') throw new Error('export-journal: markdown must be a string');
    if (typeof outputPath !== 'string' || !outputPath.trim()) throw new Error('export-journal: outputPath required');

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // Inline CSS for styling (resolve robustly in dev and in packaged builds)
    const cssText = readCssText(args.cssPath);
    const html = htmlForExport(markdown, cssText);

    const win = new BrowserWindow({
        show: false,
        webPreferences: { offscreen: true, sandbox: true }
    });

    try {
        await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        const pdf = await win.webContents.printToPDF({
            printBackground: true,
            pageSize: 'A4',
            landscape: false,
            margins: { marginType: 0 }
        });
        await fs.promises.writeFile(outputPath, pdf);
        win.destroy();
        return { ok: true, path: outputPath };
    } catch (e) {
        try { win.destroy(); } catch {}
        throw new Error('export-journal: printToPDF failed: ' + (e?.message || String(e)));
    }
});

// Resolve OS paths like 'downloads', 'documents', etc.
ipcMain.handle('get-path', (_evt, name) => {
    return app.getPath(name);
});

// Write plain text files for TXT export
ipcMain.handle('save-text', async (_evt, { content, outputPath }) => {
    if (typeof content !== 'string') throw new Error('save-text: content must be a string');
    if (typeof outputPath !== 'string' || !outputPath.trim()) throw new Error('save-text: outputPath required');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, content, 'utf8');
    return { ok: true, path: outputPath };
});
