const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

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
        SELECT date, substr(content, 1, 200) AS preview
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
    win.loadFile(path.join(__dirname, '..', 'index.html'));

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
    return db._listByYearMonthPreview.all(ym);
});

ipcMain.handle('app:quit', () => {
    app.quit();
});