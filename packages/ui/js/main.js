/*
 * TODO:
 * - Add "quit" functionality to web app (have it close the tab)
 * 
/* ==== main.js — Shell Router & UI ================================================== */
import { startEditor } from './editor.js';
import { startWriter } from './writerApp.js';
import { startThemeApp } from './themeApp.js';
import { ensureActiveTheme, applyTheme, getDefaultTheme, saveActiveTheme } from './theme.js';
import { marked } from 'marked';
import { parseTemplateSchedule, normalizeTemplateSchedule, matchTemplateSchedule, cloneTemplateSchedule, TEMPLATE_SCHEDULE_WEIGHT } from './schedule.js';

// === date helpers ===
function todayISO(tz = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

// Shift today by N days in the given time zone, returns YYYY-MM-DD
function shiftISO(days = 0, tz = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const today = fmt.format(new Date()); // local day in tz
    const [y, m, d] = today.split('-').map(Number);
    // Build a stable UTC anchor at local noon to avoid DST edge cases
    const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const shifted = new Date(base.getTime() + days * 86400000);
    return fmt.format(shifted);
}

function isISODate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

function isMonthDay(s) { return /^\d{2}-\d{2}$/.test(s); }

function isYearMonth(s) { return /^\d{4}-\d{2}$/.test(s); }
function isMonth(s) { return /^(0[1-9]|1[0-2])$/.test(s); }

function resolveMonthPast(mm, tz = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    // Find the most recent year (<= today) that contains that month
    const today = todayISO(tz); // YYYY-MM-DD
    const year  = Number(today.slice(0,4));
    const ymThis = `${year}-${mm}`;
    return (ymThis > today.slice(0,7)) ? `${year-1}-${mm}` : ymThis;
}

function isValidISO(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    return dt.getUTCFullYear() === y && (dt.getUTCMonth() + 1) === m && dt.getUTCDate() === d;
}

// Resolve MM-DD to the most recent occurrence in the past (or today) in local tz
function resolveMonthDayPast(mmdd, tz = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    const today = todayISO(tz);           // 'YYYY-MM-DD'
    const year  = Number(today.slice(0, 4));
    const [mm, dd] = mmdd.split('-').map(n => Number(n));

    let y = year;
    // If this year's occurrence is in the future, go to last year
    const candidateThisYear = `${String(y)}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
    const chosenYear = (candidateThisYear > today) ? (y - 1) : y;

    // Handle invalid dates like 02-29 in non-leap years by walking back up to 4 years
    let tryYear = chosenYear;
    for (let i = 0; i < 4; i++, tryYear--) {
        if (isValidISO(tryYear, mm, dd)) {
            return `${String(tryYear)}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
        }
    }
    // Fallback: return today if somehow invalid repeatedly (shouldn't happen)
    return today;
}

function pickTemplateForDate(templates, dateStr) {
    if (!Array.isArray(templates) || !templates.length) return null;
    const matches = [];
    for (const tpl of templates) {
        const schedule = parseTemplateSchedule(tpl.schedule);
        if (!schedule) continue;
        const result = matchTemplateSchedule(schedule, dateStr);
        if (!result) continue;
        const weight = TEMPLATE_SCHEDULE_WEIGHT[result.level] ?? -1;
        matches.push({
            template: tpl,
            schedule: result.schedule || schedule,
            level: result.level,
            weight
        });
    }
    if (!matches.length) return null;
    matches.sort((a, b) => {
        if (a.weight !== b.weight) return b.weight - a.weight;
        const updatedA = a.template.updated_at || a.template.updatedAt || '';
        const updatedB = b.template.updated_at || b.template.updatedAt || '';
        if (updatedA !== updatedB) return updatedA > updatedB ? -1 : 1;
        const nameA = (a.template.name || '').toLowerCase();
        const nameB = (b.template.name || '').toLowerCase();
        return nameA.localeCompare(nameB);
    });
    return matches[0];
}

/* -----------------------------------------------------------------------------
 * DOM REFS & SHELL STATE
 * --------------------------------------------------------------------------- */
const input  = document.querySelector('#cmdInput');
const output = document.querySelector('#output');
const screen = document.querySelector('#screen');

// DB adapter: IndexedDB for browser/PWA, Electron bridge if available
let db = window.db;
if (!db) {
    if (!window.electronAPI) {
        // ===== Minimal IndexedDB adapter for PWA =====
        const DB_NAME = 'console-journal';
        const DB_VERSION = 5;
        const STORE = 'entries';
        const TEMPLATE_STORE = 'templates';
        const SETTINGS_STORE = 'settings';
        const WRITER_STORE = 'writer_docs';
        const WRITER_FOLDER_STORE = 'writer_folders';

        const openDB = () => new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const s = db.createObjectStore(STORE, { keyPath: 'date' });
                    s.createIndex('ym', 'ym', { unique: false });
                    s.createIndex('updated_at', 'updated_at', { unique: false });
                }
                if (!db.objectStoreNames.contains(TEMPLATE_STORE)) {
                    const t = db.createObjectStore(TEMPLATE_STORE, { keyPath: 'name' });
                    t.createIndex('updated_at', 'updated_at', { unique: false });
                }
                if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
                    db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains(WRITER_STORE)) {
                    const w = db.createObjectStore(WRITER_STORE, { keyPath: 'id', autoIncrement: true });
                    w.createIndex('updated_at', 'updated_at', { unique: false });
                    w.createIndex('folder_id', 'folder_id', { unique: false });
                    w.createIndex('title_lower', 'title_lower', { unique: false });
                }
                if (!db.objectStoreNames.contains(WRITER_FOLDER_STORE)) {
                    const f = db.createObjectStore(WRITER_FOLDER_STORE, { keyPath: 'id', autoIncrement: true });
                    f.createIndex('parent_id', 'parent_id', { unique: false });
                    f.createIndex('parent_name', ['parent_id', 'name_lower'], { unique: true });
                    f.createIndex('name_lower', 'name_lower', { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        const txRunStore = async (storeName, mode, fn) => {
            const dbi = await openDB();
            return new Promise((resolve, reject) => {
                const tx = dbi.transaction(storeName, mode);
                const store = tx.objectStore(storeName);
                let result;
                try { result = fn(store, tx); } catch (e) { reject(e); return; }
                tx.oncomplete = () => resolve(result);
                tx.onerror = () => reject(tx.error);
            });
        };
        const txRun = (mode, fn) => txRunStore(STORE, mode, fn);
        const txRunWriter = (mode, fn) => txRunStore(WRITER_STORE, mode, fn);
        const txRunFolders = (mode, fn) => txRunStore(WRITER_FOLDER_STORE, mode, fn);

        function normalizeWriterTitle(title) {
            const trimmed = String(title ?? '').trim();
            return trimmed || 'Untitled Document';
        }

        function normalizeWriterFolderName(name) {
            const trimmed = String(name ?? '').trim();
            return trimmed || 'New Folder';
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
                const children = childrenMap.get(current) || [];
                for (const child of children) stack.push(child.id);
            }
            return out;
        }

        async function clearDocsForFolder(folderId) {
            const now = new Date().toISOString();
            return txRunWriter('readwrite', store => {
                return new Promise((resolve, reject) => {
                    const index = store.index('folder_id');
                    const range = IDBKeyRange.only(folderId);
                    const cursor = index.openCursor(range);
                    cursor.onsuccess = () => {
                        const cur = cursor.result;
                        if (!cur) {
                            resolve({ cleared: true });
                            return;
                        }
                        const value = { ...cur.value, folder_id: null, updated_at: now };
                        const updateReq = cur.update(value);
                        updateReq.onsuccess = () => cur.continue();
                        updateReq.onerror = () => reject(updateReq.error);
                    };
                    cursor.onerror = () => reject(cursor.error);
                });
            });
        }

        db = {
            async get(date) {
                return txRun('readonly', store => {
                    const req = store.get(date);
                    return new Promise((resolve, reject) => {
                        req.onsuccess = () => resolve(req.result || null);
                        req.onerror = () => reject(req.error);
                    });
                });
            },
            async upsert(date, content) {
                const now = new Date().toISOString();
                const ym = String(date).slice(0, 7);
                const row = { date, content: content ?? '', created_at: now, updated_at: now, ym };
                await txRun('readwrite', store => store.put(row));
                return row;
            },
            async listByYearMonth(ym) {
                return txRun('readonly', store => {
                    const idx = store.index('ym');
                    const req = idx.getAll(IDBKeyRange.only(ym));
                    return new Promise((resolve, reject) => {
                        req.onsuccess = () => resolve(req.result || []);
                        req.onerror = () => reject(req.error);
                    });
                });
            },
            async listRecent(limit = 15) {
                return txRun('readonly', store => {
                    const idx = store.index('updated_at');
                    const out = [];
                    return new Promise((resolve, reject) => {
                        const cursorReq = idx.openCursor(null, 'prev');
                        cursorReq.onsuccess = () => {
                            const cur = cursorReq.result;
                            if (cur && out.length < limit) { out.push(cur.value); cur.continue(); }
                            else resolve(out);
                        };
                        cursorReq.onerror = () => reject(cursorReq.error);
                    });
                });
            },
            async search(q) {
                const needle = String(q).toLowerCase();
                return txRun('readonly', store => {
                    const out = [];
                    return new Promise((resolve, reject) => {
                        const req = store.openCursor();
                        req.onsuccess = () => {
                            const cur = req.result;
                            if (!cur) return resolve(out);
                            const v = cur.value;
                            if ((v.content || '').toLowerCase().includes(needle)) out.push(v);
                            cur.continue();
                        };
                        req.onerror = () => reject(req.error);
                    });
                });
            },
            async delete(date) {
                return txRun('readwrite', store => {
                    const req = store.delete(date);
                    return new Promise((resolve, reject) => {
                        req.onsuccess = () => resolve(true);
                        req.onerror = () => reject(req.error);
                    });
                });
            },
            async saveTemplate(name, content = '', schedule = null) {
                const trimmed = String(name ?? '').trim();
                if (!trimmed) throw new Error('Template name required');
                const now = new Date().toISOString();
                const normalizedSchedule = schedule
                    ? normalizeTemplateSchedule(schedule, { defaultAnchorDate: schedule.anchorDate })
                    : null;
                return txRunStore(TEMPLATE_STORE, 'readwrite', store => {
                    return new Promise((resolve, reject) => {
                        const getReq = store.get(trimmed);
                        getReq.onsuccess = () => {
                            const existing = getReq.result;
                            const row = {
                                name: trimmed,
                                content: String(content ?? ''),
                                created_at: existing?.created_at ?? now,
                                updated_at: now,
                                schedule: normalizedSchedule ? cloneTemplateSchedule(normalizedSchedule) : null
                            };
                            const putReq = store.put(row);
                            putReq.onsuccess = () => resolve(row);
                            putReq.onerror = () => reject(putReq.error);
                        };
                        getReq.onerror = () => reject(getReq.error);
                    });
                });
            },
            async getTemplate(name) {
                const trimmed = String(name ?? '').trim();
                if (!trimmed) throw new Error('Template name required');
                return txRunStore(TEMPLATE_STORE, 'readonly', store => {
                    return new Promise((resolve, reject) => {
                        const req = store.get(trimmed);
                        req.onsuccess = () => {
                            const row = req.result || null;
                            if (!row) return resolve(null);
                            const schedule = parseTemplateSchedule(row.schedule);
                            resolve({ ...row, schedule });
                        };
                        req.onerror = () => reject(req.error);
                    });
                });
            },
            async listTemplates(limit = 200) {
                const max = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 200;
                return txRunStore(TEMPLATE_STORE, 'readonly', store => {
                    return new Promise((resolve, reject) => {
                        const idx = store.index('updated_at');
                        const out = [];
                        const cursorReq = idx.openCursor(null, 'prev');
                        cursorReq.onsuccess = () => {
                            const cur = cursorReq.result;
                            if (cur && out.length < max) {
                                const value = cur.value || {};
                                const schedule = parseTemplateSchedule(value.schedule);
                                out.push({
                                    ...value,
                                    schedule,
                                    preview: (value.content || '').slice(0, 200)
                                });
                                cur.continue();
                            } else {
                                resolve(out);
                            }
                        };
                        cursorReq.onerror = () => reject(cursorReq.error);
                    });
                });
            },
            async deleteTemplate(name) {
                const trimmed = String(name ?? '').trim();
                if (!trimmed) throw new Error('Template name required');
                return txRunStore(TEMPLATE_STORE, 'readwrite', store => {
                    return new Promise((resolve, reject) => {
                        const getReq = store.get(trimmed);
                        getReq.onsuccess = () => {
                            const exists = !!getReq.result;
                            if (!exists) {
                                resolve({ deleted: 0 });
                                return;
                            }
                            const delReq = store.delete(trimmed);
                            delReq.onsuccess = () => resolve({ deleted: 1 });
                            delReq.onerror = () => reject(delReq.error);
                        };
                        getReq.onerror = () => reject(getReq.error);
                    });
                });
            },
            writer: {
                async list() {
                    return txRunWriter('readonly', store => {
                        const idx = store.index('updated_at');
                        const out = [];
                        return new Promise((resolve, reject) => {
                            const cursor = idx.openCursor(null, 'prev');
                            cursor.onsuccess = () => {
                                const cur = cursor.result;
                                if (!cur) return resolve(out);
                                out.push(cur.value);
                                cur.continue();
                            };
                            cursor.onerror = () => reject(cursor.error);
                        });
                    });
                },
                async get(id) {
                    const key = Number(id);
                    if (!Number.isFinite(key)) throw new Error('Writer document id required');
                    return txRunWriter('readonly', store => {
                        const req = store.get(key);
                        return new Promise((resolve, reject) => {
                            req.onsuccess = () => resolve(req.result || null);
                            req.onerror = () => reject(req.error);
                        });
                    });
                },
                async create({ title, content = '', folderId = null } = {}) {
                    const now = new Date().toISOString();
                    const titleNormalized = normalizeWriterTitle(title);
                    const doc = {
                        title: titleNormalized,
                        title_lower: titleNormalized.toLowerCase(),
                        content: String(content ?? ''),
                        folder_id: folderId == null ? null : Number(folderId),
                        created_at: now,
                        updated_at: now
                    };
                    return txRunWriter('readwrite', store => {
                        const req = store.add(doc);
                        return new Promise((resolve, reject) => {
                            req.onsuccess = () => resolve({ ...doc, id: req.result });
                            req.onerror = () => reject(req.error);
                        });
                    });
                },
                async update({ id, title, content = '', folderId = null } = {}) {
                    const key = Number(id);
                    if (!Number.isFinite(key)) throw new Error('Writer document id required');
                    const now = new Date().toISOString();
                    const titleNormalized = normalizeWriterTitle(title);
                    return txRunWriter('readwrite', store => {
                        const getReq = store.get(key);
                        return new Promise((resolve, reject) => {
                            getReq.onsuccess = () => {
                                const existing = getReq.result;
                                if (!existing) {
                                    reject(new Error('Document not found'));
                                    return;
                                }
                                const next = {
                                    ...existing,
                                    title: titleNormalized,
                                    title_lower: titleNormalized.toLowerCase(),
                                    content: String(content ?? ''),
                                    folder_id: folderId == null ? null : Number(folderId),
                                    updated_at: now
                                };
                                const putReq = store.put(next);
                                putReq.onsuccess = () => resolve(next);
                                putReq.onerror = () => reject(putReq.error);
                            };
                            getReq.onerror = () => reject(getReq.error);
                        });
                    });
                },
                async delete(id) {
                    const key = Number(id);
                    if (!Number.isFinite(key)) throw new Error('Writer document id required');
                    return txRunWriter('readwrite', store => {
                        const req = store.delete(key);
                        return new Promise((resolve, reject) => {
                            req.onsuccess = () => resolve({ deleted: 1 });
                            req.onerror = () => reject(req.error);
                        });
                    });
                },
                async duplicate(id, { title, folderId = null } = {}) {
                    const source = await this.get(id);
                    if (!source) throw new Error('Document not found');
                    const nextTitle = normalizeWriterTitle(title || `${source.title} Copy`);
                    return this.create({
                        title: nextTitle,
                        content: source.content ?? '',
                        folderId: folderId ?? source.folder_id ?? null
                    });
                },
                async rename(id, title) {
                    const key = Number(id);
                    if (!Number.isFinite(key)) throw new Error('Writer document id required');
                    const normalized = normalizeWriterTitle(title);
                    return txRunWriter('readwrite', store => {
                        const getReq = store.get(key);
                        return new Promise((resolve, reject) => {
                            getReq.onsuccess = () => {
                                const existing = getReq.result;
                                if (!existing) {
                                    reject(new Error('Document not found'));
                                    return;
                                }
                                const next = {
                                    ...existing,
                                    title: normalized,
                                    title_lower: normalized.toLowerCase(),
                                    updated_at: new Date().toISOString()
                                };
                                const putReq = store.put(next);
                                putReq.onsuccess = () => resolve(next);
                                putReq.onerror = () => reject(putReq.error);
                            };
                            getReq.onerror = () => reject(getReq.error);
                        });
                    });
                },
                async listFolders() {
                    return txRunFolders('readonly', store => {
                        const req = store.getAll();
                        return new Promise((resolve, reject) => {
                            req.onsuccess = () => {
                                const rows = (req.result || []).map(row => ({
                                    ...row,
                                    parent_id: row.parent_id == null ? null : row.parent_id
                                }));
                                rows.sort((a, b) => a.name_lower.localeCompare(b.name_lower));
                                resolve(rows);
                            };
                            req.onerror = () => reject(req.error);
                        });
                    });
                },
                async getFolder(id) {
                    const key = Number(id);
                    if (!Number.isFinite(key)) throw new Error('Folder id required');
                    return txRunFolders('readonly', store => {
                        const req = store.get(key);
                        return new Promise((resolve, reject) => {
                            req.onsuccess = () => {
                                const row = req.result;
                                if (!row) resolve(null);
                                else resolve({ ...row, parent_id: row.parent_id == null ? null : row.parent_id });
                            };
                            req.onerror = () => reject(req.error);
                        });
                    });
                },
                async createFolder({ name, parentId = null } = {}) {
                    const parentKey = parentId == null ? null : Number(parentId);
                    if (parentKey != null && !Number.isInteger(parentKey)) throw new Error('Folder id required');
                    if (parentKey != null) {
                        const parent = await this.getFolder(parentKey);
                        if (!parent) throw new Error('Parent folder not found');
                    }
                    const existing = await this.listFolders();
                    const existingKeys = new Set(existing.map(f => folderNameKey(f.parent_id, f.name)));
                    const finalName = ensureUniqueFolderName(name, parentKey, existingKeys);
                    const now = new Date().toISOString();
                    return txRunFolders('readwrite', store => {
                        const doc = {
                            name: finalName,
                            name_lower: finalName.toLowerCase(),
                            parent_id: parentKey == null ? null : parentKey,
                            created_at: now,
                            updated_at: now
                        };
                        const req = store.add(doc);
                        return new Promise((resolve, reject) => {
                            req.onsuccess = () => resolve({ ...doc, id: req.result });
                            req.onerror = () => reject(req.error);
                        });
                    });
                },
                async renameFolder(id, name) {
                    const key = Number(id);
                    if (!Number.isFinite(key)) throw new Error('Folder id required');
                    const folder = await this.getFolder(key);
                    if (!folder) throw new Error('Folder not found');
                    const normalized = normalizeWriterFolderName(name);
                    const existing = await this.listFolders();
                    const existingKeys = new Set(
                        existing
                            .filter(f => f.id !== key)
                            .map(f => folderNameKey(f.parent_id, f.name))
                    );
                    if (existingKeys.has(folderNameKey(folder.parent_id, normalized))) {
                        throw new Error('A folder with that name already exists.');
                    }
                    const now = new Date().toISOString();
                    return txRunFolders('readwrite', store => {
                        const req = store.get(key);
                        return new Promise((resolve, reject) => {
                            req.onsuccess = () => {
                                const existingRow = req.result;
                                if (!existingRow) {
                                    reject(new Error('Folder not found'));
                                    return;
                                }
                                const next = {
                                    ...existingRow,
                                    name: normalized,
                                    name_lower: normalized.toLowerCase(),
                                    updated_at: now
                                };
                                const putReq = store.put(next);
                                putReq.onsuccess = () => resolve({ ...next, parent_id: next.parent_id == null ? null : next.parent_id });
                                putReq.onerror = () => reject(putReq.error);
                            };
                            req.onerror = () => reject(req.error);
                        });
                    });
                },
                async deleteFolder(id) {
                    const key = Number(id);
                    if (!Number.isFinite(key)) throw new Error('Folder id required');
                    const folders = await this.listFolders();
                    const target = folders.find(f => f.id === key);
                    if (!target) throw new Error('Folder not found');
                    const childrenMap = buildFolderChildrenMap(folders);
                    const cascade = collectFolderDescendants(childrenMap, key);
                    for (const folderId of cascade) {
                        await clearDocsForFolder(folderId);
                    }
                    await txRunFolders('readwrite', store => {
                        cascade.forEach(folderId => store.delete(folderId));
                        return cascade.length;
                    });
                    return { deleted: cascade.length };
                },
                async duplicateFolder(id, { name } = {}) {
                    const key = Number(id);
                    if (!Number.isFinite(key)) throw new Error('Folder id required');
                    const folders = await this.listFolders();
                    const target = folders.find(f => f.id === key);
                    if (!target) throw new Error('Folder not found');
                    const parentId = target.parent_id == null ? null : target.parent_id;
                    const rootName = name ? name : `${target.name} Copy`;
                    const createdRoot = await this.createFolder({ name: rootName, parentId });
                    const childrenMap = buildFolderChildrenMap(folders);
                    const queue = (childrenMap.get(target.id) || []).map(child => ({ folder: child, parentId: createdRoot.id }));
                    while (queue.length) {
                        const { folder: child, parentId: destParent } = queue.shift();
                        const childCreated = await this.createFolder({ name: child.name, parentId: destParent });
                        const grandchildren = childrenMap.get(child.id) || [];
                        for (const grandChild of grandchildren) {
                            queue.push({ folder: grandChild, parentId: childCreated.id });
                        }
                    }
                    return createdRoot;
                }
            }
        };
        window.db = db;
        if (!window.settings) {
            window.settings = {
                async get(key) {
                    const trimmed = String(key ?? '').trim();
                    if (!trimmed) return null;
                    return txRunStore(SETTINGS_STORE, 'readonly', store => {
                        return new Promise((resolve, reject) => {
                            const req = store.get(trimmed);
                            req.onsuccess = () => resolve(req.result ? String(req.result.value ?? '') : null);
                            req.onerror = () => reject(req.error);
                        });
                    });
                },
                async set(key, value) {
                    const trimmed = String(key ?? '').trim();
                    if (!trimmed) throw new Error('Settings key required');
                    const strValue = String(value ?? '');
                    return txRunStore(SETTINGS_STORE, 'readwrite', store => {
                        return new Promise((resolve, reject) => {
                            const req = store.put({ key: trimmed, value: strValue });
                            req.onsuccess = () => resolve({ ok: true });
                            req.onerror = () => reject(req.error);
                        });
                    });
                }
            };
        }
    } else {
        // Electron: use preload IPC bridges via a generic invoke fallback
        const invoke = (ch, ...args) =>
            (window.electronAPI && typeof window.electronAPI.invoke === 'function')
                ? window.electronAPI.invoke(ch, ...args)
                : Promise.reject(new Error('electronAPI.invoke not available'));

        db = {
            get:           (date)              => invoke('entry:getByDate', date),
            upsert:        (date, content='') => invoke('entry:upsert', { date, content }),
            listRecent:    (limit=15)          => invoke('entry:listRecent', limit),
            listByYearMonth:(ym)               => invoke('entry:listByYearMonth', ym),
            search:        (q)                 => invoke('entry:search', q),
            delete:        async (date) => {
                const res = await invoke('entry:deleteByDate', date);
                return !!(res && res.deleted);
            },
            saveTemplate: async (name, content='', schedule=null) => {
                const normalized = schedule
                    ? normalizeTemplateSchedule(schedule, { defaultAnchorDate: schedule.anchorDate })
                    : null;
                const res = await invoke('template:upsert', { name, content, schedule: normalized });
                if (!res) return res;
                return { ...res, schedule: parseTemplateSchedule(res.schedule) };
            },
            getTemplate:  async (name) => {
                const res = await invoke('template:getByName', name);
                if (!res) return null;
                return { ...res, schedule: parseTemplateSchedule(res.schedule) };
            },
            listTemplates: async () => {
                const rows = await invoke('template:list');
                if (!Array.isArray(rows)) return [];
                return rows.map(row => ({
                    ...row,
                    schedule: parseTemplateSchedule(row.schedule)
                }));
            },
            deleteTemplate: (name)           => invoke('template:delete', name),
            writer: {
                list:      () => invoke('writer:list'),
                get:       (id) => invoke('writer:get', id),
                create:    (payload = {}) => invoke('writer:create', payload),
                update:    (payload = {}) => invoke('writer:update', payload),
                delete:    (id) => invoke('writer:delete', id),
                duplicate: (id, overrides = {}) => invoke('writer:duplicate', { id, ...overrides }),
                rename:    (id, title) => invoke('writer:rename', { id, title }),
                listFolders:    () => invoke('writer:list-folders'),
                createFolder:   (payload = {}) => invoke('writer:create-folder', payload),
                renameFolder:   (id, name) => invoke('writer:rename-folder', { id, name }),
                deleteFolder:   (id) => invoke('writer:delete-folder', id),
                duplicateFolder:(id, overrides = {}) => invoke('writer:duplicate-folder', { id, ...overrides })
            }
        };
    }
}

const bootTheme = await ensureActiveTheme();
applyTheme(bootTheme);

const AUTOSAVE_SETTING_KEY = 'autosave_enabled';
let autosaveEnabled = false;

async function loadAutosavePreference() {
    try {
        if (window.settings && typeof window.settings.get === 'function') {
            const stored = await window.settings.get(AUTOSAVE_SETTING_KEY);
            if (stored != null) {
                autosaveEnabled = stored === true || stored === '1' || stored === 'true';
                return;
            }
        }
    } catch (_) {}
    try {
        const stored = window.localStorage?.getItem?.(AUTOSAVE_SETTING_KEY);
        if (stored != null) {
            autosaveEnabled = stored === '1' || stored === 'true';
            return;
        }
    } catch (_) {}
    autosaveEnabled = false;
}

await loadAutosavePreference();

// Whether a subprogram (team.js) is currently consuming input
let inputState = false;
let activeProgram = null; // holds an active subprogram (if any)

// Visible prompt and command registry
const state = {
    prompt: 'user:~$',
    commands: {},
};

async function persistAutosavePreference(enabled) {
    const value = enabled ? '1' : '0';
    try {
        if (window.settings && typeof window.settings.set === 'function') {
            await window.settings.set(AUTOSAVE_SETTING_KEY, value);
            return;
        }
    } catch (_) {}
    try {
        window.localStorage?.setItem?.(AUTOSAVE_SETTING_KEY, value);
    } catch (_) {}
}

async function setAutosavePreference(enabled, { announce = true } = {}) {
    autosaveEnabled = !!enabled;
    await persistAutosavePreference(autosaveEnabled);
    if (activeProgram && typeof activeProgram.setAutosave === 'function') {
        try { activeProgram.setAutosave(autosaveEnabled); } catch (_) {}
    }
    if (announce) {
        const status = autosaveEnabled ? 'on' : 'off';
        print(`<div class="soft">autosave: ${status}</div>`);
    }
}

// Command history
const history = [];
let historyIndex = -1;

// Minimal shell API for subprograms (e.g., editor.js)
const shell = {
    print,
    esc,
    setPrompt(p) { state.prompt = p; },
    resetPrompt() { state.prompt = 'user:~$'; },
    enter(program) { activeProgram = program; },
    exit() {
        // Ask any active program to clean up first
        if (activeProgram && typeof activeProgram.destroy === 'function') {
            try { activeProgram.destroy(); } catch {}
        }
        // Hard-remove any lingering list UI containers from the DOM
        try {
            const strayLists = document.querySelectorAll('.listui');
            strayLists.forEach(n => n.remove());
        } catch {}
        activeProgram = null;
        this.resetPrompt();
        focusInput();
    },
    suspend() {
        if (activeProgram && typeof activeProgram.disable === 'function') {
            try { activeProgram.disable(); } catch {}
        }
        activeProgram = null;
        this.resetPrompt();
        focusInput();
    },
};

/* -----------------------------------------------------------------------------
 * UTILITIES
 * --------------------------------------------------------------------------- */

// Escape HTML before injecting into the DOM
function esc(s){
    return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
} 

// Browser download helper for TXT fallback (PWA)
if (!window.downloadText) {
    window.downloadText = function (content, filename) {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    };
}

// Append rendered HTML to the output and keep view scrolled to the bottom
function print(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    output.appendChild(div);
    scrollToBottom();
};

const now   = () => new Date();
const stamp = () => now().toLocaleTimeString();

function scrollToBottom() {
    screen.scrollTop = screen.scrollHeight;
};

// Echo the current input line into the transcript and clear the input
function newline() {
  print(
    `<div class="line">
       <span class="prompt">${esc(state.prompt)}</span>
       <span class="muted">${esc(input.value)}</span>
     </div>`
  );
  input.value = '';
};

// Initial banner
function banner() {
  print(`<div class="soft">console-journal <span class="muted">v1.0</span> — <span class="stamp">${todayISO()}</span></div>`);
  print(`<div class="muted">Type <span class="kbd">tutorial</span> for help.</div>`);
};

/* -----------------------------------------------------------------------------
 * CONSOLE BRIDGE (pipe console.* into terminal output)
 * --------------------------------------------------------------------------- */

const native = {
    log:   console.log,
    info:  console.info,
    warn:  console.warn,
    error: console.error,
};

console.log   = (...args) => { native.log(...args);   print(`<span class="ok">${esc(args.join(' '))}</span>`);   };
console.info  = (...args) => { native.info(...args);  print(`<span class="info">${esc(args.join(' '))}</span>`); };
console.warn  = (...args) => { native.warn(...args);  print(`<span class="warn">${esc(args.join(' '))}</span>`); };
console.error = (...args) => { native.error(...args); print(`<span class="error">${esc(args.join(' '))}</span>`); };

/* -----------------------------------------------------------------------------
 * COMMAND REGISTRY & EXECUTION
 * --------------------------------------------------------------------------- */

// Register a new command
function register(name, handler, desc) {
    state.commands[name] = { handler, desc };
};

// Tokenizer that respects quotes:   foo "bar baz"  -> ["foo","bar baz"]
function parseArgs(str) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(str))) out.push(m[1] ?? m[2] ?? m[3]);
    return out;
};

// Execute a single command line
const exec = async (line) => {
    const argv = parseArgs(line.trim());
    const cmd  = argv.shift();
    if (!cmd) return;

    // Save non-empty commands to history
    if (line.trim()) {
        history.push(line.trim());
        historyIndex = history.length;
    }

    const item = state.commands[cmd];
    if (!item) { console.error(`command not found: ${cmd}`); return; }

    try {
       await item.handler(argv);
    } catch (err) {
        const msg = err && err.stack ? err.stack : (err?.message || String(err));
        print(`<div class="error">${esc(msg)}</div>`);
        console.error(err);
    }
};

/* -----------------------------------------------------------------------------
 * KEY HANDLER & CARET
 * --------------------------------------------------------------------------- */

const handleKeydown = async (e) => {
    // Execute commands on Enter
    if (e.key === 'Enter') {
        e.preventDefault();

        // If a subprogram provides its own key handler (e.g., list UI), route Enter there
        if (activeProgram && typeof activeProgram.onKey === 'function') {
            activeProgram.onKey(e);
            return;
        }

        const line = input.value;
        newline();

        // If a subprogram is active and expects line-based input, deliver the line
        if (activeProgram && typeof activeProgram.consume === 'function') {
            try {
                await activeProgram.consume(line);
            } catch (err) {
                const msg = err && err.stack ? err.stack : (err?.message || String(err));
                print(`<div class="error">${esc(msg)}</div>`);
                console.error(err);
            }
            return;
        }

        // Normal command execution (no subprogram)
        await exec(line);
        return;
    }

    // Command history navigation (only at root shell)
    if (!activeProgram) {
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (historyIndex > 0) {
                historyIndex--;
                input.value = history[historyIndex] || '';
                scheduleCaret();
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (historyIndex < history.length - 1) {
                historyIndex++;
                input.value = history[historyIndex] || '';
            } else {
                historyIndex = history.length;
                input.value = '';
            }
            scheduleCaret();
        }
    }

    // Navigation for active programs ("list", "search", etc.)
    if (activeProgram && typeof activeProgram.onKey === 'function') {
        // Keys that the active program (e.g., list UI) should receive directly
        const navKeys = [
            'ArrowUp','ArrowDown','PageUp','PageDown','Home','End','Escape','Enter',
            'Delete','Backspace','y','Y','n','N'
        ];
        if (navKeys.includes(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            activeProgram.onKey(e);
            return;
        } else {
            // Any other key suspends list mode and lets typing continue
            shell.suspend();
            return;
        }
    }
};

const focusInput = () => {
    input.focus();
    updateCaret();
};

// Fake caret that follows the real cursor inside the input
const caret = document.querySelector('.caret');

const updateCaret = () => {
    const inputRect = input.getBoundingClientRect();
    const styles = getComputedStyle(input);

    // Hidden mirror to measure caret X position with accurate typography
    const mirror = document.createElement('span');
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre';

    // Typography fidelity: copy critical properties that affect glyph metrics
    mirror.style.font = styles.font; // includes weight, size/line-height, family
    mirror.style.letterSpacing = styles.letterSpacing;
    mirror.style.fontKerning = styles.fontKerning;
    mirror.style.fontFeatureSettings = styles.fontFeatureSettings;
    mirror.style.textTransform = styles.textTransform;
    mirror.style.textRendering = styles.textRendering;

    // Content up to caret
    mirror.textContent = input.value.slice(0, input.selectionStart);

    document.body.appendChild(mirror);
    const measured = mirror.getBoundingClientRect().width;
    document.body.removeChild(mirror);

    const paddingLeft = parseFloat(styles.paddingLeft) || 0;
    const borderLeft = parseFloat(styles.borderLeftWidth) || 0;
    const scrollLeft = input.scrollLeft || 0;

    // Vertical positioning: account for padding/border and center within line-height
    const paddingTop = parseFloat(styles.paddingTop) || 0;
    const borderTop = parseFloat(styles.borderTopWidth) || 0;
    const fontSize = parseFloat(styles.fontSize) || 0;
    let lineHeight = parseFloat(styles.lineHeight);
    if (!isFinite(lineHeight)) {
        // Some browsers return 'normal' → approximate as 1.2 * font-size
        lineHeight = fontSize ? fontSize * 1.2 : 0;
    }
    const vertCenterAdjust = Math.max(0, (lineHeight - fontSize) / 2);

    // Optional fine-tune via CSS variable (defaults to 0)
    const varOffset = parseFloat(styles.getPropertyValue('--caret-offset-y')) || 0;

    caret.style.position = 'absolute';
    caret.style.left = (inputRect.left + borderLeft + paddingLeft + measured - scrollLeft) + 'px';
    caret.style.top = (inputRect.top + borderTop + paddingTop + vertCenterAdjust + varOffset) + 'px';
    // Keep caret height aligned to the text glyph box
    if (fontSize) caret.style.height = fontSize + 'px';
};

let caretRAF = null;
const scheduleCaret = () => {
    if (caretRAF) cancelAnimationFrame(caretRAF);
    caretRAF = requestAnimationFrame(updateCaret);
};

/* -----------------------------------------------------------------------------
 * List UI subprogram
 * --------------------------------------------------------------------------- */
function createListUI(title, items, opts = {}) {
    // items: [{ date, preview }] by default
    let idx = 0;
    const {
        getKey = (item) => String(item.date),
        getStamp = (item) => String(item.date),
        getPreview = (item) => {
            const text = (item.preview ?? item.content ?? '').replace(/\n/g, ' ');
            return text.slice(0, 120);
        },
        onOpen = async (item) => {
            const key = getKey(item);
            const row = await db.get(key);
            startEditor(shell, {
                id: row?.id ?? key,
                date: key,
                initialContent: row?.content ?? '',
                autosave: autosaveEnabled
            });
        },
        onDelete = async (item) => {
            const key = getKey(item);
            const res = await db.delete(key);
            if (typeof res === 'object' && res) {
                if (typeof res.deleted === 'number') return res.deleted > 0;
                if ('ok' in res) return !!res.ok;
            }
            return !!res;
        },
        emptyMessage = '<div class="muted">No entries left.</div>'
    } = opts;

    const container = document.createElement('div');
    container.className = 'listui';
    const head = document.createElement('div');
    head.className = 'soft';
    head.innerHTML = `${esc(title)} <span class="muted">(↑/↓ to navigate · Enter open · Del delete · Esc cancel)</span>`;
    const ul = document.createElement('ul');
    ul.className = 'menu';
    let confirmPending = false;
    let pendingItem = null;
    let confirmDiv = null;

    function render() {
        ul.innerHTML = '';
        items.forEach((it, i) => {
            const li = document.createElement('li');
            if (i === idx) li.classList.add('active');
            const stampText = esc(String(getStamp(it)));
            let preview = getPreview(it);
            if (typeof preview !== 'string') preview = '';
            const trimmed = preview.trim();
            const previewHtml = trimmed ? esc(trimmed) : '';
            const sep = previewHtml ? ' - ' : '';
            li.innerHTML = `<span class="stamp">${stampText}</span>${sep}${previewHtml}`;
            li.addEventListener('click', () => { idx = i; render(); });
            ul.appendChild(li);
        });
        const activeEl = ul.querySelector('li.active');
        if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
    }

    render();
    container.appendChild(head);
    container.appendChild(ul);
    output.appendChild(container);
    scrollToBottom();

    return {
        consume: async (_line) => {}, // no line-based input here
        onKey: (e) => {
            if (container.classList.contains('disabled')) return;
            if (!items.length) return;
            if (confirmPending) {
                const k = e.key?.toLowerCase?.() || '';
                if (k === 'y' || k === 'n') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (k === 'n') {
                        if (confirmDiv) {
                            confirmDiv.classList.add('muted');
                            confirmDiv.innerHTML = `Cancelled.`;
                        }
                        confirmPending = false;
                        pendingItem = null;
                        return;
                    }
                    (async () => {
                        try {
                            const ok = await onDelete(pendingItem);
                            const stamp = pendingItem ? esc(String(getStamp(pendingItem))) : '';
                            if (confirmDiv) {
                                confirmDiv.className = ok ? 'ok' : 'error';
                                confirmDiv.innerHTML = ok
                                    ? `Deleted <span class="stamp">${stamp}</span>.`
                                    : `Nothing deleted for <span class="stamp">${stamp}</span>.`;
                            }
                            if (ok) {
                                const keyToRemove = pendingItem ? getKey(pendingItem) : null;
                                const idxToRemove = items.findIndex(it => getKey(it) === keyToRemove);
                                if (idxToRemove !== -1) {
                                    items.splice(idxToRemove, 1);
                                    idx = Math.min(idx, Math.max(0, items.length - 1));
                                    if (items.length) {
                                        render();
                                    } else {
                                        print(emptyMessage);
                                        shell.exit();
                                    }
                                }
                            }
                        } catch (err) {
                            const msg = err?.message || String(err);
                            if (confirmDiv) {
                                confirmDiv.className = 'error';
                                confirmDiv.innerHTML = `Delete failed: ${esc(msg)}`;
                            }
                        } finally {
                            confirmPending = false;
                            pendingItem = null;
                        }
                    })();
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                shell.exit();
                return;
            }
            if (e.key === 'ArrowDown') { idx = Math.min(idx + 1, items.length - 1); render(); e.preventDefault(); }
            else if (e.key === 'ArrowUp') { idx = Math.max(idx - 1, 0); render(); e.preventDefault(); }
            else if (e.key === 'PageDown') { idx = Math.min(idx + 5, items.length - 1); render(); e.preventDefault(); }
            else if (e.key === 'PageUp') { idx = Math.max(idx - 5, 0); render(); e.preventDefault(); }
            else if (e.key === 'Home') { idx = 0; render(); e.preventDefault(); }
            else if (e.key === 'End') { idx = items.length - 1; render(); e.preventDefault(); }
            else if (e.key === 'Escape') { shell.suspend(); e.preventDefault(); }
            else if (e.key === 'Delete' || e.key === 'Backspace') {
                const chosen = items[idx];
                if (!chosen) { e.preventDefault(); return; }
                confirmPending = true;
                pendingItem = chosen;
                confirmDiv = document.createElement('div');
                confirmDiv.className = 'warn';
                confirmDiv.innerHTML = `Delete <span class="stamp">${esc(String(getStamp(chosen)))}</span>? <span class="warn">y/n</span>`;
                output.appendChild(confirmDiv);
                scrollToBottom();
                e.preventDefault();
                return;
            }
            else if (e.key === 'Enter') {
                const chosen = items[idx];
                if (!chosen) return;
                shell.suspend();
                (async () => {
                    try {
                        await onOpen(chosen);
                    } catch (err) {
                        const msg = err?.message || String(err);
                        print(`<div class="error">${esc(msg)}</div>`);
                    }
                })();
                e.preventDefault();
            }
        },
        disable: () => {
            container.classList.add('disabled');
            const activeEl = ul.querySelector('li.active');
            if (activeEl) activeEl.classList.remove('active');
            confirmDiv = document.createElement('div');
            confirmDiv.className = 'muted';
            confirmDiv.innerHTML = `Canceled`;
            output.appendChild(confirmDiv);
        },
        destroy: () => { container.remove(); }
    };
}

// Helper to load a text asset (privacy.txt, terms.txt) from disk or server
async function loadTextAsset(name) {
    const isElectron = !!(window.electronAPI && typeof window.electronAPI.readTextAsset === 'function');
    if (isElectron) {
        return await window.electronAPI.readTextAsset(name);
    }
    // Web/PWA: served from packages/ui root
    const url = new URL(name, window.location.href).href;
    const resp = await fetch(url, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error(`Failed to load ${name} (${resp.status})`);
    return await resp.text();
}

/* -----------------------------------------------------------------------------
 * BUILT-IN COMMANDS
 * --------------------------------------------------------------------------- */

// Support utilities
register('help', () => {
    const rowsHtml = Object.keys(state.commands)
        .sort()
        .map(k => {
            const desc = state.commands[k].desc || '';
            return `<div><span class="kbd">${esc(k)}</span> — ${esc(desc)}</div>`;
        })
        .join('');
    print(`
        <div class="soft">available commands</div>
        <div class="muted help">${rowsHtml}</div>
    `);
}, 'List available commands');

register('tutorial', () => {
    print(`
    <div class="soft">journal quickstart</div>
    <div class="muted help">
        <div><span class="kbd">journal</span>&nbsp&nbsp&nbsp&nbsp&nbsp&nbsp&nbsp&nbsp — open today's entry; or specify a date afterwards (YYYY-MM-DD)</div>
        <div><span class="kbd">view</span>&nbsp&nbsp&nbsp&nbsp&nbsp&nbsp&nbsp&nbsp&nbsp&nbsp&nbsp — browse the latest entries; use ↑/↓ then Enter to open</div>
        <div><span class="kbd">search "coffee"</span> — find entries containing your keywords</div>
        <div><span class="kbd">export -pdf</span>&nbsp&nbsp&nbsp&nbsp — create a PDF export of the last week of entries</div>
        <div><span class="kbd">help</span>&nbsp&nbsp&nbsp&nbsp&nbsp&nbsp&nbsp&nbsp&nbsp&nbsp&nbsp — view all commands</div>
        <div><span class="kbd">... -help</span>&nbsp&nbsp&nbsp&nbsp&nbsp&nbsp — or add the -help flag to most commands for more info</div>
    </div>`);
}, 'Quick journaling workflow overview');

register('theme', async (argv = []) => {
    const arg = (argv[0] || '').trim().toLowerCase();
    if (!arg) {
        await startThemeApp(shell);
        return;
    }
    if (arg === 'reset') {
        try {
            const defaults = await getDefaultTheme();
            defaults.name = 'Default';
            defaults.meta = { version: 1, source: 'defaults', reset_at: new Date().toISOString() };
            await saveActiveTheme(defaults);
            applyTheme(defaults);
            print('<div class="ok">Theme reset to defaults.</div>');
        } catch (err) {
            const msg = err?.message || String(err);
            print(`<div class="error">Theme reset failed: ${esc(msg)}</div>`);
        }
        return;
    }
    print('<div class="error">Usage: <span class="kbd">theme</span> or <span class="kbd">theme reset</span></div>');
}, 'Customize fonts and colors');

register('autosave', async (argv = []) => {
    if (!argv.length) {
        const status = autosaveEnabled ? 'on' : 'off';
        print(`<div class="soft">autosave: ${status}</div>`);
        return;
    }
    const arg = String(argv[0]).trim().toLowerCase();
    if (['1', 'on', 'true', 'enable', 'enabled'].includes(arg)) {
        if (autosaveEnabled) {
            print('<div class="soft">autosave: on</div>');
            return;
        }
        await setAutosavePreference(true);
        return;
    }
    if (['0', 'off', 'false', 'disable', 'disabled'].includes(arg)) {
        if (!autosaveEnabled) {
            print('<div class="soft">autosave: off</div>');
            return;
        }
        await setAutosavePreference(false);
        return;
    }
    print('<div class="error">Usage: <span class="kbd">autosave</span>, <span class="kbd">autosave 1</span>, or <span class="kbd">autosave 0</span></div>');
}, 'Toggle automatic saving for Writer and Journal');

register('clear', () => {
    output.innerHTML = '';
    banner();
}, 'Clear the screen');

register('about', () => {
    console.log('A console style journaling tool built by John Kakuk.');
}, 'About this console');

register('privacy', async () => {
    try {
        const txt = await loadTextAsset('privacy.txt');
        print(`<div class="soft">PRIVACY POLICY</div>`);
        print(`<pre class="mono">${esc(txt)}</pre>`);
    } catch (err) {
        print(`<div class="error">Unable to load privacy.txt — ${esc(err.message || String(err))}</div>`);
    }
}, 'Show Privacy Policy');

register('terms', async () => {
    try {
        const txt = await loadTextAsset('terms.txt');
        print(`<div class="soft">TERMS OF SERVICE</div>`);
        print(`<pre class="mono">${esc(txt)}</pre>`);
    } catch (err) {
        print(`<div class="error">Unable to load terms.txt — ${esc(err.message || String(err))}</div>`);
    }
}, 'Show Terms of Service');

// --- Usage helper for journal command ---
function printJournalHelp() {
    print(`
    <div class="soft">journal usage</div>
    <div class="muted help">
        <div><span class="kbd">journal</span> — open today</div>
        <div><span class="kbd">journal YYYY-MM-DD</span> — open specific date</div>
        <div><span class="kbd">journal MM-DD</span> — open the most recent past occurrence of that month/day</div>
        <div><span class="kbd">journal -y</span> — open yesterday</div>
        <div><span class="kbd">journal -t</span> — open tomorrow</div>
        <div><span class="kbd">journal -tmp "Template"</span> — create a new entry from a template (append date to target another day)</div>
        <div><span class="kbd">journal -help</span> — show this help</div>
    </div>`);
}

// --- Usage helper for view command ---
function printViewHelp() {
    print(`
    <div class="soft">view usage</div>
    <div class="muted help">
        <div><span class="kbd">view</span> — list latest 15 entries</div>
        <div><span class="kbd">view MM</span> — list entries for month <em>MM</em> in the most recent past year</div>
        <div><span class="kbd">view YYYY-MM</span> — list entries for that month and year</div>
        <div><span class="kbd">view templates</span> — manage saved templates</div>
        <div><span class="kbd">view -help</span> — show this help</div>
    </div>`);
}

// --- Usage helper for search command ---
function printSearchHelp() {
    print(`
    <div class="soft">search usage</div>
    <div class="muted help">
      <div><span class="kbd">search "terms"</span> — find entries containing the text</div>
      <div><span class="kbd">search -help</span> — show this help</div>
    </div>`);
}

register('quit', async () => {
    print('<div class="muted">Quitting...</div>');
    try {
        // Electron desktop
        if (window.electronAPI && typeof window.electronAPI.quitApp === 'function') {
            await window.electronAPI.quitApp();
            return;
        }

        // Web/PWA: attempt to close the tab/window
        // Note: browsers often block closing non‑script‑opened windows; provide best‑effort + fallback.
        const attemptClose = () => {
            try { window.close(); } catch (_) {}
        };

        attemptClose();

        // If the window wasn't script‑opened, some browsers ignore window.close().
        // Try a self‑open shim, then close again.
        setTimeout(() => {
            try { window.open('', '_self'); } catch (_) {}
            attemptClose();
        }, 25);

        // Final fallback: navigate to about:blank so the user sees an empty page if close is blocked.
        setTimeout(() => {
            try { if (document.visibilityState !== 'hidden') location.replace('about:blank'); } catch (_) {}
            print('<div class="muted">If this tab didn\'t close, use ⌘W / Ctrl+W. Browsers may block programmatic tab close.</div>');
        }, 75);
    } catch (err) {
        const msg = err?.message || String(err);
        print(`<div class="error">Quit failed: ${esc(msg)}</div>`);
    }
}, 'Close the application');

register('write', async (argv = []) => {
    if (argv && argv.length) {
        print('<div class="warn">Writer ignores additional arguments.</div>');
    }
    try {
        startWriter(shell, { autosave: autosaveEnabled });
    } catch (err) {
        const msg = err?.message || String(err);
        print(`<div class="error">Unable to open Writer: ${esc(msg)}</div>`);
    }
}, 'Open the Writer workspace');

// App starters
register('journal', async (argv = []) => {
    // Supported:
    //   journal                 -> today
    //   journal YYYY-MM-DD      -> specific date
    //   journal MM-DD           -> most recent past occurrence of that month-day
    //   journal -y               -> yesterday
    //   journal -t               -> tomorrow
    const args = argv.map(a => String(a).trim()).filter(a => a.length > 0);
    let templateName = null;
    let dateToken = null;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-help') { printJournalHelp(); return; }
        if (arg === '-tmp') {
            if (templateName !== null) {
                print('<div class="error">Duplicate -tmp arguments. Specify the template name once.</div>');
                return;
            }
            const next = args[++i];
            if (typeof next !== 'string') {
                print('<div class="error">Missing template name after -tmp.</div>');
                return;
            }
            const name = next.trim();
            if (!name) {
                print('<div class="error">Template name cannot be empty.</div>');
                return;
            }
            templateName = name;
            continue;
        }
        if (dateToken === null) {
            dateToken = arg;
            continue;
        }
        print('<div class="error">Too many arguments for journal. Use -help for usage.</div>');
        return;
    }

    let date;
    if (!dateToken) {
        date = todayISO();
    } else if (dateToken === '-y') {
        date = shiftISO(-1);
    } else if (dateToken === '-t') {
        date = shiftISO(1);
    } else if (isISODate(dateToken)) {
        date = dateToken;
    } else if (isMonthDay(dateToken)) {
        date = resolveMonthDayPast(dateToken);
    } else {
        print(`<div class="error">Invalid argument for journal: ${esc(dateToken)}<br>Use YYYY-MM-DD, MM-DD (most recent past), -y for yesterday, -t for tomorrow, or -help for usage.</div>`);
        return;
    }

    try {
        if (templateName !== null) {
            if (!db || typeof db.getTemplate !== 'function' || typeof db.upsert !== 'function') {
                print('<div class="error">Templates are not available in this environment.</div>');
                return;
            }
            let template;
            try {
                template = await db.getTemplate(templateName);
            } catch (err) {
                const msg = err?.message || String(err);
                print(`<div class="error">Unable to load template: ${esc(msg)}</div>`);
                return;
            }
            if (!template || typeof template.content !== 'string') {
                print(`<div class="error">Template "${esc(templateName)}" not found.</div>`);
                return;
            }

            const existing = await db.get(date);
            if (existing) {
                print(`<div class="error">An entry already exists for ${esc(date)}. Remove it before using -tmp.</div>`);
                return;
            }

            const inserted = await db.upsert(date, template.content ?? '');
            const row = inserted || { date, content: template.content ?? '' };
            startEditor(shell, {
                id: row.id ?? date,
                date: row.date ?? date,
                initialContent: row.content ?? (template.content ?? ''),
                autosave: autosaveEnabled
            });
            return;
        }

        let row = await db.get(date);
        if (!row) {
            let seededContent = '';
            let usedTemplateName = null;
            if (db && typeof db.listTemplates === 'function') {
                try {
                    const templates = await db.listTemplates();
                    const match = pickTemplateForDate(templates, date);
                    if (match && match.template) {
                        seededContent = match.template.content ?? '';
                        usedTemplateName = match.template.name ?? null;
                    }
                } catch (err) {
                    console.warn('Repeating template selection failed:', err);
                }
            }
            row = await db.upsert(date, seededContent);
            if (usedTemplateName) {
                print(`<div class="muted">Initialized with template "${esc(usedTemplateName)}".</div>`);
            }
        }

        startEditor(shell, {
            id: row.id ?? date,
            date: row.date ?? date,
            initialContent: row.content ?? '',
            autosave: autosaveEnabled
        });
    } catch (err) {
        const msg = err?.message || String(err);
        print(`<div class="error">${esc(msg)}</div>`);
    }
}, "Open journal (YYYY-MM-DD | MM-DD | -y | -t | -help)");

register('view', async (argv = []) => {
    let items = [];
    if (!argv.length) {
        items = await db.listRecent(15);
        if (!items.length) { print('<div class="muted">No entries yet.</div>'); return; }
        shell.setPrompt('view>');
        shell.enter(createListUI('VIEW — Latest 15', items));
        return;
    }
    const a0 = String(argv[0]).trim();
    const a0Lower = a0.toLowerCase();
    if (a0 === '-help') { printViewHelp(); return; }
    if (a0Lower === 'templates') {
        if (!db || typeof db.listTemplates !== 'function') {
            print('<div class="error">Templates are not available in this environment.</div>');
            return;
        }
        let templates = [];
        try {
            templates = await db.listTemplates();
        } catch (err) {
            const msg = err?.message || String(err);
            print(`<div class="error">Unable to list templates: ${esc(msg)}</div>`);
            return;
        }
        if (!templates || !templates.length) {
            print('<div class="muted">No templates saved yet.</div>');
            return;
        }
        shell.setPrompt('templates>');
        shell.enter(createListUI('TEMPLATES', templates, {
            getKey: (item) => String(item.name),
            getStamp: (item) => item.name,
            getPreview: (item) => {
                const src = item.preview ?? item.content ?? '';
                return src.replace(/\n/g, ' ').slice(0, 120);
            },
            onOpen: async (item) => {
                if (!db || typeof db.getTemplate !== 'function') {
                    throw new Error('Template retrieval is not available.');
                }
                const tpl = await db.getTemplate(item.name);
                const record = (tpl && typeof tpl.content === 'string') ? tpl : item;
                if (!record || typeof record.content !== 'string') {
                    throw new Error(`Template "${item.name}" not found.`);
                }
                startEditor(shell, {
                    mode: 'template',
                    templateName: item.name,
                    id: item.name,
                    initialContent: record.content ?? '',
                    templateSchedule: record.schedule ?? null,
                    title: `Template: ${item.name}`,
                    autosave: false
                });
            },
            onDelete: async (item) => {
                if (!db || typeof db.deleteTemplate !== 'function') {
                    throw new Error('Template deletion is not available.');
                }
                const res = await db.deleteTemplate(item.name);
                if (typeof res === 'object' && res) {
                    if (typeof res.deleted === 'number') return res.deleted > 0;
                    if ('ok' in res) return !!res.ok;
                }
                return !!res;
            },
            emptyMessage: '<div class="muted">No templates left.</div>'
        }));
        return;
    }
    if (isYearMonth(a0)) {
        items = await db.listByYearMonth(a0);
        if (!items.length) { print(`<div class="muted">No entries for ${esc(a0)}.</div>`); return; }
        shell.setPrompt('view>');
        shell.enter(createListUI(`VIEW — ${esc(a0)}`, items));
        return;
    }
    if (isMonth(a0)) {
        const ym = resolveMonthPast(a0);
        items = await db.listByYearMonth(ym);
        if (!items.length) { print(`<div class=\"muted\">No entries for ${esc(ym)}.</div>`); return; }
        shell.setPrompt('view>');
        shell.enter(createListUI(`VIEW — ${esc(ym)}`, items));
        return;
  }
  print(`<div class="error">Invalid argument for view: ${esc(a0)}<br>Use none (latest 15), MM, or YYYY-MM.</div>`);
}, 'View entries (latest 15 | MM | YYYY-MM)');

register('search', async (argv = []) => {
    const raw = (argv[0] ?? '').trim();
    if (raw === '-help') { printSearchHelp(); return; }
    const q = raw;
    if (!q) { print('<div class="error">search requires a query in quotes, e.g. <span class="kbd">search "coffee"</span></div>'); return; }
    const items = await db.search(q);
    if (!items.length) { print(`<div class="muted">No matches for ${esc(q)}.</div>`); return; }
    shell.setPrompt('search>');
    shell.enter(createListUI(`SEARCH — ${esc(q)}`, items));
}, 'Search entries by text');

// --- Delete command ---
// Usage: delete YYYY-MM-DD  |  delete -t
register('delete', async (argv = []) => {
    const arg = String(argv[0] || '').trim();
    const date = (arg === '-t' || arg === '--today') ? todayISO() : arg;

    if (!isISODate(date)) {
        print('<div class="error">Usage: <span class="kbd">delete YYYY-MM-DD</span> or <span class="kbd">delete -t</span></div>');
        return;
    }

    // Verify existence first
    let row = null;
    try { row = await db.get(date); } catch {}
    if (!row) {
        print(`<div class="muted">No entry found for <span class="stamp">${esc(date)}</span>.</div>`);
        return;
    }

    print(`<div class="warn">Delete <span class="stamp">${esc(date)}</span>? y/n</div>`);

    const onKey = (e) => {
        const k = e.key?.toLowerCase?.() || '';
        if (k !== 'y' && k !== 'n') return;
        e.preventDefault();
        e.stopPropagation();
        window.removeEventListener('keydown', onKey, true);

        if (k === 'n') {
            print('<div class="muted">Cancelled.</div>');
            return;
        }

        (async () => {
            try {
                const res = await db.delete(date);
                const ok = typeof res === 'object' ? (res.deleted > 0) : !!res;
                if (ok) {
                    print(`<div class="ok">Deleted <span class="stamp">${esc(date)}</span>.</div>`);
                } else {
                    print(`<div class="error">Nothing deleted for <span class="stamp">${esc(date)}</span>.</div>`);
                }
            } catch (err) {
                const msg = err?.message || String(err);
                print(`<div class="error">Delete failed: ${esc(msg)}</div>`);
            }
        })();
    };

    // Capture just this one keystroke decisively
    window.addEventListener('keydown', onKey, { capture: true });
}, 'Delete an entry (YYYY-MM-DD or -t)');

// --- Usage helper for export command ---
function printExportHelp() {
    print(`
    <div class="soft">export usage</div>
    <div class="muted help">
        <div><span class="kbd">export</span> — export the last 7 entries as <em>.txt</em> to Downloads</div>
        <div><span class="kbd">export -t</span> — export <em>today’s</em> entry</div>
        <div><span class="kbd">export -y</span> — export <em>yesterday’s</em> entry</div>
        <div><span class="kbd">export -a</span> — export the entire journal</div>
        <div><span class="kbd">export YYYY</span> — export that year</div>
        <div><span class="kbd">export YYYY-MM</span> — export that month</div>
        <div><span class="kbd">export YYYY-MM-DD</span> — export that day</div>
        <div><span class="kbd">export ... -pdf</span> — export as <em>.pdf</em> instead of .txt</div>
        <div><span class="kbd">export -help</span> — show this help</div>
    </div>`);
}

// Resolve a list of entry rows for various selectors
async function gatherEntriesForExport(selector) {
    // selector: { type: 'all' | 'year' | 'month' | 'day' }
    if (!selector || !selector.type) selector = { type: 'recent7' };

    if (selector.type === 'day') {
        const key = `${selector.y}-${String(selector.m).padStart(2,'0')}-${String(selector.d).padStart(2,'0')}`;
        const row = await db.get(key);
        return row ? [row] : [];
    }

    if (selector.type === 'month') {
        const ym = `${selector.y}-${String(selector.m).padStart(2,'0')}`;
        const rows = await db.listByYearMonth(ym);
        return rows || [];
    }

    if (selector.type === 'year') {
        const out = [];
        for (let mm = 1; mm <= 12; mm++) {
            const ym = `${selector.y}-${String(mm).padStart(2,'0')}`;
            const rows = await db.listByYearMonth(ym);
            if (rows && rows.length) out.push(...rows);
        }
        return out;
    }

    if (selector.type === 'all') {
        const rows = await db.listRecent(100000);
        return Array.isArray(rows) ? rows.slice().reverse() : [];
    }

    // default (no args): last 7 entries, oldest → newest
    const rows = await db.listRecent(7);
    return Array.isArray(rows) ? rows.slice().reverse() : [];
}

function buildMarkdownExport(rows) {
    if (!rows || !rows.length) return '_No entries._\n';
    // Ensure chronological order by date ascending
    const sorted = rows.slice().sort((a,b) => String(a.date).localeCompare(String(b.date)));
    const parts = [];
    for (const r of sorted) {
        const date = String(r.date || '').trim();
        const content = (r.content ?? '').replace(/\r\n/g, '\n');
        parts.push(`\n<span class="stamp">${date}</span>\n\n${content}\n\n---\n`);
    }
    return parts.join('');
}

async function getDownloadsDir() {
    try {
        if (window.electronAPI && typeof window.electronAPI.getPath === 'function') {
            const p = await window.electronAPI.getPath('downloads');
            if (p) return p;
        }
    } catch {}
    // Fallbacks if preload bridge doesn't expose getPath
    try {
        if (window.electronAPI && typeof window.electronAPI.getHomeDir === 'function') {
            const home = await window.electronAPI.getHomeDir();
            if (home) return home + '/Downloads';
        }
    } catch {}
    // Last resort: relative Downloads in cwd
    return 'Downloads';
}

function makeFilename(base, ext) {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0,19);
    return `${base}-${stamp}.${ext}`;
}

function parseExportArgs(argv) {
    // returns { target?: {type, y?, m?, d?}, pdf: boolean, help?: boolean, invalid?: string }
    const opts = { pdf: false };
    const args = argv.map(String);
    if (!args.length) return opts; // default case -> recent 7 (no target)

    // detect -help
    if (args.includes('-help')) return { ...opts, help: true };

    // detect -pdf
    const pdfIdx = args.indexOf('-pdf');
    if (pdfIdx !== -1) { opts.pdf = true; args.splice(pdfIdx, 1); }

    // detect -a (all)
    const allIdx = args.indexOf('-a');
    if (allIdx !== -1) { opts.target = { type: 'all' }; args.splice(allIdx, 1); }

    // detect -t (today) and -y (yesterday)
    const tIdx = args.indexOf('-t');
    const yIdx = args.indexOf('-y');
    if (tIdx !== -1) {
        const ds = todayISO();
        const [y, m, d] = ds.split('-').map(n => Number(n));
        opts.target = { type: 'day', y, m, d };
        args.splice(tIdx, 1);
    } else if (yIdx !== -1) {
        const ds = shiftISO(-1);
        const [y, m, d] = ds.split('-').map(n => Number(n));
        opts.target = { type: 'day', y, m, d };
        args.splice(yIdx, 1);
    }

    if (args.length) {
        const a0 = args[0].trim();
        if (/^\d{4}$/.test(a0)) {
            opts.target = { type: 'year', y: Number(a0) };
        } else if (/^\d{4}-\d{2}$/.test(a0)) {
            const [y, m] = a0.split('-').map(n => Number(n));
            opts.target = { type: 'month', y, m };
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(a0)) {
            const [y, m, d] = a0.split('-').map(n => Number(n));
            opts.target = { type: 'day', y, m, d };
        } else if (a0.length) {
            opts.invalid = a0;
        }
    }
    return opts;
}

register('export', async (argv = []) => {
    const parsed = parseExportArgs(argv);
    if (parsed.help) { printExportHelp(); return; }
    if (parsed.invalid) {
        print(`<div class="error">Invalid argument for export: ${esc(parsed.invalid)}<br>Use none, -a, YYYY, YYYY-MM, YYYY-MM-DD, optional -pdf, or -help.</div>`);
        return;
    }

    // Fetch rows and build markdown bundle
    const rows = await gatherEntriesForExport(parsed.target);
    if (!rows.length) { print('<div class="muted">No entries to export.</div>'); return; }

    const md = buildMarkdownExport(rows);
    const downloadsDir = await getDownloadsDir();

    // File base name
    let base;
    if (!parsed.target) {
        base = 'console-journal-LAST-7';
    } else if (parsed.target.type === 'day') {
        base = `console-journal-${String(parsed.target.y)}-${String(parsed.target.m).padStart(2,'0')}-${String(parsed.target.d).padStart(2,'0')}`;
    } else if (parsed.target.type === 'month') {
        base = `console-journal-${String(parsed.target.y)}-${String(parsed.target.m).padStart(2,'0')}`;
    } else if (parsed.target.type === 'year') {
        base = `console-journal-${String(parsed.target.y)}`;
    } else if (parsed.target.type === 'all') {
        base = 'console-journal-ALL';
    } else {
        // Fallback (shouldn't hit): treat as recent7
        base = 'console-journal-LAST-7';
    }

    const ext = parsed.pdf ? 'pdf' : 'txt';
    const filename = makeFilename(base, ext);
    const outputPath = `${downloadsDir}/${filename}`;

    if (parsed.pdf) {
        // Visual feedback while PDF is generating
        const progress = document.createElement('div');
        progress.className = 'muted';
        progress.innerHTML = 'Export in progress…';
        output.appendChild(progress);
        scrollToBottom();

        let dots = 0;
        const timer = setInterval(() => {
            dots = (dots + 1) % 4;
            progress.innerHTML = `Export in progress${'.'.repeat(dots)}`;
            scrollToBottom();
        }, 400);

        const useElectron = !!(window.electronAPI && typeof window.electronAPI.exportJournal === 'function');

        try {
            if (useElectron) {
                const res = await window.electronAPI.exportJournal({ markdown: md, outputPath, cssPath: 'packages/ui/css/pdf.css' });
                clearInterval(timer);
                progress.className = 'ok';
                progress.innerHTML = `Exported PDF to <span class="muted">${esc(res?.path || outputPath)}</span>`;
                scrollToBottom();
            } else {
                // Browser server-rendered PDF via Puppeteer
                const resp = await fetch('/api/export-pdf', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ markdown: md, title: base })
                });
                if (!resp.ok) throw new Error(`Server export failed (${resp.status})`);
                const blob = await resp.blob();

                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);

                clearInterval(timer);
                progress.className = 'ok';
                progress.innerHTML = `Downloaded PDF file <span class=\"muted\">${esc(filename)}</span>`;
                scrollToBottom();
            }
        } catch (err) {
            clearInterval(timer);
            const msg = err?.message || String(err);
            progress.className = 'error';
            progress.innerHTML = `Export PDF failed: ${esc(msg)}`;
            scrollToBottom();
        }
        return;
    }

    // Plain text export path — requires a simple IPC that writes a file, or browser fallback.
    if (window.electronAPI && typeof window.electronAPI.saveText === 'function') {
        try {
            await window.electronAPI.saveText({ content: md, outputPath });
            print(`<div class="ok">Exported TXT to <span class="muted">${esc(outputPath)}</span></div>`);
        } catch (err) {
            const msg = err?.message || String(err);
            print(`<div class="error">Export TXT failed: ${esc(msg)}</div>`);
        }
    } else if (typeof window.downloadText === 'function') {
        try {
            window.downloadText(md, filename);
            print(`<div class="ok">Downloaded TXT file <span class="muted">${esc(filename)}</span></div>`);
        } catch (err) {
            const msg = err?.message || String(err);
            print(`<div class="error">Download TXT failed: ${esc(msg)}</div>`);
        }
    } else {
        print('<div class="warn">TXT export not wired yet. Use <span class="kbd">-pdf</span> to export now, or add a <span class="kbd">downloadText</span> function to handle browser downloads.</div>');
    }
}, 'Export entries (.txt by default, add -pdf)');

// --- Switch command for web/desktop mode ---
register('switch', async (argv = []) => {
    const arg = argv[0]?.trim();
    if (!arg) {
        print('<div class="error">Usage: switch [mode]\nAvailable modes: web, desktop</div>');
        return;
    }

    if (arg === 'web') {
        print('<div class="muted">Switching to web mode...</div>');
        if (window.electronAPI && typeof window.electronAPI.openWeb === 'function') {
            try {
                await window.electronAPI.openWeb();
            } catch (err) {
                print(`<div class="error">Failed to switch: ${esc(err.message || err)}</div>`);
            }
        } else {
            print('<div class="warn">Web mode only available when running in Electron with openWeb bridge.</div>');
        }
        return;
    }

    if (arg === 'desktop') {
        print('<div class="muted">Switching to desktop mode...</div>');
        if (window.electronAPI && typeof window.electronAPI.openDesktop === 'function') {
            try {
                await window.electronAPI.openDesktop();
            } catch (err) {
                print(`<div class="error">Failed to switch: ${esc(err.message || err)}</div>`);
            }
        } else {
            print('<div class="warn">Desktop mode only available when running in Electron with openDesktop bridge.</div>');
        }
        return;
    }

    print(`<div class="error">Invalid mode: ${esc(arg)}<br>Available modes: web, desktop</div>`);
}, 'Switch between web and desktop modes');

/* -----------------------------------------------------------------------------
 * BOOT
 * --------------------------------------------------------------------------- */
(() => {
    banner();
    focusInput();

    input.addEventListener('keydown', handleKeydown);
    screen.addEventListener('click', focusInput);
    input.addEventListener('input', scheduleCaret);
    input.addEventListener('click', scheduleCaret);
    input.addEventListener('keyup', scheduleCaret);
    window.addEventListener('resize', scheduleCaret);
})();
