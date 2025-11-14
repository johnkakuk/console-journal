import { EditorState, EditorSelection, RangeSetBuilder, Transaction } from '@codemirror/state';
import { EditorView, keymap, drawSelection, Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { indentUnit, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { search, searchKeymap, openSearchPanel, findNext, findPrevious } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { listLayoutPlugin, createListKeymap, listRenumberListener, listTodoAutoComplete, listTodoLineFixer } from './listLayout.js';

const SELECTION_BG = 'var(--editor-selection-bg, color-mix(in srgb, var(--editor-fg, #000) 25%, var(--editor-bg, #fff)))';
const SELECTION_FG = 'var(--editor-selection-fg, var(--editor-fg, #000))';

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
const CUSTOM_DEFAULT_KEYMAP = defaultKeymap.filter(binding => binding.key !== 'Mod-b' && binding.key !== 'Mod-i');

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

function collectEmphasisMarkers(text) {
    const markers = [];
    const len = text.length;
    let i = 0;
    while (i < len) {
        if (text[i] !== '*') {
            i++;
            continue;
        }
        let markerLen = 1;
        if (i + 1 < len && text[i + 1] === '*') markerLen = 2;
        const marker = markerLen === 2 ? '**' : '*';
        const nextChar = text[i + markerLen] || '';

        // Skip list bullets like "* " or "** "
        const isAtLineStart = /^\s*$/.test(text.slice(0, i));
        if (markerLen === 1 && isAtLineStart && nextChar === ' ') {
            i += markerLen;
            continue;
        }

        if (!nextChar || !nextChar.trim()) {
            i += markerLen;
            continue;
        }

        let searchFrom = i + markerLen;
        let closingIndex = -1;
        while (true) {
            const idx = text.indexOf(marker, searchFrom);
            if (idx === -1) break;
            if (idx === i + markerLen) {
                searchFrom = idx + markerLen;
                continue;
            }
            const beforeClose = text[idx - 1];
            if (!beforeClose || !beforeClose.trim()) {
                searchFrom = idx + markerLen;
                continue;
            }
            closingIndex = idx;
            break;
        }
        if (closingIndex !== -1) {
            markers.push({ from: i, to: i + markerLen });
            markers.push({ from: closingIndex, to: closingIndex + markerLen });
            i = closingIndex + markerLen;
        } else {
            i += markerLen;
        }
    }
    return markers;
}

const markdownIndicatorPlugin = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = this.build(view);
    }
    update(update) {
        if (update.docChanged || update.viewportChanged)
            this.decorations = this.build(update.view);
    }
    build(view) {
        const builder = new RangeSetBuilder();
        for (const { from, to } of view.visibleRanges) {
            let lineStart = from;
            while (lineStart <= to) {
                const line = view.state.doc.lineAt(lineStart);
                this.decorateLine(line, builder);
                lineStart = line.to + 1;
                if (line.to >= to) break;
            }
        }
        return builder.finish();
    }
    decorateLine(line, builder) {
        const text = line.text;
        const headingMatch = text.match(/^\s*(#{1,6})\s+/);
        if (headingMatch) {
            const prefix = headingMatch[1];
            const offset = text.indexOf(prefix);
            for (let i = 0; i < prefix.length; i++) {
                builder.add(line.from + offset + i, line.from + offset + i + 1, Decoration.mark({ class: 'cm-md-indicator' }));
            }
        }
        if (text.includes('*')) {
            const markers = collectEmphasisMarkers(text);
            markers.forEach(({ from, to }) => {
                builder.add(line.from + from, line.from + to, Decoration.mark({ class: 'cm-md-indicator' }));
            });
        }
    }
}, {
    decorations: v => v.decorations
});

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
    '.cm-selectionBackground, ::selection': {
        backgroundColor: SELECTION_BG,
        color: SELECTION_FG
    },
    '.cm-selectionLayer .cm-selectionBackground': { backgroundColor: `${SELECTION_BG} !important` },
    '.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
        backgroundColor: `${SELECTION_BG} !important`
    },
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
        display: 'grid',
        gridTemplateColumns: 'calc(var(--list-indent-ch, 0) * 1ch) calc(var(--list-marker-ch, 2) * 1ch) minmax(0, 1fr)',
        columnGap: 'calc(var(--list-gap-ch, 0.5) * 1ch)',
        alignItems: 'start'
    },
    '.cm-line.cm-list-line .cm-list-indent': {
        gridColumn: '1',
        display: 'block',
        whiteSpace: 'pre'
    },
    '.cm-line.cm-list-line .cm-list-marker': {
        gridColumn: '2',
        display: 'block',
        justifySelf: 'end',
        whiteSpace: 'pre',
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums lining-nums',
        fontFeatureSettings: '"tnum" 1, "lnum" 1',
        opacity: 0.85,
        userSelect: 'none'
    },
    '.cm-line.cm-list-line .cm-list-content': {
        gridColumn: '3',
        minWidth: 0,
        whiteSpace: 'pre-wrap',
        lineHeight: '1.5',
        wordBreak: 'break-word'
    },
    '.cm-line.cm-list-line .cm-list-content[data-list-empty="true"]': {
        minHeight: '1.2em',
        display: 'block'
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
                        const delta = Math.round(dy);
                        scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
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
        wordCountEl: null,
        originalTitleText: '',
        currentWordCount: 0,
        fileHeaderLabel: null,
        autosaveEnabled: !!opts.autosave,
        autosaveTimer: null,
        autosaveDelay: 1500,
        autosaveInFlight: false,
        selectedFolderId: 'all',
        folderCollapsed: false,
        fileCollapsed: false,
        lastWindowWidth: window.innerWidth || 0,
        domSnapshot: null,
        titlebarInsertions: [],
        prompt: opts.prompt || 'writer>',
        emptyOverlayEl: null,
        draggingDocId: null,
        draggingFolderId: null,
        fileListDndBound: false,
        folderDndBound: false,
        folderDropTarget: null,
        folderDragIntent: null,
        inboxFolderId: null,
        panelPreference: null,
        expandedFolders: new Set()
    };

    function computeWordCount(text) {
        if (!text) return 0;
        const trimmed = text.trim();
        if (!trimmed) return 0;
        const matches = trimmed.match(/\S+/g);
        return matches ? matches.length : 0;
    }

    function updateWordCountFromText(text) {
        const count = computeWordCount(text || '');
        state.currentWordCount = count;
        if (state.wordCountEl) {
            state.wordCountEl.textContent = `${count.toLocaleString()} word${count === 1 ? '' : 's'}`;
        }
    }

    function normalizeFolderId(value) {
        if (value === 'all') return null;
        if (value === null || value === undefined) return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    function normalizeDoc(doc) {
        if (!doc) return null;
        return {
            ...doc,
            folder_id: doc.folder_id == null ? null : doc.folder_id,
            order_index: typeof doc.order_index === 'number' ? doc.order_index : 0
        };
    }

    function normalizeFolder(folder) {
        if (!folder) return null;
        return {
            ...folder,
            parent_id: folder.parent_id == null ? null : Number(folder.parent_id),
            order_index: typeof folder.order_index === 'number' ? folder.order_index : 0,
            name_lower: (folder.name || '').toLowerCase()
        };
    }

    function orderSortFolders(a, b) {
        if (isInboxFolder(a.id)) return -1;
        if (isInboxFolder(b.id)) return 1;
        const diff = (a.order_index ?? 0) - (b.order_index ?? 0);
        if (diff !== 0) return diff;
        return (a.name_lower || '').localeCompare(b.name_lower || '');
    }

    function foldersOrderedForParent(parentId, excludeId = null) {
        const normalized = normalizeFolderId(parentId);
        return state.folders
            .filter(folder => normalizeFolderId(folder.parent_id) === normalized && folder.id !== excludeId && !isInboxFolder(folder.id))
            .sort(orderSortFolders);
    }

    function isInboxFolder(id) {
        return state.inboxFolderId != null && id === state.inboxFolderId;
    }

    function orderSort(a, b) {
        const diff = (a.order_index ?? 0) - (b.order_index ?? 0);
        if (diff !== 0) return diff;
        return (a.id ?? 0) - (b.id ?? 0);
    }

    function docsOrderedForFolder(folderId, excludeId = null) {
        const normalized = normalizeFolderId(folderId);
        return state.docs
            .filter(doc => normalizeFolderId(doc.folder_id) === normalized && doc.id !== excludeId)
            .sort(orderSort);
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    async function persistDocOrder(folderIds = []) {
        if (!writerAPI || typeof writerAPI.reorderDocuments !== 'function') return;
        const unique = [];
        for (const fid of folderIds) {
            const normalized = normalizeFolderId(fid);
            if (!unique.some(val => val === normalized)) unique.push(normalized);
        }
        const moves = [];
        for (const fid of unique) {
            const ordered = docsOrderedForFolder(fid);
            ordered.forEach((doc, idx) => {
                doc.order_index = idx;
                moves.push({ id: doc.id, folderId: fid, order: idx });
            });
        }
        if (!moves.length) return;
        try {
            await writerAPI.reorderDocuments(moves);
        } catch (err) {
            showToast(err?.message || 'Failed to save document order', 'error', 'writerToastError');
            await loadDocuments();
        }
    }

    function applyDocumentMove(docId, destinationFolderId, targetIndex = null) {
        const doc = state.docs.find(d => d.id === docId);
        if (!doc) return;
        const sourceFolder = normalizeFolderId(doc.folder_id);
        const destFolder = normalizeFolderId(destinationFolderId);
        const affected = new Set([sourceFolder, destFolder]);
        if (destFolder === sourceFolder) {
            const ordered = docsOrderedForFolder(sourceFolder);
            const currentIndex = ordered.findIndex(d => d.id === docId);
            if (currentIndex === -1) return;
            const insertIndexRaw = targetIndex == null ? ordered.length - 1 : targetIndex;
            const adjustedIndex = insertIndexRaw > currentIndex ? insertIndexRaw - 1 : insertIndexRaw;
            const clampedIndex = clamp(adjustedIndex, 0, ordered.length - 1);
            if (clampedIndex === currentIndex) return;
            ordered.splice(currentIndex, 1);
            ordered.splice(clampedIndex, 0, doc);
            ordered.forEach((item, idx) => { item.order_index = idx; });
        } else {
            const sourceOrdered = docsOrderedForFolder(sourceFolder, docId);
            sourceOrdered.forEach((item, idx) => { item.order_index = idx; });
            doc.folder_id = destFolder;
            const destOrdered = docsOrderedForFolder(destFolder, docId);
            const insertIndex = clamp(targetIndex == null ? destOrdered.length : targetIndex, 0, destOrdered.length);
            destOrdered.splice(insertIndex, 0, doc);
            destOrdered.forEach((item, idx) => { item.order_index = idx; });
        }
        redrawFileList();
        persistDocOrder(Array.from(affected));
    }

    function moveFolderWithOrdering(folderId, destinationParentId, anchorId = null, before = true) {
        if (isInboxFolder(folderId)) return;
        const folder = state.folders.find(f => f.id === folderId);
        if (!folder) return;
        const destParent = normalizeFolderId(destinationParentId);
        if (destParent === folderId) return;
        if (destParent != null && isInboxFolder(destParent)) return;
        if (destParent != null && isDescendantFolder(folderId, destParent)) return;
        const sourceParent = normalizeFolderId(folder.parent_id);
        folder.parent_id = destParent;
        const affected = new Set([sourceParent, destParent]);
        const sourceSiblings = foldersOrderedForParent(sourceParent, folderId);
        sourceSiblings.forEach((f, idx) => { f.order_index = idx; });
        const destSiblings = foldersOrderedForParent(destParent, folderId);
        let insertIndex = destSiblings.length;
        if (anchorId != null) {
            const anchorIdx = destSiblings.findIndex(f => f.id === anchorId);
            if (anchorIdx >= 0) insertIndex = before ? anchorIdx : anchorIdx + 1;
        }
        destSiblings.splice(insertIndex, 0, folder);
        destSiblings.forEach((f, idx) => { f.order_index = idx; });
        persistFolderOrder(Array.from(affected));
        renderFolderTree();
    }

    function isDescendantFolder(targetId, maybeDescendant) {
        if (targetId == null || maybeDescendant == null) return false;
        const visited = new Set();
        let current = maybeDescendant;
        while (current != null && !visited.has(current)) {
            if (current === targetId) return true;
            visited.add(current);
            const folder = state.folders.find(f => f.id === current);
            current = folder ? (folder.parent_id == null ? null : folder.parent_id) : null;
        }
        return false;
    }

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

    function setPanelVisibility(updates = {}, options = {}) {
        const remember = !!options.remember;
        const width = options.width ?? window.innerWidth ?? 0;
        if (Object.prototype.hasOwnProperty.call(updates, 'folder')) {
            state.folderCollapsed = !!updates.folder;
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'file')) {
            state.fileCollapsed = !!updates.file;
        }
        if (remember) {
            state.panelPreference = {
                folder: state.folderCollapsed,
                file: state.fileCollapsed,
                width
            };
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
        if (titleEl) {
            state.originalTitleText = titleEl.textContent || '';
            titleEl.textContent = 'console-writer';
            titleEl.style.opacity = '0.6';
        }
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

            const wordCount = document.createElement('span');
            wordCount.className = 'writer-word-count muted';
            wordCount.textContent = '0 words';
            titlebar.appendChild(wordCount);
            state.wordCountEl = wordCount;
            state.titlebarInsertions.push(wordCount);
            updateWordCountFromText(state.cmView ? state.cmView.state.doc.toString() : '');
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

        if (titleEl) {
            if (state.originalTitleText) titleEl.textContent = state.originalTitleText;
            titleEl.style.opacity = '';
        }
        state.originalTitleText = '';
        state.wordCountEl = null;
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
        cancelAutosaveTimer();
    }

    function cancelAutosaveTimer() {
        if (state.autosaveTimer) {
            clearTimeout(state.autosaveTimer);
            state.autosaveTimer = null;
        }
    }

    function scheduleAutosave(immediate = false) {
        if (!state.autosaveEnabled || !state.dirty || !state.current || !state.cmView) return;
        cancelAutosaveTimer();
        const delay = immediate ? 0 : state.autosaveDelay;
        state.autosaveTimer = setTimeout(async () => {
            state.autosaveTimer = null;
            if (!state.autosaveEnabled || !state.dirty || !state.current || !state.cmView) return;
            if (state.autosaveInFlight) {
                scheduleAutosave();
                return;
            }
            state.autosaveInFlight = true;
            try {
                await saveCurrentDocument({ silent: true, refreshList: false });
            } finally {
                state.autosaveInFlight = false;
                if (state.autosaveEnabled && state.dirty && !state.autosaveTimer) {
                    scheduleAutosave();
                }
            }
        }, delay);
    }

    function setAutosaveEnabled(enabled) {
        const next = !!enabled;
        if (state.autosaveEnabled === next) return;
        state.autosaveEnabled = next;
        if (!next) {
            cancelAutosaveTimer();
        } else if (state.dirty) {
            scheduleAutosave();
        }
    }

    function createMarkerCommand(marker) {
        const length = marker.length;
        return (view) => {
            const doc = view.state.doc;
            const spec = view.state.changeByRange(range => {
                if (range.empty) {
                    return {
                        changes: { from: range.from, to: range.to, insert: marker },
                        range: EditorSelection.cursor(range.from + length)
                    };
                }

                const before = range.from >= length
                    ? doc.sliceString(range.from - length, range.from)
                    : '';
                const after = doc.sliceString(range.to, range.to + length);
                const selectedText = doc.sliceString(range.from, range.to);

                // Case 1: selection already wrapped (markers sit just outside selection)
                if (before === marker && after === marker) {
                    return {
                        changes: [
                            { from: range.to, to: range.to + length, insert: '' },
                            { from: range.from - length, to: range.from, insert: '' }
                        ],
                        range: EditorSelection.range(range.from - length, range.to - length)
                    };
                }

                // Case 2: selection includes surrounding markers (user highlighted **text**)
                if (
                    selectedText.length >= length * 2 &&
                    selectedText.startsWith(marker) &&
                    selectedText.endsWith(marker)
                ) {
                    return {
                        changes: [
                            { from: range.to - length, to: range.to, insert: '' },
                            { from: range.from, to: range.from + length, insert: '' }
                        ],
                        range: EditorSelection.range(range.from, range.to - length * 2)
                    };
                }

                // Default: wrap selection
                return {
                    changes: [
                        { from: range.from, to: range.from, insert: marker },
                        { from: range.to, to: range.to, insert: marker }
                    ],
                    range: EditorSelection.range(range.from + length, range.to + length)
                };
            });
            view.dispatch(view.state.update(spec, {
                scrollIntoView: true,
                userEvent: 'input'
            }));
            return true;
        };
    }

    function buildExtensions() {
        const applyBold = createMarkerCommand('**');
        const applyItalic = createMarkerCommand('*');
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
                        const insertBase = '- [ ] ';
                        let insertText = insertBase;
                        if (range.empty) {
                            const line = view.state.doc.lineAt(range.from);
                            const remainder = view.state.doc.sliceString(range.from, line.to);
                            if (remainder.trim().length) {
                                insertText += '\n';
                            }
                        }
                        return {
                            changes: { from: range.from, to: range.to, insert: insertText },
                            range: EditorSelection.cursor(range.from + insertBase.length)
                        };
                    });
                    view.dispatch(view.state.update(spec, {
                        scrollIntoView: true,
                        userEvent: 'input'
                    }));
                    return true;
                }
            },
            {
                key: 'Mod-b',
                preventDefault: true,
                run: applyBold
            },
            {
                key: 'Mod-i',
                preventDefault: true,
                run: applyItalic
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
                if (state.autosaveEnabled) {
                    scheduleAutosave();
                }
            }
        });

        const wordCountTracker = EditorView.updateListener.of((update) => {
            if (update.docChanged) {
                updateWordCountFromText(update.state.doc.toString());
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
            wordCountTracker,
            history(),
            todoPlugin,
            markdownIndicatorPlugin,
            listLayoutPlugin,
            listRenumberListener,
            listTodoAutoComplete,
            listTodoLineFixer,
            indentUnit.of(INDENT),
            createListKeymap(INDENT),
            keymap.of([
                ...CUSTOM_DEFAULT_KEYMAP,
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
        const width = window.innerWidth || 0;
        if (state.fileCollapsed && state.folderCollapsed) {
            setPanelVisibility({ file: false, folder: true }, { remember: true, width });
        } else if (!state.fileCollapsed && state.folderCollapsed) {
            setPanelVisibility({ folder: false }, { remember: true, width });
        } else {
            setPanelVisibility({ file: true, folder: true }, { remember: true, width });
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
                    <span class="writer-files-title"></span>
                    <button class="writer-create" title="New document" aria-label="New document"></button>
                </div>
                <div class="writer-files-body">
                    <ul class="writer-file-list"></ul>
                </div>
            </div>
        `;

        const editor = document.createElement('div');
        editor.className = 'writer-editor';
        editor.style.position = 'relative';
        editor.innerHTML = `
            <div class="writer-editor-pane" id="writerEditorPane"></div>
        `;

        // Empty-state overlay (shown when no document is selected)
        const emptyOverlay = document.createElement('div');
        emptyOverlay.id = 'writerEmptyOverlay';
        emptyOverlay.textContent = 'No document selected';
        emptyOverlay.style.position = 'absolute';
        emptyOverlay.style.inset = '0';
        emptyOverlay.style.background = 'var(--editor-panel-bg)';
        emptyOverlay.style.display = 'none';
        emptyOverlay.style.alignItems = 'center';
        emptyOverlay.style.justifyContent = 'center';
        emptyOverlay.style.fontSize = '1rem';
        emptyOverlay.style.color = 'var(--muted, rgba(255,255,255,0.7))';
        emptyOverlay.style.zIndex = '3';
        emptyOverlay.style.pointerEvents = 'none';
        editor.appendChild(emptyOverlay);

        main.appendChild(navigation);
        main.appendChild(editor);
        root.appendChild(main);

        state.rootEl = root;
        state.navigationEl = navigation;
        state.folderSectionEl = navigation.querySelector('.writer-folders');
        state.fileSectionEl = navigation.querySelector('.writer-files');
        state.folderListEl = navigation.querySelector('.writer-folder-tree');
        state.listEl = navigation.querySelector('.writer-file-list');
        state.fileHeaderLabel = navigation.querySelector('.writer-files-title');
        bindFolderDnDHandlers();
        bindFileDnDHandlers();
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
        updateFileHeaderLabel();

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
        updateWordCountFromText('');
        INIT_SCROLL_SUPPRESS.add(state.cmView);
        state.savedSnapshot = '';
        clearDirty('');
        state.emptyOverlayEl = document.getElementById('writerEmptyOverlay');
    }

    function redrawFileList() {
        if (!state.listEl) return;
        const docs = getFilteredDocs();
        state.listEl.innerHTML = '';
        for (const doc of docs) {
            const item = document.createElement('li');
            item.className = 'writer-file-item';
            item.dataset.id = String(doc.id);
            item.dataset.folderId = doc.folder_id == null ? 'root' : String(doc.folder_id);
            item.dataset.order = String(doc.order_index ?? 0);
            item.setAttribute('draggable', 'true');
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
                empty.textContent = 'This folder is empty.';
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

    function compareByUpdatedDesc(a, b) {
        const ta = a && a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const tb = b && b.updated_at ? new Date(b.updated_at).getTime() : 0;
        if (tb !== ta) return tb - ta;
        return (b.id ?? 0) - (a.id ?? 0);
    }

    function buildFolderChildrenMap(folders) {
        const map = new Map();
        for (const folder of folders) {
            const parent = folder.parent_id == null ? null : folder.parent_id;
            if (!map.has(parent)) map.set(parent, []);
            map.get(parent).push(folder);
        }
        for (const [, list] of map) {
            list.sort((a, b) => {
                const diff = (a.order_index ?? 0) - (b.order_index ?? 0);
                if (diff !== 0) return diff;
                return (a.name_lower || '').localeCompare(b.name_lower || '');
            });
        }
        return map;
    }

    function renderFolderTree() {
        if (!state.folderListEl) return;
        const folders = Array.isArray(state.folders) ? state.folders.slice() : [];
        const childrenMap = buildFolderChildrenMap(folders);
        const renderNode = (folder, { isInbox = false } = {}) => {
            const rawChildren = isInbox ? [] : (childrenMap.get(folder.id) || []);
            const children = rawChildren.filter(child => !isInboxFolder(child.id));
            const hasChildren = children.length > 0;
            const expanded = hasChildren && isFolderExpanded(folder.id);
            const liClasses = ['writer-folder-item'];
            if (hasChildren) {
                liClasses.push('has-children');
                liClasses.push(expanded ? 'expanded' : 'collapsed');
            }
            const draggableAttr = isInbox ? '' : 'draggable="true"';
            const inboxAttr = isInbox ? ' data-inbox="true"' : '';
            const caret = hasChildren
                ? `<button type="button" class="writer-folder-caret writer-folder-caret-toggle" aria-label="Toggle subfolders" aria-expanded="${expanded ? 'true' : 'false'}" draggable="false"></button>`
                : '<span class="writer-folder-caret writer-folder-caret--spacer" aria-hidden="true"></span>';
            const subtree = hasChildren
                ? `<ul>${children.map(child => renderNode(child)).join('')}</ul>`
                : '';
            return `
                <li class="${liClasses.join(' ')}" data-folder-id="${folder.id}"${inboxAttr}>
                    <div class="writer-folder-row" ${draggableAttr}>
                        ${caret}
                        <span class="writer-folder-name">${esc(folder.name)}</span>
                    </div>
                    ${subtree}
                </li>
            `;
        };
        const rootChildren = (childrenMap.get(null) || []).filter(child => !isInboxFolder(child.id));
        let html = '';
        const inbox = state.inboxFolderId != null ? state.folders.find(f => f.id === state.inboxFolderId) : null;
        if (inbox) {
            html += renderNode(inbox, { isInbox: true });
        }
        if (rootChildren.length) {
            html += rootChildren.map(child => renderNode(child)).join('');
        }
        state.folderListEl.innerHTML = html;
        highlightActiveFolder();
    }

    function highlightActiveFolder() {
        if (!state.folderListEl) return;
        state.folderListEl.querySelectorAll('.writer-folder-item').forEach(item => item.classList.remove('active'));
        const targetId = state.selectedFolderId === 'all' ? state.inboxFolderId : state.selectedFolderId;
        if (targetId == null) return;
        const active = state.folderListEl.querySelector(`.writer-folder-item[data-folder-id="${targetId}"]`);
        if (active) active.classList.add('active');
    }

    function activeFolderDisplayName() {
        const targetId = state.selectedFolderId === 'all' ? state.inboxFolderId : state.selectedFolderId;
        if (targetId == null) return 'Files';
        const folder = state.folders.find(f => f.id === targetId);
        if (folder && folder.name) return folder.name;
        return 'Files';
    }

    function updateFileHeaderLabel() {
        if (!state.fileHeaderLabel) return;
        state.fileHeaderLabel.textContent = activeFolderDisplayName();
    }

    function isFolderExpanded(id) {
        if (id == null) return false;
        const numeric = Number(id);
        return Number.isFinite(numeric) && state.expandedFolders.has(numeric);
    }

    function setFolderExpanded(id, expanded) {
        if (id == null) return;
        const numeric = Number(id);
        if (!Number.isFinite(numeric)) return;
        if (expanded) state.expandedFolders.add(numeric);
        else state.expandedFolders.delete(numeric);
    }

    function toggleFolderExpanded(id) {
        if (id == null) return;
        const numeric = Number(id);
        if (!Number.isFinite(numeric)) return;
        if (state.expandedFolders.has(numeric)) state.expandedFolders.delete(numeric);
        else state.expandedFolders.add(numeric);
    }

    function ensureFolderPathExpanded(folderId) {
        const target = normalizeFolderId(folderId);
        if (target == null) return;
        let current = getFolderParentId(target);
        while (current != null) {
            state.expandedFolders.add(current);
            current = getFolderParentId(current);
        }
    }

    function pruneInvalidExpandedFolders() {
        const valid = new Set(state.folders.map(f => f.id));
        state.expandedFolders.forEach(id => {
            if (!valid.has(id)) state.expandedFolders.delete(id);
        });
    }

    function resolveFolderId(value) {
        if (value === 'all') return 'all';
        if (value == null) return 'all';
        const num = Number(value);
        return Number.isFinite(num) ? num : 'all';
    }

    function getFolderById(id) {
        if (id == null) return null;
        return state.folders.find(f => f.id === id) || null;
    }

    function getFolderParentId(id) {
        const folder = getFolderById(id);
        return folder ? normalizeFolderId(folder.parent_id) : null;
    }

    function getFilteredDocs() {
        const activeFolder = state.selectedFolderId === 'all' ? state.inboxFolderId : state.selectedFolderId;
        if (!activeFolder) {
            return state.docs.slice().sort(compareByUpdatedDesc);
        }
        const target = normalizeFolderId(activeFolder);
        return state.docs
            .filter(doc => normalizeFolderId(doc.folder_id) === target)
            .slice()
            .sort((a, b) => {
                const orderDiff = (a.order_index ?? 0) - (b.order_index ?? 0);
                if (orderDiff !== 0) return orderDiff;
                return (a.id ?? 0) - (b.id ?? 0);
            });
    }

    function setSelectedFolder(folderId, { fromDocument = false } = {}) {
        let resolved = resolveFolderId(folderId);
        if (resolved === 'all' && state.inboxFolderId != null) {
            resolved = state.inboxFolderId;
        } else if (resolved !== 'all' && !state.folders.some(folder => folder.id === resolved)) {
            resolved = state.inboxFolderId ?? 'all';
        }
        state.selectedFolderId = resolved;
        if (resolved !== 'all' && resolved != null) {
            ensureFolderPathExpanded(resolved);
        }
        highlightActiveFolder();
        updateFileHeaderLabel();
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
                ? rows.map(normalizeFolder)
                : [];
            await ensureInboxFolderExists();
            state.folders.sort(orderSortFolders);
            pruneInvalidExpandedFolders();
            if ((state.selectedFolderId === 'all' || state.selectedFolderId == null) && state.inboxFolderId != null) {
                state.selectedFolderId = state.inboxFolderId;
            }
            if (state.selectedFolderId && state.selectedFolderId !== 'all') {
                ensureFolderPathExpanded(state.selectedFolderId);
            }
            renderFolderTree();
            updateFileHeaderLabel();
        } catch (err) {
            shell.print(`<div class="error">Failed to load folders: ${esc(err?.message || err)}</div>`);
            state.folders = [];
            state.expandedFolders.clear();
            renderFolderTree();
            updateFileHeaderLabel();
        }
    }

    async function ensureInboxFolderExists() {
        let inbox = state.folders.find(f => (f.name_lower || '') === 'inbox' && f.parent_id == null);
        if (inbox) {
            state.inboxFolderId = inbox.id;
            return;
        }
        if (!writerAPI || typeof writerAPI.createFolder !== 'function') {
            state.inboxFolderId = null;
            return;
        }
        try {
            const created = await writerAPI.createFolder({ name: 'Inbox', parentId: null });
            if (created && created.id != null) {
                inbox = normalizeFolder(created);
                state.folders.push(inbox);
                state.inboxFolderId = inbox.id;
            }
        } catch (_) {
            // Ignore; likely already exists or cannot be created
        }
    }

    async function persistFolderOrder(parentIds = []) {
        if (!writerAPI || typeof writerAPI.reorderFolders !== 'function') return;
        const unique = [];
        for (const fid of parentIds) {
            const normalized = normalizeFolderId(fid);
            if (!unique.some(val => val === normalized)) unique.push(normalized);
        }
        const moves = [];
        for (const parentId of unique) {
            const ordered = foldersOrderedForParent(parentId);
            ordered.forEach((folder, idx) => {
                folder.order_index = idx;
                moves.push({
                    id: folder.id,
                    parentId,
                    order: idx
                });
            });
        }
        if (!moves.length) return;
        try {
            await writerAPI.reorderFolders(moves);
        } catch (err) {
            showToast(err?.message || 'Failed to save folder order', 'error', 'writerToastError');
            await loadFolders();
        }
    }

    function onFolderClick(e) {
        const toggleBtn = e.target.closest('.writer-folder-caret-toggle');
        if (toggleBtn) {
            e.preventDefault();
            e.stopPropagation();
            const item = toggleBtn.closest('.writer-folder-item');
            if (!item || !item.classList.contains('has-children')) return;
            const folderId = Number(item.dataset.folderId);
            if (!Number.isFinite(folderId)) return;
            toggleFolderExpanded(folderId);
            renderFolderTree();
            return;
        }
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
        const folderId = Number(id);
        if (!Number.isFinite(folderId)) return;
        e.preventDefault();
        closeContextMenu();
        const menu = ensureFolderContextMenu();
        menu.dataset.folderId = String(folderId);
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        menu.classList.add('visible');
        const isInbox = isInboxFolder(folderId);
        menu.querySelectorAll('button').forEach(btn => {
            const action = btn.dataset.action;
            const allowed = !isInbox || action === FOLDER_ACTIONS.OPEN;
            btn.style.display = allowed ? '' : 'none';
            btn.disabled = !allowed;
            btn.onclick = () => {
                handleFolderContextAction(action, folderId);
                closeContextMenu();
            };
        });
    }

    async function handleFolderContextAction(action, id) {
        if (isInboxFolder(id) && action !== FOLDER_ACTIONS.OPEN) {
            showToast('Inbox cannot be modified', 'warn');
            return;
        }
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
        const resolvedParent = parentId == null
            ? (state.selectedFolderId === 'all' ? null : state.selectedFolderId)
            : parentId;
        if (resolvedParent != null && isInboxFolder(resolvedParent)) {
            showToast('Inbox cannot contain folders', 'warn');
            return null;
        }
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
            const folder = await writerAPI.createFolder({ name: trimmed, parentId: resolvedParent });
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
        if (isInboxFolder(id)) {
            showToast('Inbox cannot be renamed', 'warn');
            return;
        }
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

    function bindFileDnDHandlers() {
        if (!state.listEl || state.fileListDndBound) return;
        state.fileListDndBound = true;
        const el = state.listEl;
        el.addEventListener('dragstart', handleFileDragStart);
        el.addEventListener('dragover', handleFileDragOver);
        el.addEventListener('drop', handleFileDrop);
        el.addEventListener('dragend', handleFileDragEnd);
    }

    function handleFileDragStart(e) {
        const item = e.target.closest('.writer-file-item');
        if (!item) return;
        const id = Number(item.dataset.id);
        if (!Number.isFinite(id)) return;
        state.draggingDocId = id;
        item.classList.add('dragging');
        try {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(id));
        } catch (_) {}
    }

    function handleFileDragOver(e) {
        if (state.draggingDocId == null) return;
        const activeFolder = state.selectedFolderId === 'all' ? state.inboxFolderId : state.selectedFolderId;
        if (!activeFolder) return;
        e.preventDefault();
        clearDocDropIndicators();
        const item = e.target.closest('.writer-file-item');
        if (!item) return;
        const targetId = Number(item.dataset.id);
        if (!Number.isFinite(targetId) || targetId === state.draggingDocId) return;
        const rect = item.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        item.classList.add(before ? 'drag-over-before' : 'drag-over-after');
        if (state.listEl) {
            state.listEl.dataset.dropTargetId = String(targetId);
            state.listEl.dataset.dropBefore = before ? '1' : '0';
        }
    }

    function handleFileDrop(e) {
        if (state.draggingDocId == null) return;
        const activeFolder = state.selectedFolderId === 'all' ? state.inboxFolderId : state.selectedFolderId;
        if (!activeFolder) {
            clearDocDragState();
            return;
        }
        e.preventDefault();
        const docId = state.draggingDocId;
        const dropTargetId = state.listEl?.dataset.dropTargetId ? Number(state.listEl.dataset.dropTargetId) : null;
        const before = state.listEl?.dataset.dropBefore === '1';
        const destFolder = normalizeFolderId(activeFolder);
        const docs = docsOrderedForFolder(destFolder, docId);
        let insertIndex = docs.length;
        if (dropTargetId && docs.some(d => d.id === dropTargetId)) {
            const idx = docs.findIndex(d => d.id === dropTargetId);
            if (idx >= 0) insertIndex = before ? idx : idx + 1;
        }
        applyDocumentMove(docId, destFolder, insertIndex);
        clearDocDragState();
    }

    function handleFileDragEnd() {
        clearDocDragState();
        state.folderDropTarget = null;
    }

    function clearDocDropIndicators() {
        if (!state.listEl) return;
        state.listEl.querySelectorAll('.drag-over-before, .drag-over-after').forEach(el => {
            el.classList.remove('drag-over-before', 'drag-over-after');
        });
        if (state.listEl.dataset.dropTargetId) delete state.listEl.dataset.dropTargetId;
        if (state.listEl.dataset.dropBefore) delete state.listEl.dataset.dropBefore;
    }

    function clearDocDragState() {
        if (!state.listEl) return;
        state.draggingDocId = null;
        state.listEl.querySelectorAll('.writer-file-item.dragging').forEach(el => el.classList.remove('dragging'));
        clearDocDropIndicators();
    }

    function bindFolderDnDHandlers() {
        if (!state.folderListEl || state.folderDndBound) return;
        state.folderDndBound = true;
        const el = state.folderListEl;
        el.addEventListener('dragstart', handleFolderDragStart, true);
        el.addEventListener('dragover', handleFolderDragOver);
        el.addEventListener('drop', handleFolderDrop);
        el.addEventListener('dragend', handleFolderDragEnd);
    }

    function folderIdFromRow(row) {
        if (!row) return null;
        const item = row.closest('.writer-folder-item');
        if (!item) return null;
        const id = item.dataset.folderId;
        if (id === 'all') return null;
        const numeric = Number(id);
        return Number.isFinite(numeric) ? numeric : null;
    }

    function handleFolderDragStart(e) {
        if (e.target.closest('.writer-folder-caret')) {
            e.preventDefault();
            return;
        }
        const row = e.target.closest('.writer-folder-row');
        if (!row) return;
        const id = folderIdFromRow(row);
        if (id == null) return;
        state.folderDropTarget = null;
        state.draggingFolderId = id;
        row.classList.add('dragging');
        try {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(id));
        } catch (_) {}
    }

    function handleFolderDragOver(e) {
        const docDragging = state.draggingDocId != null;
        const folderDragging = state.draggingFolderId != null;
        if (!docDragging && !folderDragging) return;
        const row = e.target.closest('.writer-folder-row');
        const targetId = row ? folderIdFromRow(row) : null;
        if (docDragging) {
            e.preventDefault();
            clearFolderDropIndicators();
            state.folderDropTarget = targetId;
            if (row) row.classList.add('drag-over-target');
            else state.folderDropTarget = null;
            return;
        }
        if (!folderDragging) return;
        if (targetId === state.draggingFolderId) return;
        if (targetId != null && isDescendantFolder(state.draggingFolderId, targetId)) return;
        let intent = null;
        if (row && targetId != null) {
            const parentOfTarget = getFolderParentId(targetId);
            const rect = row.getBoundingClientRect();
            const offset = (e.clientY - rect.top) / rect.height;
            if (offset < 0.3) {
                intent = { type: 'position', parentId: parentOfTarget, targetId, before: true, row };
            } else if (offset > 0.7) {
                intent = { type: 'position', parentId: parentOfTarget, targetId, before: false, row };
            } else if (!isInboxFolder(targetId)) {
                intent = { type: 'into', parentId: targetId, row };
            }
        }
        if (!intent && !row) {
            intent = { type: 'position', parentId: null, targetId: null, before: false, row: null };
        }
        if (!intent) return;
        if (intent.parentId != null && isInboxFolder(intent.parentId)) return;
        if (intent.parentId === state.draggingFolderId) return;
        if (intent.parentId != null && isDescendantFolder(intent.parentId, state.draggingFolderId)) return;
        e.preventDefault();
        clearFolderDropIndicators();
        state.folderDragIntent = intent;
        if (!row) return;
        if (intent.type === 'position') {
            row.classList.add(intent.before ? 'drag-over-before' : 'drag-over-after');
        } else if (intent.type === 'into') {
            row.classList.add('drag-over-target');
        }
    }

    function handleFolderDrop(e) {
        const docId = state.draggingDocId;
        if (docId != null) {
            e.preventDefault();
            const destination = state.folderDropTarget ?? state.inboxFolderId ?? null;
            applyDocumentMove(docId, destination, null);
            clearDocDragState();
            clearFolderDropIndicators();
            state.folderDropTarget = null;
            return;
        }
        const folderId = state.draggingFolderId;
        if (folderId == null) return;
        const intent = state.folderDragIntent;
        if (!intent) {
            clearFolderDropIndicators();
            state.draggingFolderId = null;
            return;
        }
        e.preventDefault();
        if (intent.type === 'position') {
            moveFolderWithOrdering(folderId, intent.parentId, intent.targetId, intent.before);
        } else if (intent.type === 'into') {
            moveFolderWithOrdering(folderId, intent.parentId, null, false);
        }
        clearFolderDropIndicators();
        state.draggingFolderId = null;
        state.folderDragIntent = null;
    }

    function handleFolderDragEnd() {
        clearFolderDropIndicators();
        state.draggingFolderId = null;
        state.folderDropTarget = null;
        state.folderDragIntent = null;
    }

    function clearFolderDropIndicators() {
        if (!state.folderListEl) return;
        state.folderListEl.querySelectorAll('.writer-folder-row.drag-over').forEach(row => row.classList.remove('drag-over'));
        state.folderListEl.querySelectorAll('.writer-folder-row.drag-over-target').forEach(row => row.classList.remove('drag-over-target'));
        state.folderListEl.querySelectorAll('.writer-folder-row.drag-over-before').forEach(row => row.classList.remove('drag-over-before'));
        state.folderListEl.querySelectorAll('.writer-folder-row.drag-over-after').forEach(row => row.classList.remove('drag-over-after'));
        state.folderListEl.querySelectorAll('.writer-folder-row.dragging').forEach(row => row.classList.remove('dragging'));
        state.folderDragIntent = null;
    }

    async function duplicateFolder(id) {
        if (!writerAPI || typeof writerAPI.duplicateFolder !== 'function') return;
        const folder = state.folders.find(f => f.id === id);
        if (!folder) return;
        if (isInboxFolder(id)) {
            showToast('Inbox cannot be duplicated', 'warn');
            return;
        }
        try {
            const copy = await writerAPI.duplicateFolder(id, {});
            await loadFolders();
            if (copy && copy.id != null) setSelectedFolder(copy.id);
            await loadDocuments();
            showToast('Folder duplicated', 'ok');
        } catch (err) {
            showToast(err?.message || 'Failed to duplicate folder', 'error', 'writerToastError');
        }
    }

    async function deleteFolder(id) {
        if (!writerAPI || typeof writerAPI.deleteFolder !== 'function') return;
        const folder = state.folders.find(f => f.id === id);
        if (!folder) return;
        if (isInboxFolder(id)) {
            showToast('Inbox cannot be deleted', 'warn');
            return;
        }
        const result = await confirmModal({
            title: 'Delete folder?',
            message: `This will permanently delete "${folder.name}" and everything inside it.`,
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

    const PANEL_BUCKET = {
        LARGE: 'lg',
        MEDIUM: 'md',
        SMALL: 'sm'
    };

    function bucketForWidth(width) {
        if (width >= 1024) return PANEL_BUCKET.LARGE;
        if (width >= 768) return PANEL_BUCKET.MEDIUM;
        return PANEL_BUCKET.SMALL;
    }

    function bucketWeight(bucket) {
        switch (bucket) {
            case PANEL_BUCKET.LARGE: return 3;
            case PANEL_BUCKET.MEDIUM: return 2;
            default: return 1;
        }
    }

    function applyBreakpointDefaults(bucket) {
        if (bucket === PANEL_BUCKET.LARGE) {
            setPanelVisibility({ file: false, folder: false });
        } else if (bucket === PANEL_BUCKET.MEDIUM) {
            setPanelVisibility({ file: false, folder: true });
        } else {
            setPanelVisibility({ file: true, folder: true });
        }
    }

    function applyPreferenceIfAllowed(bucket) {
        if (!state.panelPreference) return false;
        const prefBucket = bucketForWidth(state.panelPreference.width ?? 0);
        if (bucketWeight(bucket) < bucketWeight(prefBucket)) return false;
        setPanelVisibility({
            file: !!state.panelPreference.file,
            folder: !!state.panelPreference.folder
        });
        return true;
    }

    function handleResponsivePanels(force = false) {
        const width = window.innerWidth || 0;
        const prevWidth = state.lastWindowWidth ?? width;
        const prevBucket = bucketForWidth(prevWidth);
        const curBucket = bucketForWidth(width);

        if (force) {
            applyBreakpointDefaults(curBucket);
            applyPreferenceIfAllowed(curBucket);
            state.lastWindowWidth = width;
            return;
        }

        if (curBucket === prevBucket) {
            applyPreferenceIfAllowed(curBucket);
            state.lastWindowWidth = width;
            return;
        }

        const shrinking = bucketWeight(curBucket) < bucketWeight(prevBucket);
        if (shrinking) {
            applyBreakpointDefaults(curBucket);
        } else if (!applyPreferenceIfAllowed(curBucket)) {
            applyBreakpointDefaults(curBucket);
        }

        state.lastWindowWidth = width;
    }

    function pickMostRecent(docs) {
        if (!Array.isArray(docs) || !docs.length) return null;
        const toTime = d => {
            const u = d && d.updated_at ? new Date(d.updated_at).getTime() : NaN;
            if (!Number.isNaN(u)) return u;
            const c = d && d.created_at ? new Date(d.created_at).getTime() : NaN;
            if (!Number.isNaN(c)) return c;
            return typeof d.id === 'number' ? d.id : -Infinity;
        };
        let best = docs[0];
        let bestT = toTime(best);
        for (let i = 1; i < docs.length; i++) {
            const t = toTime(docs[i]);
            if (t > bestT) { best = docs[i]; bestT = t; }
        }
        return best;
    }

    function setEmptyOverlayVisible(show) {
        if (!state.emptyOverlayEl) return;
        state.emptyOverlayEl.style.display = show ? 'flex' : 'none';
    }

    // Helper to positively clear the editor when no document is selected
    function showNoSelectionOverlay() {
        setEmptyOverlayVisible(true);
        if (state.cmView) {
            const len = state.cmView.state.doc.length;
            if (len > 0) {
                state.cmView.dispatch({ changes: { from: 0, to: len, insert: '' } });
            }
            // Reset scroll position for good measure
            try { getScrollContainer(state.cmView).scrollTop = 0; } catch (_) {}
        }
        state.current = null;
        state.savedSnapshot = '';
        clearDirty('');
        updateWordCountFromText('');
    }

    async function loadDocuments(prefetchedDocs = undefined) {
        try {
            let docs = prefetchedDocs;
            if (!Array.isArray(docs)) {
                docs = await writerAPI.list();
            }
            state.docs = Array.isArray(docs) ? docs.map(normalizeDoc) : [];
            redrawFileList();

            if (!state.docs.length) {
                showNoSelectionOverlay();
                return;
            }

            // If we already have a current doc and it's still present, keep it selected
            if (state.current && state.docs.some(d => d.id === state.current.id)) {
                setActiveListItem(state.current.id);
                setEmptyOverlayVisible(false);
                return;
            }

            // Otherwise, open the most recent document (prefer updated_at)
            let candidates = getFilteredDocs();
            if (!candidates.length && state.selectedFolderId !== state.inboxFolderId) {
                setSelectedFolder(state.inboxFolderId ?? 'all');
                candidates = getFilteredDocs();
            }
            const target = pickMostRecent(candidates.length ? candidates : state.docs);
            if (target && target.id != null) {
                await openDocument(target.id, { force: true });
                setEmptyOverlayVisible(false);
            } else {
                showNoSelectionOverlay();
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
        state.cmView.focus();
        state.cmView.dispatch({ selection: { anchor: 0 } });
        state.savedSnapshot = typeof snapshotOverride === 'string' ? snapshotOverride : doc;
        clearDirty(state.savedSnapshot);
        updateWordCountFromText(doc);
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
            const doc = normalizeDoc(await writerAPI.get(id));
            if (!doc) return;
            state.current = doc;
            const folderForDoc = doc.folder_id == null ? 'all' : doc.folder_id;
            setSelectedFolder(folderForDoc, { fromDocument: true });
            setEditorContent(doc.content || '', doc.title || 'Untitled Document', doc.content || '');
            updateWordCountFromText(doc.content || '');
            setEmptyOverlayVisible(false);
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

    async function saveCurrentDocument(options = {}) {
        const { silent = false, refreshList = !silent } = options;
        if (!state.current) {
            const doc = await createNewDocument();
            if (!doc) return false;
        }
        if (!state.cmView || !state.current) return false;
        const title = state.current.title || 'Untitled Document';
        const content = state.cmView.state.doc.toString();
        try {
            const updated = normalizeDoc(await writerAPI.update({
                id: state.current.id,
                title,
                content,
                folderId: state.current.folder_id ?? null
            }));
            state.current = updated;
            state.savedSnapshot = content;
            clearDirty(content);
            if (refreshList) {
                await loadDocuments();
                if (state.current) setActiveListItem(state.current.id);
            } else if (state.current) {
                setActiveListItem(state.current.id);
            }
            if (!silent) showToast('Document saved', 'ok');
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
            const defaultFolder = state.selectedFolderId === 'all' ? state.inboxFolderId : state.selectedFolderId;
            const folderId = defaultFolder ?? state.inboxFolderId ?? null;
            const doc = normalizeDoc(await writerAPI.create({ title, content: '', folderId }));
            await loadDocuments();
            await openDocument(doc.id, { force: true });
            setEmptyOverlayVisible(false);
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
            const doc = normalizeDoc(await writerAPI.duplicate(id, { title }));
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
            const renamed = normalizeDoc(await writerAPI.rename(id, title));
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
            // If no documents remain, or the deleted doc was the current one, show the empty overlay and clear the editor
            if (!state.docs.length) {
                showNoSelectionOverlay();
            } else if (state.current && state.current.id === id) {
                showNoSelectionOverlay();
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
        if (!state.dirty) {
            performExit();
            return;
        }
        if (state.autosaveEnabled) {
            saveCurrentDocument({ silent: true }).then((saved) => {
                if (!saved) {
                    showToast('Unable to save before exit', 'error', 'writerToastError');
                    return;
                }
                performExit();
            });
            return;
        }
        confirmExitWithoutSaving().then(async (result) => {
            if (result === 'yes') {
                clearDirty();
                performExit();
            }
        });
    }

    function performExit() {
        detachGlobalListeners();
        cancelAutosaveTimer();
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
    setEmptyOverlayVisible(true);
    shell.setPrompt(state.prompt);
    (async () => {
        let docsPromise = null;
        try {
            docsPromise = writerAPI.list();
        } catch (_) {
            docsPromise = null;
        }
        try {
            await loadFolders();
        } catch (_) {
            // already surfaced in loadFolders
        }
        let prefetchedDocs = null;
        if (docsPromise) {
            try {
                prefetchedDocs = await docsPromise;
            } catch (_) {
                prefetchedDocs = null;
            }
        }
        if (Array.isArray(prefetchedDocs)) {
            await loadDocuments(prefetchedDocs);
        } else {
            await loadDocuments();
        }
    })();

    const program = {
        async consume() {},
        destroy() {
            detachGlobalListeners();
            closeContextMenu();
            cancelAutosaveTimer();
        },
        setAutosave(enabled) {
            setAutosaveEnabled(enabled);
        }
    };

    shell.enter(program);
    return program;
}
