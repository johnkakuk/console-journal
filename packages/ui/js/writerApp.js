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

const FOLDER_ACTIONS = {
    OPEN: 'open',
    DUPLICATE: 'duplicate',
    DELETE: 'delete',
    RENAME: 'rename'
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
        // Add focus event listener to editor's DOM element
        this._onFocus = () => {
            if (this.dom) this.dom.style.display = 'block';
            this.schedule();
        };
        this.view.dom.addEventListener('focus', this._onFocus, true);
        // Add blur event listener to hide the active row when focus leaves the editor
        this._onBlur = () => {
            if (this.dom) this.dom.style.display = 'none';
        };
        this.view.dom.addEventListener('blur', this._onBlur, true);
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
                // Only show the active row when the editor pane is focused
                if (!this.view.hasFocus) {
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
        // Remove focus event listener from editor's DOM element
        this.view.dom.removeEventListener('focus', this._onFocus, true);
        // Remove blur event listener from editor's DOM element
        this.view.dom.removeEventListener('blur', this._onBlur, true);
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
        folders: [],
        current: null,
        dirty: false,
        savedSnapshot: '',
        cmView: null,
        rootEl: null,
        navigationEl: null,
        folderSectionEl: null,
        folderListEl: null,
        listEl: null,
        fileContextMenuEl: null,
        folderContextMenuEl: null,
        toggleBtn: null,
        titleHelpEl: null,
        selectedFolderId: 'all',
        folderCollapsed: false,
        fileCollapsed: true,
        lastWindowWidth: window.innerWidth || 0,
        domSnapshot: null,
        titlebarInsertions: [],
        prompt: opts.prompt || 'writer>',
    };

    function updateSidebarClasses() {
        const filesOpen = !state.fileCollapsed;
        const foldersOpen = !state.folderCollapsed;
        const hasAny = filesOpen || foldersOpen;
        if (state.rootEl) {
            state.rootEl.classList.toggle('files-open', filesOpen);
            state.rootEl.classList.toggle('folders-open', foldersOpen);
            state.rootEl.classList.toggle('panels-hidden', !hasAny);
        }
        if (state.navigationEl) {
            state.navigationEl.classList.toggle('collapsed', !hasAny);
        }
        if (state.toggleBtn) {
            state.toggleBtn.setAttribute('aria-pressed', !hasAny ? 'true' : 'false');
        }
    }

    function setPanelVisibility(updates = {}) {
        if (Object.prototype.hasOwnProperty.call(updates, 'folder')) {
            state.folderCollapsed = !!updates.folder;
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'file')) {
            state.fileCollapsed = !!updates.file;
        }
        updateSidebarClasses();
    }

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
            toggleBtn.title = 'Toggle panels';
            toggleBtn.setAttribute('aria-label', 'Toggle panels');
            toggleBtn.setAttribute('aria-pressed', state.folderCollapsed && state.fileCollapsed ? 'true' : 'false');
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
        if (state.fileContextMenuEl && state.fileContextMenuEl.parentElement) {
            state.fileContextMenuEl.parentElement.removeChild(state.fileContextMenuEl);
            state.fileContextMenuEl = null;
        }
        if (state.folderContextMenuEl && state.folderContextMenuEl.parentElement) {
            state.folderContextMenuEl.parentElement.removeChild(state.folderContextMenuEl);
            state.folderContextMenuEl = null;
        }
    }

    function ensureFileContextMenu() {
        if (state.fileContextMenuEl) return state.fileContextMenuEl;
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
        state.fileContextMenuEl = menu;
        return menu;
    }

    function ensureFolderContextMenu() {
        if (state.folderContextMenuEl) return state.folderContextMenuEl;
        const menu = document.createElement('div');
        menu.className = 'writer-context-menu';
        menu.innerHTML = `
            <button data-action="${FOLDER_ACTIONS.OPEN}">Open</button>
            <button data-action="${FOLDER_ACTIONS.RENAME}">Rename</button>
            <button data-action="${FOLDER_ACTIONS.DUPLICATE}">Duplicate</button>
            <button data-action="${FOLDER_ACTIONS.DELETE}" class="danger">Delete</button>
        `;
        document.body.appendChild(menu);
        state.folderContextMenuEl = menu;
        return menu;
    }

    function closeContextMenu() {
        if (state.fileContextMenuEl) state.fileContextMenuEl.classList.remove('visible');
        if (state.folderContextMenuEl) state.folderContextMenuEl.classList.remove('visible');
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
            const inFiles = state.listEl && state.listEl.contains(e.target);
            const inFolders = state.folderListEl && state.folderListEl.contains(e.target);
            if (!inFiles && !inFolders) {
                closeContextMenu();
            }
        });
        window.addEventListener('keydown', onHotkey, true);
        window.addEventListener('resize', handleResponsivePanels, { passive: true });
    }

    function detachGlobalListeners() {
        window.removeEventListener('click', closeContextMenu, true);
        window.removeEventListener('keydown', onHotkey, true);
        window.removeEventListener('resize', handleResponsivePanels, { passive: true });
    }

    function onHotkey(e) {
        // Global quit shortcut: Ctrl+X on macOS, Ctrl+Q on Windows/Linux
        if (isMac) {
            if (e.ctrlKey && !e.metaKey && (e.key === 'x' || e.key === 'X')) {
                e.preventDefault();
                requestExit();
                return;
            }
        } else {
            if (e.ctrlKey && (e.key === 'q' || e.key === 'Q')) {
                e.preventDefault();
                requestExit();
                return;
            }
        }
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
        if (state.fileCollapsed && state.folderCollapsed) {
            setPanelVisibility({ file: false, folder: true });
        } else if (!state.fileCollapsed && state.folderCollapsed) {
            setPanelVisibility({ folder: false });
        } else {
            setPanelVisibility({ file: true, folder: true });
            // De-focus editor so auto-focus logic re-triggers on next user click
            try { state.cmView && state.cmView.dom && state.cmView.dom.blur(); } catch (_) {}
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
            <div class="writer-folders">
                <div class="writer-folders-header">
                    <span>Folders</span>
                    <button class="writer-folder-create" title="New folder" aria-label="New folder"></button>
                </div>
                <div class="writer-folders-body">
                    <ul class="writer-folder-tree"></ul>
                </div>
            </div>
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
        state.navigationEl = navigation;
        state.folderSectionEl = navigation.querySelector('.writer-folders');
        state.fileSectionEl = navigation.querySelector('.writer-files');
        state.folderListEl = navigation.querySelector('.writer-folder-tree');
        state.listEl = navigation.querySelector('.writer-file-list');
        const createBtn = navigation.querySelector('.writer-create');
        if (createBtn) {
            createBtn.addEventListener('click', () => createNewDocument());
        }

        const folderCreateBtn = navigation.querySelector('.writer-folder-create');
        if (folderCreateBtn) {
            folderCreateBtn.addEventListener('click', () => {
                const parent = state.selectedFolderId === 'all' ? null : state.selectedFolderId;
                createFolder(parent);
            });
        }

        if (state.folderListEl) {
            state.folderListEl.addEventListener('click', onFolderClick);
            state.folderListEl.addEventListener('contextmenu', onFolderContextMenu);
        }

        if (state.listEl) {
            state.listEl.addEventListener('click', onFileClick);
            state.listEl.addEventListener('contextmenu', onFileContextMenu);
        }

        updateSidebarClasses();

        return root;
    }

    function mountUI() {
        captureDOMSnapshot();
        hideConsole();

        const parent = outputEl?.parentElement || screenEl;
        if (parent) parent.appendChild(renderLayout());
        attachGlobalListeners();
        ensureFileContextMenu();
        ensureFolderContextMenu();
        handleResponsivePanels(true);

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
        const docs = getFilteredDocs();
        state.listEl.innerHTML = '';
        for (const doc of docs) {
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
            if (!docs.length) {
                const empty = document.createElement('div');
                empty.className = 'writer-files-empty muted';
                empty.textContent = state.selectedFolderId === 'all'
                    ? 'Create your first document with the + button.'
                    : 'This folder is empty.';
                host.appendChild(empty);
            }
        }
        if (state.current) setActiveListItem(state.current.id);
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

    function buildFolderChildrenMap(folders) {
        const map = new Map();
        for (const folder of folders) {
            const parent = folder.parent_id == null ? null : folder.parent_id;
            if (!map.has(parent)) map.set(parent, []);
            map.get(parent).push(folder);
        }
        for (const [, list] of map) {
            list.sort((a, b) => (a.name_lower || '').localeCompare(b.name_lower || ''));
        }
        return map;
    }

    function renderFolderTree() {
        if (!state.folderListEl) return;
        const folders = Array.isArray(state.folders) ? state.folders.slice() : [];
        const childrenMap = buildFolderChildrenMap(folders);
        const buildMarkup = (parentId) => {
            const children = childrenMap.get(parentId == null ? null : parentId) || [];
            if (!children.length) return '';
            const items = children.map(child => {
                const subtree = buildMarkup(child.id);
                return `
                    <li class="writer-folder-item" data-folder-id="${child.id}">
                        <div class="writer-folder-row">
                            <span class="writer-folder-name">${esc(child.name)}</span>
                        </div>
                        ${subtree}
                    </li>
                `;
            });
            return `<ul>${items.join('')}</ul>`;
        };
        const nested = buildMarkup(null);
        state.folderListEl.innerHTML = `
            <li class="writer-folder-item" data-folder-id="all">
                <div class="writer-folder-row">
                    <span class="writer-folder-name">All Documents</span>
                </div>
                ${nested}
            </li>
        `;
        highlightActiveFolder();
    }

    function highlightActiveFolder() {
        if (!state.folderListEl) return;
        state.folderListEl.querySelectorAll('.writer-folder-item').forEach(item => item.classList.remove('active'));
        const selector = state.selectedFolderId === 'all'
            ? '.writer-folder-item[data-folder-id="all"]'
            : `.writer-folder-item[data-folder-id="${state.selectedFolderId}"]`;
        const active = state.folderListEl.querySelector(selector);
        if (active) active.classList.add('active');
    }

    function resolveFolderId(value) {
        if (value === 'all') return 'all';
        if (value == null) return 'all';
        const num = Number(value);
        return Number.isFinite(num) ? num : 'all';
    }

    function getFilteredDocs() {
        if (state.selectedFolderId === 'all') return state.docs.slice();
        return state.docs.filter(doc => {
            const folder = doc.folder_id == null ? null : doc.folder_id;
            return folder === state.selectedFolderId;
        });
    }

    function setSelectedFolder(folderId, { fromDocument = false } = {}) {
        const resolved = resolveFolderId(folderId);
        if (resolved !== 'all' && !state.folders.some(folder => folder.id === resolved)) {
            state.selectedFolderId = 'all';
        } else {
            state.selectedFolderId = resolved;
        }
        highlightActiveFolder();
        redrawFileList();
        if (fromDocument && state.current) {
            setActiveListItem(state.current.id);
        }
    }

    async function loadFolders() {
        if (!writerAPI || typeof writerAPI.listFolders !== 'function') {
            state.folders = [];
            renderFolderTree();
            return;
        }
        try {
            const rows = await writerAPI.listFolders();
            state.folders = Array.isArray(rows)
                ? rows.map(row => ({
                    ...row,
                    parent_id: row.parent_id == null ? null : Number(row.parent_id),
                    name_lower: (row.name || '').toLowerCase()
                }))
                : [];
            if (state.selectedFolderId !== 'all' && !state.folders.some(f => f.id === state.selectedFolderId)) {
                state.selectedFolderId = 'all';
            }
            renderFolderTree();
        } catch (err) {
            shell.print(`<div class="error">Failed to load folders: ${esc(err?.message || err)}</div>`);
            state.folders = [];
            renderFolderTree();
        }
    }

    function onFolderClick(e) {
        const row = e.target.closest('.writer-folder-row');
        if (!row) return;
        const item = row.closest('.writer-folder-item');
        if (!item) return;
        const id = item.dataset.folderId;
        if (id === 'all') {
            setSelectedFolder('all');
            return;
        }
        const numeric = Number(id);
        if (!Number.isFinite(numeric)) return;
        setSelectedFolder(numeric);
    }

    function onFolderContextMenu(e) {
        const row = e.target.closest('.writer-folder-row');
        if (!row) return;
        const item = row.closest('.writer-folder-item');
        if (!item) return;
        const id = item.dataset.folderId;
        if (id === 'all') return; // root has no context menu
        const folderId = Number(id);
        if (!Number.isFinite(folderId)) return;
        e.preventDefault();
        closeContextMenu();
        const menu = ensureFolderContextMenu();
        menu.dataset.folderId = String(folderId);
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        menu.classList.add('visible');
        menu.querySelectorAll('button').forEach(btn => {
            btn.onclick = () => {
                const action = btn.dataset.action;
                handleFolderContextAction(action, folderId);
                closeContextMenu();
            };
        });
    }

    async function handleFolderContextAction(action, id) {
        switch (action) {
            case FOLDER_ACTIONS.OPEN:
                setSelectedFolder(id);
                break;
            case FOLDER_ACTIONS.RENAME:
                await renameFolder(id);
                break;
            case FOLDER_ACTIONS.DUPLICATE:
                await duplicateFolder(id);
                break;
            case FOLDER_ACTIONS.DELETE:
                await deleteFolder(id);
                break;
            default:
                break;
        }
    }

    async function createFolder(parentId = null) {
        if (!writerAPI || typeof writerAPI.createFolder !== 'function') return null;
        const result = await promptModal({
            title: 'New folder',
            value: 'New Folder',
            confirmLabel: 'Create',
            cancelLabel: 'Cancel'
        });
        if (result === null) return null;
        const trimmed = String(result).trim();
        if (!trimmed) return null;
        try {
            const folder = await writerAPI.createFolder({ name: trimmed, parentId });
            await loadFolders();
            if (folder && folder.id != null) {
                setSelectedFolder(folder.id);
            }
            showToast('Folder created', 'ok');
            return folder;
        } catch (err) {
            showToast(err?.message || 'Failed to create folder', 'error', 'writerToastError');
            return null;
        }
    }

    async function renameFolder(id) {
        if (!writerAPI || typeof writerAPI.renameFolder !== 'function') return;
        const folder = state.folders.find(f => f.id === id);
        if (!folder) return;
        const result = await promptModal({
            title: 'Rename folder',
            value: folder.name || 'Folder',
            confirmLabel: 'Rename'
        });
        if (result === null) return;
        const trimmed = String(result).trim();
        if (!trimmed) return;
        try {
            await writerAPI.renameFolder(id, trimmed);
            await loadFolders();
            setSelectedFolder(id);
            showToast('Folder renamed', 'ok');
        } catch (err) {
            showToast(err?.message || 'Failed to rename folder', 'error', 'writerToastError');
        }
    }

    async function duplicateFolder(id) {
        if (!writerAPI || typeof writerAPI.duplicateFolder !== 'function') return;
        const folder = state.folders.find(f => f.id === id);
        if (!folder) return;
        try {
            const copy = await writerAPI.duplicateFolder(id, {});
            await loadFolders();
            if (copy && copy.id != null) setSelectedFolder(copy.id);
            showToast('Folder duplicated', 'ok');
        } catch (err) {
            showToast(err?.message || 'Failed to duplicate folder', 'error', 'writerToastError');
        }
    }

    async function deleteFolder(id) {
        if (!writerAPI || typeof writerAPI.deleteFolder !== 'function') return;
        const folder = state.folders.find(f => f.id === id);
        if (!folder) return;
        const result = await confirmModal({
            title: 'Delete folder?',
            message: `This will remove "${folder.name}" and unfile its documents.`,
            confirmLabel: 'Delete',
            cancelLabel: 'Cancel',
            danger: true
        });
        if (result !== 'confirm') return;
        try {
            await writerAPI.deleteFolder(id);
            const nextSelection = 'all';
            await loadFolders();
            setSelectedFolder(nextSelection);
            await loadDocuments();
            showToast('Folder deleted', 'warn');
        } catch (err) {
            showToast(err?.message || 'Failed to delete folder', 'error', 'writerToastError');
        }
    }

    function handleResponsivePanels(force = false) {
        const width = window.innerWidth || 0;

        // Helper to apply the correct default visibility for each breakpoint
        const applyForWidth = () => {
            if (width >= 1024) {
                // ≥1024px: open BOTH (Folder + File)
                setPanelVisibility({ file: false, folder: false });
            } else if (width >= 768) {
                // 768–1023px: open File only; keep Folder collapsed
                setPanelVisibility({ file: false, folder: true });
            } else {
                // <768px: collapse BOTH
                setPanelVisibility({ file: true, folder: true });
            }
        };

        if (force) {
            applyForWidth();
            state.lastWindowWidth = width;
            return;
        }

        const prev = state.lastWindowWidth;
        // Determine breakpoint buckets to reapply defaults only when crossing a breakpoint
        const prevBucket = prev >= 1024 ? 'lg' : prev >= 768 ? 'md' : 'sm';
        const curBucket = width >= 1024 ? 'lg' : width >= 768 ? 'md' : 'sm';

        if (prevBucket !== curBucket) {
            applyForWidth();
        }

        state.lastWindowWidth = width;
    }

    async function loadDocuments() {
        try {
            const docs = await writerAPI.list();
            state.docs = Array.isArray(docs) ? docs : [];
            redrawFileList();
            if (!state.docs.length) {
                setEditorContent('', 'Untitled Document');
                state.current = null;
                return;
            }
            if (state.current && state.docs.some(d => d.id === state.current.id)) {
                setActiveListItem(state.current.id);
                return;
            }
            let candidates = getFilteredDocs();
            if (!candidates.length && state.selectedFolderId !== 'all') {
                setSelectedFolder('all');
                candidates = getFilteredDocs();
            }
            if (!candidates.length) {
                candidates = state.docs.slice();
            }
            if (candidates.length) {
                await openDocument(candidates[0].id, { force: true });
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
            const folderForDoc = doc.folder_id == null ? 'all' : doc.folder_id;
            setSelectedFolder(folderForDoc, { fromDocument: true });
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
        closeContextMenu();
        const menu = ensureFileContextMenu();
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
            const folderId = state.selectedFolderId === 'all' ? null : state.selectedFolderId;
            const doc = await writerAPI.create({ title, content: '', folderId });
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
            confirmExitWithoutSaving().then(async (result) => {
                if (result === 'yes') {
                    clearDirty();
                    performExit();
                }
                // else: do nothing, stay in editor
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


    function confirmModal({ title = 'Confirm', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
        return new Promise((resolve) => {
            const existing = document.getElementById('writerConfirmModal');
            if (existing && existing.parentElement) existing.parentElement.removeChild(existing);
            const wrap = document.createElement('div');
            wrap.id = 'writerConfirmModal';
            wrap.className = 'cj-modal-backdrop';
            wrap.innerHTML = `
                <div class="cj-modal" role="dialog" aria-modal="true" aria-labelledby="writerConfirmTitle">
                    <div id="writerConfirmTitle" class="cj-modal-title">${esc(title)}</div>
                    <div class="cj-modal-body">${esc(message)}</div>
                    <div class="cj-modal-actions">
                        <button class="confirm ${danger ? 'danger' : ''}">${esc(confirmLabel)}</button>
                        <button class="cancel">${esc(cancelLabel)}</button>
                    </div>
                    <div class="cj-modal-hint muted">Enter = ${esc(confirmLabel)} · Esc = ${esc(cancelLabel)}</div>
                </div>
            `;
            document.body.appendChild(wrap);
            const confirmBtn = wrap.querySelector('button.confirm');
            const cancelBtn = wrap.querySelector('button.cancel');
            const cleanup = () => {
                window.removeEventListener('keydown', onKey, true);
                if (wrap && wrap.parentElement) wrap.parentElement.removeChild(wrap);
            };
            const accept = () => { cleanup(); resolve('confirm'); };
            const reject = () => { cleanup(); resolve('cancel'); };
            const onKey = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    reject();
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    accept();
                }
            };
            confirmBtn.addEventListener('click', accept);
            cancelBtn.addEventListener('click', reject);
            window.addEventListener('keydown', onKey, true);
            setTimeout(() => {
                try { confirmBtn.focus({ preventScroll: true }); } catch { confirmBtn.focus(); }
            }, 0);
        });
    }

    // Custom modal for confirming exit without saving
    function confirmExitWithoutSaving() {
        return new Promise((resolve) => {
            const existing = document.getElementById('writerConfirmExitModal');
            if (existing && existing.parentElement) existing.parentElement.removeChild(existing);
            const wrap = document.createElement('div');
            wrap.id = 'writerConfirmExitModal';
            wrap.className = 'cj-modal-backdrop';
            wrap.innerHTML = `
                <div class="cj-modal" role="dialog" aria-modal="true" aria-labelledby="writerConfirmExitTitle">
                    <div id="writerConfirmExitTitle" class="cj-modal-title">Confirm</div>
                    <div class="cj-modal-body">Exit without saving?</div>
                    <div class="cj-modal-actions">
                        <button class="confirm">Yes</button>
                        <button class="cancel">No</button>
                    </div>
                    <div class="cj-modal-hint muted">y = yes &middot; n = no</div>
                </div>
            `;
            document.body.appendChild(wrap);
            const confirmBtn = wrap.querySelector('button.confirm');
            const cancelBtn = wrap.querySelector('button.cancel');
            let done = false;
            const cleanup = () => {
                window.removeEventListener('keydown', onKey, true);
                if (wrap && wrap.parentElement) wrap.parentElement.removeChild(wrap);
                done = true;
            };
            const accept = () => { if (!done) { cleanup(); resolve('yes'); } };
            const reject = () => { if (!done) { cleanup(); resolve('no'); } };
            const onKey = (e) => {
                if (e.key === 'y' || e.key === 'Y') {
                    e.preventDefault();
                    accept();
                } else if (e.key === 'n' || e.key === 'N') {
                    e.preventDefault();
                    reject();
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    accept();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    reject();
                }
            };
            confirmBtn.addEventListener('click', accept);
            cancelBtn.addEventListener('click', reject);
            window.addEventListener('keydown', onKey, true);
            setTimeout(() => {
                try { confirmBtn.focus({ preventScroll: true }); } catch { confirmBtn.focus(); }
            }, 0);
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
    loadFolders()
        .catch(() => {})
        .then(() => loadDocuments());

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
