/* ==== editor.js — Minimal inline writer (subprogram) ======================= */
import { EditorState, RangeSetBuilder, Transaction, EditorSelection } from '@codemirror/state';
import { EditorView, keymap, drawSelection, highlightActiveLine, Decoration, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { indentOnInput, indentUnit, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { search, searchKeymap, openSearchPanel, findNext, findPrevious } from '@codemirror/search';
import { normalizeTemplateSchedule, cloneTemplateSchedule, isISODate } from './schedule.js';
import { listLayoutPlugin, createListKeymap, listRenumberListener } from './listLayout.js';

function hasPointerUserEvent(update) {
    if (!update || !Array.isArray(update.transactions)) return false;
    return update.transactions.some(tr => {
        const userEvent = tr.annotation(Transaction.userEvent);
        if (typeof userEvent !== 'string') return false;
        const lowered = userEvent.toLowerCase();
        return lowered.includes('pointer') || lowered.includes('mouse');
    });
}

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
                const todoPrefixMatch = line.text.match(/^(\s*[-*]\s+\[( |x)\]\s*)/);
                if (todoPrefixMatch) {
                    const isChecked = todoPrefixMatch[2] === 'x';
                    const lineClasses = ['todo-line'];
                    if (isChecked) lineClasses.push('completed');
                    const lineSpec = { class: lineClasses.join(' ') };
                    builder.add(
                        line.from,
                        line.from,
                        Decoration.line(lineSpec)
                    );

                    const bracketStart = line.text.indexOf('[');
                    const bracketEnd = line.text.indexOf(']', bracketStart);
                    if (bracketStart !== -1 && bracketEnd !== -1) {
                        // 1) Bracket click-target span
                        const decoFrom = line.from + bracketStart;
                        const decoTo = line.from + bracketEnd + 1;
                        builder.add(
                            decoFrom,
                            decoTo,
                            Decoration.mark({ class: 'todo-click-target' })
                        );

                        // 2) Trailing text span after "]"
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
                    /^(\s*[-*]\s+\[)( |x)(\])/,
                    (_, prefix, mark, suffix) => `${prefix}${newMark}${suffix}`
                );
                const tr = view.state.update({
                    changes: { from: line.from, to: line.to, insert: newText },
                    annotations: Transaction.userEvent.of('pointer.todo-toggle')
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
                /^(\s*[-*]\s+\[)( |x)(\])/,
                (_, prefix, mark, suffix) => `${prefix}${newMark}${suffix}`
            );
            const tr = view.state.update({
                changes: { from: line.from, to: line.to, insert: newText },
                annotations: Transaction.userEvent.of('pointer.todo-toggle')
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
    const initialSchedule = isTemplate ? cloneTemplateSchedule(opts.templateSchedule) : null;
    // --- Editor-local state ---------------------------------------------------
    const state = {
        title: opts.title || (isTemplate ? templateName : new Date().toLocaleString()),
        id:     opts.id ?? (isTemplate ? templateName : null),
        date: isTemplate ? null : (typeof opts.date === 'string' ? opts.date : new Date().toISOString().slice(0,10)), // 'YYYY-MM-DD'
        templateName,
        buffer: initialText.split('\n'),
        dirty: false,
        templateSchedule: initialSchedule
    };

    // // If this is a brand-new entry (no existing content), seed first line with the formatted date
    // if (!isTemplate && (!initialText || initialText.trim() === '')) {
    //     const banner = `# ${fmtBannerDate(state.date)}`;
    //     state.buffer = [banner, ''];
    // } else if (!state.buffer.length) {
    //     state.buffer = [''];
    // }

    // CodeMirror editor view
    let cmView = null;
    // Tracks the exact text at the last save so we can clear the '*' when undoing back to saved state
    let savedSnapshot = '';

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
            ? `TEMPLATE - ${(state.templateName ?? templateName)}`
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

        // Add the 'locked' class to #screen after mounting editor window
        const screen = document.querySelector('#screen');
        if (screen) screen.classList.add('locked');
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
        // Remove the 'locked' class from #screen before restoring editor window
        const screen = document.querySelector('#screen');
        if (screen) screen.classList.remove('locked');
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
            fontFamily: 'var(--font-editor, var(--font-mono))',
            fontSize: 'var(--editor-font-size)',
            lineHeight: 'var(--editor-line-height)'
        },
        '.cm-scroller': { fontFamily: 'inherit', height: '100%', overflow: 'auto' },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--editor-caret)' },
        '&.cm-editor.cm-focused': { outline: 'none' },
        // Disable default paragraph-wide highlight; we’ll draw a single-row overlay instead
        '.cm-activeLine': { backgroundColor: 'transparent' }, // current: single-row overlay handles highlight
        // To restore paragraph-wide highlight instead, uncomment this and remove the overlay plugin in buildExtensions():
        // '.cm-activeLine': { backgroundColor: 'var(--editor-active-line-bg)' },
        '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--editor-selection-bg)' },
        '.cm-lineNumbers': { color: 'color-mix(in srgb, var(--text) 55%, transparent)' },
        '.cm-gutters': { backgroundColor: 'var(--editor-gutter-bg)', borderRight: '1px solid var(--border, rgba(255,255,255,0.1))' },
        '.cm-panels': { backgroundColor: 'var(--editor-panel-bg)' },
        // --- To-do clickable overlay style ---
        '.todo-click-target': {
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: '2ch',
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
        '.todo-click-target:hover::after': { opacity: 1 },
        '.cm-line.cm-list-line': {
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'calc(var(--list-gap-ch, 0.5) * 1ch)'
        },
        '.cm-line.cm-list-line .cm-list-indent': {
            flex: '0 0 calc(var(--list-indent-ch, 0) * 1ch)',
            width: 'calc(var(--list-indent-ch, 0) * 1ch)',
            whiteSpace: 'pre'
        },
        '.cm-line.cm-list-line .cm-list-marker': {
            display: 'flex',
            justifyContent: 'flex-end',
            flex: '0 0 calc(var(--list-marker-ch, 2) * 1ch)',
            width: 'calc(var(--list-marker-ch, 2) * 1ch)',
            whiteSpace: 'pre',
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums lining-nums',
            fontFeatureSettings: '"tnum" 1, "lnum" 1',
            opacity: 0.85,
            userSelect: 'none'
        },
        '.cm-line.cm-list-line .cm-list-content': {
            flex: '1 1 auto',
            minWidth: 0,
            whiteSpace: 'pre-wrap',
            lineHeight: '1.5',
            wordBreak: 'break-word'
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


    // Helper to find the actual scroll container (for typewriter/active-line logic)
    function getScrollContainer(view) {
        let el = view.scrollDOM;
        while (el) {
            const cs = getComputedStyle(el);
            const oy = cs.overflowY || cs.overflow || '';
            if (oy.includes('auto') || oy.includes('scroll')) return el;
            el = el.parentElement;
        }
        return view.scrollDOM;
    }

    // When the active line leaves the scroller viewport, snap it back to the nearer edge
    const snapOutOfView = EditorView.updateListener.of((update) => {
        if (!(update.docChanged || update.selectionSet)) return;
        if (hasPointerUserEvent(update)) return;
        const view = update.view;
        const scroller = getScrollContainer(view);
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
            const pad = lineH * 2; // breathing room from the edge

            if (above) {
                const delta = caret.top - (scr.top + pad);
                scroller.scrollTop += delta;
            } else if (below) {
                const delta = caret.bottom - (scr.bottom - pad);
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
            // Ensure the scroll container is relatively positioned so absolute works
            const container = getScrollContainer(view);
            const cs = getComputedStyle(container);
            if (cs.position === 'static') container.style.position = 'relative';
            container.appendChild(this.dom);
            this._onResize = () => this.schedule();
            window.addEventListener('resize', this._onResize, { passive: true });
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
                    const container = getScrollContainer(this.view);
                    const scrollerRect = container.getBoundingClientRect();
                    this._top = caret.top - scrollerRect.top + container.scrollTop;
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
            window.removeEventListener('resize', this._onResize);
            if (this.dom && this.dom.parentNode) this.dom.parentNode.removeChild(this.dom);
            this.dom = null;
        }
    });

    // Typewriter: pixel-accurate scroll advance when caret moves to a new visual row (no drift)
    function typewriterAdvanceScroll() {
        return ViewPlugin.fromClass(class {
            constructor(view) {
                this.view = view;
                this._scheduled = false;
                this._lastBottom = null;   // last caret bottom (px) relative to scroller
                this._lineH = view.defaultLineHeight || 24;
                this._suppressScroll = false;
                this._curBottom = null;
                this.schedule();
            }
            schedule() {
                if (this._scheduled) return;
                this._scheduled = true;
                this.view.requestMeasure({
                    read: () => {
                        const head = this.view.state.selection.main.head;
                        const caret = this.view.coordsAtPos(head);
                        const scroller = getScrollContainer(this.view);
                        if (!caret || !scroller) {
                            this._curBottom = null;
                            return;
                        }
                        const scrRect = scroller.getBoundingClientRect();
                        // caret bottom in scroller coordinates (include current scrollTop)
                        this._curBottom = (caret.bottom - scrRect.top) + scroller.scrollTop;
                    },
                    write: () => {
                        this._scheduled = false;
                        const scroller = getScrollContainer(this.view);
                        const cur = this._curBottom;
                        if (!scroller || cur == null) return;
                        if (this._lastBottom == null) {
                            this._lastBottom = cur;
                            return;
                        }
                        if (this._suppressScroll) {
                            this._lastBottom = cur;
                            this._suppressScroll = false;
                            return;
                        }
                        // Positive delta when caret advanced to a lower visual row (enter or soft-wrap)
                        const dy = cur - this._lastBottom;
                        const threshold = this._lineH * 0.6; // ignore jitter
                        if (dy > threshold) {
                            scroller.scrollTop += Math.round(dy);
                            this._lastBottom = cur;
                        } else if (dy < -threshold) {
                            // Caret moved up (e.g. arrow up); resync baseline
                            this._lastBottom = cur;
                        }
                    }
                });
            }
            update(update) {
                if (hasPointerUserEvent(update)) {
                    this._suppressScroll = true;
                }
                if (update.selectionSet || update.docChanged || update.viewportChanged || update.scrollChanged || update.domChanged) {
                    this.schedule();
                }
            }
        });
    }

    // Keep the banner '*' in sync with the real saved state, even across undo/redo
    const unsavedTracker = EditorView.updateListener.of((update) => {
        if (!(update && update.docChanged)) return;
        const cur = update.state.doc.toString();
        if (cur === savedSnapshot) {
            if (unsaved) clearUnsaved();
            state.dirty = false;
        } else {
            if (!unsaved) markUnsaved();
            state.dirty = true;
        }
    });

    // --- Indentation config & smart Tab for Markdown lists/quotes -------------
    const INDENT = '  '; // two spaces per nesting level
    const indentConfig = indentUnit.of(INDENT);

    // Dynamically maintain top/bottom padding in the CodeMirror scroller based on its height.
    function dynamicScrollerPadding() {
        return ViewPlugin.fromClass(class {
            constructor(view) {
                this.view = view;
                this.scroller = view.scrollDOM;
                this.scroller.style.boxSizing = 'content-box';
                this._onWindowResize = () => this.updatePads();
                this._ro = new ResizeObserver(() => this.updatePads());
                this._ro.observe(this.scroller);
                window.addEventListener('resize', this._onWindowResize, { passive: true });
                this.updatePads();
            }

            updatePads() {
                const vh = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
                const pad = Math.round(vh * 0.7);
                const topVal = pad + 'px';
                const botVal = pad + 'px';
                if (this.scroller && this.scroller.style.paddingTop !== topVal) this.scroller.style.paddingTop = topVal;
                if (this.scroller && this.scroller.style.paddingBottom !== botVal) this.scroller.style.paddingBottom = botVal;
            }

            update(update) {
                if (update.viewportChanged || update.domChanged) {
                    this.updatePads();
                }
            }

            destroy() {
                try { this._ro && this._ro.disconnect(); } catch {}
                window.removeEventListener('resize', this._onWindowResize);
            }
        });
    }

    function buildExtensions() {
        const insertTodo = (view) => {
            const spec = view.state.changeByRange(range => {
                const insertText = '- [ ] ';
                return {
                    changes: { from: range.from, to: range.to, insert: insertText },
                    range: EditorSelection.cursor(range.from + insertText.length)
                };
            });
            view.dispatch(view.state.update(spec, {
                scrollIntoView: true,
                userEvent: 'input'
            }));
            return true;
        };

        const saveExitKeymap = keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { save(); return true; } },
            { key: isMac ? 'Ctrl-x' : 'Ctrl-q', preventDefault: true, run: () => { exit(); return true; } },
            { key: 'Mod-t', preventDefault: true, run: insertTodo }
        ]);

        // Add some bottom padding to simulate scrollPastEnd effect

        return [
            retroTheme,
            dynamicScrollerPadding(),
            drawSelection(),
            // === Active line highlight mode ============================================
            // Current: use a single visual-row overlay (safe measured plugin).
            // If you prefer the paragraph-wide highlight, comment out `activeRowPlugin`
            // below and uncomment the `highlightActiveLine()` line here. Also restore the
            // .cm-activeLine background in the theme above.
            activeRowPlugin,
            typewriterAdvanceScroll(),
            snapOutOfView,
            unsavedTracker,
            history(),
            todoPlugin,
            listLayoutPlugin,
            listRenumberListener,
            indentConfig,
            createListKeymap(INDENT),
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

    // Toast helper reused across save flows to align with global notifications
    function showToast(message, id = 'writerToast') {
        try {
            const prev = id ? document.getElementById(id) : null;
            if (prev && prev.parentElement) prev.parentElement.removeChild(prev);
            const toast = document.createElement('div');
            if (id) toast.id = id;
            toast.className = 'template-toast';
            toast.textContent = message;
            (document.body || document.documentElement).appendChild(toast);
            toast.addEventListener('animationend', () => {
                if (toast && toast.parentElement) toast.parentElement.removeChild(toast);
            }, { once: true });
        } catch (_) {}
    }

    async function save() {
        if (!cmView) return;
        if (isTemplate) {
            promptTemplateSave();
            return;
        }

        const text = cmView.state.doc.toString();
        state.buffer = text.split('\n');
        try {
            if (window.db && typeof window.db.upsert === 'function') {
                await window.db.upsert(state.date, text);
                savedSnapshot = text;
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
        clearUnsaved();
        showToast('Saved');
        state.dirty = false;
    }

    function showTemplateSavedToast() {
        showToast('Template Saved', 'templateToast');
    }

    function showTemplateModal({ onSave, onCancel, initialValue = '', initialSchedule = null } = {}) {
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
                    <div class="cj-modal-field cj-schedule">
                        <span class="cj-schedule-title">Repeating schedule</span>
                        <div class="cj-schedule-intro muted">Optional schedule. More specific rules win (Year &gt; Month &gt; Week &gt; Day).</div>
                        <div class="cj-schedule-section" data-section="day">
                            <label class="cj-schedule-row">
                                <input type="checkbox" class="cj-sched-enable" name="schedDayEnabled" />
                                <span>Every</span>
                                <input type="number" min="1" step="1" name="schedDayInterval" />
                                <span>day(s)</span>
                            </label>
                        </div>
                        <div class="cj-schedule-section" data-section="week">
                            <label class="cj-schedule-row">
                                <input type="checkbox" class="cj-sched-enable" name="schedWeekEnabled" />
                                <span>Repeat every</span>
                                <input type="number" min="1" step="1" name="schedWeekInterval" />
                                <span>week(s) on</span>
                            </label>
                            <div class="cj-schedule-weekdays">
                                <label><input type="checkbox" name="schedWeekDay" value="1">Mon</label>
                                <label><input type="checkbox" name="schedWeekDay" value="2">Tue</label>
                                <label><input type="checkbox" name="schedWeekDay" value="3">Wed</label>
                                <label><input type="checkbox" name="schedWeekDay" value="4">Thu</label>
                                <label><input type="checkbox" name="schedWeekDay" value="5">Fri</label>
                                <label><input type="checkbox" name="schedWeekDay" value="6">Sat</label>
                                <label><input type="checkbox" name="schedWeekDay" value="0">Sun</label>
                            </div>
                        </div>
                        <div class="cj-schedule-section" data-section="month">
                            <label class="cj-schedule-row">
                                <input type="checkbox" class="cj-sched-enable" name="schedMonthEnabled" />
                                <span>Repeat every</span>
                                <input type="number" min="1" step="1" name="schedMonthInterval" />
                                <span>month(s) on the</span>
                            </label>
                            <div class="cj-schedule-month">
                                <input type="number" min="1" max="31" step="1" name="schedMonthDay" class="cj-month-day" />
                                <select name="schedMonthNth" class="cj-month-nth" style="display:none;">
                                    <option value="1">1st</option>
                                    <option value="2">2nd</option>
                                    <option value="3">3rd</option>
                                    <option value="4">4th</option>
                                    <option value="last">Last</option>
                                </select>
                                <select name="schedMonthTarget">
                                    <option value="day">Day</option>
                                    <option value="1">Mon</option>
                                    <option value="2">Tue</option>
                                    <option value="3">Wed</option>
                                    <option value="4">Thu</option>
                                    <option value="5">Fri</option>
                                    <option value="6">Sat</option>
                                    <option value="0">Sun</option>
                                </select>
                            </div>
                        </div>
                        <div class="cj-schedule-section" data-section="year">
                            <label class="cj-schedule-row cj-schedule-row-year">
                                <input type="checkbox" class="cj-sched-enable" name="schedYearEnabled" />
                                <span>Repeat every</span>
                                <input type="number" min="1" step="1" name="schedYearInterval" />
                                <span>year(s) on</span>
                                <input type="date" name="schedYearDate" />
                            </label>
                        </div>
                    </div>
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

        const dayEnable = wrap.querySelector('input[name="schedDayEnabled"]');
        const dayInterval = wrap.querySelector('input[name="schedDayInterval"]');
        const weekEnable = wrap.querySelector('input[name="schedWeekEnabled"]');
        const weekInterval = wrap.querySelector('input[name="schedWeekInterval"]');
        const weekDayInputs = Array.from(wrap.querySelectorAll('input[name="schedWeekDay"]'));
        const monthEnable = wrap.querySelector('input[name="schedMonthEnabled"]');
        const monthInterval = wrap.querySelector('input[name="schedMonthInterval"]');
        const monthDayInput = wrap.querySelector('input[name="schedMonthDay"]');
        const monthNthSelect = wrap.querySelector('select[name="schedMonthNth"]');
        const monthTarget = wrap.querySelector('select[name="schedMonthTarget"]');
        const yearEnable = wrap.querySelector('input[name="schedYearEnabled"]');
        const yearInterval = wrap.querySelector('input[name="schedYearInterval"]');
        const yearDate = wrap.querySelector('input[name="schedYearDate"]');

        const sectionDescriptors = [
            { key: 'day', checkbox: dayEnable, inputs: [dayInterval] },
            { key: 'week', checkbox: weekEnable, inputs: [weekInterval, ...weekDayInputs] },
            { key: 'month', checkbox: monthEnable, inputs: [monthInterval, monthDayInput, monthNthSelect, monthTarget] },
            { key: 'year', checkbox: yearEnable, inputs: [yearInterval, yearDate] }
        ];
        const primaryCheckboxes = sectionDescriptors.map(s => s.checkbox).filter(Boolean);

        const scheduleInitial = cloneTemplateSchedule(initialSchedule);
        const todayIso = new Date().toISOString().slice(0, 10);
        let anchorSeed = (scheduleInitial && isISODate(scheduleInitial.anchorDate))
            ? scheduleInitial.anchorDate
            : todayIso;

        const setInputsDisabled = (inputs, disabled) => {
            for (const inputEl of inputs) {
                if (!inputEl) continue;
                inputEl.disabled = !!disabled;
            }
        };

        const refreshSectionLocks = () => {
            const activeDescriptor = sectionDescriptors.find(({ checkbox }) => checkbox && checkbox.checked) || null;
            sectionDescriptors.forEach(({ checkbox, inputs }) => {
                if (!checkbox) return;
                const section = checkbox.closest('.cj-schedule-section');
                const isActive = checkbox.checked;
                if (section) {
                    section.dataset.active = isActive ? '1' : '0';
                }
                checkbox.disabled = !!activeDescriptor && checkbox !== activeDescriptor.checkbox;
                setInputsDisabled(inputs, !isActive);
            });
            syncMonthMode();
        };

        const ensureSectionEnabled = (checkbox) => {
            if (!checkbox || checkbox.disabled || checkbox.checked) return;
            checkbox.checked = true;
            refreshSectionLocks();
        };

        primaryCheckboxes.forEach((checkbox) => {
            if (!checkbox) return;
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    sectionDescriptors.forEach(({ checkbox: sibling }) => {
                        if (sibling && sibling !== checkbox) sibling.checked = false;
                    });
                }
                refreshSectionLocks();
            });
        });

        sectionDescriptors.forEach(({ checkbox, inputs }) => {
            inputs.forEach(ctrl => {
                if (!ctrl) return;
                ctrl.addEventListener('focus', () => ensureSectionEnabled(checkbox), { passive: true });
            });
        });

        refreshSectionLocks();

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

        function syncMonthMode() {
            if (!monthTarget) return;
            const useDay = monthTarget.value === 'day';

            if (monthDayInput) {
                monthDayInput.style.display = useDay ? '' : 'none';
                monthDayInput.disabled = !useDay || (monthEnable && !monthEnable.checked);
                if (useDay) {
                    monthDayInput.min = '1';
                    monthDayInput.max = '31';
                    if (!monthDayInput.value) monthDayInput.value = '1';
                }
            }
            if (monthNthSelect) {
                monthNthSelect.style.display = useDay ? 'none' : '';
                monthNthSelect.disabled = useDay || (monthEnable && !monthEnable.checked);
                if (!useDay && !monthNthSelect.value) {
                    monthNthSelect.value = '1';
                }
            }
        }

        const applyInitialSchedule = () => {
            if (dayInterval) dayInterval.value = scheduleInitial?.day?.interval ?? '1';
            if (dayEnable) dayEnable.checked = !!scheduleInitial?.day;

            if (weekInterval) weekInterval.value = scheduleInitial?.week?.interval ?? '1';
            if (weekEnable) weekEnable.checked = !!scheduleInitial?.week;
            if (scheduleInitial?.week?.weekdays && weekDayInputs.length) {
                const set = new Set(scheduleInitial.week.weekdays.map(Number));
                weekDayInputs.forEach(cb => { cb.checked = set.has(Number(cb.value)); });
            } else {
                weekDayInputs.forEach(cb => { cb.checked = false; });
            }

            if (monthInterval) monthInterval.value = scheduleInitial?.month?.interval ?? '1';
            if (monthEnable) monthEnable.checked = !!scheduleInitial?.month;
            if (scheduleInitial?.month?.mode === 'weekday' && scheduleInitial.month.weekday !== undefined) {
                if (monthTarget) monthTarget.value = String(scheduleInitial.month.weekday);
                if (monthNthSelect) monthNthSelect.value = String(scheduleInitial.month.nth === 'last' ? 'last' : (scheduleInitial.month.nth ?? '1'));
                if (monthDayInput && !monthDayInput.value) monthDayInput.value = '1';
            } else {
                if (monthTarget) monthTarget.value = 'day';
                if (monthDayInput) monthDayInput.value = scheduleInitial?.month?.day ?? '1';
                if (monthNthSelect && !monthNthSelect.value) monthNthSelect.value = '1';
            }

            if (yearInterval) yearInterval.value = scheduleInitial?.year?.interval ?? '1';
            if (yearEnable) yearEnable.checked = !!scheduleInitial?.year;
            const yearDefault = scheduleInitial?.year?.startDate && isISODate(scheduleInitial.year.startDate)
                ? scheduleInitial.year.startDate
                : anchorSeed;
            if (yearDate) yearDate.value = yearDefault;
            refreshSectionLocks();
        };

        const collectRawSchedule = () => {
            const yearDateVal = (yearDate && yearDate.value) ? yearDate.value : '';
            const yearDateValid = isISODate(yearDateVal);
            const anchorDate = (yearEnable && yearEnable.checked && yearDateValid) ? yearDateVal : anchorSeed;
            return {
                anchorDate,
                day: {
                    enabled: !!(dayEnable && dayEnable.checked),
                    interval: dayInterval ? dayInterval.value : ''
                },
                week: {
                    enabled: !!(weekEnable && weekEnable.checked),
                    interval: weekInterval ? weekInterval.value : '',
                    weekdays: weekDayInputs.map(cb => cb.checked ? Number(cb.value) : null).filter(v => v !== null)
                },
                month: {
                    enabled: !!(monthEnable && monthEnable.checked),
                    interval: monthInterval ? monthInterval.value : '',
                    mode: monthTarget && monthTarget.value !== 'day' ? 'weekday' : 'day',
                    value: (monthTarget && monthTarget.value !== 'day')
                        ? (monthNthSelect ? monthNthSelect.value : '')
                        : (monthDayInput ? monthDayInput.value : ''),
                    weekday: monthTarget && monthTarget.value !== 'day' ? Number(monthTarget.value) : null
                },
                year: {
                    enabled: !!(yearEnable && yearEnable.checked),
                    interval: yearInterval ? yearInterval.value : '',
                    date: yearDateValid ? yearDateVal : ''
                }
            };
        };

        const focusElement = (el) => {
            if (!el) return;
            try { el.focus({ preventScroll: true }); }
            catch { el.focus(); }
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
                    focusElement(input);
                    try { input.select(); } catch {}
                }
                return;
            }

            const rawSchedule = collectRawSchedule();
            const normalized = normalizeTemplateSchedule(rawSchedule, { defaultAnchorDate: rawSchedule.anchorDate });

            if (rawSchedule.day.enabled && (!normalized || !normalized.day)) {
                showError('Daily schedule interval must be at least 1.');
                focusElement(dayInterval);
                return;
            }
            if (rawSchedule.week.enabled) {
                if (!rawSchedule.week.weekdays.length) {
                    showError('Select at least one weekday for the weekly schedule.');
                    focusElement(weekDayInputs[0]);
                    return;
                }
                if (!normalized || !normalized.week) {
                    showError('Weekly schedule interval must be at least 1.');
                    focusElement(weekInterval);
                    return;
                }
            }
            if (rawSchedule.month.enabled) {
                if (rawSchedule.month.mode === 'day') {
                    const dayVal = Number(rawSchedule.month.value);
                    if (!Number.isFinite(dayVal) || dayVal < 1 || dayVal > 31) {
                        showError('Choose a day between 1 and 31 for the monthly schedule.');
                        focusElement(monthDayInput);
                        return;
                    }
                    if (!normalized || !normalized.month || normalized.month.mode !== 'day') {
                        showError('Monthly schedule interval must be at least 1.');
                        focusElement(monthInterval);
                        return;
                    }
                } else {
                    if (rawSchedule.month.weekday === null) {
                        showError('Choose a weekday for the monthly schedule.');
                        focusElement(monthTarget);
                        return;
                    }
                    if (!normalized || !normalized.month || normalized.month.mode !== 'weekday') {
                        showError('Monthly schedule interval must be at least 1.');
                        focusElement(monthInterval);
                        return;
                    }
                    if (normalized.month.nth !== 'last') {
                        const nthVal = Number(rawSchedule.month.value);
                        if (!Number.isFinite(nthVal) || nthVal < 1 || nthVal > 4) {
                            showError('Choose 1st, 2nd, 3rd, 4th, or Last for the monthly schedule.');
                            focusElement(monthNthSelect);
                            return;
                        }
                    }
                }
            }
            if (rawSchedule.year.enabled) {
                if (!isISODate(rawSchedule.year.date)) {
                    showError('Pick a valid date for the yearly schedule.');
                    focusElement(yearDate);
                    return;
                }
                if (!normalized || !normalized.year) {
                    showError('Yearly schedule interval must be at least 1.');
                    focusElement(yearInterval);
                    return;
                }
            }

            const schedulePayload = normalized ? cloneTemplateSchedule(normalized) : null;
            if (normalized && normalized.anchorDate) {
                anchorSeed = normalized.anchorDate;
            }

            showError('');
            submitting = true;
            try {
                if (typeof onSave === 'function') {
                    await onSave(value, schedulePayload);
                }
                cleanup();
            } catch (err) {
                submitting = false;
                const message = err?.message || String(err);
                showError(message);
                if (input) {
                    focusElement(input);
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
            if (k === 'enter' && !e.shiftKey) {
                if (wrap.contains(document.activeElement)) {
                    e.preventDefault();
                    e.stopPropagation();
                    accept();
                    return;
                }
            }
        };

        window.addEventListener('keydown', onKey, true);

        applyInitialSchedule();

        if (monthTarget) monthTarget.addEventListener('change', () => {
            syncMonthMode();
            refreshSectionLocks();
        });
        if (yearDate) yearDate.addEventListener('change', () => {
            if (yearEnable && yearEnable.checked && yearDate && isISODate(yearDate.value)) {
                anchorSeed = yearDate.value;
            }
        });

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
                focusElement(input);
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
            onSave: async (name, schedule) => {
                const saved = await window.db.saveTemplate(name, text, schedule);
                const nextSchedule = saved && saved.schedule
                    ? cloneTemplateSchedule(saved.schedule)
                    : cloneTemplateSchedule(schedule);
                state.templateSchedule = nextSchedule;
                state.templateName = name;
                state.id = name;
                state.title = `Template: ${name}`;
                const headerEl = document.querySelector('.writer-header');
                if (headerEl) headerEl.textContent = `TEMPLATE - ${name}`;
                if (cmView) savedSnapshot = cmView.state.doc.toString();
                clearUnsaved();
                state.dirty = false;
                showTemplateSavedToast();
            },
            initialValue: isTemplate ? ((state.templateName ?? templateName) ?? '') : '',
            initialSchedule: state.templateSchedule
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
    savedSnapshot = startDoc;
    cmView = new EditorView({
        state: EditorState.create({ doc: startDoc, extensions: buildExtensions() }),
        parent: paneEl
    });
    cmView.focus();
    // Move cursor to end and scroll to bottom when opening a file
    const docLen = cmView.state.doc.length;
    cmView.dispatch({ selection: { anchor: docLen }, scrollIntoView: true });
    requestAnimationFrame(() => {
        // Position the end of the document around ~35% from the top, accounting for bottom padding
        const scroller = (typeof getScrollContainer === 'function') ? getScrollContainer(cmView) : cmView.scrollDOM;
        if (!scroller) return;
        const child = cmView.scrollDOM; // CM's internal scroller/content root

        const ch = scroller.clientHeight || Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);

        // Compute effective bottom of real content by subtracting any bottom padding present
        const csContainer = getComputedStyle(scroller);
        const csChild = child && child !== scroller ? getComputedStyle(child) : csContainer;
        const padBottomContainer = parseFloat(csContainer.paddingBottom || '0') || 0;
        const padBottomChild = parseFloat(csChild.paddingBottom || '0') || 0;
        const padBottom = Math.max(padBottomContainer, padBottomChild);

        const contentBottom = Math.max(0, scroller.scrollHeight - padBottom);
        const target = Math.max(0, contentBottom - Math.round(ch * 0.35));
        scroller.scrollTop = target;

        // Let one more frame render, then re-enable typewriter/snap behavior
        // requestAnimationFrame(() => {
        //     INIT_SCROLL_SUPPRESS.delete(cmView);
        // });
    });

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
