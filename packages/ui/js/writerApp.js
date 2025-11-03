import { EditorState, EditorSelection, RangeSetBuilder, Transaction } from '@codemirror/state';
import { EditorView, keymap, drawSelection, Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { indentUnit, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { search, searchKeymap, openSearchPanel, findNext, findPrevious } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { listLayoutPlugin, createListKeymap, listRenumberListener } from './listLayout.js';

const MENU_ACTIONS = {
    OPEN: 'open',
    DUPLICATE: 'duplicate',
    DELETE: 'delete',
    EXPORT: 'export',
    RENAME: 'rename',
};

const INDENT = '  '; // two spaces per nesting level

function hasPointerUserEvent(update) {
    if (!update || !Array.isArray(update.transactions)) return false;
    return update.transactions.some(tr => {
        const userEvent = tr.annotation(Transaction.userEvent);
        if (typeof userEvent !== 'string') return false;
        const lowered = userEvent.toLowerCase();
        return lowered.includes('pointer') || lowered.includes('mouse');
    });
}

class TodoClickTargetWidget extends WidgetType {
    toDOM() {
        const span = document.createElement('span');
        span.className = 'todo-click-target';
        span.style.position = 'absolute';
        span.style.top = '0';
        span.style.left = '0';
        span.style.width = '100%';
        span.style.height = '100%';
        span.style.pointerEvents = 'auto';
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
                const match = line.text.match(/^(\s*[-*]\s+\[( |x)\]\s*)/);
                if (!match) continue;
                const isChecked = match[2] === 'x';
                const lineClasses = ['todo-line'];
                if (isChecked) lineClasses.push('completed');
                const lineSpec = { class: lineClasses.join(' ') };
                builder.add(line.from, line.from, Decoration.line(lineSpec));

                const bracketStart = line.text.indexOf('[');
                const bracketEnd = line.text.indexOf(']', bracketStart);
                if (bracketStart === -1 || bracketEnd === -1) continue;
                const decoFrom = line.from + bracketStart;
                const decoTo = line.from + bracketEnd + 1;
                builder.add(decoFrom, decoTo, Decoration.mark({ class: 'todo-click-target' }));
                const spaceAfter = line.text.slice(bracketEnd + 1).match(/^\s*/)[0].length;
                const contentStart = line.from + bracketEnd + 1 + spaceAfter;
                if (contentStart < line.to) {
                    builder.add(contentStart, line.to, Decoration.mark({ class: 'todo-text' }));
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
            const processToggle = (line) => {
                const match = line.text.match(/^\s*[-*]\s+\[( |x)\]/);
                if (!match) return false;
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
            };

            if (target.classList.contains('todo-click-target')) {
                const pos = view.posAtDOM(target, event.clientX, event.clientY);
                const line = view.state.doc.lineAt(pos);
                return processToggle(line);
            }

            const lineNode = target.closest('.cm-line');
            if (!lineNode) return false;
            const pos = view.posAtDOM(lineNode, event.clientX, event.clientY);
            const line = view.state.doc.lineAt(pos);
            const match = line.text.match(/^\s*[-*]\s+\[( |x)\]/);
            if (!match) return false;
            const bracketStart = line.text.indexOf('[');
            const bracketEnd = line.text.indexOf(']', bracketStart);
            if (bracketStart === -1 || bracketEnd === -1) return false;
            const range = document.createRange();
            range.setStart(lineNode.firstChild || lineNode, 0);
            range.setEnd(lineNode.firstChild || lineNode, lineNode.textContent?.length ?? 0);
            const rects = range.getClientRects();
            const rect = Array.from(rects).find(r => event.clientY >= r.top && event.clientY <= r.bottom);
            if (!rect) return false;
            const relativeX = event.clientX - rect.left;
            const averageChar = rect.width / (line.text.length || 1);
            const charOffset = Math.floor(relativeX / Math.max(averageChar, 1));
            if (charOffset < bracketStart || charOffset > bracketEnd) return false;
            return processToggle(line);
        }
    })
];

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
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--editor-selection-bg)' },
    '.cm-lineNumbers': { color: 'color-mix(in srgb, var(--text) 55%, transparent)' },
    '.cm-gutters': { backgroundColor: 'var(--editor-gutter-bg)', borderRight: '1px solid var(--border, rgba(255,255,255,0.1))' },
    '.cm-panels': { background: 'var(--editor-panel-bg)' },
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

const retroHighlight = HighlightStyle.define([
    { tag: t.strong, fontWeight: '700' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.heading1, fontWeight: '700', fontSize: '1.5em' },
    { tag: t.heading2, fontWeight: '700', fontSize: '1.35em' },
    { tag: t.heading3, fontWeight: '700', fontSize: '1.2em' },
    { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700' }
]);

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

const snapOutOfView = EditorView.updateListener.of((update) => {
    if (!(update.docChanged || update.selectionSet)) return;
    if (hasPointerUserEvent(update)) return;
    const view = update.view;
    const scroller = getScrollContainer(view);
    if (!scroller) return;
    requestAnimationFrame(() => {
        const head = view.state.selection.main.head;
        const caret = view.coordsAtPos(head);
        if (!caret) return;
        const scr = scroller.getBoundingClientRect();
        const above = caret.top < scr.top;
        const below = caret.bottom > scr.bottom;
        if (!above && !below) return;
        const lineH = view.defaultLineHeight || 24;
        const pad = lineH * 2;
        if (above) {
            const delta = caret.top - (scr.top + pad);
            scroller.scrollTop += delta;
        } else if (below) {
            const delta = caret.bottom - (scr.bottom - pad);
            scroller.scrollTop += delta;
        }
    });
});

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

function typewriterAdvanceScroll() {
    return ViewPlugin.fromClass(class {
        constructor(view) {
            this.view = view;
            this._scheduled = false;
            this._lastBottom = null;
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
                    const dy = cur - this._lastBottom;
                    const threshold = this._lineH * 0.6;
                    if (dy > threshold) {
                        scroller.scrollTop += Math.round(dy);
                        this._lastBottom = cur;
                    } else if (dy < -threshold) {
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
            if (update.viewportChanged || update.domChanged) this.updatePads();
        }
        destroy() {
            try { this._ro && this._ro.disconnect(); } catch {}
            window.removeEventListener('resize', this._onWindowResize);
        }
    });
}

const INIT_SCROLL_SUPPRESS = new WeakSet();

function showToast(message, variant = 'info', id = 'writerToast') {
    try {
        const prev = id ? document.getElementById(id) : null;
        if (prev && prev.parentElement) prev.parentElement.removeChild(prev);
        const toast = document.createElement('div');
        if (id) toast.id = id;
        toast.className = `template-toast ${variant}`;
        toast.textContent = message;
        (document.body || document.documentElement).appendChild(toast);
        toast.addEventListener('animationend', () => {
            if (toast && toast.parentElement) toast.parentElement.removeChild(toast);
        }, { once: true });
    } catch (_) {}
}

export function startWriter(shell, opts = {}) {
    const writerAPI = window?.db?.writer;
    if (!writerAPI || typeof writerAPI.list !== 'function') {
        shell.print('<div class="error">Writer is unavailable in this environment.</div>');
        return null;
    }

    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent || '');
    const outputEl = document.getElementById('output');
    const inputWrapEl = document.getElementById('inputWrap');
    const caretEl = document.querySelector('.caret');
    const screenEl = document.getElementById('screen');
    const titleEl = document.querySelector('.title');
    const titlebar = document.querySelector('.titlebar');

    const state = {
        docs: [],
        current: null,
        dirty: false,
        savedSnapshot: '',
        cmView: null,
        rootEl: null,
        listEl: null,
        contextMenuEl: null,
        toggleBtn: null,
        titleHelpEl: null,
        navCollapsed: false,
        domSnapshot: null,
        titlebarInsertions: [],
        prompt: opts.prompt || 'writer>',
    };

    function esc(str) {
        return String(str ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    }

    function captureDOMSnapshot() {
        state.domSnapshot = {
            outputHTML: outputEl ? outputEl.innerHTML : '',
            inputDisplay: inputWrapEl ? inputWrapEl.style.display : '',
            caretDisplay: caretEl ? caretEl.style.display : '',
            screenPadding: screenEl ? screenEl.style.padding : ''
        };
    }

    function hideConsole() {
        if (inputWrapEl) inputWrapEl.style.display = 'none';
        if (caretEl) caretEl.style.display = 'none';
        if (outputEl) outputEl.innerHTML = '';
        if (screenEl) screenEl.classList.add('locked');
        if (titleEl) titleEl.style.opacity = '0.6';
        if (titlebar) titlebar.classList.add('writer-mode');

        if (titlebar) {
            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = 'writer-toggle';
            toggleBtn.title = 'Toggle file selector';
            toggleBtn.setAttribute('aria-label', 'Toggle file selector');
            toggleBtn.setAttribute('aria-pressed', 'false');
            toggleBtn.innerHTML = '<span class="writer-toggle-icon" aria-hidden="true"></span>';
            toggleBtn.addEventListener('click', toggleNavigation);
            titlebar.insertBefore(toggleBtn, titlebar.firstChild);
            state.toggleBtn = toggleBtn;
            state.titlebarInsertions.push(toggleBtn);

            const help = document.createElement('span');
            help.className = 'writer-title-help muted';
            help.textContent = isMac ? '⌘+S save · Ctrl+X exit' : 'Ctrl+S save · Ctrl+Q exit';
            titlebar.appendChild(help);
            state.titleHelpEl = help;
            state.titlebarInsertions.push(help);
        }
    }

    function restoreConsole() {
        if (screenEl) screenEl.classList.remove('locked');
        if (state.rootEl && state.rootEl.parentElement) {
            state.rootEl.parentElement.removeChild(state.rootEl);
        }
        if (outputEl && state.domSnapshot) outputEl.innerHTML = state.domSnapshot.outputHTML;
        if (inputWrapEl && state.domSnapshot) inputWrapEl.style.display = state.domSnapshot.inputDisplay;
        if (caretEl && state.domSnapshot) caretEl.style.display = state.domSnapshot.caretDisplay;
        if (screenEl && state.domSnapshot) screenEl.style.padding = state.domSnapshot.screenPadding;

        if (titleEl) titleEl.style.opacity = '';
        if (titlebar) {
            titlebar.classList.remove('writer-mode');
            state.titlebarInsertions.forEach(node => {
                if (node && node.parentElement) node.parentElement.removeChild(node);
            });
            state.titlebarInsertions = [];
        }
        if (state.contextMenuEl && state.contextMenuEl.parentElement) {
            state.contextMenuEl.parentElement.removeChild(state.contextMenuEl);
        }
    }

    function ensureContextMenu() {
        if (state.contextMenuEl) return state.contextMenuEl;
        const menu = document.createElement('div');
        menu.className = 'writer-context-menu';
        menu.innerHTML = `
            <button data-action="${MENU_ACTIONS.OPEN}">Open</button>
            <button data-action="${MENU_ACTIONS.RENAME}">Rename</button>
            <button data-action="${MENU_ACTIONS.DUPLICATE}">Duplicate</button>
            <button data-action="${MENU_ACTIONS.EXPORT}">Export PDF</button>
            <button data-action="${MENU_ACTIONS.DELETE}" class="danger">Delete</button>
        `;
        document.body.appendChild(menu);
        state.contextMenuEl = menu;
        return menu;
    }

    function closeContextMenu() {
        if (state.contextMenuEl) state.contextMenuEl.classList.remove('visible');
    }

    function markDirty() {
        if (state.dirty) return;
        state.dirty = true;
        if (state.current) {
            const item = state.listEl?.querySelector(`[data-id="${state.current.id}"]`);
            if (item) item.classList.add('dirty');
        }
    }

    function clearDirty(snapshot) {
        state.dirty = false;
        if (typeof snapshot === 'string') state.savedSnapshot = snapshot;
        if (state.current) {
            const item = state.listEl?.querySelector(`[data-id="${state.current.id}"]`);
            if (item) item.classList.remove('dirty');
        }
    }

    function buildExtensions() {
        const saveExitKeymap = keymap.of([
            {
                key: 'Mod-s',
                preventDefault: true,
                run: () => {
                    saveCurrentDocument();
                    return true;
                }
            },
            {
                key: isMac ? 'Ctrl-x' : 'Ctrl-q',
                preventDefault: true,
                run: () => {
                    requestExit();
                    return true;
                }
            },
            {
                key: 'Mod-t',
                preventDefault: true,
                run: (view) => {
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
                }
            }
        ]);

        const unsavedTracker = EditorView.updateListener.of((update) => {
            if (!(update && update.docChanged)) return;
            const cur = update.state.doc.toString();
            if (cur === state.savedSnapshot) {
                clearDirty();
                state.dirty = false;
            } else {
                markDirty();
            }
        });

        return [
            retroTheme,
            dynamicScrollerPadding(),
            drawSelection(),
            activeRowPlugin,
            typewriterAdvanceScroll(),
            snapOutOfView,
            unsavedTracker,
            history(),
            todoPlugin,
            listLayoutPlugin,
            listRenumberListener,
            indentUnit.of(INDENT),
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

    function attachGlobalListeners() {
        window.addEventListener('click', closeContextMenu, true);
        window.addEventListener('contextmenu', (e) => {
            if (!state.listEl || !state.listEl.contains(e.target)) {
                closeContextMenu();
            }
        });
        window.addEventListener('keydown', onHotkey, true);
    }

    function detachGlobalListeners() {
        window.removeEventListener('click', closeContextMenu, true);
        window.removeEventListener('keydown', onHotkey, true);
    }

    function onHotkey(e) {
        if ((isMac && e.metaKey) || (!isMac && e.ctrlKey)) {
            if (e.shiftKey && (e.key === 'n' || e.key === 'N')) {
                e.preventDefault();
                createNewDocument();
                return;
            }
        }
        if (e.key === 'Escape') closeContextMenu();
    }

    function toggleNavigation() {
        state.navCollapsed = !state.navCollapsed;
        if (state.rootEl) {
            if (state.navCollapsed) state.rootEl.classList.add('nav-collapsed');
            else state.rootEl.classList.remove('nav-collapsed');
        }
        if (state.toggleBtn) {
            state.toggleBtn.setAttribute('aria-pressed', state.navCollapsed ? 'true' : 'false');
        }
    }

    function renderLayout() {
        const root = document.createElement('div');
        root.id = 'writerRoot';
        root.className = 'writer-root';

        const main = document.createElement('div');
        main.className = 'writer-main';

        const navigation = document.createElement('div');
        navigation.className = 'writer-navigation';
        navigation.innerHTML = `
            <div class="writer-files">
                <div class="writer-files-header">
                    <span>Files</span>
                    <button class="writer-create" title="New document" aria-label="New document"></button>
                </div>
                <div class="writer-files-body">
                    <ul class="writer-file-list"></ul>
                </div>
            </div>
        `;

        const editor = document.createElement('div');
        editor.className = 'writer-editor';
        editor.innerHTML = `
            <div class="writer-editor-pane" id="writerEditorPane"></div>
        `;

        main.appendChild(navigation);
        main.appendChild(editor);
        root.appendChild(main);

        state.rootEl = root;
        state.listEl = navigation.querySelector('.writer-file-list');
        const createBtn = navigation.querySelector('.writer-create');
        if (createBtn) {
            createBtn.addEventListener('click', () => createNewDocument());
        }

        if (state.listEl) {
            state.listEl.addEventListener('click', onFileClick);
            state.listEl.addEventListener('contextmenu', onFileContextMenu);
        }

        return root;
    }

    function mountUI() {
        captureDOMSnapshot();
        hideConsole();

        const parent = outputEl?.parentElement || screenEl;
        if (parent) parent.appendChild(renderLayout());
        attachGlobalListeners();
        ensureContextMenu();

        const paneEl = document.getElementById('writerEditorPane');
        if (!paneEl) throw new Error('Writer editor pane missing');

        state.cmView = new EditorView({
            state: EditorState.create({ doc: '', extensions: buildExtensions() }),
            parent: paneEl
        });
        INIT_SCROLL_SUPPRESS.add(state.cmView);
        state.savedSnapshot = '';
        clearDirty('');
    }

    function redrawFileList() {
        if (!state.listEl) return;
        state.listEl.innerHTML = '';
        for (const doc of state.docs) {
            const item = document.createElement('li');
            item.className = 'writer-file-item';
            item.dataset.id = String(doc.id);
            if (state.current && doc.id === state.current.id) item.classList.add('active');
            item.innerHTML = `
                <div class="writer-file-title">${esc(doc.title)}</div>
                <div class="writer-file-meta muted">${formatUpdatedAt(doc.updated_at)}</div>
            `;
            state.listEl.appendChild(item);
        }
        const host = state.listEl.parentElement;
        if (host) {
            const prevEmpty = host.querySelector('.writer-files-empty');
            if (prevEmpty) prevEmpty.remove();
            if (!state.docs.length) {
                const empty = document.createElement('div');
                empty.className = 'writer-files-empty muted';
                empty.textContent = 'Create your first document with the + button.';
                host.appendChild(empty);
            }
        }
    }

    function setActiveListItem(id) {
        if (!state.listEl) return;
        state.listEl.querySelectorAll('.writer-file-item').forEach(item => {
            if (item.dataset.id === String(id)) item.classList.add('active');
            else item.classList.remove('active');
        });
    }

    function formatUpdatedAt(value) {
        if (!value) return '';
        try {
            const dt = new Date(value);
            if (Number.isNaN(dt.getTime())) return '';
            return dt.toLocaleString();
        } catch (_) {
            return '';
        }
    }

    async function loadDocuments() {
        try {
            const docs = await writerAPI.list();
            state.docs = Array.isArray(docs) ? docs : [];
            redrawFileList();
            if (state.docs.length && (!state.current || !state.docs.some(d => d.id === state.current.id))) {
                await openDocument(state.docs[0].id, { force: true });
            } else if (!state.docs.length) {
                setEditorContent('', 'Untitled Document');
                state.current = null;
            }
        } catch (err) {
            shell.print(`<div class="error">Failed to load writer documents: ${esc(err?.message || err)}</div>`);
        }
    }

    function setEditorContent(content, title, snapshotOverride) {
        if (!state.cmView) return;
        const doc = typeof content === 'string' ? content : '';
        state.cmView.dispatch({
            changes: { from: 0, to: state.cmView.state.doc.length, insert: doc }
        });
        const docLen = state.cmView.state.doc.length;
        state.cmView.dispatch({ selection: { anchor: docLen }, scrollIntoView: true });
        requestAnimationFrame(() => {
            const scroller = getScrollContainer(state.cmView);
            if (!scroller) return;
            const ch = scroller.clientHeight || Math.max(0, window.innerHeight || 0);
            const csContainer = getComputedStyle(scroller);
            const child = state.cmView.scrollDOM;
            const csChild = child && child !== scroller ? getComputedStyle(child) : csContainer;
            const padBottomContainer = parseFloat(csContainer.paddingBottom || '0') || 0;
            const padBottomChild = parseFloat(csChild.paddingBottom || '0') || 0;
            const padBottom = Math.max(padBottomContainer, padBottomChild);
            const contentBottom = Math.max(0, scroller.scrollHeight - padBottom);
            const target = Math.max(0, contentBottom - Math.round(ch * 0.35));
            scroller.scrollTop = target;
            requestAnimationFrame(() => {
                INIT_SCROLL_SUPPRESS.delete(state.cmView);
            });
        });
        state.savedSnapshot = typeof snapshotOverride === 'string' ? snapshotOverride : doc;
        clearDirty(state.savedSnapshot);
    }

    async function openDocument(id, { force = false } = {}) {
        if (!force && state.current && state.current.id === id) return;
        if (!force && state.dirty) {
            const result = await confirmModal({
                title: 'Unsaved changes',
                message: 'Save changes before switching documents?',
                confirmLabel: 'Save',
                cancelLabel: 'Discard'
            });
            if (result === 'confirm') {
                const saved = await saveCurrentDocument();
                if (!saved) return;
            }
            clearDirty();
        }
        try {
            const doc = await writerAPI.get(id);
            if (!doc) return;
            state.current = doc;
            setActiveListItem(id);
            setEditorContent(doc.content || '', doc.title || 'Untitled Document', doc.content || '');
        } catch (err) {
            shell.print(`<div class="error">Unable to open document: ${esc(err?.message || err)}</div>`);
        }
    }

    function onFileClick(e) {
        const li = e.target.closest('.writer-file-item');
        if (!li) return;
        const id = Number(li.dataset.id);
        if (!Number.isFinite(id)) return;
        openDocument(id);
    }

    function onFileContextMenu(e) {
        const li = e.target.closest('.writer-file-item');
        if (!li) return;
        e.preventDefault();
        const id = Number(li.dataset.id);
        if (!Number.isFinite(id)) return;
        const menu = ensureContextMenu();
        menu.dataset.fileId = String(id);
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        menu.classList.add('visible');
        menu.querySelectorAll('button').forEach(btn => {
            btn.onclick = () => {
                const action = btn.dataset.action;
                handleContextAction(action, id);
                closeContextMenu();
            };
        });
    }

    async function handleContextAction(action, id) {
        switch (action) {
            case MENU_ACTIONS.OPEN:
                await openDocument(id);
                break;
            case MENU_ACTIONS.DUPLICATE:
                await duplicateDocument(id);
                break;
            case MENU_ACTIONS.DELETE:
                await deleteDocument(id);
                break;
            case MENU_ACTIONS.EXPORT:
                await exportDocument(id);
                break;
            case MENU_ACTIONS.RENAME:
                await renameDocument(id);
                break;
            default:
                break;
        }
    }

    async function saveCurrentDocument() {
        if (!state.current) {
            const doc = await createNewDocument();
            if (!doc) return false;
        }
        if (!state.cmView || !state.current) return false;
        const title = state.current.title || 'Untitled Document';
        const content = state.cmView.state.doc.toString();
        try {
            const updated = await writerAPI.update({
                id: state.current.id,
                title,
                content,
                folderId: state.current.folder_id ?? null
            });
            state.current = updated;
            state.savedSnapshot = content;
            clearDirty(content);
            await loadDocuments();
            setActiveListItem(state.current.id);
            showToast('Document saved', 'ok');
            return true;
        } catch (err) {
            showToast(`Save failed: ${err?.message || err}`, 'error', 'writerToastError');
            return false;
        }
    }

    async function createNewDocument() {
        if (state.dirty) {
            const proceed = await confirmModal({
                title: 'Unsaved changes',
                message: 'Save current document before creating a new one?',
                confirmLabel: 'Save',
                cancelLabel: 'Discard'
            });
            if (proceed === 'confirm') {
                const saved = await saveCurrentDocument();
                if (!saved) return null;
            } else {
                clearDirty();
            }
        }
        const requested = await promptModal({
            title: 'New document',
            value: 'Untitled',
            confirmLabel: 'Create',
            cancelLabel: 'Cancel'
        });
        if (requested === null) return null;
        const trimmed = String(requested ?? '').trim();
        if (!trimmed) return null;
        const desiredTitle = trimmed;
        const existingTitles = new Set(state.docs.map(doc => doc.title));
        let title = desiredTitle;
        let counter = 2;
        while (existingTitles.has(title)) {
            title = `${desiredTitle} ${counter++}`;
        }
        try {
            const doc = await writerAPI.create({ title, content: '' });
            await loadDocuments();
            await openDocument(doc.id, { force: true });
            showToast('New document created', 'ok');
            return doc;
        } catch (err) {
            shell.print(`<div class="error">Failed to create document: ${esc(err?.message || err)}</div>`);
            return null;
        }
    }

    async function duplicateDocument(id) {
        try {
            const source = await writerAPI.get(id);
            if (!source) return;
            const base = `${source.title} Copy`;
            const existingTitles = new Set(state.docs.map(doc => doc.title));
            let title = base;
            let counter = 1;
            while (existingTitles.has(title)) {
                counter += 1;
                title = `${base} ${counter}`;
            }
            const doc = await writerAPI.duplicate(id, { title });
            await loadDocuments();
            await openDocument(doc.id, { force: true });
            showToast('Document duplicated', 'ok');
        } catch (err) {
            shell.print(`<div class="error">Duplicate failed: ${esc(err?.message || err)}</div>`);
        }
    }

    async function renameDocument(id) {
        const target = state.docs.find(doc => doc.id === id);
        if (!target) return;
        const result = await promptModal({
            title: 'Rename document',
            value: target.title || 'Untitled Document',
            confirmLabel: 'Rename'
        });
        if (!result || !result.trim()) return;
        const title = result.trim();
        try {
            const renamed = await writerAPI.rename(id, title);
            await loadDocuments();
            if (state.current && state.current.id === id) {
                state.current = { ...state.current, title: renamed.title };
                if (!state.dirty) setActiveListItem(id);
            }
            showToast('Document renamed', 'ok');
        } catch (err) {
            shell.print(`<div class="error">Rename failed: ${esc(err?.message || err)}</div>`);
        }
    }

    async function deleteDocument(id) {
        const target = state.docs.find(doc => doc.id === id);
        if (!target) return;
        const result = await confirmModal({
            title: 'Delete document?',
            message: `This will permanently remove "${target.title}".`,
            confirmLabel: 'Delete',
            cancelLabel: 'Cancel',
            danger: true
        });
        if (result !== 'confirm') return;
        try {
            await writerAPI.delete(id);
            showToast('Document deleted', 'warn');
            await loadDocuments();
            if (state.current && state.current.id === id) {
                state.current = null;
                if (state.docs.length) {
                    await openDocument(state.docs[0].id, { force: true });
                } else {
                    setEditorContent('', 'Untitled Document', '');
                    clearDirty('');
                }
            }
        } catch (err) {
            shell.print(`<div class="error">Delete failed: ${esc(err?.message || err)}</div>`);
        }
    }

    async function exportDocument(id) {
        try {
            const doc = await writerAPI.get(id);
            if (!doc) return;
            await exportAsPdf(doc);
        } catch (err) {
            shell.print(`<div class="error">Export failed: ${esc(err?.message || err)}</div>`);
        }
    }

    async function exportAsPdf(doc) {
        const title = doc.title || 'Writer Document';
        const base = title.replace(/[^\w.-]+/g, '-');
        const filename = `${base}.pdf`;
        const markdownContent = doc.content || '';
        const downloadsDir = await getDownloadsDir();
        const outputPath = `${downloadsDir}/${filename}`;
        const useElectron = !!(window.electronAPI && typeof window.electronAPI.exportJournal === 'function');
        if (useElectron) {
            try {
                await window.electronAPI.exportJournal({ markdown: markdownContent, outputPath, cssPath: 'packages/ui/css/pdf.css', title });
                showToast(`Exported to ${outputPath}`, 'ok', 'writerToastExport');
            } catch (err) {
                showToast(`Export failed: ${err?.message || err}`, 'error', 'writerToastExport');
            }
            return;
        }
        try {
            const resp = await fetch('/api/export-pdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ markdown: markdownContent, title })
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
            showToast(`Downloaded ${filename}`, 'ok', 'writerToastExport');
        } catch (err) {
            showToast(`Export failed: ${err?.message || err}`, 'error', 'writerToastExport');
        }
    }

    async function getDownloadsDir() {
        if (window.electronAPI && typeof window.electronAPI.getPath === 'function') {
            try {
                return await window.electronAPI.getPath('downloads');
            } catch (_) {}
        }
        return '.';
    }

    function requestExit() {
        if (state.dirty) {
            confirmModal({
                title: 'Unsaved changes',
                message: 'Save current document before exiting?',
                confirmLabel: 'Save',
                cancelLabel: 'Discard'
            }).then(async (result) => {
                if (result === 'confirm') {
                    const saved = await saveCurrentDocument();
                    if (!saved) return;
                }
                clearDirty();
                performExit();
            });
        } else {
            performExit();
        }
    }

    function performExit() {
        detachGlobalListeners();
        if (state.cmView) {
            state.cmView.destroy();
            state.cmView = null;
        }
        restoreConsole();
        shell.exit();
        shell.print('<div class="muted">Exited Writer.</div>');
    }

    function confirmModal({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
        return new Promise((resolve) => {
            const wrap = document.createElement('div');
            wrap.className = 'cj-modal-backdrop';
            wrap.innerHTML = `
                <div class="cj-modal" role="dialog" aria-modal="true">
                    <div class="cj-modal-title">${esc(title)}</div>
                    <div class="cj-modal-body">${esc(message)}</div>
                    <div class="cj-modal-actions">
                        <button class="confirm ${danger ? 'danger' : ''}">${confirmLabel}</button>
                        <button class="cancel">${cancelLabel}</button>
                    </div>
                </div>
            `;
            document.body.appendChild(wrap);
            const confirmBtn = wrap.querySelector('button.confirm');
            const cancelBtn = wrap.querySelector('button.cancel');
            const cleanup = () => {
                if (wrap && wrap.parentElement) wrap.parentElement.removeChild(wrap);
                window.removeEventListener('keydown', onKey, true);
            };
            const accept = () => { cleanup(); resolve('confirm'); };
            const reject = () => { cleanup(); resolve('cancel'); };
            function onKey(e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    reject();
                }
                if (e.key === 'Enter') {
                    e.preventDefault();
                    accept();
                }
            }
            confirmBtn.addEventListener('click', accept);
            cancelBtn.addEventListener('click', reject);
            window.addEventListener('keydown', onKey, true);
            setTimeout(() => confirmBtn.focus(), 0);
        });
    }

    function promptModal({ title, value = '', confirmLabel = 'OK', cancelLabel = 'Cancel' } = {}) {
        return new Promise((resolve) => {
            const wrap = document.createElement('div');
            wrap.className = 'cj-modal-backdrop';
            wrap.innerHTML = `
                <div class="cj-modal" role="dialog" aria-modal="true">
                    <div class="cj-modal-title">${esc(title)}</div>
                    <div class="cj-modal-body">
                        <input type="text" class="cj-modal-input" value="${esc(value)}" spellcheck="false" />
                    </div>
                    <div class="cj-modal-actions">
                        <button class="confirm">${confirmLabel}</button>
                        <button class="cancel">${cancelLabel}</button>
                    </div>
                </div>
            `;
            document.body.appendChild(wrap);
            const input = wrap.querySelector('.cj-modal-input');
            const confirmBtn = wrap.querySelector('button.confirm');
            const cancelBtn = wrap.querySelector('button.cancel');
            const cleanup = () => {
                if (wrap && wrap.parentElement) wrap.parentElement.removeChild(wrap);
                window.removeEventListener('keydown', onKey, true);
            };
            const accept = () => { cleanup(); resolve(input.value); };
            const reject = () => { cleanup(); resolve(null); };
            function onKey(e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    reject();
                }
                if (e.key === 'Enter') {
                    e.preventDefault();
                    accept();
                }
            }
            confirmBtn.addEventListener('click', accept);
            cancelBtn.addEventListener('click', reject);
            window.addEventListener('keydown', onKey, true);
            setTimeout(() => {
                input.focus();
                input.select();
            }, 0);
        });
    }

    mountUI();
    shell.setPrompt(state.prompt);
    loadDocuments();

    const program = {
        async consume() {},
        destroy() {
            detachGlobalListeners();
            closeContextMenu();
        }
    };

    shell.enter(program);
    return program;
}
