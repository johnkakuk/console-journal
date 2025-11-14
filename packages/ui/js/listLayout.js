import { Annotation, EditorSelection, Prec, RangeSetBuilder, Transaction } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, keymap } from '@codemirror/view';
import { indentLess, indentMore, insertNewlineAndIndent } from '@codemirror/commands';

const ORDERED_LIST_RE = /^(\s*)(\d+)([.)])(\s+)(.*)$/;
const TODO_LIST_RE = /^(\s*)([-*])(\s+)\[( |x|X)\](\s*)(.*)$/;
const UNORDERED_LIST_RE = /^(\s*)([-+*])(\s+)(.*)$/;
const LIST_GAP_CH = 0.5;
const TODO_AUTOCOMPLETE_PREFIX_RE = /^\s*[-*]\s+$/;
const TODO_AUTOCOMPLETE_SUFFIX_RE = /^\s*\]/;
const TODO_BRACKET_LINE_RE = /^\s*\[/;
const todoAutoCompleteAnnotation = Annotation.define();
const todoLineFixAnnotation = Annotation.define();

function countLeadingSpaces(text) {
    const match = text.match(/^\s*/);
    return match ? match[0].length : 0;
}

function linesInSelection(state) {
    const seen = new Set();
    const out = [];
    for (const r of state.selection.ranges) {
        let line = state.doc.lineAt(r.from).number;
        const endLine = state.doc.lineAt(r.to).number;
        for (; line <= endLine; line++) {
            if (!seen.has(line)) {
                seen.add(line);
                out.push(line);
            }
        }
    }
    return out;
}

function parseListLine(text) {
    if (!text) return null;

    const todo = text.match(TODO_LIST_RE);
    if (todo) {
        const indent = todo[1] || '';
        const bullet = todo[2];
        const gap = todo[3] || ' ';
        const mark = todo[4] || ' ';
        const after = todo[5] ?? '';
        const rest = todo[6] ?? '';
        const markerCore = `${bullet}${gap}[${mark}]`;
        const markerLength = markerCore.length;
        const markerEnd = indent.length + markerLength;
        return {
            type: 'todo',
            indent,
            indentLength: indent.length,
            bullet,
            spacing: gap,
            checked: mark.toLowerCase() === 'x',
            afterBracket: after,
            content: rest,
            contentStart: markerEnd + after.length,
            markerLength,
            markerEnd
        };
    }

    const ordered = text.match(ORDERED_LIST_RE);
    if (ordered) {
        const indent = ordered[1] || '';
        const numberText = ordered[2];
        const markerChar = ordered[3];
        const gap = ordered[4] || ' ';
        const rest = ordered[5] ?? '';
        const prefix = indent + numberText + markerChar + gap;
        const markerLength = prefix.length - indent.length;
        const markerEnd = indent.length + markerLength;
        return {
            type: 'ordered',
            indent,
            indentLength: indent.length,
            number: Number(numberText),
            numberText,
            markerChar,
            spacing: gap,
            content: rest,
            contentStart: prefix.length,
            markerLength,
            markerEnd
        };
    }

    const unordered = text.match(UNORDERED_LIST_RE);
    if (unordered) {
        const indent = unordered[1] || '';
        const bullet = unordered[2];
        const gap = unordered[3] || ' ';
        const rest = unordered[4] ?? '';
        const prefix = indent + bullet + gap;
        const markerLength = prefix.length - indent.length;
        const markerEnd = indent.length + markerLength;
        return {
            type: 'unordered',
            indent,
            indentLength: indent.length,
            bullet,
            spacing: gap,
            content: rest,
            contentStart: prefix.length,
            markerLength,
            markerEnd
        };
    }

    return null;
}

function makeListPrefix(parsed, overrides = {}) {
    const indent = overrides.indent ?? parsed.indent;
    switch (parsed.type) {
        case 'ordered': {
            const number = overrides.number ?? 1;
            const spacing = parsed.spacing && parsed.spacing.length ? parsed.spacing : ' ';
            return `${indent}${number}${parsed.markerChar}${spacing}`;
        }
        case 'unordered': {
            const spacing = parsed.spacing && parsed.spacing.length ? parsed.spacing : ' ';
            const bullet = overrides.bullet ?? parsed.bullet;
            return `${indent}${bullet}${spacing}`;
        }
        case 'todo': {
            const spacing = parsed.spacing && parsed.spacing.length ? parsed.spacing : ' ';
            const afterBracket = overrides.afterBracket ?? (parsed.afterBracket && parsed.afterBracket.length ? parsed.afterBracket : ' ');
            const bullet = overrides.bullet ?? parsed.bullet;
            const checked = overrides.checked === true ? 'x' : ' ';
            return `${indent}${bullet}${spacing}[${checked}]${afterBracket}`;
        }
        default:
            return indent;
    }
}

function continuationIndent(parsed) {
    return ' '.repeat(parsed.contentStart);
}

function listEnterCommandFactory(indentString) {
    return function listEnterCommand(view) {
        const { state } = view;
        if (state.selection.ranges.length !== 1) return false;
        const range = state.selection.main;
        if (!range.empty) return false;

        const line = state.doc.lineAt(range.head);
        const parsed = parseListLine(line.text);
        if (!parsed) return false;

        const cursorOffset = range.head - line.from;
        if (cursorOffset < parsed.contentStart) {
            const target = line.from + parsed.contentStart;
            if (range.head !== target) {
                view.dispatch({
                    selection: EditorSelection.cursor(target),
                    scrollIntoView: true
                });
            }
            return true;
        }

        const content = line.text.slice(parsed.contentStart).trim();
        if (!content) {
            const parentIndentLength = Math.max(0, parsed.indentLength - indentString.length);
            const parentIndent = parsed.indent.slice(0, parentIndentLength);
            const removeTo = line.from + parsed.contentStart;
            view.dispatch({
                changes: { from: line.from, to: removeTo, insert: parentIndent },
                selection: EditorSelection.cursor(line.from + parentIndentLength),
                scrollIntoView: true,
                annotations: Transaction.userEvent.of('input')
            });
            insertNewlineAndIndent(view);
            return true;
        }

        const nextNumber = parsed.type === 'ordered' ? parsed.number + 1 : undefined;
        const prefix = makeListPrefix(parsed, {
            number: nextNumber,
            checked: false
        });
        const insertText = `\n${prefix}`;
        view.dispatch({
            changes: { from: range.from, to: range.to, insert: insertText },
            selection: EditorSelection.cursor(range.from + insertText.length),
            scrollIntoView: true,
            annotations: Transaction.userEvent.of('input')
        });
        return true;
    };
}

function listSoftBreakCommand(view) {
    const { state } = view;
    if (state.selection.ranges.length !== 1) return false;
    const range = state.selection.main;
    if (!range.empty) return false;

    const line = state.doc.lineAt(range.head);
    const parsed = parseListLine(line.text);
    if (!parsed) return false;

    const cursorOffset = range.head - line.from;
    if (cursorOffset < parsed.contentStart) {
        const target = line.from + parsed.contentStart;
        if (target !== range.head) {
            view.dispatch({
                selection: EditorSelection.cursor(target),
                scrollIntoView: true
            });
        }
        return true;
    }

    const insertText = `\n${continuationIndent(parsed)}`;
    view.dispatch({
        changes: { from: range.from, to: range.to, insert: insertText },
        selection: EditorSelection.cursor(range.from + insertText.length),
        scrollIntoView: true,
        annotations: Transaction.userEvent.of('input')
    });
    return true;
}

function listIndentCommandFactory(indentString) {
    return function listIndentCommand(view) {
        const { state } = view;
        const selectedLines = linesInSelection(state);
        if (!selectedLines.length) return indentMore(view);

        const targets = [];
        for (const lineNumber of selectedLines) {
            const ln = state.doc.line(lineNumber);
            const parsed = parseListLine(ln.text);
            if (!parsed) return indentMore(view);
            targets.push(ln);
        }

        if (!targets.length) return true;
        const changes = targets.map(ln => ({ from: ln.from, to: ln.from, insert: indentString }));
        view.dispatch({
            changes,
            scrollIntoView: true,
            annotations: Transaction.userEvent.of('input')
        });
        return true;
    };
}

function listOutdentCommandFactory(indentString) {
    return function listOutdentCommand(view) {
        const { state } = view;
        const selectedLines = linesInSelection(state);
        if (!selectedLines.length) return indentLess(view);

        const changes = [];
        for (const lineNumber of selectedLines) {
            const ln = state.doc.line(lineNumber);
            const parsed = parseListLine(ln.text);
            if (!parsed) return indentLess(view);
            if (!parsed.indentLength) return indentLess(view);
            const remove = Math.min(indentString.length, parsed.indentLength);
            changes.push({ from: ln.from, to: ln.from + remove, insert: '' });
        }

        if (!changes.length) return true;
        view.dispatch({
            changes,
            scrollIntoView: true,
            annotations: Transaction.userEvent.of('input')
        });
        return true;
    };
}

export function createListKeymap(indentString = '  ') {
    const enterCommand = listEnterCommandFactory(indentString);
    const indentCommand = listIndentCommandFactory(indentString);
    const outdentCommand = listOutdentCommandFactory(indentString);

    return Prec.highest(keymap.of([
        { key: 'Enter', run: enterCommand },
        { key: 'Shift-Enter', run: enterCommand },
        {
            key: 'Tab',
            preventDefault: true,
            run: indentCommand
        },
        {
            key: 'Shift-Tab',
            preventDefault: true,
            run: outdentCommand
        }
    ]));
}

function analyzeListStructure(state) {
    const builder = new RangeSetBuilder();
    const numberingChanges = [];
    const doc = state.doc;
    const levels = [];
    const allLevels = [];
    const lineInfos = [];

    const ensureLevel = (parsed) => {
        const indent = parsed.indentLength;
        const markerWidthCh = Math.max(parsed.contentStart - parsed.indentLength, parsed.markerLength);
        while (levels.length && indent < levels[levels.length - 1].indent) {
            levels.pop();
        }
        let level = levels.length ? levels[levels.length - 1] : null;
        if (!level || indent > level.indent) {
            level = {
                indent,
                type: parsed.type,
                counter: 0,
                maxDigits: 0,
                markerWidth: markerWidthCh,
                spacingWidth: parsed.spacing ? parsed.spacing.length : 1
            };
            levels.push(level);
            allLevels.push(level);
            return level;
        }
        if (indent === level.indent && level.type !== parsed.type) {
            level = {
                indent,
                type: parsed.type,
                counter: 0,
                maxDigits: 0,
                markerWidth: markerWidthCh,
                spacingWidth: parsed.spacing ? parsed.spacing.length : 1
            };
            levels[levels.length - 1] = level;
            allLevels.push(level);
            return level;
        }
        if (indent === level.indent) {
            level.markerWidth = Math.max(level.markerWidth, markerWidthCh);
            level.spacingWidth = Math.max(level.spacingWidth, parsed.spacing ? parsed.spacing.length : 1);
            return level;
        }
        return level;
    };

    for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
        const line = doc.line(lineNo);
        const parsed = parseListLine(line.text);
        if (parsed) {
            const level = ensureLevel(parsed);
            if (parsed.type === 'ordered') {
                level.counter += 1;
                const expected = level.counter;
                const expectedText = String(expected);
                level.maxDigits = Math.max(level.maxDigits, expectedText.length);
                const markerWidthCh = Math.max(parsed.contentStart - parsed.indentLength, parsed.markerLength);
                level.markerWidth = Math.max(level.markerWidth, markerWidthCh);
                if (parsed.number !== expected) {
                    const numberFrom = line.from + parsed.indentLength;
                    const numberTo = numberFrom + parsed.numberText.length;
                    numberingChanges.push({ from: numberFrom, to: numberTo, insert: expectedText });
                }
                lineInfos.push({ line, parsed, level });
            } else {
                const markerWidthCh = Math.max(parsed.contentStart - parsed.indentLength, parsed.markerLength);
                level.markerWidth = Math.max(level.markerWidth, markerWidthCh);
                lineInfos.push({ line, parsed, level });
            }
        } else {
            if (!line.text.trim().length) {
                levels.length = 0;
                continue;
            }
            const indentLen = countLeadingSpaces(line.text);
            while (levels.length && indentLen <= levels[levels.length - 1].indent) {
                levels.pop();
            }
        }
    }

    for (const level of allLevels) {
        if (level.type === 'ordered') {
            const digits = Math.max(level.maxDigits, 1);
            const spacing = Math.max(level.spacingWidth || 1, 1);
            level.markerWidth = Math.max(level.markerWidth, digits + 1 + spacing);
        } else if (level.type === 'todo') {
            level.markerWidth = Math.max(level.markerWidth, 5);
        } else if (level.type === 'unordered') {
            level.markerWidth = Math.max(level.markerWidth, 2);
        }
    }

    for (const info of lineInfos) {
        const { line, parsed, level } = info;
        const styleParts = [
            `--list-indent-ch:${parsed.indentLength}`,
            `--list-marker-ch:${level.markerWidth}`,
            `--list-gap-ch:${LIST_GAP_CH}`
        ];
        const markerFrom = line.from + parsed.indentLength;
        const markerTo = line.from + parsed.contentStart;
        const hasContent = markerTo < line.to;
        const attributes = {
            style: styleParts.join(';'),
            'data-list-type': parsed.type,
            'data-list-empty': hasContent ? 'false' : 'true'
        };
        builder.add(
            line.from,
            line.from,
            Decoration.line({ class: `cm-list-line cm-list-type-${parsed.type}`, attributes })
        );
        if (parsed.indentLength > 0) {
            builder.add(
                line.from,
                line.from + parsed.indentLength,
                Decoration.mark({
                    class: 'cm-list-indent',
                    inclusiveStart: true,
                    inclusiveEnd: false
                })
            );
        }
        builder.add(
            markerFrom,
            markerTo,
            Decoration.mark({
                class: 'cm-list-marker',
                inclusiveStart: false,
                inclusiveEnd: false
            })
        );
        const contentAttributes = {
            'data-list-type': parsed.type,
            'data-list-empty': hasContent ? 'false' : 'true'
        };
        const contentDeco = Decoration.mark({
            class: 'cm-list-content',
            inclusiveStart: true,
            inclusiveEnd: true,
            attributes: contentAttributes
        });
        if (hasContent) {
            builder.add(markerTo, line.to, contentDeco);
        } else {
            builder.add(markerTo, markerTo, contentDeco);
        }
    }

    return {
        decorations: builder.finish(),
        numberingChanges
    };
}

const autoNumberAnnotation = Annotation.define();

const todoAutoCompleteHandler = EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== '[') return false;
    if (from !== to) return false;
    const { state } = view;
    if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
    const line = state.doc.lineAt(from);
    const prefix = state.doc.sliceString(line.from, from);
    if (TODO_AUTOCOMPLETE_PREFIX_RE.test(prefix)) {
        const suffix = state.doc.sliceString(from, line.to);
        if (TODO_AUTOCOMPLETE_SUFFIX_RE.test(suffix)) return false;
        const hasContentSuffix = /\S/.test(suffix);
        const replaceTo = hasContentSuffix ? line.to : to;
        const insertText = hasContentSuffix ? `[ ] \n${suffix}` : '[ ] ';
        view.dispatch({
            changes: { from, to: replaceTo, insert: insertText },
            selection: EditorSelection.cursor(from + 4),
            annotations: todoAutoCompleteAnnotation.of(true),
            scrollIntoView: false
        });
        return true;
    }

    if (from === line.from && line.number > 1 && TODO_BRACKET_LINE_RE.test(line.text)) {
        const prev = state.doc.line(line.number - 1);
        if (TODO_AUTOCOMPLETE_PREFIX_RE.test(prev.text)) {
            const leadingSpaces = (line.text.match(/^\s*/) || [''])[0].length;
            const joinFrom = prev.to;
            const joinTo = line.from + leadingSpaces;
            const spacing = prev.text.endsWith(' ') ? '' : ' ';
            const insertText = spacing + '[ ] ';
            view.dispatch({
                changes: { from: joinFrom, to: joinTo, insert: insertText },
                selection: EditorSelection.cursor(joinFrom + insertText.length),
                annotations: todoAutoCompleteAnnotation.of(true),
                scrollIntoView: false
            });
            return true;
        }
    }

    return false;
});

export const listLayoutPlugin = ViewPlugin.fromClass(class {
    constructor(view) {
        const result = analyzeListStructure(view.state);
        this.decorations = result.decorations;
    }
    update(update) {
        if (!(update.docChanged || update.viewportChanged)) return;
        const result = analyzeListStructure(update.state);
        this.decorations = result.decorations;
    }
}, {
    decorations: v => v.decorations
});

export const listRenumberListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (update.transactions.some(tr => tr.annotation(autoNumberAnnotation))) return;
    const result = analyzeListStructure(update.state);
    if (!result.numberingChanges.length) return;
    update.view.dispatch({
        changes: result.numberingChanges,
        annotations: [autoNumberAnnotation.of(true), Transaction.addToHistory.of(false)]
    });
});

const todoLineFixer = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (update.transactions.some(tr => tr.annotation(todoAutoCompleteAnnotation) || tr.annotation(todoLineFixAnnotation))) return;

    const { state, view } = update;
    const main = state.selection.main;
    if (!main.empty) return;
    const line = state.doc.lineAt(main.head);
    if (line.number <= 1) return;
    if (!TODO_BRACKET_LINE_RE.test(line.text)) return;
    const prev = state.doc.line(line.number - 1);
    if (!TODO_AUTOCOMPLETE_PREFIX_RE.test(prev.text)) return;

    const leadingSpaces = (line.text.match(/^\s*/) || [''])[0].length;
    const rest = line.text.slice(leadingSpaces);
    if (!rest.startsWith('[')) return;
    const remainder = rest.slice(1); // keep anything typed after '['
    const trailing = state.doc.sliceString(line.to, line.to + 1) === '\n' ? '\n' : '\n';

    const from = prev.to;
    const to = line.to;
    const needsSpace = prev.text.endsWith(' ') ? '' : ' ';
    const insert = `${needsSpace}[ ] ${remainder}${trailing}`;
    const caret = from + needsSpace.length + 4; // account for " [ ] "

    view.dispatch({
        changes: { from, to, insert },
        selection: EditorSelection.cursor(caret),
        scrollIntoView: false,
        annotations: todoLineFixAnnotation.of(true)
    });
});

export const listTodoAutoComplete = todoAutoCompleteHandler;
export const listTodoLineFixer = todoLineFixer;
export const listTodoBlankGuard = EditorView.updateListener.of(() => {});
