// ── Mobius Local Server (Final Pilot Edition) ──────────────────────────────────
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { exec } = require('child_process');

const PORT        = process.env.PORT || 3000;
const VERCEL_HOST = 'mobius-vercel.vercel.app';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // --- THE PACKING STATION (Customized for Boon's Machine) ---
  if (urlPath === '/api/system/pack' && req.method === 'POST') {
    console.log("▶️ [SERVER] Received Pack request...");
    
    const docDir = path.join(__dirname, 'documents');
    if (!fs.existsSync(docDir)) fs.mkdirSync(docDir);

    const outputPath = path.join(docDir, 'repomix-output.xml');
    
    // We use the exact path found by where.exe npm
    const npxPath = `"C:\\Program Files\\nodejs\\npx.cmd"`;
    
    console.log(`📦 [SERVER] Packing with: ${npxPath}`);

    exec(`${npxPath} --yes repomix --output "${outputPath}" --format xml`, (error) => {
      if (error) {
        console.error(`❌ [SERVER] Repomix Error: ${error.message}`);
        res.writeHead(500);
        return res.end(JSON.stringify({ error: error.message }));
      }
      console.log("✅ [SERVER] Factory Packed Successfully!");
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Factory Packed!', path: 'documents/repomix-output.xml' }));
    });
    return;
  }

  // ── Proxy /api/* to Vercel (Original Logic) ─────────────────────────────
  if (urlPath.startsWith('/api/') || urlPath.startsWith('/auth/') || urlPath === '/ask' || urlPath === '/parse' || urlPath === '/upload') {
    const options = {
      hostname: VERCEL_HOST,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: VERCEL_HOST }
    };
    const proxy = https.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxy.on('error', (err) => {
      res.writeHead(502);
      res.end('Proxy error: ' + err.message);
    });
    req.pipe(proxy);
    return;
  }

  // ── Serve static files (Original Logic) ────────────────────────────────
  let filePath = urlPath;
  if (filePath === '/' || filePath === '') filePath = '/index.html';
  const fullPath = path.join(__dirname, filePath);
  const ext = path.extname(fullPath);
  const mimeType = MIME[ext] || 'text/plain';

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(500); res.end('Server error'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`🚀 Mobius Factory running at http://localhost:${PORT}`);
});