const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { marked } = require('marked');
const puppeteer = require('puppeteer');

const app = express();
const UI_ROOT = path.join(__dirname, '..', '..', 'packages', 'ui');

app.use(express.json({ limit: '10mb' }));

function readPdfCss() {
    const candidates = [
        path.join(__dirname, '..', '..', 'packages', 'ui', 'css', 'pdf.css'),
        path.join(process.cwd(), 'packages', 'ui', 'css', 'pdf.css'),
        path.join(__dirname, 'packages', 'ui', 'css', 'pdf.css'),
    ];
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); } catch (_) {}
    }
    return '';
}

// Heroku / proxies
app.set('trust proxy', 1);

// Export PDF endpoint
app.post('/api/export-pdf', async (req, res) => {
    try {
        const { markdown, title } = req.body || {};
        const cssText = readPdfCss();
        const bodyHtml = marked.parse(String(markdown || ''));
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title ? String(title) : 'Console Journal Export'}</title>
<style>${cssText}</style></head><body><article class="markdown-body">${bodyHtml}</article></body></html>`;

        const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        try {
            const page = await browser.newPage();

            // Verbose diagnostics
            page.on('console', msg => {
                try { console.log('[puppeteer:console]', msg.type(), msg.text()); } catch (_) {}
            });
            page.on('pageerror', err => console.error('[puppeteer:pageerror]', err && err.stack ? err.stack : err));
            page.on('requestfailed', req => console.warn('[puppeteer:requestfailed]', req.url(), req.failure() && req.failure().errorText));

            await page.setContent(html, { waitUntil: 'domcontentloaded' });
            // Ensure fonts/styles fully applied
            try { await page.evaluate(() => document.fonts && document.fonts.ready && document.fonts.ready.then(() => true)); } catch (_) {}
            await new Promise(r => setTimeout(r, 75));
            await page.emulateMediaType('screen');

            const pdf = await page.pdf({
                format: 'A4',
                printBackground: true,
                margin: { top: '18mm', right: '18mm', bottom: '18mm', left: '18mm' }
            });

            const isBuf = Buffer.isBuffer(pdf);
            const len = isBuf ? pdf.length : (pdf && pdf.byteLength) || 0;
            console.log(`[export-pdf] generated: isBuffer=${isBuf} length=${len}`);

            const filename = (title ? String(title) : 'console-journal') + '.pdf';
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            if (isBuf) res.setHeader('Content-Length', String(len));
            return res.end(isBuf ? pdf : Buffer.from(pdf));
        } finally {
            await browser.close();
        }
    } catch (err) {
        console.error('export-pdf error:', err);
        res.status(500).json({ error: (err && err.stack) ? err.stack : String(err && err.message ? err.message : err) });
    }
});

// Static UI
app.use(express.static(UI_ROOT, { maxAge: '1y', immutable: true }));
app.get('*', (_req, res) => res.sendFile(path.join(UI_ROOT, 'index.html')));

// --- HTTPS in dev ---
const CERT_DIR = path.join(__dirname, 'certs');
const CERT_PATH = path.join(CERT_DIR, 'localhost-cert.pem');
const KEY_PATH = path.join(CERT_DIR, 'localhost-key.pem');

const isProd = process.env.NODE_ENV === 'production';
const envWantsHttps = process.env.HTTPS === 'true' || process.env.DEV_HTTPS === '1';
const certsExist = fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH);
const useHttps = !isProd && (envWantsHttps || certsExist);

const PORT = Number(process.env.PORT || (useHttps ? 3443 : 3000));
const HTTP_REDIRECT_PORT = Number(process.env.HTTP_REDIRECT_PORT || 3000);

function start() {
    if (useHttps) {
        // Load certs; if it fails, fall back to HTTP
        try {
            const credentials = {
                cert: fs.readFileSync(CERT_PATH),
                key: fs.readFileSync(KEY_PATH)
            };

            https.createServer(credentials, app).listen(PORT, () => {
                console.log(`Console Journal (web) over HTTPS: https://localhost:${PORT}`);
            });

            // Optional: lightweight HTTP->HTTPS redirect for convenience
            http.createServer((req, res) => {
                const host = req.headers.host ? req.headers.host.replace(/:\d+$/, `:${PORT}`) : `localhost:${PORT}`;
                const url = `https://${host}${req.url}`;
                res.writeHead(301, { Location: url });
                res.end();
            }).listen(HTTP_REDIRECT_PORT, () => {
                console.log(`HTTP redirector listening on http://localhost:${HTTP_REDIRECT_PORT} → HTTPS ${PORT}`);
            });
            return;
        } catch (e) {
            console.warn('[web] HTTPS requested but cert load failed, falling back to HTTP:', e && e.message);
        }
    }

    // Plain HTTP (prod on Heroku or dev fallback)
    http.createServer(app).listen(PORT, () => {
        console.log(`Console Journal (web) over HTTP: http://localhost:${PORT}`);
    });
}

start();