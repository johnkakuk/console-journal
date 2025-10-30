/*
 *  JOURNAL:
 *  - Create view command
 *      - Create an arrow-key-navigable list of latest 15 entries
 *  - Add args to view command
 *      - MM to view all entries from a given month (most recent year)
 *      - YYYY-MM to view all entries from a given month and year
 *  - Create search command (args required)
 *      - search "search content"
 *      - Allow users to search for entries containing the search parameter
 * 
/* ==== main.js — Shell Router & UI ================================================== */
import { startEditor } from './editor.js';

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

// Renderer guard for DB
const db = window.db ?? {
    get: async () => null,
    upsert: async (date, content) => ({ id: -1, date, content }),
    listRecent: async (limit = 15) => [],
    listByYearMonth: async (_ym) => [],
    search: async (_q) => []
};

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
    if (e.key === 'Enter') {
        e.preventDefault();

        const line = input.value;
        newline();

        // If a subprogram is active, let it consume the line
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
    }

    // Command history navigation (only at root shell)
    if (!activeProgram) { // Allow subprograms to override arrow keys
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

      // Navigation for activePrograms ("list", "search")
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

  // Normal command execution
  await exec(line);
};

const focus = () => {
    input.focus();
    updateCaret();
};

// Fake caret that follows the real cursor inside the input
const caret = document.querySelector('.caret');

const updateCaret = () => {
    const inputRect = input.getBoundingClientRect();

    // Hidden mirror to measure caret X position
    const mirror = document.createElement('span');
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre';
    mirror.style.font = getComputedStyle(input).font;
    mirror.textContent = input.value.slice(0, input.selectionStart);
    document.body.appendChild(mirror);

    const caretX = mirror.getBoundingClientRect().width;
    caret.style.position = 'absolute';
    caret.style.left = (inputRect.left + caretX) + 'px';
    caret.style.top  = inputRect.top + 'px';

    document.body.removeChild(mirror);
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

/* -----------------------------------------------------------------------------
 * BUILT-IN COMMANDS
 * --------------------------------------------------------------------------- */

// Support utilities
register('help', () => {
    const rows = Object.keys(state.commands)
        .sort()
        .map(k => `  ${k.padEnd(10)} - ${state.commands[k].desc || ''}`);
    console.log(rows.join('\n'));
}, 'List available commands');

register('clear', () => {
    output.innerHTML = '';
    banner();
}, 'Clear the screen');

register('about', () => {
    console.log('A console style journaling tool built by John Kakuk.');
}, 'About this console');

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
    await window.electronAPI.quitApp();
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