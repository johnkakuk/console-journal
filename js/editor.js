/* ==== editor.js — Minimal inline writer (subprogram) ======================= */
import { EditorState } from '../node_modules/@codemirror/state/dist/index.js';
import { EditorView, keymap, drawSelection, highlightActiveLine } from '../node_modules/@codemirror/view/dist/index.js';
import { defaultKeymap, indentMore, indentLess, history, historyKeymap } from '../node_modules/@codemirror/commands/dist/index.js';
import { markdown } from '../node_modules/@codemirror/lang-markdown/dist/index.js';
import { indentOnInput, indentUnit, syntaxHighlighting, HighlightStyle } from '../node_modules/@codemirror/language/dist/index.js';
import { tags as t } from '../node_modules/@lezer/highlight/dist/index.js';
import { search, searchKeymap, openSearchPanel, findNext, findPrevious } from '../node_modules/@codemirror/search/dist/index.js';
import { Decoration, ViewPlugin, ViewUpdate } from '../node_modules/@codemirror/view/dist/index.js';
    // --- Interactive Markdown To-Do List Plugin ------------------------------
    // --- Simple Markdown To-Do Toggle Plugin ------------------------------
// --- Interactive Markdown To-Do List Plugin with clickable overlay ---------
import { WidgetType } from '../node_modules/@codemirror/view/dist/index.js';
import { RangeSetBuilder } from '../node_modules/@codemirror/state/dist/index.js';

// Widget for clickable overlay on the [ ] or [x] in todo list
class TodoClickTargetWidget extends WidgetType {
    constructor() { super(); }
    toDOM() {
        const span = document.createElement('span');
        span.className = 'todo-click-target';
        // The span overlays the bracket area, but doesn't alter text
        span.style.position = 'absolute';
        span.style.top = '0';
        span.style.left = '0';
        span.style.width = '100%';
        span.style.height = '100%';
        span.style.pointerEvents = 'auto';
        // No content; pseudo-element or background can be styled
        return span;
    }
    ignoreEvent() { return false; }
}

const todoDecorationPlugin = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = this.buildDecorations(view);
    }
    update(update) {
        if (update.docChanged || update.viewportChanged)
            this.decorations = this.buildDecorations(update.view);
    }
    buildDecorations(view) {
        const builder = new RangeSetBuilder();
        for (let { from, to } of view.visibleRanges) {
            let startLine = view.state.doc.lineAt(from).number;
            let endLine = view.state.doc.lineAt(to).number;
            for (let i = startLine; i <= endLine; ++i) {
                const line = view.state.doc.line(i);
                const match = line.text.match(/^\s*[-*]\s+\[( |x)\]/);
                if (match) {
                    const bracketStart = line.text.indexOf('[');
                    const bracketEnd = line.text.indexOf(']', bracketStart);
                    if (bracketStart !== -1 && bracketEnd !== -1) {
                        // 1) If completed, add the line decoration first so builder order is monotonic
                        if (match[1] === 'x') {
                            builder.add(
                                line.from,
                                line.from,
                                Decoration.line({ class: 'completed' })
                            );
                        }

                        // 2) Bracket click-target span
                        const decoFrom = line.from + bracketStart;
                        const decoTo = line.from + bracketEnd + 1;
                        builder.add(
                            decoFrom,
                            decoTo,
                            Decoration.mark({ class: 'todo-click-target' })
                        );

                        // 3) Trailing text span after "]"
                        // Skip spaces after closing bracket so they belong to the left segment (the brackets)
                        const spaceAfter = line.text.slice(bracketEnd + 1).match(/^\s*/)[0].length;
                        const contentStart = line.from + bracketEnd + 1 + spaceAfter;
                        if (contentStart < line.to) {
                            builder.add(
                                contentStart,
                                line.to,
                                Decoration.mark({ class: 'todo-text' })
                            );
                        }
                    }
                }
            }
        }
        return builder.finish();
    }
}, {
    decorations: v => v.decorations
});

const todoPlugin = [
    todoDecorationPlugin,
    EditorView.domEventHandlers({
        mousedown(event, view) {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return false;

            // Only respond if the click is inside our clickable overlay
            if (!target.classList.contains('todo-click-target')) {
                // For legacy support, allow click on the text itself
                // Find the line and position clicked
                // fallback if not on overlay
                let lineNode = target.closest('.cm-line');
                if (!lineNode) return false;
                const pos = view.posAtDOM(target, event.clientX, event.clientY);
                const line = view.state.doc.lineAt(pos);
                const match = line.text.match(/^\s*[-*]\s+\[( |x)\]/);
                if (!match) return false;
                // Find the offset in the line text for the click
                function getCharOffset(node, x, y) {
                    let total = 0;
                    let found = false;
                    function walk(n) {
                        if (found) return;
                        if (n.nodeType === 3) { // text node
                            const range = document.createRange();
                            range.selectNodeContents(n);
                            for (let i = 0; i < n.length; ++i) {
                                range.setStart(n, i);
                                range.setEnd(n, i + 1);
                                const rect = range.getBoundingClientRect();
                                if (
                                    x >= rect.left &&
                                    x <= rect.right &&
                                    y >= rect.top &&
                                    y <= rect.bottom
                                ) {
                                    found = true;
                                    total += i;
                                    break;
                                }
                            }
                            if (!found) total += n.length;
                        } else if (n.nodeType === 1) {
                            for (let child of n.childNodes) {
                                walk(child);
                                if (found) break;
                            }
                        }
                    }
                    walk(node);
                    return total;
                }
                const charOffset = getCharOffset(lineNode, event.clientX, event.clientY);
                const bracketStart = line.text.indexOf('[');
                const bracketEnd = line.text.indexOf(']', bracketStart);
                if (
                    bracketStart === -1 ||
                    bracketEnd === -1 ||
                    charOffset < bracketStart ||
                    charOffset > bracketEnd
                ) {
                    return false;
                }
                event.preventDefault();
                event.stopPropagation();
                if (event.stopImmediatePropagation) event.stopImmediatePropagation();
                const checked = match[1] === 'x';
                const newMark = checked ? ' ' : 'x';
                const newText = line.text.replace(
                    /^\s*([-*]\s+\[)( |x)(\])/,
                    (_, a, mark, c) => `${a}${newMark}${c}`
                );
                const tr = view.state.update({
                    changes: { from: line.from, to: line.to, insert: newText }
                });
                view.dispatch(tr);
                return true;
            }

            // If click is on overlay, find which line/position
            let lineNode = target.closest('.cm-line');
            if (!lineNode) return false;
            // Find the CodeMirror line number via DOM
            // Use posAtDOM with the overlay target
            const pos = view.posAtDOM(target, event.clientX, event.clientY);
            const line = view.state.doc.lineAt(pos);
            const match = line.text.match(/^\s*[-*]\s+\[( |x)\]/);
            if (!match) return false;
            // Find the [ and ] positions
            const bracketStart = line.text.indexOf('[');
            const bracketEnd = line.text.indexOf(']', bracketStart);
            if (
                bracketStart === -1 ||
                bracketEnd === -1 ||
                pos < line.from + bracketStart ||
                pos > line.from + bracketEnd + 1
            ) {
                return false;
            }
            event.preventDefault();
            event.stopPropagation();
            if (event.stopImmediatePropagation) event.stopImmediatePropagation();
            const checked = match[1] === 'x';
            const newMark = checked ? ' ' : 'x';
            const newText = line.text.replace(
                /^\s*([-*]\s+\[)( |x)(\])/,
                (_, a, mark, c) => `${a}${newMark}${c}`
            );
            const tr = view.state.update({
                changes: { from: line.from, to: line.to, insert: newText }
            });
            view.dispatch(tr);
            return true;
        }
    })
];

export function startEditor(shell, opts = {}) {
    // --- Editor-local state ---------------------------------------------------
    const state = {
        title: opts.title || new Date().toLocaleString(),
        id:     opts.id ?? null,
        date: typeof opts.date === 'string' ? opts.date : new Date().toISOString().slice(0,10), // 'YYYY-MM-DD'
        buffer: (typeof opts.initialContent === 'string' ? opts.initialContent : '').split('\n'),
        dirty: false,
    };

    // CodeMirror editor view
    let cmView = null;

    // Snapshot of console DOM we will restore on exit
    let domSnapshot = null;
    const outputEl = document.getElementById('output');
    const inputWrapEl = document.getElementById('inputWrap');
    const caretEl = document.querySelector('.caret');
    const screenEl = document.getElementById('screen');
    const titleEl = document.querySelector('.title');
    const originalTitle = titleEl ? titleEl.textContent : null;

    // Save current console UI and mount writer UI
    function mountEditorDom() {
        // Take a snapshot
        domSnapshot = {
            outputHTML: outputEl ? outputEl.innerHTML : '',
            inputDisplay: inputWrapEl ? inputWrapEl.style.display : '',
            caretDisplay: caretEl ? caretEl.style.display : '',
            screenPadding: screenEl ? screenEl.style.padding : ''
        };

        // Hide the console input/caret and clear output
        if (inputWrapEl) inputWrapEl.style.display = 'none';
        if (caretEl) caretEl.style.display = 'none';
        if (outputEl) outputEl.innerHTML = '';

        // Build writer root
        const root = document.createElement('div');
        root.id = 'writerRoot';
        root.style.display = 'flex';
        root.style.flexDirection = 'column';
        root.style.height = '100%';
        root.style.width = '100%';
        root.style.padding = '12px 16px';
        root.style.boxSizing = 'border-box';
        root.style.gap = '8px';

        // Header
        const header = document.createElement('div');
        header.className = 'writer-header soft';
        header.textContent = `JOURNAL - ${fmtBannerDate(state.date)}`;

        // Help line
        const help = document.createElement('div');
        help.className = 'writer-help muted';
        help.textContent = 'CMD + S to save, CTRL + X to exit';

        // Editor pane wrapper (where CodeMirror will mount)
        const pane = document.createElement('div');
        pane.id = 'writerPane';
        pane.style.position = 'relative';
        pane.style.flex = '1';
        pane.style.width = '100%';

        // Status bar
        const status = document.createElement('div');
        status.id = 'writerStatus';
        status.className = 'writer-status muted';
        status.textContent = '';

        root.appendChild(header);
        root.appendChild(help);
        root.appendChild(pane);
        root.appendChild(status);

        // Mount into the screen/output container
        if (outputEl && outputEl.parentElement) {
            outputEl.parentElement.appendChild(root);
        } else if (screenEl) {
            screenEl.appendChild(root);
        }
    }

    // Track unsaved changes in the banner (writer header)
    let unsaved = false;

    function markUnsaved() {
        if (unsaved) return;
        const bannerEl = document.querySelector('.writer-header');
        if (bannerEl && !bannerEl.textContent.trim().endsWith('*')) {
            bannerEl.textContent += ' *';
            unsaved = true;
        }
    }

    function clearUnsaved() {
        const bannerEl = document.querySelector('.writer-header');
        if (bannerEl) {
            bannerEl.textContent = bannerEl.textContent.replace(/\s*\*$/, '');
            unsaved = false;
        }
    }

    // Move the cursor to the end of the document and scroll into view
    function focusEnd(view) {
        const docLen = view.state.doc.length;
        view.dispatch({
            selection: { anchor: docLen },
            scrollIntoView: true
        });
    }

    // Restore console UI from snapshot and remove writer UI
    function restoreEditorDom() {
        const root = document.getElementById('writerRoot');
        if (root && root.parentElement) {
            root.parentElement.removeChild(root);
        }
        if (outputEl) outputEl.innerHTML = domSnapshot ? domSnapshot.outputHTML : '';
        if (inputWrapEl) inputWrapEl.style.display = domSnapshot ? domSnapshot.inputDisplay : '';
        if (caretEl) caretEl.style.display = domSnapshot ? domSnapshot.caretDisplay : '';
        if (screenEl) screenEl.style.padding = domSnapshot ? domSnapshot.screenPadding : '';
    }

    // --- Helpers --------------------------------------------------------------
    function fmtBannerDate(d = new Date()) {
        // Accept Date or 'YYYY-MM-DD' string
        const toDate = (x) => {
            if (x instanceof Date) return x;
            if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) return new Date(x + 'T00:00:00');
            return new Date();
        };
        const dt = toDate(d);
        const months = [
            'January','February','March','April','May','June',
            'July','August','September','October','November','December'
        ];
        const m = months[dt.getMonth()];
        const dd = String(dt.getDate()).padStart(2, '0');
        const yyyy = dt.getFullYear();
        return `${m} ${dd}, ${yyyy}`;
    }

    function ok(msg)        { shell.print(`<span class="ok">${shell.esc(msg)}</span>`); }
    function info(msg)    { shell.print(`<span class="info">${shell.esc(msg)}</span>`); }


    function summary() {
        const lines = state.buffer.length;
        return `${lines} line${lines === 1 ? '' : 's'}`;
    }

    // Retro green-on-black theme for CM6
    const retroTheme = EditorView.theme({
        '&': { backgroundColor: 'var(--bg, #000)', color: 'var(--text, #00ff66)', height: '100%' },
        '.cm-content': { caretColor: 'var(--text, #00ff66)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '14px', lineHeight: '1.5' },
        '.cm-scroller': { fontFamily: 'inherit' },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text, #00ff66)' },
        '&.cm-editor.cm-focused': { outline: 'none' },
        '.cm-activeLine': { backgroundColor: 'rgba(0,255,102,0.08)' },
        '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(0,255,102,0.25)' },
        '.cm-lineNumbers': { color: 'rgba(0,255,102,0.5)' },
        '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid rgba(0,255,102,0.1)' },
        '.cm-panels': { backgroundColor: 'transparent' },
        // --- To-do clickable overlay style ---
        '.todo-click-target': {
            position: 'relative',
            cursor: 'pointer',
            // Transparent, but overlays the bracket area for click
            background: 'transparent',
            zIndex: 2,
            pointerEvents: 'auto',
        },
        '.todo-click-target::after': {
            content: '""',
            position: 'absolute',
            left: 0, top: 0, right: 0, bottom: 0,
            background: 'rgba(0,255,102,0.08)',
            opacity: 0,
            transition: 'opacity 0.1s',
            pointerEvents: 'none',
        },
        '.todo-click-target:hover::after': {
            opacity: 1,
        }
    }, { dark: true });

    // Syntax highlight accents for Markdown (conservative)
    const retroHighlight = HighlightStyle.define([
        { tag: t.strong, fontWeight: '700' },
        { tag: t.emphasis, fontStyle: 'italic' },
        { tag: t.heading1, fontWeight: '700', fontSize: '1.5em' },
        { tag: t.heading2, fontWeight: '700', fontSize: '1.35em' },
        { tag: t.heading3, fontWeight: '700', fontSize: '1.2em' },
        { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700' }
    ]);

    // Scroll by one line height when Enter is pressed
    const scrollByLine = keymap.of([{
        key: 'Enter' || 'Backspace',
        run: (view) => {
            // Let CodeMirror handle the newline normally
            const tr = view.state.replaceSelection('\n');
            view.dispatch(tr);
            // Scroll the scroller by one line height
            const scroller = document.querySelector("#screen");
            if (scroller && view.defaultLineHeight) {
                scroller.scrollTop += view.defaultLineHeight;
            }
            return true;
        }
    }]);

    // When the active line leaves the #screen viewport, snap it back to the nearer edge
    const snapOutOfView = EditorView.updateListener.of((update) => {
        if (!(update.docChanged || update.selectionSet)) return;
        const view = update.view;
        const scroller = document.querySelector('#screen');
        if (!scroller) return;

        // Defer to avoid reading layout during CM's update
        requestAnimationFrame(() => {
            const head = view.state.selection.main.head;
            const caret = view.coordsAtPos(head);
            if (!caret) return;

            const scr = scroller.getBoundingClientRect();
            const above = caret.top < scr.top;
            const below = caret.bottom > scr.bottom;
            if (!above && !below) return; // already in view

            const lineH = view.defaultLineHeight || 24;
            const pad = lineH * 2; // keep a little breathing room from the edge

            if (above) {
                // Snap so the caret sits a bit below the top edge
                const delta = (caret.top - (scr.top + pad));
                scroller.scrollTop += delta;
            } else if (below) {
                // Snap so the caret sits a bit above the bottom edge
                const delta = (caret.bottom - (scr.bottom - pad));
                scroller.scrollTop += delta;
            }
        });
    });

    const markDirtyListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
            markUnsaved();
            state.dirty = true;
        }
    });

    // --- Indentation config & smart Tab for Markdown lists/quotes -------------
    const INDENT = '    '; // two spaces
    const indentConfig = indentUnit.of(INDENT);

    // Regex for Markdown list/quote starters: "- ", "* ", "+ ", "1. ", "> "
    const LIST_START_RE = /^\s*(?:[-+*]\s|\d+\.\s|>\s)/;

    function linesInSelection(state) {
        const seen = new Set();
        const out = [];
        for (const r of state.selection.ranges) {
            let line = state.doc.lineAt(r.from).number;
            const endLine = state.doc.lineAt(r.to).number;
            for (; line <= endLine; line++) {
                if (!seen.has(line)) { seen.add(line); out.push(line); }
            }
        }
        return out;
    }

    const smartListTabKeymap = keymap.of([
        {
            key: 'Tab',
            preventDefault: true,
            run: (view) => {
                const { state } = view;
                const lines = linesInSelection(state);
                // If every selected line starts like a list/quote, indent by INDENT at BOL
                if (lines.length && lines.every(n => LIST_START_RE.test(state.doc.line(n).text))) {
                    const changes = lines.map(n => {
                        const ln = state.doc.line(n);
                        return { from: ln.from, to: ln.from, insert: INDENT };
                    });
                    view.dispatch({ changes, scrollIntoView: true });
                    return true;
                }
                // Otherwise, defer to standard editor behavior
                return indentMore(view);
            }
        },
        {
            key: 'Shift-Tab',
            preventDefault: true,
            run: (view) => {
                const { state } = view;
                const lines = linesInSelection(state);
                if (!lines.length) return indentLess(view);
                // If we’re on list/quote lines, try to outdent up to INDENT spaces
                if (lines.every(n => /^\s+/.test(state.doc.line(n).text))) {
                    const changes = [];
                    for (const n of lines) {
                        const ln = state.doc.line(n);
                        const txt = ln.text;
                        if (!LIST_START_RE.test(txt)) return indentLess(view);
                        let remove = 0;
                        for (let i = 0; i < INDENT.length && i < txt.length && txt[i] === ' '; i++) remove++;
                        if (remove > 0) changes.push({ from: ln.from, to: ln.from + remove, insert: '' });
                    }
                    if (changes.length) {
                        view.dispatch({ changes, scrollIntoView: true });
                        return true;
                    }
                }
                // Fallback to standard outdent when not on list blocks
                return indentLess(view);
            }
        }
    ]);

    function buildExtensions() {
        const saveExitKeymap = keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { save(); return true; } },
            { key: 'Ctrl-x', preventDefault: true, run: () => { exit(); return true; } },
        ]);

        // Add some bottom padding to simulate scrollPastEnd effect
        const padTheme = EditorView.theme({ '.cm-scroller': { paddingBottom: '80vh' } });

        return [
            retroTheme,
            padTheme,
            drawSelection(),
            highlightActiveLine(),
            snapOutOfView,
            markDirtyListener,
            history(),
            todoPlugin,
            scrollByLine,
            indentConfig,
            smartListTabKeymap,
            keymap.of([
                ...defaultKeymap,
                ...historyKeymap,
                ...searchKeymap,
                { key: 'Mod-f', preventDefault: true, run: openSearchPanel },
                { key: 'Enter', run: findNext },
                { key: 'Shift-Enter', run: findPrevious }
            ]),
            search({ top: true }),
            saveExitKeymap,
            indentOnInput(),
            markdown(),
            syntaxHighlighting(retroHighlight),
            EditorView.lineWrapping,
        ];
    }

    function save() {
        if (cmView) {
            const text = cmView.state.doc.toString();
            state.buffer = text.split('\n');
            // Persist to SQLite via preload bridge if available
            try { window.db && typeof window.db.upsert === 'function' && window.db.upsert(state.date, text); } catch {}
        }
        clearUnsaved();
        state.dirty = false;

        const status = document.getElementById('writerStatus');
        if (status) {
            status.textContent = `Saved (${summary()})`;
        } else {
            ok(`Saved (${summary()})`);
        }
    }

    function exit() {
        // Cleanup listeners, restore prompt/title, and return to shell
        window.removeEventListener('keydown', onHotkey, true);
        if (titleEl && originalTitle != null) titleEl.textContent = originalTitle;

        // sync buffer from CodeMirror one last time (no confirmation)
        if (cmView) {
            const text = cmView.state.doc.toString();
            state.buffer = text.split('\n');
        }

        // Restore original console UI
        restoreEditorDom();

        shell.exit();
        ok('Exited writer');
    }

    // --- Hotkeys --------------------------------------------------------------
    function onHotkey(e) {
        // Meta+S (⌘S on macOS)
        if (e.metaKey && (e.key === 's' || e.key === 'S')) {
            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();
            save();
            return;
        }
        // Ctrl+X
        if (e.ctrlKey && (e.key === 'x' || e.key === 'X')) {
            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();
            exit();
            return;
        }
    }

    // --- Mount ---------------------------------------------------------------
    // Swap the titlebar text
    if (titleEl) titleEl.textContent = 'EDITOR';
    // Prompt change for editor mode
    shell.setPrompt('journal>');
    // Replace the console output with a full-screen editor surface
    mountEditorDom();

    // Mount CodeMirror editor into our pane
    const paneEl = document.getElementById('writerPane');
    const startDoc = state.buffer.join('\n');
    cmView = new EditorView({
        state: EditorState.create({ doc: startDoc, extensions: buildExtensions() }),
        parent: paneEl
    });
    cmView.focus();
    focusEnd(cmView);

    // Start listening for hotkeys (capture=true to win against browser defaults)
    window.addEventListener('keydown', onHotkey, true);

    // Register as an active subprogram
    const program = {
        async consume(_line) {
            // Shell Enter is ignored; the textarea owns input.
            // We still mark dirty to reflect that something happened.
            state.dirty = true;
        }
    };

    shell.enter(program);
    return program;
}