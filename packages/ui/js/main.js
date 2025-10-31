/*
 * TODO:
 * - Add "quit" functionality to web app (have it close the tab)
 * 
/* ==== main.js — Shell Router & UI ================================================== */
import { startEditor } from './editor.js';
import { marked } from 'marked';

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
        const DB_VERSION = 1;
        const STORE = 'entries';

        const openDB = () => new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const s = db.createObjectStore(STORE, { keyPath: 'date' });
                    s.createIndex('ym', 'ym', { unique: false });
                    s.createIndex('updated_at', 'updated_at', { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        const txRun = async (mode, fn) => {
            const dbi = await openDB();
            return new Promise((resolve, reject) => {
                const tx = dbi.transaction(STORE, mode);
                const store = tx.objectStore(STORE);
                let result;
                try { result = fn(store, tx); } catch (e) { reject(e); return; }
                tx.oncomplete = () => resolve(result);
                tx.onerror = () => reject(tx.error);
            });
        };

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
            }
        };
        window.db = db;
    } else {
        // Electron: defer to preload-exposed db where present; keep a safe stub otherwise
        db = {
            get: async () => null,
            upsert: async (date, content) => ({ id: date, date, content }),
            listRecent: async () => [],
            listByYearMonth: async () => [],
            search: async () => []
        };
    }
}

// Whether a subprogram (team.js) is currently consuming input
let inputState = false;
let activeProgram = null; // holds an active subprogram (if any)

// Visible prompt and command registry
const state = {
    prompt: 'user:~$',
    commands: {},
};

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
        if (activeProgram && typeof activeProgram.destroy === 'function') {
          try { activeProgram.destroy(); } catch {}
        }
        activeProgram = null; 
        this.resetPrompt(); 
        focus(); 
    },
    suspend() {
        if (activeProgram && typeof activeProgram.disable === 'function') {
            try { activeProgram.disable(); } catch {}
        }
        activeProgram = null;
        this.resetPrompt();
        focus();
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
  print(`<div class="muted">Type <span class="kbd">help</span> to list commands.</div>`);
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
        const navKeys = ['ArrowUp','ArrowDown','PageUp','PageDown','Home','End','Escape','Enter'];
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

const focus = () => {
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
function createListUI(title, items) {
    // items: [{ date, preview }]
    let idx = 0;
    const container = document.createElement('div');
    container.className = 'listui';
    const head = document.createElement('div');
    head.className = 'soft';
    head.innerHTML = `${esc(title)} <span class="muted">(↑/↓ to navigate · Enter open · Esc cancel)</span>`;
    const ul = document.createElement('ul');
    ul.className = 'menu';

    function render() {
        ul.innerHTML = '';
        items.forEach((it, i) => {
            const li = document.createElement('li');
            if (i === idx) li.classList.add('active');
            const date = esc(it.date);
            const prev = esc(((it.preview || it.content || '').replace(/\n/g,' ').slice(0, 120)));
            li.innerHTML = `<span class="stamp">${date}</span> — ${prev}`;
            // Click-to-select
            li.addEventListener('click', () => { idx = i; render(); });
            ul.appendChild(li);
        });
        // Keep the active row visible when navigating
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
            if (e.key === 'ArrowDown') { idx = Math.min(idx + 1, items.length - 1); render(); e.preventDefault(); }
            else if (e.key === 'ArrowUp') { idx = Math.max(idx - 1, 0); render(); e.preventDefault(); }
            else if (e.key === 'PageDown') { idx = Math.min(idx + 5, items.length - 1); render(); e.preventDefault(); }
            else if (e.key === 'PageUp') { idx = Math.max(idx - 5, 0); render(); e.preventDefault(); }
            else if (e.key === 'Home') { idx = 0; render(); e.preventDefault(); }
            else if (e.key === 'End') { idx = items.length - 1; render(); e.preventDefault(); }
            else if (e.key === 'Escape') { shell.suspend(); e.preventDefault(); }
            else if (e.key === 'Enter') {
                const chosen = items[idx];
                if (!chosen) return;
                // Freeze the current list so it's static when returning from editor
                shell.suspend();
                // Fetch full content then open editor
                (async () => {
                    const row = await db.get(chosen.date);
                    startEditor(shell, {
                        id: row?.id ?? chosen.date,
                        date: chosen.date,
                        initialContent: row?.content ?? ''
                    });
                })();
                e.preventDefault();
            }
        },
        disable: () => {
            container.classList.add('disabled');
            const activeEl = ul.querySelector('li.active');
            if (activeEl) activeEl.classList.remove('active');
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

// App starters
register('journal', async (argv = []) => {
    // Supported:
    //   journal                 -> today
    //   journal YYYY-MM-DD      -> specific date
    //   journal MM-DD           -> most recent past occurrence of that month-day
    //   journal -y               -> yesterday
    //   journal -t               -> tomorrow
    let date;
    if (!argv.length) {
        date = todayISO();
    } else {
        const arg = String(argv[0]).trim();
        if (arg === '-help') { printJournalHelp(); return; }
        else if (arg === '-y') date = shiftISO(-1);
        else if (arg === '-t') date = shiftISO(1);
        else if (isISODate(arg)) date = arg;
        else if (isMonthDay(arg)) date = resolveMonthDayPast(arg);
        else {
            print(`<div class="error">Invalid argument for journal: ${esc(arg)}<br>Use YYYY-MM-DD, MM-DD (most recent past), -y for yesterday, -t for tomorrow, or -help for usage.</div>`);
            return;
        }
    }

    let row = await db.get(date);
    if (!row) row = await db.upsert(date, '');

    startEditor(shell, {
        id: row.id ?? date,
        date: row.date ?? date,
        initialContent: row.content ?? ''
    });
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
    if (a0 === '-help') { printViewHelp(); return; }
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
    if (!rows || !rows.length) return 'Console Journal Export\n\n_No entries._\n';
    // Ensure chronological order by date ascending
    const sorted = rows.slice().sort((a,b) => String(a.date).localeCompare(String(b.date)));
    const parts = ['Console Journal Export\n'];
    for (const r of sorted) {
        const date = String(r.date || '').trim();
        const content = (r.content ?? '').replace(/\r\n/g, '\n');
        parts.push(`\n${date}\n\n${content}\n\n---\n`);
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
    window.onload = () => {
        banner();
        focus();
    };

    input.addEventListener('keydown', handleKeydown);
    screen.addEventListener('click', focus);
    input.addEventListener('input', scheduleCaret);
    input.addEventListener('click', scheduleCaret);
    input.addEventListener('keyup', scheduleCaret);
    window.addEventListener('resize', scheduleCaret);
})();