/* ==== editor.js — Minimal inline writer (subprogram) ======================= */
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { EditorView, keymap, drawSelection, highlightActiveLine, Decoration, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { defaultKeymap, indentMore, indentLess, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { indentOnInput, indentUnit, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { search, searchKeymap, openSearchPanel, findNext, findPrevious } from '@codemirror/search';

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
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent || '');
    const mode = opts.mode === 'template' ? 'template' : 'entry';
    const isTemplate = mode === 'template';
    const rawTemplateName = isTemplate ? String(opts.templateName ?? '').trim() : '';
    const templateName = isTemplate ? (rawTemplateName || 'Untitled Template') : null;
    const initialText = typeof opts.initialContent === 'string' ? opts.initialContent : '';
    // --- Editor-local state ---------------------------------------------------
    const state = {
        title: opts.title || (isTemplate ? templateName : new Date().toLocaleString()),
        id:     opts.id ?? (isTemplate ? templateName : null),
        date: isTemplate ? null : (typeof opts.date === 'string' ? opts.date : new Date().toISOString().slice(0,10)), // 'YYYY-MM-DD'
        templateName,
        buffer: initialText.split('\n'),
        dirty: false,
    };

    // If this is a brand-new entry (no existing content), seed first line with the formatted date
    if (!isTemplate && (!initialText || initialText.trim() === '')) {
        const banner = `# ${fmtBannerDate(state.date)}`;
        state.buffer = [banner, ''];
    } else if (!state.buffer.length) {
        state.buffer = [''];
    }

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
    const originalTitleDisplay = titleEl ? titleEl.style.display : null;

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
        header.textContent = isTemplate
            ? `TEMPLATE - ${templateName}`
            : `JOURNAL - ${fmtBannerDate(state.date)}`;

        // Help line
        const help = document.createElement('div');
        help.className = 'writer-help muted';
        const saveCombo = isMac ? 'CMD + S' : 'CTRL + S';
        const templateCombo = isMac ? 'CMD + SHIFT + S' : 'CTRL + SHIFT + S';
        const exitCombo = isMac ? 'CTRL + X' : 'CTRL + Q';
        if (isTemplate) {
            help.textContent = `${saveCombo} to save, ${templateCombo} to duplicate, ${exitCombo} to exit`;
        } else {
            help.textContent = `${saveCombo} to save, ${templateCombo} to save template, ${exitCombo} to exit`;
        }

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

        // Mount header/help under the .titlebar (as child)
        const titlebar = document.querySelector('.titlebar');
        const bars = document.createElement('div');
        bars.id = 'writerBars';
        bars.style.display = 'flex';
        bars.style.flexDirection = 'column';
        bars.style.gap = '4px';
        bars.appendChild(header);
        bars.appendChild(help);
        if (titlebar) {
            titlebar.appendChild(bars);
        } else {
            // Fallback if titlebar isn’t present
            if (screenEl) screenEl.prepend(bars);
        }

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
        const bars = document.getElementById('writerBars');
        if (bars && bars.parentElement) bars.parentElement.removeChild(bars);
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

    // Retro theme driven entirely by CSS variables (defined in style.css)
    const retroTheme = EditorView.theme({
        '&': { backgroundColor: 'var(--editor-bg)', color: 'var(--editor-fg)', height: '100%' },
        '.cm-content': {
            caretColor: 'var(--editor-caret)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--editor-font-size)',
            lineHeight: 'var(--editor-line-height)'
        },
        '.cm-scroller': { fontFamily: 'inherit' },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--editor-caret)' },
        '&.cm-editor.cm-focused': { outline: 'none' },
        // Disable default paragraph-wide highlight; we’ll draw a single-row overlay instead
        '.cm-activeLine': { backgroundColor: 'transparent' }, // current: single-row overlay handles highlight
        // To restore paragraph-wide highlight instead, uncomment this and remove the overlay plugin in buildExtensions():
        // '.cm-activeLine': { backgroundColor: 'var(--editor-active-line-bg)' },
        '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--editor-selection-bg)' },
        '.cm-lineNumbers': { color: 'var(--editor-gutter-fg)' },
        '.cm-gutters': { backgroundColor: 'var(--editor-gutter-bg)', borderRight: '1px solid var(--editor-gutter-border)' },
        '.cm-panels': { backgroundColor: 'var(--editor-panel-bg)' },
        // --- To-do clickable overlay style ---
        '.todo-click-target': {
            position: 'relative',
            cursor: 'pointer',
            background: 'transparent',
            zIndex: 2,
            pointerEvents: 'auto'
        },
        '.todo-click-target::after': {
            content: '""',
            position: 'absolute',
            left: 0, top: 0, right: 0, bottom: 0,
            background: 'var(--editor-todo-hover-bg)',
            opacity: 0,
            transition: 'opacity 0.1s',
            pointerEvents: 'none'
        },
        '.todo-click-target:hover::after': { opacity: 1 }
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

    // Single visual-row highlight using safe measurement (no layout reads during updates)
    const activeRowPlugin = ViewPlugin.fromClass(class {
        constructor(view) {
            this.view = view;
            this.dom = document.createElement('div');
            this.dom.className = 'cm-activeRow';
            this.dom.style.position = 'absolute';
            this.dom.style.left = '0';
            this.dom.style.right = '0';
            this.dom.style.pointerEvents = 'none';
            this.dom.style.zIndex = '1';
            // Ensure the scrollDOM is relatively positioned so absolute works
            const scroller = view.scrollDOM;
            const cs = getComputedStyle(scroller);
            if (cs.position === 'static') scroller.style.position = 'relative';
            scroller.appendChild(this.dom);
            this._scheduled = false;
            this._top = 0;
            this._height = 0;
            this._visible = false;
            this.schedule();
        }
        schedule() {
            if (this._scheduled) return;
            this._scheduled = true;
            this.view.requestMeasure({
                read: () => {
                    const head = this.view.state.selection.main.head;
                    const caret = this.view.coordsAtPos(head);
                    if (!caret) {
                        this._visible = false;
                        return;
                    }
                    const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
                    this._top = caret.top - scrollerRect.top + this.view.scrollDOM.scrollTop;
                    this._height = Math.max(1, caret.bottom - caret.top);
                    this._visible = true;
                },
                write: () => {
                    this._scheduled = false;
                    if (!this.dom) return;
                    if (!this._visible) {
                        this.dom.style.display = 'none';
                        return;
                    }
                    this.dom.style.display = 'block';
                    this.dom.style.top = `${this._top}px`;
                    this.dom.style.height = `${this._height}px`;
                    this.dom.style.background = 'var(--editor-active-line-bg)';
                }
            });
        }
        update(update) {
            if (update.selectionSet || update.viewportChanged || update.domChanged || update.scrollChanged) {
                this.schedule();
            }
        }
        destroy() {
            if (this.dom && this.dom.parentNode) this.dom.parentNode.removeChild(this.dom);
            this.dom = null;
        }
    });

    // Typewriter: pixel-accurate scroll advance when caret moves to a new visual row (no drift)
    function typewriterAdvanceScroll(screenEl) {
        return ViewPlugin.fromClass(class {
            constructor(view) {
                this.view = view;
                this._scheduled = false;
                this._lastBottom = null;   // last caret bottom (px) relative to screenEl scroll
                this._lineH = view.defaultLineHeight || 24;
                this.schedule();
            }
            schedule() {
                if (this._scheduled) return;
                this._scheduled = true;
                this.view.requestMeasure({
                    read: () => {
                        const head = this.view.state.selection.main.head;
                        const caret = this.view.coordsAtPos(head);
                        if (!caret || !screenEl) {
                            this._curBottom = null;
                            return;
                        }
                        const scrRect = screenEl.getBoundingClientRect();
                        // caret bottom in scroller coordinates (include current scrollTop)
                        this._curBottom = (caret.bottom - scrRect.top) + screenEl.scrollTop;
                    },
                    write: () => {
                        this._scheduled = false;
                        const cur = this._curBottom;
                        if (cur == null) return;
                        if (this._lastBottom == null) {
                            this._lastBottom = cur;
                            return;
                        }
                        // Positive delta when caret advanced to a lower visual row (enter or soft-wrap)
                        let dy = cur - this._lastBottom;
                        // Ignore tiny jitter; only act when we clearly crossed to next row
                        const threshold = this._lineH * 0.6;
                        if (dy > threshold) {
                            // Scroll by the measured delta (rounded to pixel) to avoid fractional drift
                            screenEl.scrollTop += Math.round(dy);
                            this._lastBottom = cur;
                        } else if (dy < -threshold) {
                            // Caret moved up (e.g., arrow up); resync baseline without scrolling
                            this._lastBottom = cur;
                        }
                    }
                });
            }
            update(update) {
                // Reschedule on any user action that may shift caret position/layout
                if (update.selectionSet || update.docChanged || update.viewportChanged || update.scrollChanged || update.domChanged) {
                    this.schedule();
                }
            }
        });
    }

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
            { key: isMac ? 'Ctrl-x' : 'Ctrl-q', preventDefault: true, run: () => { exit(); return true; } },
        ]);

        // Add some bottom padding to simulate scrollPastEnd effect
        const padTheme = EditorView.theme({ '.cm-scroller': { paddingBottom: '80vh' } });

        return [
            retroTheme,
            padTheme,
            drawSelection(),
            // === Active line highlight mode ============================================
            // Current: use a single visual-row overlay (safe measured plugin).
            // If you prefer the paragraph-wide highlight, comment out `activeRowPlugin`
            // below and uncomment the `highlightActiveLine()` line here. Also restore the
            // .cm-activeLine background in the theme above.
            activeRowPlugin,
            typewriterAdvanceScroll(screenEl),
            snapOutOfView,
            markDirtyListener,
            history(),
            todoPlugin,
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

    // Visual feedback: quick save sweep bar along the bottom
    function flashSaveBar() {
        try {
            const prev = document.getElementById('saveFlash');
            if (prev && prev.parentElement) prev.parentElement.removeChild(prev);
            const bar = document.createElement('div');
            bar.id = 'saveFlash';
            bar.className = 'save-flash';
            (document.body || document.documentElement).appendChild(bar);
            bar.addEventListener('animationend', () => {
                if (bar && bar.parentElement) bar.parentElement.removeChild(bar);
            }, { once: true });
        } catch (_) {}
    }

    async function save() {
        if (cmView) {
            const text = cmView.state.doc.toString();
            state.buffer = text.split('\n');
            try {
                if (isTemplate) {
                    if (!window.db || typeof window.db.saveTemplate !== 'function') {
                        throw new Error('Template storage is not available.');
                    }
                    await window.db.saveTemplate(templateName, text);
                    showTemplateSavedToast();
                } else if (window.db && typeof window.db.upsert === 'function') {
                    await window.db.upsert(state.date, text);
                }
            } catch (err) {
                const msg = err?.message || String(err);
                const statusEl = document.getElementById('writerStatus');
                if (statusEl) {
                    statusEl.textContent = `Save failed: ${msg}`;
                } else {
                    info(`Save failed: ${msg}`);
                }
                return;
            }
        }
        clearUnsaved();
        flashSaveBar();
        state.dirty = false;

        const status = document.getElementById('writerStatus');
        const message = isTemplate
            ? `Template "${templateName}" saved (${summary()})`
            : `Saved (${summary()})`;
        if (status) {
            status.textContent = message;
        } else {
            ok(message);
        }
    }

    function showTemplateSavedToast() {
        try {
            const prev = document.getElementById('templateToast');
            if (prev && prev.parentElement) prev.parentElement.removeChild(prev);
            const toast = document.createElement('div');
            toast.id = 'templateToast';
            toast.className = 'template-toast';
            toast.textContent = 'Template Saved';
            (document.body || document.documentElement).appendChild(toast);
            toast.addEventListener('animationend', () => {
                if (toast && toast.parentElement) toast.parentElement.removeChild(toast);
            }, { once: true });
        } catch (_) {}
    }

    function showTemplateModal({ onSave, onCancel, initialValue = '' } = {}) {
        const prev = document.getElementById('templateModal');
        if (prev && prev.parentElement) prev.parentElement.removeChild(prev);

        const wrap = document.createElement('div');
        wrap.id = 'templateModal';
        wrap.className = 'cj-modal-backdrop';
        wrap.innerHTML = `
            <div class="cj-modal" role="dialog" aria-modal="true" aria-labelledby="cjTemplateModalTitle">
                <div id="cjTemplateModalTitle" class="cj-modal-title">Save Template</div>
                <div class="cj-modal-body">
                    <label class="cj-modal-field">
                        <span>Template name</span>
                        <input type="text" name="templateName" autocomplete="off" spellcheck="false" />
                    </label>
                    <div class="cj-modal-error error" style="display:none;"></div>
                </div>
                <div class="cj-modal-actions">
                    <button class="save" autofocus>Save</button>
                    <button class="cancel">Cancel</button>
                </div>
                <div class="cj-modal-hint muted">enter = save · esc = cancel</div>
            </div>
        `;
        document.body.appendChild(wrap);

        const input = wrap.querySelector('input[name="templateName"]');
        const btnSave = wrap.querySelector('button.save');
        const btnCancel = wrap.querySelector('button.cancel');
        const errorEl = wrap.querySelector('.cj-modal-error');

        if (input) {
            input.value = initialValue;
            try { input.setSelectionRange(0, input.value.length); } catch {}
        }

        const showError = (msg) => {
            if (!errorEl) return;
            if (msg) {
                errorEl.textContent = msg;
                errorEl.style.display = 'block';
            } else {
                errorEl.textContent = '';
                errorEl.style.display = 'none';
            }
        };

        let submitting = false;

        const cleanup = () => {
            window.removeEventListener('keydown', onKey, true);
            if (wrap && wrap.parentElement) wrap.parentElement.removeChild(wrap);
        };

        const reject = () => {
            if (submitting) return;
            cleanup();
            try { onCancel && onCancel(); } catch {}
        };

        const accept = async () => {
            if (submitting) return;
            const value = (input && input.value || '').trim();
            if (!value) {
                showError('Template name is required.');
                if (input) {
                    try { input.focus({ preventScroll: true }); } catch { input.focus(); }
                    try { input.select(); } catch {}
                }
                return;
            }
            showError('');
            submitting = true;
            try {
                if (typeof onSave === 'function') {
                    await onSave(value);
                }
                cleanup();
            } catch (err) {
                submitting = false;
                const message = err?.message || String(err);
                showError(message);
                if (input) {
                    try { input.focus({ preventScroll: true }); } catch { input.focus(); }
                    try { input.select(); } catch {}
                }
            }
        };

        const onKey = (e) => {
            const k = (e.key || '').toLowerCase();
            if (k === 'escape') {
                e.preventDefault();
                e.stopPropagation();
                reject();
                return;
            }
            if (k === 'enter') {
                // allow Enter from input or Save button
                if (document.activeElement === input || document.activeElement === btnSave) {
                    e.preventDefault();
                    e.stopPropagation();
                    accept();
                    return;
                }
            }
        };

        window.addEventListener('keydown', onKey, true);

        if (btnSave) btnSave.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            accept();
        });
        if (btnCancel) btnCancel.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            reject();
        });
        if (input) input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                accept();
            }
        });

        setTimeout(() => {
            if (input) {
                try { input.focus({ preventScroll: true }); }
                catch (_) { input.focus(); }
            }
        }, 0);
    }

    function promptTemplateSave() {
        if (!cmView) return;
        if (!window.db || typeof window.db.saveTemplate !== 'function') {
            info('Template storage is not available.');
            return;
        }
        const text = cmView.state.doc.toString();
        state.buffer = text.split('\n');
        showTemplateModal({
            onSave: async (name) => {
                await window.db.saveTemplate(name, text);
                const status = document.getElementById('writerStatus');
                if (status) {
                    status.textContent = `Template "${name}" saved (${summary()})`;
                } else {
                    ok(`Template "${name}" saved (${summary()})`);
                }
                showTemplateSavedToast();
            },
            initialValue: isTemplate ? (templateName ?? '') : ''
        });
    }

    // --- Unsaved-abandon modal -------------------------------------------------
    function showConfirmModal(message, onYes, onNo) {
        // If an existing modal is present, remove it first
        const prev = document.getElementById('confirmModal');
        if (prev && prev.parentElement) prev.parentElement.removeChild(prev);

        const wrap = document.createElement('div');
        wrap.id = 'confirmModal';
        wrap.className = 'cj-modal-backdrop';
        wrap.innerHTML = `
            <div class="cj-modal" role="dialog" aria-modal="true" aria-labelledby="cjModalTitle">
                <div id="cjModalTitle" class="cj-modal-title">Confirm</div>
                <div class="cj-modal-body">${shell.esc(message)}</div>
                <div class="cj-modal-actions">
                    <button class="yes" autofocus>Yes</button>
                    <button class="no">No</button>
                </div>
                <div class="cj-modal-hint muted">y = yes · n = no</div>
            </div>
        `;
        document.body.appendChild(wrap);

        const btnYes = wrap.querySelector('button.yes');
        const btnNo  = wrap.querySelector('button.no');

        // Focus management
        const buttons = [btnYes, btnNo];
        let focusIdx = 0;
        const setFocus = (i) => {
            focusIdx = (i + buttons.length) % buttons.length;
            const el = buttons[focusIdx];
            if (el) {
                try { el.focus({ preventScroll: true }); } catch { el.focus(); }
            }
        };
        // Ensure initial focus is on Yes
        setTimeout(() => setFocus(0), 0);

        const cleanup = () => {
            window.removeEventListener('keydown', onKey, true);
            if (wrap && wrap.parentElement) wrap.parentElement.removeChild(wrap);
        };
        const accept = () => { cleanup(); try { onYes && onYes(); } catch {} };
        const reject = () => { cleanup(); try { onNo && onNo(); } catch {} };

        const onKey = (e) => {
            const k = (e.key || '').toLowerCase();

            // quick accepts/cancels
            if (k === 'y') { e.preventDefault(); e.stopPropagation(); accept(); return; }
            if (k === 'n' || k === 'escape') { e.preventDefault(); e.stopPropagation(); reject(); return; }

            // navigation between Yes/No
            if (k === 'tab') {
                e.preventDefault();
                e.stopPropagation();
                setFocus(focusIdx + (e.shiftKey ? -1 : 1));
                return;
            }
            if (k === 'arrowright' || k === 'arrowdown') {
                e.preventDefault();
                e.stopPropagation();
                setFocus(focusIdx + 1);
                return;
            }
            if (k === 'arrowleft' || k === 'arrowup') {
                e.preventDefault();
                e.stopPropagation();
                setFocus(focusIdx - 1);
                return;
            }
        };
        window.addEventListener('keydown', onKey, true);

        btnYes.addEventListener('click', accept);
        btnNo.addEventListener('click', reject);
    }

    function requestExit() {
        if (state.dirty || unsaved) {
            showConfirmModal('Exit without saving?', () => performExit(), () => {/* cancelled */});
            return;
        }
        performExit();
    }

    function exit() {
        requestExit();
    }

    function performExit() {
        // Cleanup listeners, restore prompt/title, and return to shell
        window.removeEventListener('keydown', onHotkey, true);
        if (titleEl) {
            if (originalTitle != null) titleEl.textContent = originalTitle;
            titleEl.style.display = originalTitleDisplay ?? '';
        }

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
        {
            // Save template: Cmd/Ctrl + Shift + S
            if (((isMac && e.metaKey) || (!isMac && e.ctrlKey)) && e.shiftKey && (e.key === 's' || e.key === 'S')) {
                e.preventDefault();
                e.stopImmediatePropagation();
                e.stopPropagation();
                promptTemplateSave();
                return;
            }
            // Save: Cmd+S (mac) or Ctrl+S (win/linux)
            if (((isMac && e.metaKey) || (!isMac && e.ctrlKey)) && (e.key === 's' || e.key === 'S')) {
                e.preventDefault();
                e.stopImmediatePropagation();
                e.stopPropagation();
                save();
                return;
            }
            // Exit: Ctrl+X (mac) or Ctrl+Q (win/linux)
            if (e.ctrlKey && ((isMac && (e.key === 'x' || e.key === 'X')) || (!isMac && (e.key === 'q' || e.key === 'Q')))) {
                e.preventDefault();
                e.stopImmediatePropagation();
                e.stopPropagation();
                exit();
                return;
            }
        }
    }

    // --- Mount ---------------------------------------------------------------
    // Hide the title while the editor is active (superfluous during writing)
    if (titleEl) titleEl.style.display = 'none';
    // Prompt change for editor mode
    shell.setPrompt(isTemplate ? 'template>' : 'journal>');
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
