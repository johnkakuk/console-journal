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

const DEFAULT_WRITER_STATUS_NAME = 'None';
const DEFAULT_WRITER_STATUS_COLOR = '#00000000';
const DEFAULT_USER_STATUS_COLOR = '#37c978';
let defaultWriterStatusId = null;

function setDefaultWriterStatusId(id) {
    if (Number.isFinite(id) && id > 0) {
        defaultWriterStatusId = Number(id);
    }
    return defaultWriterStatusId;
}

function normalizeStatusColor(input, { allowTransparent = false } = {}) {
    if (typeof input !== 'string') {
        return allowTransparent ? DEFAULT_WRITER_STATUS_COLOR : DEFAULT_USER_STATUS_COLOR;
    }
    let value = input.trim();
    if (/^transparent$/i.test(value)) {
        return allowTransparent ? DEFAULT_WRITER_STATUS_COLOR : DEFAULT_USER_STATUS_COLOR;
    }
    if (/^#[0-9a-fA-F]{3}$/.test(value)) {
        const r = value[1];
        const g = value[2];
        const b = value[3];
        value = `#${r}${r}${g}${g}${b}${b}`;
    }
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
        return value.toLowerCase();
    }
    if (/^#[0-9a-fA-F]{8}$/.test(value)) {
        return value.toLowerCase();
    }
    return allowTransparent ? DEFAULT_WRITER_STATUS_COLOR : DEFAULT_USER_STATUS_COLOR;
}

function ensureDefaultWriterStatus() {
    if (!db) return null;
    const existing = db.prepare(`SELECT id FROM writer_statuses WHERE is_builtin = 1 LIMIT 1`).get();
    if (existing && existing.id) {
        return setDefaultWriterStatusId(existing.id);
    }
    const stmt = db.prepare(`
        INSERT INTO writer_statuses (name, color, is_builtin, order_index)
        VALUES (?, ?, 1, 0)
        RETURNING id
    `);
    const row = stmt.get(DEFAULT_WRITER_STATUS_NAME, DEFAULT_WRITER_STATUS_COLOR);
    if (row && row.id) {
        return setDefaultWriterStatusId(row.id);
    }
    return setDefaultWriterStatusId(1);
}

function getDefaultWriterStatusId() {
    if (defaultWriterStatusId == null) {
        return ensureDefaultWriterStatus();
    }
    return defaultWriterStatusId;
}

function normalizeStatusRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name || DEFAULT_WRITER_STATUS_NAME,
        color: typeof row.color === 'string'
            ? row.color
            : (row.is_builtin ? DEFAULT_WRITER_STATUS_COLOR : DEFAULT_USER_STATUS_COLOR),
        is_builtin: row.is_builtin === 1 || row.is_builtin === true,
        order_index: row.order_index == null ? 0 : row.order_index
    };
}

function sanitizeStatusId(raw) {
    const fallback = getDefaultWriterStatusId();
    const numeric = Number(raw);
    if (!Number.isInteger(numeric) || numeric <= 0) return fallback;
    if (!db) return fallback;
    if (db._writerGetStatus) {
        const row = db._writerGetStatus.get(numeric);
        return row ? numeric : fallback;
    }
    const stmt = db.prepare(`SELECT id FROM writer_statuses WHERE id = ?`);
    const row = stmt.get(numeric);
    return row ? numeric : fallback;
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
            order_index INTEGER NOT NULL DEFAULT 0,
            status_id INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS writer_statuses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#00000000',
            is_builtin INTEGER NOT NULL DEFAULT 0,
            order_index INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS writer_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            parent_id INTEGER,
            order_index INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_writer_documents_updated_at ON writer_documents (updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_writer_documents_folder ON writer_documents (folder_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_writer_statuses_name ON writer_statuses (name COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_writer_statuses_order ON writer_statuses (order_index, id);
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
    const ensuredStatusId = ensureDefaultWriterStatus();

    const templateColumns = db.prepare(`PRAGMA table_info(templates)`).all();
    if (!templateColumns.some(col => col.name === 'schedule')) {
        db.exec(`ALTER TABLE templates ADD COLUMN schedule TEXT`);
    }

    const folderColumns = db.prepare(`PRAGMA table_info(writer_folders)`).all();
    const folderSchemaInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='writer_folders'`).get();
    if (folderSchemaInfo && folderSchemaInfo.sql && folderSchemaInfo.sql.includes('UNIQUE')) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS writer_folders_tmp (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                parent_id INTEGER,
                order_index INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO writer_folders_tmp (id, name, parent_id, order_index, created_at, updated_at)
            SELECT id, name, parent_id, COALESCE(order_index, 0), created_at, updated_at FROM writer_folders;
            DROP TABLE writer_folders;
            ALTER TABLE writer_folders_tmp RENAME TO writer_folders;
        `);
    }
    if (!folderColumns.some(col => col.name === 'parent_id')) {
        db.exec(`
            ALTER TABLE writer_folders ADD COLUMN parent_id INTEGER;
            CREATE INDEX IF NOT EXISTS idx_writer_folders_parent ON writer_folders(parent_id);
        `);
    } else {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_writer_folders_parent ON writer_folders(parent_id);`);
    }
    if (!folderColumns.some(col => col.name === 'order_index')) {
        db.exec(`ALTER TABLE writer_folders ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0;`);
        db.exec(`UPDATE writer_folders SET order_index = id WHERE order_index = 0;`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_writer_folders_parent_order ON writer_folders(parent_id, order_index);`);

    const docColumns = db.prepare(`PRAGMA table_info(writer_documents)`).all();
    if (!docColumns.some(col => col.name === 'order_index')) {
        db.exec(`
            ALTER TABLE writer_documents ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0;
        `);
        db.exec(`UPDATE writer_documents SET order_index = id WHERE order_index = 0;`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_writer_documents_folder_order ON writer_documents(folder_id, order_index);`);
    const defaultStatusFallback = Number.isFinite(ensuredStatusId) ? ensuredStatusId : 1;
    if (!docColumns.some(col => col.name === 'status_id')) {
        db.exec(`
            ALTER TABLE writer_documents ADD COLUMN status_id INTEGER NOT NULL DEFAULT ${defaultStatusFallback};
        `);
        db.exec(`UPDATE writer_documents SET status_id = ${defaultStatusFallback} WHERE status_id IS NULL;`);
    } else {
        db.exec(`UPDATE writer_documents SET status_id = ${defaultStatusFallback} WHERE status_id IS NULL OR status_id <= 0;`);
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
            order_index,
            status_id,
            created_at,
            updated_at
        FROM writer_documents
        ORDER BY
            (folder_id IS NULL) DESC,
            folder_id,
            order_index,
            datetime(updated_at) DESC,
            id DESC
    `);
    db._writerGet = db.prepare(`SELECT * FROM writer_documents WHERE id = ?`);
    db._writerInsert = db.prepare(`
        INSERT INTO writer_documents (title, content, folder_id, order_index, status_id)
        VALUES (@title, @content, @folder_id, @order_index, @status_id)
        RETURNING id, title, content, folder_id, order_index, status_id, created_at, updated_at
    `);
    db._writerUpdate = db.prepare(`
        UPDATE writer_documents
        SET title = @title,
            content = @content,
            folder_id = @folder_id,
            status_id = COALESCE(@status_id, status_id),
            updated_at = datetime('now')
        WHERE id = @id
        RETURNING id, title, content, folder_id, order_index, status_id, created_at, updated_at
    `);
    db._writerDelete = db.prepare(`DELETE FROM writer_documents WHERE id = ?`);
    db._writerRename = db.prepare(`
        UPDATE writer_documents
        SET title = @title,
            updated_at = datetime('now')
        WHERE id = @id
        RETURNING id, title, content, folder_id, order_index, status_id, created_at, updated_at
    `);
    db._writerSetStatus = db.prepare(`
        UPDATE writer_documents
        SET status_id = @status_id,
            updated_at = datetime('now')
        WHERE id = @id
        RETURNING id, title, content, folder_id, order_index, status_id, created_at, updated_at
    `);
    db._writerListFolders = db.prepare(`
        SELECT id, name, parent_id, order_index, created_at, updated_at
        FROM writer_folders
        ORDER BY
            (parent_id IS NULL) DESC,
            parent_id,
            order_index,
            name COLLATE NOCASE
    `);
    db._writerGetFolder = db.prepare(`SELECT * FROM writer_folders WHERE id = ?`);
    db._writerInsertFolder = db.prepare(`
        INSERT INTO writer_folders (name, parent_id, order_index)
        VALUES (@name, @parent_id, @order_index)
        RETURNING id, name, parent_id, order_index, created_at, updated_at
    `);
    db._writerRenameFolder = db.prepare(`
        UPDATE writer_folders
        SET name = @name,
            updated_at = datetime('now')
        WHERE id = @id
        RETURNING id, name, parent_id, order_index, created_at, updated_at
    `);
    db._writerDeleteFolder = db.prepare(`DELETE FROM writer_folders WHERE id = ?`);
    db._writerDeleteDocsInFolder = db.prepare(`DELETE FROM writer_documents WHERE folder_id = ?`);
    db._writerMaxOrder = db.prepare(`
        SELECT COALESCE(MAX(order_index), -1) AS max_order
        FROM writer_documents
        WHERE (@folder_id IS NULL AND folder_id IS NULL) OR folder_id = @folder_id
    `);
    db._writerReorder = db.prepare(`
        UPDATE writer_documents
        SET folder_id = @folder_id,
            order_index = @order_index,
            updated_at = datetime('now')
        WHERE id = @id
    `);
    db._writerMaxFolderOrder = db.prepare(`
        SELECT COALESCE(MAX(order_index), -1) AS max_order
        FROM writer_folders
        WHERE (@parent_id IS NULL AND parent_id IS NULL) OR parent_id = @parent_id
    `);
    db._writerReorderFolders = db.prepare(`
        UPDATE writer_folders
        SET parent_id = @parent_id,
            order_index = @order_index,
            updated_at = datetime('now')
        WHERE id = @id
    `);
    db._writerListStatuses = db.prepare(`
        SELECT id, name, color, is_builtin, order_index
        FROM writer_statuses
        ORDER BY order_index ASC, id ASC
    `);
    db._writerInsertStatus = db.prepare(`
        INSERT INTO writer_statuses (name, color, order_index, is_builtin)
        VALUES (@name, @color, @order_index, 0)
        RETURNING id, name, color, is_builtin, order_index
    `);
    db._writerUpdateStatus = db.prepare(`
        UPDATE writer_statuses
        SET name = COALESCE(@name, name),
            color = COALESCE(@color, color),
            updated_at = datetime('now')
        WHERE id = @id AND is_builtin = 0
        RETURNING id, name, color, is_builtin, order_index
    `);
    db._writerDeleteStatus = db.prepare(`DELETE FROM writer_statuses WHERE id = ? AND is_builtin = 0`);
    db._writerGetStatus = db.prepare(`SELECT * FROM writer_statuses WHERE id = ?`);
    db._writerMaxStatusOrder = db.prepare(`SELECT COALESCE(MAX(order_index), -1) AS max_order FROM writer_statuses`);
    db._writerReorderStatuses = db.prepare(`
        UPDATE writer_statuses
        SET order_index = @order_index,
            updated_at = datetime('now')
        WHERE id = @id AND is_builtin = 0
    `);
    db._writerResetStatus = db.prepare(`
        UPDATE writer_documents
        SET status_id = @default_id,
            updated_at = datetime('now')
        WHERE status_id = @target_id
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

function normalizeDocRow(row) {
    if (!row) return null;
    return {
        ...row,
        folder_id: row.folder_id == null ? null : row.folder_id,
        order_index: row.order_index == null ? 0 : row.order_index,
        status_id: row.status_id == null ? getDefaultWriterStatusId() : row.status_id
    };
}

function nextFolderOrder(db, cache, parentId) {
    const key = parentId == null ? 'null' : String(parentId);
    if (!cache.has(key)) {
        const row = db._writerMaxFolderOrder.get({ parent_id: parentId });
        const base = row && Number.isFinite(row.max_order) ? Number(row.max_order) : -1;
        cache.set(key, base + 1);
    } else {
        cache.set(key, cache.get(key) + 1);
    }
    return cache.get(key);
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
    return db._writerList.all().map(normalizeDocRow).filter(Boolean);
});

ipcMain.handle('writer:get', (_evt, id) => {
    const key = Number(id);
    if (!Number.isInteger(key) || key <= 0) throw new Error('Bad writer document id');
    const row = db._writerGet.get(key);
    if (!row) return null;
    return normalizeDocRow(row);
});

ipcMain.handle('writer:create', (_evt, payload = {}) => {
    const title = normalizeWriterTitle(payload.title);
    const content = typeof payload.content === 'string' ? payload.content : '';
    const folderId = payload.folderId == null ? null : Number(payload.folderId);
    if (folderId != null && !Number.isInteger(folderId)) throw new Error('Bad folder id');
    const maxRow = db._writerMaxOrder.get({ folder_id: folderId });
    const baseOrder = maxRow && Number.isFinite(maxRow.max_order) ? Number(maxRow.max_order) : -1;
    const nextOrder = baseOrder + 1;
    const statusId = sanitizeStatusId(payload.statusId);
    const row = db._writerInsert.get({
        title,
        content,
        folder_id: folderId,
        order_index: nextOrder,
        status_id: statusId
    });
    return normalizeDocRow(row);
});

ipcMain.handle('writer:update', (_evt, payload = {}) => {
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Bad writer document id');
    const title = normalizeWriterTitle(payload.title);
    const content = typeof payload.content === 'string' ? payload.content : '';
    const folderId = payload.folderId == null ? null : Number(payload.folderId);
    if (folderId != null && !Number.isInteger(folderId)) throw new Error('Bad folder id');
    const statusId = payload.statusId == null ? null : sanitizeStatusId(payload.statusId);
    const row = db._writerUpdate.get({
        id,
        title,
        content,
        folder_id: folderId,
        status_id: statusId
    });
    if (!row) throw new Error('Writer document not found');
    return normalizeDocRow(row);
});

ipcMain.handle('writer:set-status', (_evt, payload = {}) => {
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Bad writer document id');
    const statusId = sanitizeStatusId(payload.statusId);
    const row = db._writerSetStatus.get({ id, status_id: statusId });
    if (!row) throw new Error('Writer document not found');
    return normalizeDocRow(row);
});

ipcMain.handle('writer:delete', (_evt, id) => {
    const key = Number(id);
    if (!Number.isInteger(key) || key <= 0) throw new Error('Bad writer document id');
    return { deleted: db._writerDelete.run(key).changes };
});

ipcMain.handle('writer:reorder-docs', (_evt, payload = {}) => {
    const moves = Array.isArray(payload.moves) ? payload.moves : [];
    if (!moves.length) return { updated: 0 };
    const txn = db.transaction(() => {
        for (const move of moves) {
            const id = Number(move.id);
            if (!Number.isInteger(id) || id <= 0) throw new Error('Bad writer document id');
            const folderId = move.folderId == null ? null : Number(move.folderId);
            if (folderId != null && !Number.isInteger(folderId)) throw new Error('Bad folder id');
            const orderIndex = Number(move.order);
            if (!Number.isFinite(orderIndex)) throw new Error('Bad order index');
            db._writerReorder.run({
                id,
                folder_id: folderId,
                order_index: orderIndex
            });
        }
    });
    txn();
    return { updated: moves.length };
});

ipcMain.handle('writer:reorder-folders', (_evt, payload = {}) => {
    const moves = Array.isArray(payload.moves) ? payload.moves : [];
    if (!moves.length) return { updated: 0 };
    const txn = db.transaction(() => {
        for (const move of moves) {
            const id = Number(move.id);
            if (!Number.isInteger(id) || id <= 0) throw new Error('Bad folder id');
            const parentId = move.parentId == null ? null : Number(move.parentId);
            if (parentId != null && !Number.isInteger(parentId)) throw new Error('Bad folder parent id');
            const orderIndex = Number(move.order);
            if (!Number.isFinite(orderIndex)) throw new Error('Bad folder order index');
            db._writerReorderFolders.run({
                id,
                parent_id: parentId,
                order_index: orderIndex
            });
        }
    });
    txn();
    return { updated: moves.length };
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
    const maxRow = db._writerMaxOrder.get({ folder_id: folderId });
    const nextOrder = (maxRow && Number.isFinite(maxRow.max_order) ? Number(maxRow.max_order) : -1) + 1;
    const statusId = sanitizeStatusId(payload.statusId == null ? source.status_id : payload.statusId);
    const row = db._writerInsert.get({
        title,
        content: source.content || '',
        folder_id: folderId,
        order_index: nextOrder,
        status_id: statusId
    });
    return normalizeDocRow(row);
});

ipcMain.handle('writer:rename', (_evt, payload = {}) => {
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Bad writer document id');
    const title = normalizeWriterTitle(payload.title);
    const row = db._writerRename.get({ id, title });
    if (!row) throw new Error('Document not found');
    return normalizeDocRow(row);
});

ipcMain.handle('writer:list-folders', () => {
    return db._writerListFolders.all().map(row => ({
        ...row,
        parent_id: row.parent_id == null ? null : row.parent_id,
        order_index: row.order_index == null ? 0 : row.order_index
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
    const maxRow = db._writerMaxFolderOrder.get({ parent_id: parentId });
    const nextOrder = (maxRow && Number.isFinite(maxRow.max_order) ? Number(maxRow.max_order) : -1) + 1;
    const row = db._writerInsertFolder.get({
        name,
        parent_id: parentId,
        order_index: nextOrder
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
            db._writerDeleteDocsInFolder.run(folderId);
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
    const orderCache = new Map();
    const writerDocs = db._writerList.all();
    const docsByFolder = new Map();
    for (const doc of writerDocs) {
        if (doc.folder_id == null) continue;
        const key = Number(doc.folder_id);
        if (!docsByFolder.has(key)) docsByFolder.set(key, []);
        docsByFolder.get(key).push({
            ...doc,
            order_index: Number.isFinite(doc.order_index) ? doc.order_index : Number(doc.order_index)
        });
    }
    const copyDocsIntoFolder = (sourceFolderId, destinationFolderId) => {
        const docs = docsByFolder.get(sourceFolderId);
        if (!docs || !docs.length) return;
        const sorted = docs.slice().sort((a, b) => {
            const orderDiff = (Number(a.order_index) || 0) - (Number(b.order_index) || 0);
            if (orderDiff !== 0) return orderDiff;
            return (a.id || 0) - (b.id || 0);
        });
        sorted.forEach((doc, idx) => {
            const orderIndex = Number.isFinite(doc.order_index) ? Number(doc.order_index) : idx;
            db._writerInsert.get({
                title: doc.title,
                content: doc.content || '',
                folder_id: destinationFolderId,
                order_index: orderIndex,
                status_id: sanitizeStatusId(doc.status_id)
            });
        });
    };
    const txn = db.transaction(() => {
        const rootName = ensureUniqueFolderName(desired, parentId, existingKeys);
        const createRecursive = (folder, newParentId, { forcedName = null, preserveChildNames = false } = {}) => {
            const nameToUse = forcedName != null
                ? forcedName
                : preserveChildNames
                    ? folder.name
                    : ensureUniqueFolderName(folder.name, newParentId, existingKeys);
            if (forcedName != null || preserveChildNames) {
                existingKeys.add(folderNameKey(newParentId, nameToUse));
            }
            const orderIndex = nextFolderOrder(db, orderCache, newParentId);
            const row = db._writerInsertFolder.get({ name: nameToUse, parent_id: newParentId, order_index: orderIndex });
            created.push(row);
            copyDocsIntoFolder(folder.id, row.id);
            const children = childrenMap.get(folder.id) || [];
            for (const child of children) {
                createRecursive(child, row.id, { preserveChildNames: true });
            }
        };
        createRecursive(target, parentId, { forcedName: rootName });
    });
    txn();
    if (!created.length) throw new Error('Unable to duplicate folder');
    const root = created[0];
    return { ...root, parent_id: root.parent_id == null ? null : root.parent_id };
});

ipcMain.handle('writer:list-statuses', () => {
    return db._writerListStatuses.all().map(normalizeStatusRow).filter(Boolean);
});

ipcMain.handle('writer:create-status', (_evt, payload = {}) => {
    const rawName = typeof payload.name === 'string' ? payload.name : '';
    const trimmed = rawName.trim();
    if (!trimmed) throw new Error('Status name required');
    if (trimmed.toLowerCase() === DEFAULT_WRITER_STATUS_NAME.toLowerCase()) {
        throw new Error('That status name is reserved');
    }
    const color = normalizeStatusColor(payload.color);
    const existing = db.prepare(`SELECT id FROM writer_statuses WHERE name COLLATE NOCASE = ?`).get(trimmed);
    if (existing && existing.id) throw new Error('A status with that name already exists');
    const maxRow = db._writerMaxStatusOrder.get();
    const nextOrder = (maxRow && Number.isFinite(maxRow.max_order) ? Number(maxRow.max_order) : -1) + 1;
    const row = db._writerInsertStatus.get({ name: trimmed, color, order_index: nextOrder });
    return normalizeStatusRow(row);
});

ipcMain.handle('writer:update-status', (_evt, payload = {}) => {
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Bad status id');
    const target = db._writerGetStatus.get(id);
    if (!target) throw new Error('Status not found');
    if (target.is_builtin) throw new Error('Cannot modify this status');
    let name = null;
    if (typeof payload.name === 'string') {
        const trimmed = payload.name.trim();
        if (trimmed) {
            const existing = db.prepare(`SELECT id FROM writer_statuses WHERE name COLLATE NOCASE = ? AND id != ?`).get(trimmed, id);
            if (existing && existing.id) throw new Error('A status with that name already exists');
            name = trimmed;
        }
    }
    const color = payload.color == null ? null : normalizeStatusColor(payload.color);
    const row = db._writerUpdateStatus.get({ id, name, color });
    if (!row) throw new Error('Status update failed');
    return normalizeStatusRow(row);
});

ipcMain.handle('writer:delete-status', (_evt, payload = {}) => {
    const value = typeof payload === 'object' && payload !== null ? payload.id : payload;
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Bad status id');
    const target = db._writerGetStatus.get(id);
    if (!target) return { deleted: 0 };
    if (target.is_builtin) throw new Error('Cannot delete this status');
    const defaultId = getDefaultWriterStatusId();
    const txn = db.transaction(() => {
        db._writerResetStatus.run({ default_id: defaultId, target_id: id });
        return db._writerDeleteStatus.run(id).changes;
    });
    const deleted = txn();
    return { deleted };
});

ipcMain.handle('writer:reorder-statuses', (_evt, payload = {}) => {
    const order = Array.isArray(payload.order) ? payload.order : [];
    const ids = order.map(Number).filter(id => Number.isInteger(id) && id > 0);
    if (!ids.length) return { updated: 0 };
    const txn = db.transaction(() => {
        ids.forEach((id, idx) => {
            db._writerReorderStatuses.run({ id, order_index: idx });
        });
    });
    txn();
    return { updated: ids.length };
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
