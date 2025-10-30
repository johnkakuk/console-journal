import { openDB } from 'idb';

const DB_NAME = 'console-journal';
const DB_VERSION = 1;
const STORE = 'entries';

async function db() {
    const d = await openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'date' }); // 'YYYY-MM-DD'
                store.createIndex('ym', 'ym');
                store.createIndex('updated_at', 'updated_at');
            }
        }
    });
    return d;
}

export async function get(date) {
    const d = await db();
    return d.get(STORE, date);
}

export async function upsert({ date, content }) {
    const d = await db();
    const now = new Date().toISOString();
    const row = { date, content, updated_at: now, created_at: now, ym: date.slice(0,7) };
    await d.put(STORE, row);
    return row;
}

export async function listByMonth(ym) {
    const d = await db();
    return d.getAllFromIndex(STORE, 'ym', IDBKeyRange.only(ym));
}

export async function listRecent(n=15) {
    const d = await db();
    const tx = d.transaction(STORE);
    const idx = tx.store.index('updated_at');
    const all = [];
    let cursor = await idx.openCursor(null, 'prev'); // newest first
    while (cursor && all.length < n) {
        all.push(cursor.value);
        cursor = await cursor.continue();
    }
    await tx.done;
    return all.map(({ date, content }) => ({ date, content }));
}

export async function search(term) {
    // simple contains search; for larger stores you'd add an FTS worker
    term = term.toLowerCase();
    const d = await db();
    const all = await d.getAll(STORE);
    return all.filter(r => (r.content || '').toLowerCase().includes(term));
}