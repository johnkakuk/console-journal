const THEME_STORAGE_KEY = 'theme:active';
const THEME_VERSION = 1;

export const THEME_VAR_WHITELIST = [
    '--bg',
    '--panel',
    '--text',
    '--muted',
    '--error',
    '--warn',
    '--info',
    '--soft',
    '--accent',
    '--app-bg',
    '--app-fg',
    '--console-bg',
    '--console-fg',
    '--editor-bg',
    '--editor-fg',
    '--editor-caret',
    '--editor-selection-bg',
    '--editor-gutter-bg',
    '--border',
    '--font-ui',
    '--font-mono',
    '--font-editor',
    '--base-font-size',
    '--editor-font-size',
    '--editor-line-height',
    '--caret-offset-y'
];

const COLOR_ALPHA = {
    '--editor-selection-bg': 0.25,
    '--border': 0.15
};

const COLOR_FALLBACKS = {
    '--app-bg': '--bg',
    '--app-fg': '--text',
    '--accent': '--text',
    '--soft': '--text',
    '--console-bg': '--bg',
    '--console-fg': '--text',
    '--editor-bg': '--bg',
    '--editor-fg': '--text',
    '--editor-caret': '--text',
    '--editor-selection-bg': '--text',
    '--editor-gutter-bg': '--bg',
    '--border': '--text'
};

const COLOR_VARS = THEME_VAR_WHITELIST.filter(v => !v.startsWith('--font') && !v.endsWith('-size') && !v.endsWith('-line-height') && v !== '--caret-offset-y');

const GOOGLE_FONT_CATALOG = {
    'inter': { family: 'Inter', weights: [400, 600] },
    'ibm plex sans': { family: 'IBM Plex Sans', weights: [400, 600] },
    'rubik': { family: 'Rubik', weights: [400, 500] },
    'roboto': { family: 'Roboto', weights: [400, 500, 700] },
    'open sans': { family: 'Open Sans', weights: [400, 600] },
    'merriweather': { family: 'Merriweather', weights: [400, 700] },
    'lora': { family: 'Lora', weights: [400, 600] },
    'jetbrains mono': { family: 'JetBrains Mono', weights: [400, 500] },
    'fira code': { family: 'Fira Code', weights: [400, 500] },
    'ibm plex mono': { family: 'IBM Plex Mono', weights: [400, 500] },
    'source code pro': { family: 'Source Code Pro', weights: [400, 500] }
};

const STYLE_ID = 'themeStyle';

function cloneDeep(obj) {
    return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

function ensureStyleElement() {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        document.head.appendChild(el);
    }
    return el;
}

function normalizeHex(value) {
    if (typeof value !== 'string') return null;
    let v = value.trim();
    if (/^#[0-9a-f]{3}$/i.test(v)) {
        v = '#' + v.slice(1).split('').map(ch => ch + ch).join('');
    }
    if (/^#[0-9a-f]{6}$/i.test(v)) {
        return v.toLowerCase();
    }
    return null;
}

function rgbaToHex(value) {
    const match = value.match(/rgba?\(([^)]+)\)/i);
    if (!match) return null;
    const parts = match[1].split(',').map(p => p.trim());
    if (parts.length < 3) return null;
    const [r, g, b] = parts.map((n, idx) => idx < 3 ? Math.max(0, Math.min(255, Math.round(Number(n)))) : 0);
    return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
}

function extractAlpha(value) {
    const match = value.match(/rgba?\(([^)]+)\)/i);
    if (!match) return null;
    const parts = match[1].split(',').map(p => p.trim());
    if (parts.length === 4) {
        const a = Number(parts[3]);
        return Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : null;
    }
    return null;
}

function buildColorValue(hex, alpha = null) {
    if (!hex) return null;
    const norm = normalizeHex(hex);
    if (!norm) return null;
    if (alpha == null || Number.isNaN(alpha)) {
        return norm;
    }
    const r = parseInt(norm.slice(1, 3), 16);
    const g = parseInt(norm.slice(3, 5), 16);
    const b = parseInt(norm.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const VAR_REF_RE = /^var\(\s*(--[^\s,)]+)\s*\)/;

function resolveVarValue(value, vars, seen = new Set()) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    const match = trimmed.match(VAR_REF_RE);
    if (match) {
        const ref = match[1];
        if (!vars || seen.has(ref)) return null;
        seen.add(ref);
        return resolveVarValue(vars[ref], vars, seen);
    }
    return trimmed;
}

function sanitizeThemeVars(vars = {}) {
    const out = {};
    for (const key of THEME_VAR_WHITELIST) {
        if (!(key in vars)) continue;
        let value = vars[key];
        if (typeof value !== 'string') continue;
        let trimmed = value.trim();
        if (COLOR_VARS.includes(key)) {
            if (trimmed.startsWith('var(')) {
                out[key] = trimmed;
                continue;
            }
            const alpha = key in COLOR_ALPHA ? COLOR_ALPHA[key] : extractAlpha(trimmed);
            const hex = normalizeHex(trimmed) || rgbaToHex(trimmed);
            if (hex) {
                trimmed = buildColorValue(hex, key in COLOR_ALPHA ? COLOR_ALPHA[key] : alpha);
            } else {
                continue;
            }
        }
        out[key] = trimmed;
    }
    return out;
}

function extractPrimaryFont(value) {
    if (typeof value !== 'string') return null;
    const primary = value.split(',')[0] || '';
    const cleaned = primary.replace(/["']/g, '').trim().toLowerCase();
    if (cleaned.startsWith('var(')) return null;
    return cleaned;
}

function buildFamiliesFromVars(vars) {
    const families = [];
    const uiFont = extractPrimaryFont(vars['--font-ui']);
    const monoFont = extractPrimaryFont(vars['--font-mono']);
    const editorFont = extractPrimaryFont(vars['--font-editor']);
    if (uiFont && GOOGLE_FONT_CATALOG[uiFont]) {
        families.push(GOOGLE_FONT_CATALOG[uiFont]);
    }
    if (monoFont && GOOGLE_FONT_CATALOG[monoFont]) {
        if (!families.some(f => f.family === GOOGLE_FONT_CATALOG[monoFont].family)) {
            families.push(GOOGLE_FONT_CATALOG[monoFont]);
        }
    }
    if (editorFont && GOOGLE_FONT_CATALOG[editorFont]) {
        if (!families.some(f => f.family === GOOGLE_FONT_CATALOG[editorFont].family)) {
            families.push(GOOGLE_FONT_CATALOG[editorFont]);
        }
    }
    return families;
}

export function validateTheme(theme) {
    if (!theme || typeof theme !== 'object') return false;
    if (typeof theme.name !== 'string') return false;
    if (!theme.vars || typeof theme.vars !== 'object') return false;
    if (!theme.meta || typeof theme.meta !== 'object') return false;
    if (theme.meta.version !== THEME_VERSION) return false;
    return true;
}

export function applyTheme(theme) {
    if (!validateTheme(theme)) return;
    const vars = sanitizeThemeVars(theme.vars);
    const lines = Object.entries(vars).map(([k, v]) => `    ${k}: ${v};`);
    const style = ensureStyleElement();
    style.textContent = `:root {\n${lines.join('\n')}\n}`;
    fontLinkManager.update(buildFamiliesFromVars(vars));
}

export function parseDefaultsFromCSS(text) {
    if (typeof text !== 'string') return {};
    const match = text.match(/:root\s*{([^}]+)}/s);
    if (!match) return {};
    const body = match[1];
    const vars = {};
    const regex = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = regex.exec(body))) {
        const key = m[1];
        if (!THEME_VAR_WHITELIST.includes(key)) continue;
        vars[key] = m[2].trim();
    }
    return vars;
}

let defaultThemeCache = null;

export async function getDefaultTheme() {
    if (defaultThemeCache) return cloneDeep(defaultThemeCache);
    try {
        const url = new URL('css/theme.css', window.location.href).href;
        const resp = await fetch(url, { cache: 'no-cache' });
        if (!resp.ok) throw new Error(`Failed to fetch theme.css (${resp.status})`);
        const text = await resp.text();
        const vars = parseDefaultsFromCSS(text);
        defaultThemeCache = {
            name: 'Default',
            vars,
            meta: { version: THEME_VERSION, source: 'defaults' }
        };
        return cloneDeep(defaultThemeCache);
    } catch (err) {
        console.error('getDefaultTheme failed', err);
        return {
            name: 'Default',
            vars: {},
            meta: { version: THEME_VERSION, source: 'defaults', error: err?.message || String(err) }
        };
    }
}

function safeParse(json) {
    try {
        const parsed = JSON.parse(json);
        return validateTheme(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

async function storageGet(key) {
    if (window.settings && typeof window.settings.get === 'function') {
        return await window.settings.get(key);
    }
    if (typeof localStorage !== 'undefined') {
        return localStorage.getItem(key);
    }
    return null;
}

async function storageSet(key, value) {
    if (window.settings && typeof window.settings.set === 'function') {
        await window.settings.set(key, value);
        return;
    }
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, value);
    }
}

export async function loadActiveTheme() {
    const raw = await storageGet(THEME_STORAGE_KEY);
    if (!raw) return null;
    return safeParse(raw);
}

export async function saveActiveTheme(theme) {
    if (!validateTheme(theme)) throw new Error('Invalid theme');
    const payload = {
        name: theme.name,
        vars: sanitizeThemeVars(theme.vars),
        meta: { ...theme.meta, version: THEME_VERSION, saved_at: new Date().toISOString() }
    };
    await storageSet(THEME_STORAGE_KEY, JSON.stringify(payload));
    return payload;
}

export async function ensureActiveTheme() {
    let theme = await loadActiveTheme();
    if (!theme) {
        theme = await getDefaultTheme();
        theme.meta = { version: THEME_VERSION, source: 'defaults', seeded_at: new Date().toISOString() };
        await saveActiveTheme(theme);
    }
    applyTheme(theme);
    return theme;
}

function buildFontQuery(family) {
    if (!family || typeof family.family !== 'string') return null;
    const weights = Array.isArray(family.weights) && family.weights.length ? family.weights : [400];
    const escaped = family.family.replace(/ /g, '+');
    const weightStr = weights.slice().sort((a, b) => a - b).join(';');
    return `family=${escaped}:wght@${weightStr}`;
}

function ensureFontLink() {
    let link = document.getElementById('themeFonts');
    if (!link) {
        link = document.createElement('link');
        link.id = 'themeFonts';
        link.rel = 'stylesheet';
        link.type = 'text/css';
        link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
    }
    return link;
}

function removeFontLink() {
    const link = document.getElementById('themeFonts');
    if (link && link.parentElement) link.parentElement.removeChild(link);
}

export const fontLinkManager = (() => {
    let timer = null;
    let lastHref = '';

    function applyHref(href) {
        if (!href) {
            removeFontLink();
            lastHref = '';
            return;
        }
        const link = ensureFontLink();
        if (lastHref !== href) {
            link.href = href;
            lastHref = href;
        }
    }

    return {
        update(families = []) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                const parts = families
                    .map(buildFontQuery)
                    .filter(Boolean);
                if (!parts.length) {
                    applyHref('');
                    return;
                }
                const href = `https://fonts.googleapis.com/css2?${parts.join('&')}&display=swap`;
                applyHref(href);
            }, 200);
        },
        clear() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            applyHref('');
        }
    };
})();

export function extractHexForInput(value, key, vars = {}) {
    const resolved = resolveVarValue(value, vars);
    const trim = typeof resolved === 'string' ? resolved.trim() : '';
    const hex = normalizeHex(trim) || rgbaToHex(trim);
    if (hex) return hex;
    const fallbackKey = COLOR_FALLBACKS[key];
    if (fallbackKey && fallbackKey !== key) {
        const fallbackValue = vars[fallbackKey];
        if (fallbackValue != null) {
            const fbHex = extractHexForInput(fallbackValue, fallbackKey, vars);
            if (fbHex) return fbHex;
        }
    }
    return COLOR_ALPHA[key] != null ? '#ffffff' : '#000000';
}

export function buildValueFromInput(hex, key) {
    const alpha = COLOR_ALPHA[key];
    return buildColorValue(hex, alpha ?? null);
}

export function createThemeDraft(baseTheme) {
    const theme = validateTheme(baseTheme) ? cloneDeep(baseTheme) : {
        name: 'Draft',
        vars: {},
        meta: { version: THEME_VERSION, source: 'draft' }
    };
    theme.vars = sanitizeThemeVars(theme.vars);
    theme.meta = theme.meta || {};
    theme.meta.version = THEME_VERSION;
    return theme;
}

export const ThemeStorageKey = THEME_STORAGE_KEY;
