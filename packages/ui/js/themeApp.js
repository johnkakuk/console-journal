import {
    applyTheme,
    buildValueFromInput,
    createThemeDraft,
    extractHexForInput,
    getDefaultTheme,
    loadActiveTheme,
    saveActiveTheme,
    validateTheme
} from './theme.js';

const VAR_GROUPS = [
    {
        title: 'COLORS',
        vars: ['--bg', '--panel', '--text', '--muted', '--soft', '--accent', '--border', '--editor-selection-bg']
    }
];

const COLOR_LABELS = {
    '--editor-selection-bg': 'Highlight'
};

const FONT_OPTIONS_UI = [
    {
        id: 'system-ui',
        label: 'System Default',
        css: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
        google: null
    },
    {
        id: 'roboto',
        label: 'Roboto',
        css: '"Roboto", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
        google: { family: 'Roboto', weights: [400, 500, 700] }
    },
    {
        id: 'open-sans',
        label: 'Open Sans',
        css: '"Open Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
        google: { family: 'Open Sans', weights: [400, 600] }
    }
];

const FONT_OPTIONS_EDITOR = [
    {
        id: 'system-editor',
        label: 'System Default',
        css: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
        google: null
    },
    {
        id: 'roboto-editor',
        label: 'Roboto (Sans)',
        css: '"Roboto", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
        google: { family: 'Roboto', weights: [400, 500, 700] }
    },
    {
        id: 'open-sans-editor',
        label: 'Open Sans (Sans)',
        css: '"Open Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
        google: { family: 'Open Sans', weights: [400, 600] }
    },
    {
        id: 'merriweather-editor',
        label: 'Merriweather (Serif)',
        css: '"Merriweather", Georgia, "Times New Roman", serif',
        google: { family: 'Merriweather', weights: [400, 700] }
    },
    {
        id: 'lora-editor',
        label: 'Lora (Serif)',
        css: '"Lora", Georgia, "Times New Roman", serif',
        google: { family: 'Lora', weights: [400, 600] }
    },
    {
        id: 'jetbrains-editor',
        label: 'JetBrains Mono',
        css: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Courier New", monospace',
        google: { family: 'JetBrains Mono', weights: [400, 500] }
    },
    {
        id: 'source-code-editor',
        label: 'Source Code Pro',
        css: '"Source Code Pro", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Courier New", monospace',
        google: { family: 'Source Code Pro', weights: [400, 500] }
    }
];

const FONT_OPTIONS_MONO = [
    {
        id: 'system-mono',
        label: 'System Mono',
        css: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        google: null
    },
    {
        id: 'jetbrains-mono',
        label: 'JetBrains Mono',
        css: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Courier New", monospace',
        google: { family: 'JetBrains Mono', weights: [400, 500] }
    },
    {
        id: 'source-code-pro',
        label: 'Source Code Pro',
        css: '"Source Code Pro", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Courier New", monospace',
        google: { family: 'Source Code Pro', weights: [400, 500] }
    }
];

function detectFontOption(value, options) {
    if (!value) return options[0];
    const normal = value.replace(/\s+/g, ' ').trim().toLowerCase();
    const exact = options.find(opt => opt.css.replace(/\s+/g, ' ').trim().toLowerCase() === normal);
    if (exact) return exact;
    const primary = value.split(',')[0].replace(/["']/g, '').trim().toLowerCase();
    const fuzzy = options.find(opt => opt.css.split(',')[0].replace(/["']/g, '').trim().toLowerCase() === primary);
    return fuzzy || options[0];
}

function scheduleMeasure() {
    requestAnimationFrame(() => {
        try { window.dispatchEvent(new Event('resize')); } catch {}
    });
}

function setStatus(text) {
    const el = document.getElementById('themeStatus');
    if (el) el.textContent = text || '';
}

function showThemeToast(message) {
    try {
        const prev = document.getElementById('themeToast');
        if (prev && prev.parentElement) prev.parentElement.removeChild(prev);
        const toast = document.createElement('div');
        toast.id = 'themeToast';
        toast.className = 'template-toast';
        toast.textContent = message;
        (document.body || document.documentElement).appendChild(toast);
        toast.addEventListener('animationend', () => {
            if (toast && toast.parentElement) toast.parentElement.removeChild(toast);
        }, { once: true });
    } catch (_) {}
}

function createColorRow(name, value) {
    const wrapper = document.createElement('div');
    wrapper.className = 'theme-color';
    const label = document.createElement('div');
    label.className = 'theme-color-label';
    label.textContent = COLOR_LABELS[name] || name.replace(/^--/, '');
    const swatch = document.createElement('button');
    swatch.className = 'theme-color-swatch';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = value;
    swatch.style.setProperty('--swatch-color', value);
    swatch.addEventListener('click', () => colorInput.click());
    colorInput.className = 'theme-color-input';
    wrapper.appendChild(label);
    wrapper.appendChild(swatch);
    wrapper.appendChild(colorInput);
    return { wrapper, swatch, input: colorInput };
}

function extractMaxWidth(value) {
    if (typeof value !== 'string') return 81;
    const match = value.match(/([0-9]+(?:\.[0-9]+)?)/);
    if (!match) return 81;
    const num = Number(match[1]);
    if (!Number.isFinite(num)) return 81;
    return Math.min(140, Math.max(40, Math.round(num)));
}

function extractLineHeight(value) {
    const num = typeof value === 'number'
        ? value
        : Number.parseFloat(String(value ?? '').replace(/em$/, ''));
    if (!Number.isFinite(num)) return 1.5;
    const clamped = Math.min(2.5, Math.max(1, num));
    return Math.round(clamped * 100) / 100;
}

export async function startThemeApp(shell) {
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent || '');
    let activeTheme = await loadActiveTheme();
    if (!validateTheme(activeTheme)) {
        activeTheme = await getDefaultTheme();
    }
    let draft = createThemeDraft(activeTheme);
    draft.meta = { ...draft.meta, version: 1, source: 'draft' };

    const originalTheme = createThemeDraft(activeTheme);

    const outputEl = document.getElementById('output');
    const inputWrapEl = document.getElementById('inputWrap');
    const caretEl = document.querySelector('.caret');
    const screenEl = document.getElementById('screen');
    const titleEl = document.querySelector('.title');
    const titlebar = document.querySelector('.titlebar');

    const snapshot = {
        outputHTML: outputEl ? outputEl.innerHTML : '',
        inputDisplay: inputWrapEl ? inputWrapEl.style.display : '',
        caretDisplay: caretEl ? caretEl.style.display : '',
        screenPadding: screenEl ? screenEl.style.padding : '',
        titleDisplay: titleEl ? titleEl.style.display : ''
    };

    if (inputWrapEl) inputWrapEl.style.display = 'none';
    if (caretEl) caretEl.style.display = 'none';
    if (outputEl) outputEl.innerHTML = '';

    const root = document.createElement('div');
    root.id = 'themeRoot';
    root.className = 'theme-root';

    const bars = document.createElement('div');
    bars.id = 'themeBars';
    bars.className = 'theme-bars';

    const header = document.createElement('div');
    header.className = 'theme-header soft';
    header.textContent = 'THEME DESIGNER';

    const help = document.createElement('div');
    help.className = 'theme-help muted';
    const saveCombo = isMac ? 'CMD + S' : 'CTRL + S';
    help.textContent = `${saveCombo} to save · Reset to default · ESC to cancel`;

    bars.appendChild(header);
    bars.appendChild(help);

    const panels = document.createElement('div');
    panels.className = 'theme-panels';

    const fontsPanel = document.createElement('section');
    fontsPanel.className = 'theme-panel';
    const fontsTitle = document.createElement('h2');
    fontsTitle.textContent = 'Fonts';
    fontsPanel.appendChild(fontsTitle);

    const monoLabel = document.createElement('label');
    monoLabel.className = 'theme-font-label';
    monoLabel.textContent = 'Mono Font';
    const monoSelect = document.createElement('select');
    monoSelect.className = 'theme-font-select';
    FONT_OPTIONS_MONO.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.id;
        option.textContent = opt.label;
        monoSelect.appendChild(option);
    });
    monoLabel.appendChild(monoSelect);
    fontsPanel.appendChild(monoLabel);

    const monoPreview = document.createElement('pre');
    monoPreview.className = 'theme-font-preview mono';
    monoPreview.textContent = `for (const note of journal) {\n    console.log(note.title);\n}`;
    fontsPanel.appendChild(monoPreview);

    const editorLabel = document.createElement('label');
    editorLabel.className = 'theme-font-label';
    editorLabel.textContent = 'Journal Font';
    const editorSelect = document.createElement('select');
    editorSelect.className = 'theme-font-select';
    FONT_OPTIONS_EDITOR.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.id;
        option.textContent = opt.label;
        editorSelect.appendChild(option);
    });
    editorLabel.appendChild(editorSelect);
    fontsPanel.appendChild(editorLabel);

    const editorPreview = document.createElement('div');
    editorPreview.className = 'theme-font-preview editor';
    editorPreview.innerHTML = `
        <div class="preview-heading">Journal Preview</div>
        <p>The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.</p>
    `;
    fontsPanel.appendChild(editorPreview);

    const writerLabel = document.createElement('label');
    writerLabel.className = 'theme-font-label';
    writerLabel.textContent = 'Writer Font';
    const writerSelect = document.createElement('select');
    writerSelect.className = 'theme-font-select';
    FONT_OPTIONS_EDITOR.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.id;
        option.textContent = opt.label;
        writerSelect.appendChild(option);
    });
    writerLabel.appendChild(writerSelect);
    fontsPanel.appendChild(writerLabel);

    const writerPreview = document.createElement('div');
    writerPreview.className = 'theme-font-preview writer';
    writerPreview.innerHTML = `
        <div class="preview-heading">Writer Preview</div>
        <p>Scenes: The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.</p>
    `;
    fontsPanel.appendChild(writerPreview);

    const uiLabel = document.createElement('label');
    uiLabel.className = 'theme-font-label';
    uiLabel.textContent = 'UI Font';
    const uiSelect = document.createElement('select');
    uiSelect.className = 'theme-font-select';
    FONT_OPTIONS_UI.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.id;
        option.textContent = opt.label;
        uiSelect.appendChild(option);
    });
    uiLabel.appendChild(uiSelect);
    fontsPanel.appendChild(uiLabel);

    const uiPreview = document.createElement('div');
    uiPreview.className = 'theme-font-preview ui';
    uiPreview.innerHTML = `
        <div class="preview-heading">Heading Preview</div>
        <div class="preview-body">The quick brown fox jumps over the lazy dog.</div>
    `;
    fontsPanel.appendChild(uiPreview);

    panels.appendChild(fontsPanel);

    const colorPanels = document.createElement('div');
    colorPanels.className = 'theme-color-panels';
    panels.appendChild(colorPanels);

    const colorInputs = new Map();

    for (const group of VAR_GROUPS) {
        const section = document.createElement('section');
        section.className = 'theme-panel';
        const h2 = document.createElement('h2');
        h2.textContent = group.title;
        section.appendChild(h2);
        const grid = document.createElement('div');
        grid.className = 'theme-color-grid';
        for (const v of group.vars) {
            const current = draft.vars[v] ?? '';
            const hex = extractHexForInput(current, v, draft.vars);
            const { wrapper, swatch, input } = createColorRow(v, hex);
            input.addEventListener('input', () => {
                const newValue = buildValueFromInput(input.value, v);
                draft.vars[v] = newValue;
                swatch.style.setProperty('--swatch-color', input.value);
                dirty = true;
                updateStatus();
                updatePreview();
            });
            grid.appendChild(wrapper);
            colorInputs.set(v, { input, swatch });
        }
        section.appendChild(grid);
        colorPanels.appendChild(section);
    }

    const layoutPanel = document.createElement('section');
    layoutPanel.className = 'theme-panel';
    const layoutTitle = document.createElement('h2');
    layoutTitle.textContent = 'Layout';
    layoutPanel.appendChild(layoutTitle);

    const maxLabel = document.createElement('label');
    maxLabel.className = 'theme-number-label';
    maxLabel.textContent = 'Editor Width (characters)';
    const maxWidthInput = document.createElement('input');
    maxWidthInput.type = 'number';
    maxWidthInput.className = 'theme-number-input';
    maxWidthInput.min = '40';
    maxWidthInput.max = '140';
    maxWidthInput.step = '1';
    maxWidthInput.value = String(extractMaxWidth(draft.vars['--editor-max-width'] ?? '81'));
    maxWidthInput.addEventListener('input', () => {
        const width = extractMaxWidth(maxWidthInput.value + '');
        maxWidthInput.value = String(width);
        draft.vars['--editor-max-width'] = `${width}ch`;
        dirty = true;
        updateStatus();
        updatePreview();
    });
    maxLabel.appendChild(maxWidthInput);
    layoutPanel.appendChild(maxLabel);

    const lineLabel = document.createElement('label');
    lineLabel.className = 'theme-number-label';
    lineLabel.textContent = 'Line Height';
    const lineHeightInput = document.createElement('input');
    lineHeightInput.type = 'number';
    lineHeightInput.className = 'theme-number-input';
    lineHeightInput.min = '1';
    lineHeightInput.max = '2.5';
    lineHeightInput.step = '0.05';
    lineHeightInput.value = extractLineHeight(draft.vars['--editor-line-height'] ?? '1.5').toFixed(2);
    lineHeightInput.addEventListener('input', () => {
        const height = extractLineHeight(lineHeightInput.value + '');
        lineHeightInput.value = height.toFixed(2);
        draft.vars['--editor-line-height'] = String(height);
        dirty = true;
        updateStatus();
        updatePreview();
    });
    lineLabel.appendChild(lineHeightInput);
    layoutPanel.appendChild(lineLabel);

    panels.appendChild(layoutPanel);

    const actions = document.createElement('div');
    actions.className = 'theme-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = 'Save & Close';
    const resetBtn = document.createElement('button');
    resetBtn.className = 'warn';
    resetBtn.textContent = 'Reset';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    actions.appendChild(saveBtn);
    actions.appendChild(resetBtn);
    actions.appendChild(cancelBtn);

    const status = document.createElement('div');
    status.id = 'themeStatus';
    status.className = 'theme-status muted';

    root.appendChild(header);
    root.appendChild(help);
    root.appendChild(panels);
    root.appendChild(status);
    root.appendChild(actions);

    if (titlebar) {
        titlebar.appendChild(bars);
    } else if (screenEl) {
        screenEl.prepend(bars);
    }

    if (outputEl && outputEl.parentElement) {
        outputEl.parentElement.appendChild(root);
    } else if (screenEl) {
        screenEl.appendChild(root);
    } else {
        (document.body || document.documentElement).appendChild(root);
    }

    if (titleEl) {
        titleEl.style.display = 'none';
    }

    shell.setPrompt('theme>');

    function currentFontOptions() {
        const uiOpt = detectFontOption(draft.vars['--font-ui'], FONT_OPTIONS_UI);
        const editorOpt = detectFontOption(draft.vars['--font-editor'], FONT_OPTIONS_EDITOR);
        const writerOpt = detectFontOption(draft.vars['--font-writer'], FONT_OPTIONS_EDITOR);
        const monoOpt = detectFontOption(draft.vars['--font-mono'], FONT_OPTIONS_MONO);
        return { uiOpt, editorOpt, writerOpt, monoOpt };
    }

    function updateFontPreviews() {
        const { uiOpt, editorOpt, writerOpt, monoOpt } = currentFontOptions();
        uiSelect.value = uiOpt.id;
        editorSelect.value = editorOpt.id;
        writerSelect.value = writerOpt.id;
        monoSelect.value = monoOpt.id;
        uiPreview.style.fontFamily = uiOpt.css;
        editorPreview.style.fontFamily = editorOpt.css;
        writerPreview.style.fontFamily = writerOpt.css;
        monoPreview.style.fontFamily = monoOpt.css;
    }

    function updateColorsUI() {
        colorInputs.forEach((widgets, key) => {
            const hex = extractHexForInput(draft.vars[key] ?? '', key, draft.vars);
            widgets.input.value = hex;
            widgets.swatch.style.setProperty('--swatch-color', hex);
        });
    }

    function updateLayoutUI() {
        maxWidthInput.value = String(extractMaxWidth(draft.vars['--editor-max-width'] ?? '81'));
        lineHeightInput.value = extractLineHeight(draft.vars['--editor-line-height'] ?? '1.5').toFixed(2);
    }

    function updatePreview() {
        const { uiOpt, editorOpt, writerOpt, monoOpt } = currentFontOptions();
        draft.vars['--font-ui'] = uiOpt.css;
        draft.vars['--font-editor'] = editorOpt.css;
        draft.vars['--font-writer'] = writerOpt.css;
        draft.vars['--font-mono'] = monoOpt.css;
        applyTheme(draft);
        updateFontPreviews();
        updateLayoutUI();
        scheduleMeasure();
    }

    function updateStatus(message) {
        if (message) {
            setStatus(message);
            return;
        }
        setStatus(dirty ? 'Unsaved changes' : '');
    }

    let dirty = false;

    uiSelect.addEventListener('change', () => {
        const opt = FONT_OPTIONS_UI.find(o => o.id === uiSelect.value) || FONT_OPTIONS_UI[0];
        draft.vars['--font-ui'] = opt.css;
        dirty = true;
        updateStatus();
        updatePreview();
    });

    editorSelect.addEventListener('change', () => {
        const opt = FONT_OPTIONS_EDITOR.find(o => o.id === editorSelect.value) || FONT_OPTIONS_EDITOR[0];
        draft.vars['--font-editor'] = opt.css;
        dirty = true;
        updateStatus();
        updatePreview();
    });

    writerSelect.addEventListener('change', () => {
        const opt = FONT_OPTIONS_EDITOR.find(o => o.id === writerSelect.value) || FONT_OPTIONS_EDITOR[0];
        draft.vars['--font-writer'] = opt.css;
        dirty = true;
        updateStatus();
        updatePreview();
    });

    monoSelect.addEventListener('change', () => {
        const opt = FONT_OPTIONS_MONO.find(o => o.id === monoSelect.value) || FONT_OPTIONS_MONO[0];
        draft.vars['--font-mono'] = opt.css;
        dirty = true;
        updateStatus();
        updatePreview();
    });

    async function handleSave(closeAfter = false) {
        try {
            const saved = await saveActiveTheme({
                name: draft.name || 'Active Theme',
                vars: draft.vars,
                meta: { version: 1, source: 'user', saved_at: new Date().toISOString() }
            });
            activeTheme = saved;
            draft = createThemeDraft(saved);
            dirty = false;
            updateStatus('Theme saved');
            updatePreview();
            updateColorsUI();
            showThemeToast('Theme saved');
            if (closeAfter) {
                shell.exit();
            }
        } catch (err) {
            const msg = err?.message || String(err);
            updateStatus(`Save failed: ${msg}`);
        }
    }

    async function handleReset() {
        const confirmReset = window.confirm('Reset theme to factory defaults?');
        if (!confirmReset) return;
        try {
            const defaults = await getDefaultTheme();
            defaults.name = 'Default';
            defaults.meta = { version: 1, source: 'defaults', reset_at: new Date().toISOString() };
            await saveActiveTheme(defaults);
            activeTheme = defaults;
            draft = createThemeDraft(defaults);
            dirty = false;
            updatePreview();
            updateColorsUI();
            updateStatus('Theme reset to defaults');
            showThemeToast('Theme reset');
        } catch (err) {
            const msg = err?.message || String(err);
            updateStatus(`Reset failed: ${msg}`);
        }
    }

    function handleCancel() {
        const themeToRestore = activeTheme ? activeTheme : originalTheme;
        draft = createThemeDraft(themeToRestore);
        applyTheme(themeToRestore);
        dirty = false;
        shell.exit();
    }

    saveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        handleSave(true);
    });

    resetBtn.addEventListener('click', (e) => {
        e.preventDefault();
        handleReset();
    });

    cancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        handleCancel();
    });

    function onHotkey(e) {
        if ((isMac && e.metaKey || (!isMac && e.ctrlKey)) && (e.key === 's' || e.key === 'S')) {
            e.preventDefault();
            handleSave(false);
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            handleCancel();
        }
    }

    window.addEventListener('keydown', onHotkey, true);

    function cleanup() {
        window.removeEventListener('keydown', onHotkey, true);
        if (bars && bars.parentElement) bars.parentElement.removeChild(bars);
        if (root && root.parentElement) root.parentElement.removeChild(root);
        if (outputEl) outputEl.innerHTML = snapshot.outputHTML;
        if (inputWrapEl) inputWrapEl.style.display = snapshot.inputDisplay;
        if (caretEl) caretEl.style.display = snapshot.caretDisplay;
        if (screenEl) screenEl.style.padding = snapshot.screenPadding;
        if (titleEl) titleEl.style.display = snapshot.titleDisplay ?? '';
        setStatus('');
    }

    const program = {
        consume: async () => { dirty = true; updateStatus(); },
        destroy: cleanup
    };

    shell.enter(program);

    updatePreview();
    updateColorsUI();
    updateLayoutUI();
    updateStatus('');

    return program;
}
