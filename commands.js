// ── Mobius Command Registry ───────────────────────────────────────────────────
// Client-side command handlers for colon-prefix commands.
// index.html calls detectCommand(text) and runCommand() to execute commands.
// Single-word commands (no colon) are also recognised.

// ── Model persistence ─────────────────────────────────────────────────────────

// Cloud models + local aliases. 'local' routes to Ollama → WebLLM automatically.
const MODEL_CHAIN = ['groq', 'gemini', 'mistral', 'github', 'web', 'web2', 'web3', 'local', 'qwen', 'deepseek', 'webllm'];

function getLastModel() {
  return localStorage.getItem('mobius_last_model') || 'groq';
}

function setLastModel(model) {
  if (!MODEL_CHAIN.includes(model)) return;
  // 'local' and 'webllm' are always session-only — never the persistent default
  // Default is always groq (cloud). Use Ask: local explicitly for local AI.
  if (model === 'local' || model === 'webllm') return;
  localStorage.setItem('mobius_last_model', model);
}

function nextModelInChain(current) {
  const idx = MODEL_CHAIN.indexOf(current);
  if (idx === -1 || idx === MODEL_CHAIN.length - 1) return null;
  return MODEL_CHAIN[idx + 1];
}

// ── IndexedDB storage for folder handle ──────────────────────────────────────

const DB_NAME  = 'MobiusFS';
const DB_STORE = 'handles';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(DB_STORE);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

async function saveHandle(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(handle, 'rootHandle');
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

async function loadHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get('rootHandle');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

async function clearHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete('rootHandle');
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

// ── Access management ─────────────────────────────────────────────────────────

let rootHandle = null;

async function ensureAccess(output) {
  if (rootHandle) return true;
  try {
    const stored = await loadHandle();
    if (stored) {
      let perm = await stored.queryPermission({ mode: 'read' });
      if (perm !== 'granted') perm = await stored.requestPermission({ mode: 'read' });
      if (perm === 'granted') { rootHandle = stored; return true; }
    }
  } catch { /* fall through */ }
  output('No folder access granted. Running Access...');
  return await handleAccess(output);
}

// ── Date / Time / Location ────────────────────────────────────────────────────

function handleDate(args, output) {
  const now = new Date();
  const str = now.toLocaleDateString('en-AU', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  document.getElementById('input').value = '';
  output('📅 ' + str);
}

function handleTime(args, output) {
  const now = new Date();
  const str = now.toLocaleTimeString('en-AU', { hour:'numeric', minute:'2-digit', hour12:true });
  document.getElementById('input').value = '';
  output('🕐 ' + str);
}

async function handleLocation(args, output) {
  output('📍 Detecting location...');
  try {
    const res  = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    if (data.error) throw new Error(data.reason || 'Unknown error');
    document.getElementById('input').value = '';
    output('📍 ' + data.city + ', ' + data.region + ', ' + data.country_name + ' (' + data.country_code + ')\n🌐 IP: ' + data.ip + '\n🕐 Timezone: ' + data.timezone);
  } catch (err) {
    output('❌ Location unavailable: ' + err.message);
  }
}

// ── Google ────────────────────────────────────────────────────────────────────

async function handleGoogle(args, output) {
  const userId = getAuth('mobius_user_id');
  if (!userId) { output('❌ Not logged in.'); return; }
  output('🔍 Fetching Google account info...');
  try {
    const res  = await fetch('/api/google/info?userId=' + encodeURIComponent(userId));
    const data = await res.json();
    if (data.error) { output('❌ ' + data.error); return; }
    const lines = [
      '🔗 Google Account',
      'Name:  ' + data.name,
      'Email: ' + data.email,
    ];
    output(lines.join('\n'));
  } catch (err) {
    output('❌ Failed to fetch Google info: ' + err.message);
  }
}

// ── Device ────────────────────────────────────────────────────────────────────

async function handleDevice(args, output) {
  const ua  = navigator.userAgent;
  const nav = navigator;
  const lines = ['🖥️  Device Information'];

  let os =
    /Windows NT 10/.test(ua)   ? 'Windows 10/11' :
    /Windows NT 6\.3/.test(ua) ? 'Windows 8.1' :
    /Mac OS X/.test(ua)        ? 'macOS ' + (ua.match(/Mac OS X ([\d_]+)/)?.[1]?.replace(/_/g,'.') || '') :
    /Android/.test(ua)         ? 'Android ' + (ua.match(/Android ([\d.]+)/)?.[1] || '') :
    /iPhone|iPad/.test(ua)     ? 'iOS ' + (ua.match(/OS ([\d_]+)/)?.[1]?.replace(/_/g,'.') || '') :
    /Linux/.test(ua)           ? 'Linux' : 'Unknown';

  let arch = '';
  if (nav.userAgentData) {
    try {
      const hi = await nav.userAgentData.getHighEntropyValues(['architecture','bitness','platformVersion','model']);
      if (hi.architecture) arch = hi.architecture + (hi.bitness ? '-bit' : '');
      if (hi.model)        lines.push('Device model: ' + hi.model);
      if (/Windows/.test(os) && hi.platformVersion) {
        const major = parseInt(hi.platformVersion.split('.')[0]);
        if (major >= 13) os = 'Windows 11';
        else if (major > 0) os = 'Windows 10';
      }
    } catch { /* high entropy not granted */ }
  }
  lines.push('OS: ' + os);
  if (arch) lines.push('Architecture: ' + arch);

  const browser =
    /Edg\//.test(ua)     ? 'Edge '    + (ua.match(/Edg\/([\d.]+)/)?.[1]    || '') :
    /Chrome\//.test(ua)  ? 'Chrome '  + (ua.match(/Chrome\/([\d.]+)/)?.[1]  || '') :
    /Firefox\//.test(ua) ? 'Firefox ' + (ua.match(/Firefox\/([\d.]+)/)?.[1] || '') :
    /Safari\//.test(ua)  ? 'Safari '  + (ua.match(/Version\/([\d.]+)/)?.[1] || '') : 'Unknown';
  lines.push('Browser: ' + browser);

  const isMobile = /Mobi|Android|iPhone|iPad/.test(ua);
  const isTablet = /iPad|Tablet/.test(ua) || (isMobile && Math.min(screen.width, screen.height) > 600);
  lines.push('Device type: ' + (isTablet ? 'Tablet' : isMobile ? 'Mobile' : 'Desktop'));
  lines.push('Screen: ' + screen.width + '\xd7' + screen.height + ' (' + window.devicePixelRatio + '\xd7 DPR)');
  lines.push('Color depth: ' + screen.colorDepth + '-bit');
  lines.push('Orientation: ' + (screen.orientation?.type || 'unknown'));

  if (nav.hardwareConcurrency) lines.push('CPU cores: ' + nav.hardwareConcurrency);
  if (nav.deviceMemory)        lines.push('RAM: ~' + nav.deviceMemory + ' GB');

  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const dbgInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbgInfo) {
        const vendor   = gl.getParameter(dbgInfo.UNMASKED_VENDOR_WEBGL);
        const renderer = gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL);
        if (vendor)   lines.push('GPU vendor: ' + vendor);
        if (renderer) lines.push('GPU: ' + renderer);
      }
    }
  } catch { /* unavailable */ }

  try {
    const est   = await navigator.storage.estimate();
    const used  = (est.usage / 1024 / 1024).toFixed(1);
    const quota = (est.quota / 1024 / 1024 / 1024).toFixed(2);
    lines.push('Storage used: ' + used + ' MB of ~' + quota + ' GB quota');
  } catch { /* unavailable */ }

  const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
  if (conn) {
    if (conn.effectiveType) lines.push('Connection: ' + conn.effectiveType.toUpperCase());
    if (conn.downlink)      lines.push('Bandwidth: ~' + conn.downlink + ' Mbps');
    if (conn.rtt)           lines.push('Latency: ' + conn.rtt + ' ms');
  }

  lines.push('Language: ' + (nav.language || 'unknown'));
  lines.push('Dark mode: ' + (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'Yes' : 'No'));
  lines.push('Online: ' + (nav.onLine ? 'Yes' : 'No'));
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0 || navigator.msMaxTouchPoints > 0;
  lines.push('Touch: ' + (hasTouch ? 'Yes (' + (navigator.maxTouchPoints || navigator.msMaxTouchPoints) + ' points)' : 'No'));

  document.getElementById('input').value = '';
  output(lines.join('\n'));
}

// ── Access ────────────────────────────────────────────────────────────────────

async function handleAccess(output) {
  if (!('showDirectoryPicker' in window)) {
    output('❌ File System Access API not supported. Use Chrome or Edge on desktop/Android.');
    return false;
  }
  try {
    rootHandle = null;
    await clearHandle();
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    rootHandle = handle;
    await saveHandle(handle);
    document.getElementById('input').value = '';
    const entries = [];
    for await (const [name, h] of handle.entries()) {
      entries.push((h.kind === 'directory' ? '📁' : '📄') + ' ' + name);
    }
    entries.sort();
    output('✅ Access granted to: ' + handle.name + '\n\n📁 Contents (' + entries.length + ' items):\n' + entries.join('\n'));
    return true;
  } catch (err) {
    if (err.name !== 'AbortError') output('❌ Access denied: ' + err.message);
    else output('❌ Folder selection cancelled.');
    return false;
  }
}

// ── Find (with Ext:, From:, To: sub-args) ────────────────────────────────────

function parseNaturalDate(str) {
  if (!str) return null;
  const s   = str.trim().toLowerCase();
  const now = new Date();
  if (s === 'today')      { const d = new Date(now); d.setHours(0,0,0,0); return d; }
  if (s === 'yesterday')  { const d = new Date(now); d.setDate(d.getDate()-1); d.setHours(0,0,0,0); return d; }
  if (s === 'last week')  { const d = new Date(now); d.setDate(d.getDate()-7); d.setHours(0,0,0,0); return d; }
  if (s === 'last month') { const d = new Date(now); d.setMonth(d.getMonth()-1); d.setHours(0,0,0,0); return d; }
  if (s === 'last year')  { const d = new Date(now); d.setFullYear(d.getFullYear()-1); d.setHours(0,0,0,0); return d; }
  const parsed = new Date(str);
  return isNaN(parsed) ? null : parsed;
}

function parseFindArgs(raw) {
  const subArgPattern = /\b(Ext|From|To):\s*/gi;
  const parts  = {};
  const tokens = raw.split(subArgPattern);
  parts.name = tokens[0].trim().toLowerCase();
  for (let i = 1; i < tokens.length; i += 2) {
    const key = tokens[i].toLowerCase();
    const val = (tokens[i+1] || '').trim();
    if (key === 'ext')  parts.ext  = val.replace(/^\./, '').toLowerCase();
    if (key === 'from') parts.from = parseNaturalDate(val);
    if (key === 'to')   parts.to   = parseNaturalDate(val);
  }
  if (parts.to) { parts.to = new Date(parts.to); parts.to.setHours(23,59,59,999); }
  return parts;
}

async function handleFind(args, output) {
  if (!await ensureAccess(output)) return;
  if (!args.trim()) { output('Usage: Find: filename [Ext: pdf] [From: last month] [To: today]'); return; }

  const { name, ext, from, to } = parseFindArgs(args);
  if (!name) { output('Usage: Find: filename [Ext: pdf] [From: last month] [To: today]'); return; }

  let desc = 'Searching "' + rootHandle.name + '" for "' + name + '"';
  if (ext)  desc += ' [.' + ext + ']';
  if (from) desc += ' [from ' + from.toLocaleDateString('en-AU') + ']';
  if (to)   desc += ' [to ' + to.toLocaleDateString('en-AU') + ']';
  output('🔍 ' + desc + '...');

  const results = [];
  await searchDirectory(rootHandle, name, ext || null, from || null, to || null, results, '');
  document.getElementById('input').value = '';

  if (results.length === 0) {
    output('No matches found for "' + name + '".');
  } else {
    output('Found ' + results.length + ' result(s):\n' + results.join('\n'));
  }
}

async function searchDirectory(dirHandle, query, ext, from, to, results, path) {
  for await (const [name, handle] of dirHandle.entries()) {
    const fullPath  = path ? path + '/' + name : name;
    const nameLower = name.toLowerCase();

    if (!nameLower.includes(query)) {
      if (handle.kind === 'directory' && results.length < 200) {
        try { await searchDirectory(handle, query, ext, from, to, results, fullPath); } catch { /* skip */ }
      }
      continue;
    }

    if (ext && handle.kind === 'file') {
      const dotIdx  = nameLower.lastIndexOf('.');
      const fileExt = dotIdx !== -1 ? nameLower.slice(dotIdx + 1) : '';
      if (fileExt !== ext) continue;
    }

    if ((from || to) && handle.kind === 'file') {
      try {
        const file     = await handle.getFile();
        const modified = new Date(file.lastModified);
        if (from && modified < from) continue;
        if (to   && modified > to)   continue;
      } catch { /* skip if unreadable */ }
    }

    results.push((handle.kind === 'directory' ? '📁' : '📄') + ' ' + fullPath);

    if (handle.kind === 'directory' && results.length < 200) {
      try { await searchDirectory(handle, query, ext, from, to, results, fullPath); } catch { /* skip */ }
    }
  }
}

// ── List ──────────────────────────────────────────────────────────────────────

async function handleList(args, output) {
  if (!await ensureAccess(output)) return;
  const entries = [];
  for await (const [name, handle] of rootHandle.entries()) {
    entries.push((handle.kind === 'directory' ? '📁' : '📄') + ' ' + name);
  }
  entries.sort();
  document.getElementById('input').value = '';
  output('📁 "' + rootHandle.name + '" (' + entries.length + ' items):\n' + entries.join('\n'));
}

// ── Focus ─────────────────────────────────────────────────────────────────────
// Focus: filename   — search whole Drive, show clickable list, copy chosen file to Mobius folder
// Focus: add text   — append text to the Mobius copy, do NOT send to AI
// Focus: update     — write Mobius copy back to the original file
// Focus: end        — detach file

let focusFile = null; // { id, name, mimeType, content, folderId, originalId }

// Expose for index.html to attach file to mobius_query FILES
window.getFocusFile = () => focusFile;

// Called when user clicks a file in the Focus search results list
window.focusSelectFile = async function(file, folderId, outputEl) {
  const userId = getAuth('mobius_user_id');
  try {
    if (file.inMobius) {
      // Already in Mobius folder — read directly, no copy needed
      outputEl.textContent = '📥 Loading "' + file.name + '"...';
      const res  = await fetch('/api/focus/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, fileId: file.id, mimeType: file.mimeType })
      });
      const data = await res.json();
      if (data.error) { outputEl.textContent = '❌ Read failed: ' + data.error; return; }
      focusFile = { id: file.id, name: file.name, mimeType: file.mimeType, content: data.content, folderId, originalId: null, path: file.path || null };
    } else {
      // Outside Mobius — copy in
      outputEl.textContent = '📋 Copying "' + file.name + '" to Mobius folder...';
      const res  = await fetch('/api/focus/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, fileId: file.id, mimeType: file.mimeType, filename: file.name, folderId })
      });
      const data = await res.json();
      if (data.error) { outputEl.textContent = '❌ Copy failed: ' + data.error; return; }
      focusFile = { id: data.copy.id, name: data.copy.name, mimeType: 'text/plain', content: data.copy.content, folderId, originalId: file.id, path: file.path || null };
    }
    const md = window.markdownToHtml || (t => t.replace(/\n/g, '<br>'));
    outputEl.classList.add('html-content');
    outputEl.innerHTML =
      '🟢 Focused on: <strong>' + focusFile.name + '</strong>' +
      (focusFile.path ? ' — <span style="font-size:12px;color:#8d7c64;">Path: ' + focusFile.path + '</span>' : '') + '<br>' +
      (focusFile.content ? '📝 Current content:<br>' + md(focusFile.content) : '📄 File is empty.') + '<br><br>' +
      'File will be attached to all AI queries this session.<br>' +
      'Use "Focus: add [text]" to append entries.<br>' +
      (focusFile.originalId ? 'Use "Focus: update" to write back to the original.<br>' : '') +
      'Use "Focus: end" to detach.';
  } catch (err) { outputEl.textContent = '❌ ' + err.message; }
};

async function handleFocus(args, output, outputEl) {
  const userId = getAuth('mobius_user_id');
  if (!userId) { output('❌ Not logged in.'); return; }

  const trimmed = args.trim();

  // Focus: end
  if (trimmed.toLowerCase() === 'end') {
    focusFile = null;
    document.getElementById('input').value = '';
    output('🔴 Focus ended. File detached from queries.');
    return;
  }

  // Focus: update — write Mobius copy back to original
  if (trimmed.toLowerCase() === 'update') {
    if (!focusFile) { output('❌ No file in focus.'); return; }
    if (!focusFile.originalId) { output('❌ No original file to update (file was created in Mobius folder).'); return; }
    output('🔄 Updating original file...');
    try {
      const res  = await fetch('/api/focus/update-original', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, originalFileId: focusFile.originalId, content: focusFile.content })
      });
      const data = await res.json();
      if (data.error) { output('❌ Update failed: ' + data.error); return; }
      document.getElementById('input').value = '';
      output('✅ Original file updated successfully.');
    } catch (err) { output('❌ ' + err.message); }
    return;
  }

  // Focus: add [text] — append to Mobius copy in memory, then write full content to Drive
  // Supports: 'add some text' or 'add\nmultiline text'
  if (trimmed.toLowerCase().startsWith('add') && (trimmed.length === 3 || trimmed[3] === ' ' || trimmed[3] === '\n')) {
    if (!focusFile) { output('❌ No file in focus. Use Focus: filename first.'); return; }
    const text = trimmed.slice(3).replace(/^[\s\n]+/, '');
    if (!text) { output('Usage: Focus: add [your text here]'); return; }
    output('💾 Saving to "' + focusFile.name + '"...');
    try {
      // Build updated content in memory first
      const timestamp = new Date().toLocaleString('en-AU');
      const updated = (focusFile.content ? focusFile.content + '\n\n' : '') + '[' + timestamp + ']\n' + text;
      const res = await fetch('/api/focus/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, fileId: focusFile.id, content: updated })
      });
      const data = await res.json();
      if (data.error) { output('❌ Save failed: ' + data.error); return; }
      focusFile.content = updated;
      document.getElementById('input').value = '';
      output('✅ Saved to "' + focusFile.name + '".');
    } catch (err) { output('❌ ' + err.message); }
    return;
  }

  // Focus: filename — search whole Drive
  const filename = trimmed;
  if (!filename) { output('Usage: Focus: filename  |  Focus: add [text]  |  Focus: update  |  Focus: end'); return; }

  output('🔍 Searching Drive for "' + filename + '"...');

  try {
    const findRes  = await fetch('/api/focus/find', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, filename })
    });
    const findData = await findRes.json();
    if (findData.error) { output('❌ ' + findData.error); return; }

    if (findData.files.length === 0) {
      // Not found — create new in Mobius folder
      output('📄 Not found. Creating "' + filename + '.md" in Mobius folder...');
      const createRes  = await fetch('/api/focus/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, filename, folderId: findData.folderId })
      });
      const createData = await createRes.json();
      if (createData.error) { output('❌ ' + createData.error); return; }
      focusFile = { id: createData.file.id, name: createData.file.name, mimeType: 'text/plain', content: '', folderId: findData.folderId, originalId: null };
      document.getElementById('input').value = '';
      if (outputEl) {
        outputEl.classList.add('html-content');
        outputEl.innerHTML = '🟢 Focused on new file: <strong>' + focusFile.name + '</strong><br>📄 File is empty.<br><br>Use "Focus: add [text]" to add content.<br>Use "Focus: end" to detach.';
      }
      return;
    }

    if (findData.files.length === 1) {
      await window.focusSelectFile(findData.files[0], findData.folderId, outputEl);
      document.getElementById('input').value = '';
      return;
    }

    // Multiple matches — show clickable list
    document.getElementById('input').value = '';
    if (outputEl) {
      outputEl.innerHTML = '📋 Found ' + findData.files.length + ' files. Tap to select:<br><br>' +
        findData.files.map((f, i) => {
          const safeId = 'focus-file-' + i;
          const label = f.inMobius ? '📂 ' : '📄 '; // folder icon = already in Mobius
          return '<div id="' + safeId + '" style="cursor:pointer;padding:6px 10px;margin-bottom:4px;background:#ede5d4;border:1px solid #c9bfae;border-radius:1px;" ' +
            'onmouseover="this.style.background=\'#d9cfbc\'" onmouseout="this.style.background=\'#ede5d4\'" ' +
            'onclick="window.focusSelectFile(' + JSON.stringify(f).replace(/"/g, '&quot;') + ', \'' + findData.folderId + '\', document.getElementById(\'' + safeId + '\').closest(\'.mq-block\'))">' +
            label + f.name + (f.path ? ' <span style="font-size:11px;color:#8d7c64;">— Path: ' + f.path + '</span>' : '') + '</div>';
        }).join('');
    }
  } catch (err) { output('❌ ' + err.message); }
}

// ── New Chat ─────────────────────────────────────────────────────────────────

async function handleNew(args, output) {
  if (window.newChat) {
    window.newChat(args);
  } else {
    output('❌ newChat not available.');
  }
}

// ── Code Mode ────────────────────────────────────────────────────────────────

const CODE_EXCLUDE = new Set(['node_modules', '.git', '.vercel', '.aider.tags.cache.v4', 'documents']);
const REPO_EXTS    = new Set(['js', 'html']);

let codeSession = null; // { projectName, mapContent, repoContent, auditContent }

// Expose for index.html to check coding mode
window.getCodeSession = () => codeSession;

// ── Shared: save content to Google Drive Mobius folder ────────────────────────
async function saveToMobiusDrive(userId, filename, content, output) {
  try {
    output('💾 Saving ' + filename + ' to Drive...');
    const res  = await fetch('/api/focus/create-or-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, filename, content })
    });
    const data = await res.json();
    if (data.error) { output('⚠️  Drive save failed: ' + data.error); return false; }
    output('✅ Saved to Drive: ' + filename);
    return true;
  } catch (err) {
    output('⚠️  Drive save failed: ' + err.message);
    return false;
  }
}

// ── Shared: offer download link ───────────────────────────────────────────────
// Left-click: native Save As dialog (Chrome/Edge) or direct download fallback
// Right-click → Save link as: works on all browsers/platforms
function offerDownload(outputEl, filename, content) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.textContent = '⬇️  Save ' + filename;
  link.href        = url;
  link.download    = filename;
  link.title       = 'Save into the documents/ folder of your project  |  Left-click: Save As  |  Right-click: Save link as';
  link.style.cssText = 'display:block; margin-top:8px; color:#4a7c4e; font-weight:bold; cursor:pointer;';

  link.onclick = async e => {
    // Try File System Access API for native folder picker (Chrome/Edge desktop)
    if (window.showSaveFilePicker) {
      e.preventDefault();
      try {
        const ext = filename.split('.').pop();
        // Try to open picker inside the project documents/ subfolder
        let startDir = null;
        if (window.getCodeSession && window.getCodeSession()?.projectHandle) {
          try {
            startDir = await window.getCodeSession().projectHandle.getDirectoryHandle('documents', { create: false });
          } catch { /* documents/ doesn't exist — fall through */ }
        }
        const opts = {
          suggestedName: filename,
          types: [{ description: 'Text file', accept: { 'text/plain': ['.' + ext] } }]
        };
        if (startDir) opts.startIn = startDir;
        const handle = await window.showSaveFilePicker(opts);
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        return;
      } catch (err) {
        if (err.name === 'AbortError') return; // user cancelled
        // Fall through to href/download on other errors
      }
    }
    // Fallback: let the href/download attribute handle it
  };

  // Revoke blob URL after a generous delay
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  outputEl.appendChild(link);
}

// ── Code: scan — static analysis engine (no AI) ────────────────────────────────
async function generateScan(projectHandle, projectName, output) {
  output('🔬 Scanning ' + projectName + ' for issues...');

  const findings = []; // { severity, file, line, code, issue }
  const allFunctions = {}; // fname -> [files] for duplicate detection
  const allExports   = {}; // fname -> file
  const allImports   = new Set(); // all imported names across project

  // Known secret patterns — only flag real tokens/keys
  const SECRET_PATTERNS = [
    /\bsk-[A-Za-z0-9]{20,}\b/,
    /\bAIza[A-Za-z0-9_-]{30,}\b/,
    /\bghp_[A-Za-z0-9]{30,}\b/,
    /\bBearer\s+[A-Za-z0-9_.-]{20,}\b/,
    /['"][a-f0-9]{32,}['"]/,
    /['"][A-Za-z0-9+\/]{40,}={0,2}['"]/
  ];

  function flag(severity, file, lineNum, codeLine, issue) {
    findings.push({ severity, file, line: lineNum, code: codeLine.trim(), issue });
  }

  async function scanFile(handle, relPath) {
    let text = '';
    try { const f = await handle.getFile(); text = await f.text(); } catch { return; }
    const lines = text.split('\n');

    // Track function names for duplicate detection
    const fnPat = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
    const arPat = /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/;
    for (const line of lines) {
      let fm = line.match(fnPat) || line.match(arPat);
      if (fm) {
        const fn = fm[1];
        if (!allFunctions[fn]) allFunctions[fn] = [];
        allFunctions[fn].push(relPath);
      }
    }

    // Track exports
    const expPat = /module\.exports\s*=\s*\{([^}]+)\}/;
    const expMatch = text.match(expPat);
    if (expMatch) {
      expMatch[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean)
        .forEach(name => { allExports[name] = relPath; });
    }

    // Track imports
    const reqPat = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let rm;
    while ((rm = reqPat.exec(text)) !== null) allImports.add(rm[1]);

    // Per-line checks
    let inMultiComment = false;
    let fnStartLine    = -1;
    let fnBraceDepth   = 0;
    let fnLineCount    = 0;
    let currentFn      = '';
    let braceDepth     = 0;

    for (let i = 0; i < lines.length; i++) {
      const line    = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // Track multi-line comments
      if (trimmed.startsWith('/*')) inMultiComment = true;
      if (inMultiComment) { if (trimmed.includes('*/')) inMultiComment = false; continue; }
      if (trimmed.startsWith('//')) continue;

      // console.log left in
      if (/console\.log\(/.test(trimmed)) {
        flag('LOW', relPath, lineNum, trimmed, 'console.log left in production code');
      }

      // TODO/FIXME/HACK comments
      if (/\/\/.*\b(TODO|FIXME|HACK|XXX)\b/i.test(trimmed)) {
        const tag = trimmed.match(/\b(TODO|FIXME|HACK|XXX)\b/i)[1].toUpperCase();
        flag('LOW', relPath, lineNum, trimmed, tag + ' comment unresolved');
      }

      // Hardcoded secrets
      for (const pat of SECRET_PATTERNS) {
        if (pat.test(trimmed) && !/process\.env/.test(trimmed) && !/\/\//.test(trimmed.slice(0, trimmed.search(pat)))) {
          flag('HIGH', relPath, lineNum, trimmed, 'Possible hardcoded secret or token');
          break;
        }
      }

      // await without try/catch — look for bare await not inside a try/catch/finally block
      if (/\bawait\s+\w/.test(trimmed)) {
        let inTry = false;
        let depth = 0;
        for (let j = i; j >= Math.max(0, i - 60); j--) {
          const prev = lines[j].trim();
          depth += (prev.match(/\}/g) || []).length;
          depth -= (prev.match(/\{/g) || []).length;
          // Inside a try, catch, or finally block — already handled
          if (depth < 0 && /\b(try|catch|finally)\b/.test(prev)) { inTry = true; break; }
          if (depth < 0) break;
        }
        // Skip functions designed to throw upward (callers handle errors)
        const throwsUpward = /\b(ask|scan|walk|generate|handle|save|load|fetch|get|read|write|copy|find|create|update|delete|parse)\w*\s*[=(]/.test(
          lines.slice(Math.max(0, i - 60), i).join(' ')
        );
        if (!inTry && !throwsUpward) flag('MED', relPath, lineNum, trimmed, 'await not wrapped in try/catch');
      }

      // Empty catch blocks — only flag truly empty ones, not intentionally commented suppressions
      if (/catch\s*(\(.*\))?\s*\{\s*\}/.test(trimmed)) {
        flag('MED', relPath, lineNum, trimmed, 'Empty catch block — consider logging or handling the error');
      }

      // Route handlers with no auth check (req.body used, no userId/token nearby)
      if (/app\.(post|put|delete|patch)\s*\(/.test(trimmed)) {
        const routeBlock = lines.slice(i, Math.min(i + 20, lines.length)).join('\n');
        if (/req\.body/.test(routeBlock) && !/userId|token|auth|bearer|session/i.test(routeBlock)) {
          flag('MED', relPath, lineNum, trimmed, 'Route modifies data but no auth check found in first 20 lines');
        }
      }

      // [1] fetch() response not checked with res.ok before use
      // Catches: const data = await res.json() without if (!res.ok) check nearby
      if (/\bawait\s+\w+\.json\(\)/.test(trimmed)) {
        // Look back up to 5 lines for a res.ok check
        const nearby = lines.slice(Math.max(0, i - 5), i).join(' ');
        if (!/res\.ok|response\.ok|\.ok\b/.test(nearby)) {
          flag('MED', relPath, lineNum, trimmed, 'res.json() called — check res.ok first to catch HTTP errors (401, 500 etc)');
        }
      }

      // [2] data.error not checked after Mobius API calls
      // Catches fetch to /api/* or /ask where response data.error is not checked nearby
      if (/await fetch\(['"]\/(api|ask|parse)/.test(trimmed)) {
        const block = lines.slice(i, Math.min(i + 8, lines.length)).join(' ');
        if (!/data\.error|result\.error|\.error\b/.test(block)) {
          flag('MED', relPath, lineNum, trimmed, 'Mobius API call — check data.error in response handler');
        }
      }

      // [3] async event handler (onclick/addEventListener) without try/catch
      // Silent failures in browser event handlers are hard to trace
      if (/\.addEventListener\s*\(|onclick\s*=/.test(trimmed) && /async/.test(trimmed)) {
        const block = lines.slice(i, Math.min(i + 15, lines.length)).join(' ');
        if (!/\btry\b/.test(block)) {
          flag('MED', relPath, lineNum, trimmed, 'async event handler without try/catch — failures will be silent');
        }
      }

      // [4] process.env.* used without fallback or validation
      // Catches bare process.env.X used directly in expressions without || or check
      if (/process\.env\.\w+/.test(trimmed)) {
        const envVar = (trimmed.match(/process\.env\.(\w+)/) || [])[1];
        if (envVar && !/\|\||if\s*\(|throw|\?\s/.test(trimmed)) {
          flag('LOW', relPath, lineNum, trimmed, 'process.env.' + envVar + ' used without fallback — will be undefined if key missing');
        }
      }

      // [5] JSON.parse() without try/catch — throws on malformed input
      if (/\bJSON\.parse\s*\(/.test(trimmed)) {
        let inTryJson = false;
        let depthJson = 0;
        for (let j = i; j >= Math.max(0, i - 20); j--) {
          const prev = lines[j].trim();
          depthJson += (prev.match(/\}/g) || []).length;
          depthJson -= (prev.match(/\{/g) || []).length;
          if (depthJson < 0 && /\b(try|catch)\b/.test(prev)) { inTryJson = true; break; }
          if (depthJson < 0) break;
        }
        if (!inTryJson) flag('MED', relPath, lineNum, trimmed, 'JSON.parse() not in try/catch — malformed JSON will throw and crash the handler');
      }

      // Function length tracking
      const isFnStart = /^\s*(?:async\s+)?function\s+\w+|^\s*(?:export\s+)?const\s+\w+\s*=\s*(?:async\s+)?\(/.test(line);
      if (isFnStart) {
        currentFn   = (line.match(/function\s+(\w+)/) || line.match(/const\s+(\w+)/))?.[1] || '?';
        fnStartLine = lineNum;
        fnBraceDepth = braceDepth;
        fnLineCount  = 0;
      }
      if (fnStartLine > -1) {
        fnLineCount++;
        braceDepth += (line.match(/\{/g) || []).length;
        braceDepth -= (line.match(/\}/g) || []).length;
        if (braceDepth <= fnBraceDepth && fnLineCount > 5) {
          if (fnLineCount > 80) flag('MED', relPath, fnStartLine, 'function ' + currentFn, 'Function is ' + fnLineCount + ' lines — consider splitting');
          fnStartLine = -1; fnLineCount = 0;
        }
      } else {
        braceDepth += (line.match(/\{/g) || []).length;
        braceDepth -= (line.match(/\}/g) || []).length;
      }
    }
  }

  async function walkDir(dirHandle, pathPrefix) {
    for await (const [name, handle] of dirHandle.entries()) {
      if (CODE_EXCLUDE.has(name)) continue;
      const relPath = pathPrefix ? pathPrefix + '/' + name : name;
      if (handle.kind === 'directory') { await walkDir(handle, relPath); continue; }
      const ext = name.split('.').pop().toLowerCase();
      if (!REPO_EXTS.has(ext)) continue;
      await scanFile(handle, relPath);
    }
  }

  try {
    await walkDir(projectHandle, '');
  } catch (err) {
    output('❌ Scan error: ' + err.message);
    return null;
  }

  // ── Cross-file check 1: ENV vars in code vs .env.local ─────────────────────
  // Reads .env.local from project root, compares against all process.env.X found in code
  try {
    let envFileHandle = null;
    for await (const [name, handle] of projectHandle.entries()) {
      if (name === '.env.local' && handle.kind === 'file') { envFileHandle = handle; break; }
    }
    if (envFileHandle) {
      const envFile    = await envFileHandle.getFile();
      const envText    = await envFile.text();
      const definedKeys = new Set(
        envText.split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#') && l.includes('='))
          .map(l => l.split('=')[0].trim())
      );
      // Collect all process.env.X references from scanned files
      const usedEnvPat = /process\.env\.(\w+)/g;
      const usedKeys   = new Set();
      async function collectEnvRefs(dirHandle, pathPfx) {
        for await (const [name, handle] of dirHandle.entries()) {
          if (CODE_EXCLUDE.has(name)) continue;
          const rp = pathPfx ? pathPfx + '/' + name : name;
          if (handle.kind === 'directory') { await collectEnvRefs(handle, rp); continue; }
          const ext = name.split('.').pop().toLowerCase();
          if (!REPO_EXTS.has(ext)) continue;
          try {
            const f = await handle.getFile();
            const t = await f.text();
            let m;
            while ((m = usedEnvPat.exec(t)) !== null) usedKeys.add(m[1]);
          } catch { /* skip */ }
        }
      }
      await collectEnvRefs(projectHandle, '');
      for (const key of usedKeys) {
        if (!definedKeys.has(key)) {
          findings.push({ severity: 'HIGH', file: '.env.local', line: '-', code: 'process.env.' + key, issue: 'ENV key "' + key + '" used in code but missing from .env.local — will be undefined in production' });
        }
      }
    } else {
      findings.push({ severity: 'MED', file: '.env.local', line: '-', code: '', issue: '.env.local not found in project root — environment variables cannot be verified' });
    }
  } catch (envErr) {
    findings.push({ severity: 'LOW', file: '.env.local', line: '-', code: '', issue: 'Could not read .env.local: ' + envErr.message });
  }

  // ── Cross-file check 2: require() deps vs package.json ───────────────────────
  // Reads package.json, compares all external require() calls against listed dependencies
  try {
    let pkgHandle = null;
    for await (const [name, handle] of projectHandle.entries()) {
      if (name === 'package.json' && handle.kind === 'file') { pkgHandle = handle; break; }
    }
    if (pkgHandle) {
      const pkgFile = await pkgHandle.getFile();
      const pkgJson = JSON.parse(await pkgFile.text());
      const listed  = new Set([
        ...Object.keys(pkgJson.dependencies      || {}),
        ...Object.keys(pkgJson.devDependencies   || {}),
        ...Object.keys(pkgJson.peerDependencies  || {})
      ]);
      // Check all collected imports (non-relative, non-node-builtin)
      const nodeBuiltins = new Set(['fs','path','os','http','https','url','crypto','events','stream','buffer','util','assert','child_process','process','querystring']);
      for (const dep of allImports) {
        if (dep.startsWith('.') || dep.startsWith('/')) continue; // relative — skip
        const pkgName = dep.startsWith('@') ? dep.split('/').slice(0,2).join('/') : dep.split('/')[0];
        if (nodeBuiltins.has(pkgName)) continue; // node built-in — skip
        if (!listed.has(pkgName)) {
          findings.push({ severity: 'HIGH', file: 'package.json', line: '-', code: 'require(\'' + dep + '\')', issue: 'Package "' + pkgName + '" is used in code but not listed in package.json — will fail on deployment' });
        }
      }
    } else {
      findings.push({ severity: 'MED', file: 'package.json', line: '-', code: '', issue: 'package.json not found — cannot verify dependencies' });
    }
  } catch (pkgErr) {
    findings.push({ severity: 'LOW', file: 'package.json', line: '-', code: '', issue: 'Could not read package.json: ' + pkgErr.message });
  }

  // Cross-file: duplicate function names
  for (const [fname, files] of Object.entries(allFunctions)) {
    if (files.length > 1) {
      findings.push({ severity: 'MED', file: files.join(' + '), line: '-', code: 'function ' + fname, issue: 'Duplicate function name across files' });
    }
  }

  // Sort: HIGH first, then MED, then LOW
  const order = { HIGH: 0, MED: 1, LOW: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return findings;
}

// ── Code: repo — recursive JS/HTML parser ────────────────────────────────────
async function generateRepo(projectHandle, projectName, output, outputEl) {
  output('🔍 Scanning ' + projectName + ' files...');

  const sections = [];

  async function scanDir(dirHandle, pathPrefix) {
    const entries = [];
    for await (const [name, handle] of dirHandle.entries()) {
      entries.push([name, handle]);
    }
    entries.sort((a, b) => a[0].localeCompare(b[0]));

    for (const [name, handle] of entries) {
      if (CODE_EXCLUDE.has(name)) continue; 
      const relPath = pathPrefix ? pathPrefix + '/' + name : name;

      if (handle.kind === 'directory') {
        await scanDir(handle, relPath);
        continue;
      }

      const ext = name.split('.').pop().toLowerCase();
      if (!REPO_EXTS.has(ext)) continue;

      let text = '';
      try {
        const file = await handle.getFile();
        text = await file.text();
      } catch { continue; }

      const lines  = [];
      const seen   = new Set();

      // [F] function declarations: function foo(...)
      const fnDeclPat = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*?)\)/gm;
      let m;
      while ((m = fnDeclPat.exec(text)) !== null) {
        const fname = m[1];
        if (!seen.has('F:' + fname)) {
          seen.add('F:' + fname);
          const pos      = text.lastIndexOf('\n', m.index - 1);
          const prev     = text.lastIndexOf('\n', pos - 1);
          const prevLine = text.slice(prev + 1, pos).trim();
          const comment  = prevLine.startsWith('//') ? ' \u2014 ' + prevLine.slice(2).trim() : '';
          lines.push('[F] ' + fname + '(' + m[2].replace(/\s+/g, ' ').trim() + ')' + comment);
        }
      }

      // [F] arrow functions at start of line: const foo = (async)? (...) =>
      const arrowPat = /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/gm;
      while ((m = arrowPat.exec(text)) !== null) {
        const fname = m[1];
        if (!seen.has('F:' + fname)) {
          seen.add('F:' + fname);
          const pos      = text.lastIndexOf('\n', m.index - 1);
          const prev     = text.lastIndexOf('\n', pos - 1);
          const prevLine = text.slice(prev + 1, pos).trim();
          const comment  = prevLine.startsWith('//') ? ' \u2014 ' + prevLine.slice(2).trim() : '';
          lines.push('[F] ' + fname + '(' + m[2].replace(/\s+/g, ' ').trim() + ')' + comment);
        }
      }

      // [V] process.env references
      const envPat = /process\.env\.([A-Z0-9_]+)/g;
      const envVars = new Set();
      let em;
      while ((em = envPat.exec(text)) !== null) envVars.add(em[1]);
      for (const v of [...envVars].sort()) lines.push('[V] ' + v);

      // [>] require/import — skip template literals and expressions
      const reqPat = /require\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]/g;
      const deps   = new Set();
      let rm;
      while ((rm = reqPat.exec(text)) !== null) {
        const dep = (rm[1] || rm[2] || '').trim();
        if (!dep || dep.startsWith('+') || dep.includes('${') || dep.startsWith('node_modules')) continue;
        deps.add(dep);
      }
      for (const d of [...deps].sort()) lines.push('[>] ' + d);

      // [<] module.exports
      const expPat = /module\.exports\s*=\s*\{([^}]+)\}/;
      const expMatch = expPat.exec(text);
      if (expMatch) {
        const exported = expMatch[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean);
        if (exported.length) lines.push('[<] exports: ' + exported.join(', '));
      }

      // [R] Express routes
      const routePat = /app\.(post|get|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g;
      let route;
      while ((route = routePat.exec(text)) !== null) {
        const rkey = 'R:' + route[1] + route[2];
        if (!seen.has(rkey)) { seen.add(rkey); lines.push('[R] ' + route[1].toUpperCase() + ' ' + route[2]); }
      }

      if (lines.length) {
        sections.push('## ' + relPath + '\n' + lines.join('\n'));
      }
    }
  }

  try {
    await scanDir(projectHandle, '');
  } catch (err) {
    output('❌ Scan error: ' + err.message);
    return null;
  }

  const timestamp  = new Date().toLocaleString('en-AU');
  const legend =
    '# Classifier Legend\n' +
    '# [F] Function        — named function or arrow function\n' +
    '# [V] Env variable    — process.env.* reference\n' +
    '# [>] Import          — require() or import from\n' +
    '# [<] Export          — module.exports entry\n' +
    '# [R] Route           — Express app.get/post/put/delete/patch endpoint\n';
  const repoContent = '# ' + projectName + ' — Code Index\n' +
    '# Generated: ' + timestamp + '\n' +
    legend + '\n' +
    sections.join('\n\n');

  return repoContent;
}

async function handleCode(args, output, outputEl) {
  const trimmed = args.trim();
  const lower   = trimmed.toLowerCase();
  const userId  = getAuth('mobius_user_id');

  // Code: end
  if (lower === 'end') {
    codeSession = null;
    document.getElementById('input').value = '';
    updateCodeBadge();
    output('🔴 Code mode ended.');
    return;
  }

  // Code: show — display loaded context summary
  if (lower === 'show') {
    if (!codeSession) { output('❌ No active code session. Use Code: [projectname] first.'); return; }
    const parts = ['📋 Code session: ' + codeSession.projectName];
    if (codeSession.mapContent)   parts.push('\n── .map ────────────────────\n'   + codeSession.mapContent);
    if (codeSession.repoContent)  parts.push('\n── .repo ───────────────────\n'  + codeSession.repoContent);
    if (codeSession.auditContent) parts.push('\n── .audit ──────────────────\n' + codeSession.auditContent);
    output(parts.join('\n'));
    return;
  }

  // Code: repo — generate .repo file
  if (lower === 'repo') {
    if (!codeSession) { output('❌ No active code session. Use Code: [projectname] first.'); return; }

    // Switch outputEl to append mode
    outputEl.classList.add('html-content');
    outputEl.innerHTML = '';
    const append = msg => {
      const line = document.createElement('div');
      line.textContent = msg;
      outputEl.appendChild(line);
    };

    const repoContent = await generateRepo(codeSession.projectHandle, codeSession.projectName, append, outputEl);
    if (!repoContent) return;
    const repoName = codeSession.projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_') + '.repo';
    codeSession.repoContent = repoContent;
    codeSession.repoGeneratedAt = Date.now();
    const sectionCount = (repoContent.match(/^## /gm) || []).length;
    append('✅ .repo generated — ' + sectionCount + ' files, ' + repoContent.length + ' chars');
    offerDownload(outputEl, repoName, repoContent);
    await saveToMobiusDrive(userId, repoName, repoContent, append);
    document.getElementById('input').value = '';
    return;
  }

  // Code: map — AI-generated project overview from .repo
  if (lower === 'map') {
    if (!codeSession) { output('❌ No active code session. Use Code: [projectname] first.'); return; }

    outputEl.classList.add('html-content');
    outputEl.innerHTML = '';
    const append = msg => { const d = document.createElement('div'); d.textContent = msg; outputEl.appendChild(d); };

    // Check repo freshness — prompt if missing or stale (>5 mins)
    const FIVE_MINS = 5 * 60 * 1000;
    const repoAge   = codeSession.repoGeneratedAt ? (Date.now() - codeSession.repoGeneratedAt) : Infinity;
    const repoStale = !codeSession.repoContent || repoAge > FIVE_MINS;

    if (repoStale) {
      const reason = !codeSession.repoContent ? 'No .repo found in this session.' : '.repo is more than 5 minutes old.';
      const prompt = document.createElement('div');
      prompt.style.cssText = 'margin-bottom:10px; color:#4a3728;';
      prompt.textContent = '⚠️  ' + reason + ' Generate a fresh .repo before mapping?';
      outputEl.appendChild(prompt);

      const yesBtn = document.createElement('button');
      yesBtn.textContent = '✅ Yes — run Code: repo first';
      yesBtn.style.cssText = 'margin-right:8px; padding:4px 12px; background:#4a7c4e; color:#fff; border:none; border-radius:2px; cursor:pointer; font-family:inherit; font-size:13px;';

      const noBtn = document.createElement('button');
      noBtn.textContent = '⏭️ Use existing';
      noBtn.style.cssText = 'padding:4px 12px; background:#8d7c64; color:#fff; border:none; border-radius:2px; cursor:pointer; font-family:inherit; font-size:13px;';

      noBtn.onclick = () => { outputEl.innerHTML = ''; runMap(); };
      yesBtn.onclick = async () => {
        outputEl.innerHTML = '';
        const repoContent = await generateRepo(codeSession.projectHandle, codeSession.projectName, append, outputEl);
        if (!repoContent) return;
        const repoName = codeSession.projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_') + '.repo';
        codeSession.repoContent = repoContent;
        codeSession.repoGeneratedAt = Date.now();
        append('✅ .repo done — ' + repoContent.length + ' chars');
        offerDownload(outputEl, repoName, repoContent);
        await saveToMobiusDrive(userId, repoName, repoContent, append);
        runMap();
      };

      outputEl.appendChild(yesBtn);
      outputEl.appendChild(noBtn);
      document.getElementById('input').value = '';

      // Register Esc handler for global Esc support
      window._escHandler = () => {
        outputEl.innerHTML = '❌ Cancelled.';
        document.getElementById('input').value = '';
      };
      return;
    }

    runMap();

    async function runMap() {
      window._escHandler = null; // clear any pending Esc handler
      if (!codeSession.repoContent) { append('❌ No .repo available. Run Code: repo first.'); return; }
      append('🗺️  Generating map for ' + codeSession.projectName + '...');

      // ── Read README and old .map from project folder (optional context) ──
      let readmeContent = '';
      let oldMapContent = '';
      try {
        const readmeHandle = await codeSession.projectHandle.getFileHandle('README.md', { create: false });
        const readmeFile   = await readmeHandle.getFile();
        readmeContent      = await readmeFile.text();
        append('📄 README.md loaded (' + readmeContent.length + ' chars)');
      } catch { append('ℹ️  No README.md found — skipping.'); }
      try {
        const docsHandle   = await codeSession.projectHandle.getDirectoryHandle('documents', { create: false });
        const mapName      = codeSession.projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_') + '.map';
        const mapHandle    = await docsHandle.getFileHandle(mapName, { create: false });
        const mapFile      = await mapHandle.getFile();
        oldMapContent      = await mapFile.text();
        append('🗺️  Previous .map loaded (' + oldMapContent.length + ' chars)');
      } catch { append('ℹ️  No previous .map found — generating fresh.'); }

      const mapPrompt =
        'You are a senior software architect generating a living project map.\n' +
        'Use British English. Be concise and precise.\n\n' +
        'You have been given three inputs:\n' +
        '1. CODE INDEX (.repo) — the current state of the codebase, auto-generated\n' +
        '2. README — human-facing documentation describing the project\n' +
        '3. PREVIOUS MAP — the last .map file (may be empty if this is the first run)\n\n' +
        'Your task:\n' +
        '- Produce an updated .map that reflects the current codebase\n' +
        '- Preserve and refine design decisions and architecture thinking from the previous .map\n' +
        '- Where the previous .map contains decisions or principles that are still valid, keep them\n' +
        '- Where the code has changed or the previous .map is outdated, update it\n' +
        '- You may respectfully disagree with or refine decisions in the previous .map if the code evidence suggests a better framing\n' +
        '- Use [D] prefix for design decisions and principles, [E] prefix for external facts (URLs, keys, services)\n\n' +
        'Structure your response with these sections (add others if the project warrants it):\n' +
        '# ' + codeSession.projectName + ' — Project Map\n\n' +
        '## Purpose\n## Architecture\n## Key Files\n## Data Flow\n## AI Models\n## External Dependencies\n## Design Principles\n\n' +
        '---\n' +
        '## CODE INDEX (.repo)\n' + codeSession.repoContent + '\n\n' +
        '## README\n' + (readmeContent || '(not found)') + '\n\n' +
        '## PREVIOUS MAP\n' + (oldMapContent || '(none — first run)');

    try {
      const res  = await fetch('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobius_query: { ASK: 'gemini', INSTRUCTIONS: 'Long', HISTORY: [], QUERY: mapPrompt, FILES: [], CONTEXT: 'None' }, userId, session_id: window.getCurrentSessionId ? window.getCurrentSessionId() : null, topic: 'code' })
      });
      const data = await res.json();
      if (data.error) { append('❌ AI error: ' + data.error); return; }
      const mapName = codeSession.projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_') + '.map';
      codeSession.mapContent = data.reply;
      append('✅ .map generated — ' + data.reply.length + ' chars');
      offerDownload(outputEl, mapName, data.reply);
      await saveToMobiusDrive(userId, mapName, data.reply, append);
    } catch (err) { append('❌ ' + err.message); }
    document.getElementById('input').value = '';
    } // end runMap
    return;
  }

  // Code: scan — fast static analysis, no AI
  if (lower === 'scan') {
    if (!codeSession) { output('❌ No active code session. Use Code: [projectname] first.'); return; }

    outputEl.classList.add('html-content');
    outputEl.innerHTML = '';
    const append = msg => { const d = document.createElement('div'); d.textContent = msg; outputEl.appendChild(d); };

    const findings = await generateScan(codeSession.projectHandle, codeSession.projectName, append);
    if (!findings) return;

    document.getElementById('input').value = '';

    if (findings.length === 0) {
      append('✅ No issues found. Code looks clean.');
      return;
    }

    const high = findings.filter(f => f.severity === 'HIGH');
    const med  = findings.filter(f => f.severity === 'MED');
    const low  = findings.filter(f => f.severity === 'LOW');
    append('📊 ' + findings.length + ' issue(s) found — HIGH: ' + high.length + '  MED: ' + med.length + '  LOW: ' + low.length);
    append('');

    for (const f of findings) {
      const icon = f.severity === 'HIGH' ? '🔴' : f.severity === 'MED' ? '🟡' : '⚪';
      append(icon + ' [' + f.severity + '] ' + f.file + ':' + f.line);
      append('   └ ' + f.issue);
      append('   │ ' + f.code.slice(0, 80) + (f.code.length > 80 ? '…' : ''));
      append('');
    }

    // Store scan findings for potential audit escalation
    codeSession.scanFindings = findings;

    // Build plain-text version for download
    const scanText =
      '# ' + codeSession.projectName + ' — Scan Report\n' +
      '# Generated: ' + new Date().toLocaleString('en-AU') + '\n' +
      '# HIGH: ' + high.length + '  MED: ' + med.length + '  LOW: ' + low.length + '\n\n' +
      findings.map(f =>
        '[' + f.severity + '] ' + f.file + ':' + f.line + '\n' +
        '  Issue: ' + f.issue + '\n' +
        '  Code:  ' + f.code
      ).join('\n\n');

    const scanName = codeSession.projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_') + '.scan';
    offerDownload(outputEl, scanName, scanText);

    // Offer AI escalation button
    const btn = document.createElement('button');
    btn.textContent = '🧠 Ask AI about these findings (Code: audit)';
    btn.style.cssText = 'margin-top:6px; padding:6px 14px; background:#4a7c4e; color:#fff; border:none; border-radius:2px; cursor:pointer; font-family:inherit; font-size:13px;';
    btn.onclick = () => {
      document.getElementById('input').value = 'Code: audit';
      document.getElementById('input').focus();
    };
    outputEl.appendChild(btn);
    return;
  }

  // Code: audit new | audit | audit end
  if (lower === 'audit new' || lower === 'audit' || lower === 'audit end') {
    if (!codeSession) { output('❌ No active code session. Use Code: [projectname] first.'); return; }

    outputEl.classList.add('html-content');
    outputEl.innerHTML = '';
    const append = msg => { const d = document.createElement('div'); d.textContent = msg; outputEl.appendChild(d); };
    const appendHtml = html => { const d = document.createElement('div'); d.classList.add('html-content'); d.innerHTML = html; outputEl.appendChild(d); };

    const baseName   = codeSession.projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const auditName  = baseName + '.audit';
    const now        = new Date().toLocaleString('en-AU');

    // ── Helper: parse .audit file into sections ──────────────────────────────
    function parseAuditFile(content) {
      const sections = {};
      const matches = content.split(/^## /m);
      for (const block of matches) {
        const nl = block.indexOf('\n');
        if (nl === -1) continue;
        const key = block.slice(0, nl).trim().toUpperCase();
        sections[key] = block.slice(nl + 1).trim();
      }
      // Parse header fields
      const headerMatch = content.match(/^# .+\n((?:[\s\S]*?))(?=^## )/m);
      if (headerMatch) {
        const header = headerMatch[1];
        sections._started  = (header.match(/started: (.+)/) || [])[1]  || '';
        sections._status   = (header.match(/status: (.+)/)  || [])[1]  || 'in_progress';
        sections._modified = (header.match(/modified: (.+)/) || [])[1] || '';
      }
      return sections;
    }

    // ── Helper: serialise sections back to .audit file ─────────────────────────
    function buildAuditFile(sections, projectName) {
      return [
        '# ' + projectName + ' — Audit',
        '# started: '  + (sections._started  || now),
        '# status: '   + (sections._status   || 'in_progress'),
        '# modified: ' + now,
        '',
        '## REPO',
        sections.REPO || '',
        '',
        '## SCAN',
        sections.SCAN || '',
        '',
        '## AUDITPLAN',
        sections.AUDITPLAN || '(pending)',
        '',
        '## STATUS',
        sections.STATUS || '',
        '',
        '## CHAT',
        sections.CHAT || ''
      ].join('\n');
    }

    // ── Helper: format scan findings as lean text (no code snippets) ─────────────
    function formatScanLean(findings) {
      return findings.map(f => '[' + f.severity + '] ' + f.file + ':' + f.line + ' — ' + f.issue).join('\n');
    }

    // ── Helper: build Gemini prompt from audit sections ──────────────────────
    function buildGeminiContext(sections, instruction) {
      return [
        'You are a senior software engineer conducting a structured code audit.',
        'Use British English. Be concise and precise.',
        '',
        instruction,
        '',
        '## REPO',
        sections.REPO || '',
        '',
        '## SCAN (pending findings only)',
        sections.SCAN || '',
        '',
        '## AUDITPLAN',
        sections.AUDITPLAN || '(not yet generated)',
        '',
        '## STATUS',
        sections.STATUS || '',
        '',
        '## CHAT HISTORY',
        sections.CHAT || '(none yet)'
      ].join('\n');
    }

    // ── CODE: AUDIT END ────────────────────────────────────────────────────
    if (lower === 'audit end') {
      append('📌 Closing audit for ' + codeSession.projectName + '...');
      // Load existing audit file
      let existingContent = codeSession.auditContent || '';
      if (!existingContent) { append('❌ No active audit found.'); return; }
      const sections = parseAuditFile(existingContent);

      // Ask Gemini for final summary
      append('🧠 Asking Gemini for final summary...');
      const prompt = buildGeminiContext(sections,
        'The audit is now complete. Produce a concise final summary covering:\n' +
        '1. What was fixed and in which files\n' +
        '2. What was skipped and why\n' +
        '3. Any remaining risks or recommendations\n' +
        'Keep it brief. This will be saved as the permanent audit record.');
      try {
        const res  = await fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mobius_query: { ASK: 'gemini', INSTRUCTIONS: 'Long', HISTORY: [], QUERY: prompt, FILES: [], CONTEXT: 'None' }, userId, session_id: window.getCurrentSessionId ? window.getCurrentSessionId() : null, topic: 'audit' }) });
        const data = await res.json();
        if (data.error) { append('❌ AI error: ' + data.error); return; }

        sections._status  = 'complete';
        sections.CHAT     = (sections.CHAT ? sections.CHAT + '\n\n' : '') +
          '[' + now + '] AUDIT CLOSED\n' + data.reply;
        sections.AUDITPLAN = sections.AUDITPLAN + '\n\n## FINAL SUMMARY\n' + data.reply;

        const finalContent = buildAuditFile(sections, codeSession.projectName);
        codeSession.auditContent = finalContent;
        await saveToMobiusDrive(userId, auditName, finalContent, append);
        offerDownload(outputEl, auditName, finalContent);
        appendHtml('<div style="margin-top:10px;padding:10px;background:#f5eedd;border:1px solid #c9bfae;border-radius:1px;white-space:pre-wrap;font-size:13px;">' + (window.markdownToHtml ? window.markdownToHtml(data.reply) : data.reply) + '</div>');
        append('✅ Audit closed and saved.');
      } catch (err) { append('❌ ' + err.message); }
      document.getElementById('input').value = '';
      return;
    }

    // ── CODE: AUDIT NEW ───────────────────────────────────────────────────
    if (lower === 'audit new') {
      append('🔹 Starting new audit for ' + codeSession.projectName + '...');

      // Step 1: generate fresh repo
      append('🔍 Generating repo...');
      const repoContent = await generateRepo(codeSession.projectHandle, codeSession.projectName, append, outputEl);
      if (!repoContent) return;
      codeSession.repoContent      = repoContent;
      codeSession.repoGeneratedAt  = Date.now();

      // Step 2: run scan
      append('🔍 Running scan...');
      const findings = await generateScan(codeSession.projectHandle, codeSession.projectName, append);
      if (!findings) return;
      const high = findings.filter(f => f.severity === 'HIGH');
      const med  = findings.filter(f => f.severity === 'MED');
      const low  = findings.filter(f => f.severity === 'LOW');
      append('📊 ' + findings.length + ' findings — HIGH: ' + high.length + '  MED: ' + med.length + '  LOW: ' + low.length);

      const leanScan = formatScanLean(findings);

      // Step 3: ask Gemini for briefing + auditplan
      const thinkingDiv = document.createElement('div');
      thinkingDiv.style.cssText = 'color:#8d7c64;font-style:italic;margin-top:4px;';
      thinkingDiv.textContent = '🧠 Asking Gemini for briefing and audit plan…';
      outputEl.appendChild(thinkingDiv);

      let dots = 0;
      const thinkingTimer = setInterval(() => {
        dots = (dots + 1) % 4;
        thinkingDiv.textContent = '🧠 Asking Gemini for briefing and audit plan' + '.'.repeat(dots) + ' '.repeat(3 - dots);
      }, 600);

      const briefingPrompt =
        'You are a senior software engineer starting a code audit.\n' +
        'Use British English. Be concise and precise.\n\n' +
        'Here is the code index (repo) and the list of scan findings.\n\n' +
        'Produce two things:\n\n' +
        '## BRIEFING\n' +
        'A short summary: what types of issues were found, which files are most affected, ' +
        'any patterns or root causes, and overall risk level.\n\n' +
        '## AUDITPLAN\n' +
        'An ordered fix list. Group by file. For each file list the findings to fix, ' +
        'the recommended approach, and why. Mark each item as [PENDING].\n' +
        'Be specific. One file at a time is the working rule.\n\n' +
        '--- REPO ---\n' + repoContent + '\n\n' +
        '--- SCAN ---\n' + leanScan;

      try {
        const res  = await fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mobius_query: { ASK: 'gemini', INSTRUCTIONS: 'Long', HISTORY: [], QUERY: briefingPrompt, FILES: [], CONTEXT: 'None' }, userId, session_id: window.getCurrentSessionId ? window.getCurrentSessionId() : null, topic: 'audit' }) });
        clearInterval(thinkingTimer);
        thinkingDiv.textContent = '✅ Gemini responded.';
        const data = await res.json();
        if (data.error) { append('❌ AI error: ' + data.error); return; }

        // Parse briefing and auditplan from response
        const briefingMatch   = data.reply.match(/##\s*BRIEFING\s*\n([\s\S]*?)(?=##\s*AUDITPLAN|$)/i);
        const auditplanMatch  = data.reply.match(/##\s*AUDITPLAN\s*\n([\s\S]*)/i);
        const briefingText    = briefingMatch  ? briefingMatch[1].trim()  : data.reply;
        const auditplanText   = auditplanMatch ? auditplanMatch[1].trim() : '(Gemini did not produce a structured plan — review briefing above)';

        // Build initial STATUS block
        const statusText =
          'phase: briefing\n' +
          'started: ' + now + '\n' +
          'last_action: audit new\n' +
          'files_changed: none\n' +
          'deployments: 0\n' +
          'findings_total: ' + findings.length + '\n' +
          'findings_pending: ' + findings.length + '\n' +
          'findings_resolved: 0';

        // Build initial CHAT block
        const chatText = '[' + now + '] AUDIT NEW\nGemini briefing received. Awaiting your approval to proceed.';

        // Assemble and save .audit file
        const sections = {
          _started: now, _status: 'in_progress', _modified: now,
          REPO: repoContent, SCAN: leanScan,
          AUDITPLAN: auditplanText, STATUS: statusText, CHAT: chatText
        };
        const auditContent = buildAuditFile(sections, codeSession.projectName);
        codeSession.auditContent = auditContent;
        await saveToMobiusDrive(userId, auditName, auditContent, append);
        offerDownload(outputEl, auditName, auditContent);

        // Display briefing
        append('');
        append('── GEMINI BRIEFING ─────────────────────────────────');
        appendHtml('<div style="margin-top:6px;padding:10px;background:#f5eedd;border:1px solid #c9bfae;border-radius:1px;font-size:13px;">' + (window.markdownToHtml ? window.markdownToHtml(briefingText) : briefingText) + '</div>');
        append('');
        append('Review the briefing above. When ready, type your response or run Code: audit to continue.');

      } catch (err) { append('❌ ' + err.message); }
      document.getElementById('input').value = '';
      return;
    }

    // ── CODE: AUDIT (resume) ───────────────────────────────────────────────
    // Load .audit from session or Drive
    let auditContent = codeSession.auditContent || null;
    if (!auditContent) {
      append('📥 Loading audit from Drive...');
      try {
        const res  = await fetch('/api/focus/find', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, filename: auditName }) });
        const found = await res.json();
        if (found.files && found.files.length > 0) {
          const readRes  = await fetch('/api/focus/read', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, fileId: found.files[0].id, mimeType: 'text/plain' }) });
          const readData = await readRes.json();
          if (readData.content) { auditContent = readData.content; codeSession.auditContent = auditContent; }
        }
      } catch { /* fall through */ }
    }

    if (!auditContent) {
      append('⚠️  No audit file found. Run Code: audit new to start.');
      document.getElementById('input').value = '';
      return;
    }

    const sections = parseAuditFile(auditContent);

    if (sections._status === 'complete') {
      append('✅ This audit is already marked complete.');
      append('Run Code: audit new to start a fresh audit.');
      document.getElementById('input').value = '';
      return;
    }

    // Re-scan to get current state
    append('🔍 Re-scanning ' + codeSession.projectName + '...');
    const findings = await generateScan(codeSession.projectHandle, codeSession.projectName, append);
    if (!findings) return;
    const high = findings.filter(f => f.severity === 'HIGH');
    const med  = findings.filter(f => f.severity === 'MED');
    const low  = findings.filter(f => f.severity === 'LOW');
    append('📊 Current: ' + findings.length + ' findings — HIGH: ' + high.length + '  MED: ' + med.length + '  LOW: ' + low.length);

    // Update scan section with current pending findings
    sections.SCAN = formatScanLean(findings);

    // Update status
    const prevStatus = sections.STATUS || '';
    const pendingMatch = prevStatus.match(/findings_pending: (\d+)/);
    const resolvedMatch = prevStatus.match(/findings_resolved: (\d+)/);
    const totalMatch = prevStatus.match(/findings_total: (\d+)/);
    const total    = totalMatch   ? parseInt(totalMatch[1])   : findings.length;
    const resolved = totalMatch && resolvedMatch ? (total - findings.length) : 0;
    sections.STATUS = prevStatus
      .replace(/findings_pending: \d+/, 'findings_pending: ' + findings.length)
      .replace(/findings_resolved: \d+/, 'findings_resolved: ' + resolved)
      .replace(/last_action: .+/, 'last_action: audit resume ' + now);

    // Build catch-up prompt for Gemini
    const catchUpPrompt = buildGeminiContext(sections,
      'We are resuming this code audit. The scan has been re-run and the findings above reflect the current state.\n' +
      'Review the auditplan and chat history, then tell me:\n' +
      '1. What has been done since we last worked on this\n' +
      '2. What you intend to do next and why\n' +
      '3. The specific change you recommend for the next file — describe it clearly before I apply anything\n' +
      'Wait for my approval before proceeding.');

    const resumeThinkDiv = document.createElement('div');
    resumeThinkDiv.style.cssText = 'color:#8d7c64;font-style:italic;margin-top:4px;';
    resumeThinkDiv.textContent = '🧠 Asking Gemini to resume…';
    outputEl.appendChild(resumeThinkDiv);
    let rDots = 0;
    const resumeTimer = setInterval(() => {
      rDots = (rDots + 1) % 4;
      resumeThinkDiv.textContent = '🧠 Asking Gemini to resume' + '.'.repeat(rDots) + ' '.repeat(3 - rDots);
    }, 600);
    try {
      const res  = await fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobius_query: { ASK: 'gemini', INSTRUCTIONS: 'Long', HISTORY: [], QUERY: catchUpPrompt, FILES: [], CONTEXT: 'None' }, userId, session_id: window.getCurrentSessionId ? window.getCurrentSessionId() : null, topic: 'audit' }) });
      clearInterval(resumeTimer);
      resumeThinkDiv.textContent = '✅ Gemini responded.';
      const data = await res.json();
      if (data.error) { append('❌ AI error: ' + data.error); return; }

      // Append to chat history
      sections.CHAT = (sections.CHAT ? sections.CHAT + '\n\n' : '') +
        '[' + now + '] RESUMED\n' + data.reply;

      // Save updated .audit
      const updatedContent = buildAuditFile(sections, codeSession.projectName);
      codeSession.auditContent = updatedContent;
      await saveToMobiusDrive(userId, auditName, updatedContent, append);

      // Display Gemini response
      append('');
      append('── GEMINI ───────────────────────────────────────');
      appendHtml('<div style="margin-top:6px;padding:10px;background:#f5eedd;border:1px solid #c9bfae;border-radius:1px;font-size:13px;">' + (window.markdownToHtml ? window.markdownToHtml(data.reply) : data.reply) + '</div>');

      // Input area for response — expose a helper so the main chat can record it
      append('');
      const instrDiv = document.createElement('div');
      instrDiv.style.cssText = 'font-size:12px;color:#8d7c64;margin-top:4px;';
      instrDiv.textContent = 'Type your response in the input box. Your reply will be recorded in the audit chat. Run Code: audit again after applying any fix and deploying.';
      outputEl.appendChild(instrDiv);

      // Expose a function so index.html can append user messages to auditchat
      window._auditAppendUserMessage = async function(userMsg) {
        const s = parseAuditFile(codeSession.auditContent || '');
        s.CHAT = (s.CHAT ? s.CHAT + '\n\n' : '') + '[' + new Date().toLocaleString('en-AU') + '] YOU\n' + userMsg;
        const updated = buildAuditFile(s, codeSession.projectName);
        codeSession.auditContent = updated;
        await saveToMobiusDrive(userId, auditName, updated, () => {});
      };

    } catch (err) { append('❌ ' + err.message); }
    document.getElementById('input').value = '';
    return;
  }

  // Code: all — run repo, map, audit in sequence
  if (lower === 'all') {
    if (!codeSession) { output('❌ No active code session. Use Code: [projectname] first.'); return; }

    outputEl.classList.add('html-content');
    outputEl.innerHTML = '';
    const append = msg => { const d = document.createElement('div'); d.textContent = msg; outputEl.appendChild(d); };
    append('⚙️  Running Code: all for ' + codeSession.projectName + '...');

    // Step 1: repo
    append('\n── Step 1/3: repo ──');
    const repoContent = await generateRepo(codeSession.projectHandle, codeSession.projectName, append, outputEl);
    if (!repoContent) { append('❌ repo failed. Stopping.'); return; }
    const baseName  = codeSession.projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    codeSession.repoContent = repoContent;
    append('✅ .repo done — ' + repoContent.length + ' chars');
    offerDownload(outputEl, baseName + '.repo', repoContent);
    await saveToMobiusDrive(userId, baseName + '.repo', repoContent, append);

    // Step 2: map
    append('\n── Step 2/3: map ──');
    try {
      const mapPrompt = 'You are a senior software architect. Analyse this code index and produce a concise project map.\n\n' +
        '# ' + codeSession.projectName + ' — Project Map\n\n## Purpose\n## Architecture\n## Key Files\n## Data Flow\n## External Dependencies\n## Notes\n\n---\nCODE INDEX:\n' + repoContent;
      const mr = await fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobius_query: { ASK: 'gemini', INSTRUCTIONS: 'Long', HISTORY: [], QUERY: mapPrompt, FILES: [], CONTEXT: 'None' }, userId, session_id: window.getCurrentSessionId ? window.getCurrentSessionId() : null, topic: 'code' }) });
      const md = await mr.json();
      if (md.error) { append('❌ map error: ' + md.error); }
      else {
        codeSession.mapContent = md.reply;
        append('✅ .map done — ' + md.reply.length + ' chars');
        offerDownload(outputEl, baseName + '.map', md.reply);
        await saveToMobiusDrive(userId, baseName + '.map', md.reply, append);
      }
    } catch (err) { append('❌ map: ' + err.message); }

    // Step 3: audit
    append('\n── Step 3/3: audit ──');
    try {
      const auditPrompt = 'You are a senior software engineer conducting a code audit. Analyse this code index and produce a concise audit report.\n\n' +
        '# ' + codeSession.projectName + ' — Audit Report\n\n## Summary\n## Strengths\n## Issues\n## Improvements\n## Security\n## Missing\n\n---\nCODE INDEX:\n' + repoContent;
      const ar = await fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobius_query: { ASK: 'gemini', INSTRUCTIONS: 'Long', HISTORY: [], QUERY: auditPrompt, FILES: [], CONTEXT: 'None' }, userId, session_id: window.getCurrentSessionId ? window.getCurrentSessionId() : null, topic: 'audit' }) });
      const ad = await ar.json();
      if (ad.error) { append('❌ audit error: ' + ad.error); }
      else {
        codeSession.auditContent = ad.reply;
        append('✅ .audit done — ' + ad.reply.length + ' chars');
        offerDownload(outputEl, baseName + '.audit', ad.reply);
        await saveToMobiusDrive(userId, baseName + '.audit', ad.reply, append);
      }
    } catch (err) { append('❌ audit: ' + err.message); }

    append('\n✅ Code: all complete.');
    document.getElementById('input').value = '';
    return;
  }

  // Code: status — snapshot current session state to Drive
  if (lower === 'status') {
    if (!codeSession) { output('❌ No active code session. Use Code: [projectname] first.'); return; }

    outputEl.classList.add('html-content');
    outputEl.innerHTML = '';
    const append = msg => { const d = document.createElement('div'); d.textContent = msg; outputEl.appendChild(d); };
    append('📌 Saving status for ' + codeSession.projectName + '...');

    const now     = new Date().toLocaleString('en-AU');
    const baseName = codeSession.projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const statusContent =
      '# ' + codeSession.projectName + ' — Session Status\n' +
      '# Saved: ' + now + '\n\n' +
      '## Loaded\n' +
      (codeSession.mapContent   ? '✅ .map loaded (' + codeSession.mapContent.length + ' chars)\n'   : '⚠️  .map not loaded\n') +
      (codeSession.repoContent  ? '✅ .repo loaded (' + codeSession.repoContent.length + ' chars)\n' : '⚠️  .repo not loaded\n') +
      (codeSession.auditContent ? '✅ .audit loaded (' + codeSession.auditContent.length + ' chars)\n': '⚠️  .audit not loaded\n') +
      '\n## What was done\n(fill in manually or ask AI to summarise)\n\n' +
      '## What is next\n(fill in manually or ask AI to suggest)\n';

    const statusName = baseName + '.status';
    offerDownload(outputEl, statusName, statusContent);
    await saveToMobiusDrive(userId, statusName, statusContent, append);
    append('✅ Status saved as ' + statusName);
    document.getElementById('input').value = '';
    return;
  }

  // Code: [projectname] — search for matching folders, show selection list
  const projectName = trimmed;
  if (!projectName) {
    output('Usage: Code: [projectname]  |  Code: repo  |  Code: map  |  Code: scan  |  Code: audit new  |  Code: audit  |  Code: audit end  |  Code: all  |  Code: status  |  Code: show  |  Code: end');
    return;
  }

  output('🔍 Select the folder containing "' + projectName + '"...');

  // Always open a fresh picker for Code: — independent of rootHandle
  let pickedHandle;
  try {
    pickedHandle = await window.showDirectoryPicker({ mode: 'read' });
  } catch (err) {
    if (err.name !== 'AbortError') output('❌ Access denied: ' + err.message);
    else output('❌ Cancelled.');
    return;
  }

  const searchLower = projectName.toLowerCase();

  // Case 1: selected folder IS the project
  if (pickedHandle.name.toLowerCase() === searchLower) {
    document.getElementById('input').value = '';
    await codeSelectFolder({ name: pickedHandle.name, relPath: pickedHandle.name, handle: pickedHandle }, projectName, outputEl);
    return;
  }

  // Case 2: search one level deep inside selected folder
  const matches = [];
  for await (const [name, handle] of pickedHandle.entries()) {
    if (handle.kind !== 'directory') continue;
    if (CODE_EXCLUDE.has(name)) continue;
    if (name.toLowerCase().includes(searchLower)) {
      matches.push({ name, relPath: name, handle });
    }
  }

  // Case 3: exact match found — use directly without showing list
  const exact = matches.filter(m => m.name.toLowerCase() === searchLower);
  if (exact.length === 1) {
    document.getElementById('input').value = '';
    await codeSelectFolder(exact[0], projectName, outputEl);
    return;
  }

  document.getElementById('input').value = '';

  // Build selection list
  if (outputEl) {
    outputEl.classList.add('html-content');
    let html = '<div style="font-size:13px;color:#4a3728;margin-bottom:8px;">'
      + '📁 Folders matching "' + projectName + '" — click to select:</div>';

    if (matches.length === 0) {
      html += '<div style="color:#8d7c64;margin-bottom:8px;">No matching folders found.</div>';
    } else {
      matches.forEach((m, i) => {
        const id = 'code-folder-' + i;
        html += '<div id="' + id + '" style="cursor:pointer;padding:6px 10px;margin-bottom:4px;'
          + 'background:#ede5d4;border:1px solid #c9bfae;border-radius:1px;"'
          + ' onmouseover="this.style.background=\'#d9cfbc\'"'
          + ' onmouseout="this.style.background=\'#ede5d4\'"'
          + ' onclick="window.codeSelectFolderByIndex(' + i + ', document.getElementById(\'' + id + '\').closest(\'.mq-block\'))">'    
          + '📁 ' + m.relPath + '</div>';
      });
    }

    // Create new folder option
    html += '<div id="code-create" style="cursor:pointer;padding:6px 10px;margin-bottom:4px;'
      + 'background:#e8f0e8;border:1px solid #4a7c4e;border-radius:1px;color:#4a7c4e;"'
      + ' onmouseover="this.style.background=\'#d4e8d4\'"'
      + ' onmouseout="this.style.background=\'#e8f0e8\'"'
      + ' onclick="window.codeCreateFolder(\'' + projectName + '\', document.getElementById(\'code-create\').closest(\'.mq-block\'))">'    
      + '➕ Create new folder: ' + projectName + '</div>';

    // Cancel option
    html += '<div style="cursor:pointer;padding:6px 10px;margin-bottom:4px;'
      + 'background:#f5eedd;border:1px solid #c9bfae;border-radius:1px;color:#8d7c64;"'
      + ' onmouseover="this.style.background=\'#ede5d4\'"'
      + ' onmouseout="this.style.background=\'#f5eedd\'"'
      + ' onclick="this.closest(\'.mq-block\').innerHTML=\'❌ Cancelled.\'">'    
      + '✕ Cancel</div>';

    outputEl.innerHTML = html;

    // Store matches for click handler
    window._codeFolderMatches = matches;
    window._codeFolderProjectName = projectName;
  }
}

// Internal handler — called directly or from click list
async function codeSelectFolder(m, projectName, outputEl) {
  const userId = getAuth('mobius_user_id');
  if (!m) return;

  outputEl.classList.add('html-content');
  outputEl.innerHTML = '⏳ Loading ' + m.relPath + '...';

  const baseName  = projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const mapName   = baseName + '.map';
  const repoName  = baseName + '.repo';
  const auditName = baseName + '.audit';

  async function findDocFile(dirHandle, filename, depth) {
    if (depth > 2) return null;
    // Check documents/ subfolder first (preferred location)
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'directory' && name.toLowerCase() === 'documents') {
        for await (const [dname, dhandle] of handle.entries()) {
          if (dhandle.kind === 'file' && dname.toLowerCase() === filename) {
            const file = await dhandle.getFile();
            return { content: await file.text(), date: new Date(file.lastModified) };
          }
        }
      }
    }
    // Fallback: check root of project (legacy / stray files)
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'file' && name.toLowerCase() === filename) {
        const file = await handle.getFile();
        return { content: await file.text(), date: new Date(file.lastModified) };
      }
    }
    return null;
  }

  let mapResult, repoResult, auditResult;
  try {
    [mapResult, repoResult, auditResult] = await Promise.all([
      findDocFile(m.handle, mapName,   0),
      findDocFile(m.handle, repoName,  0),
      findDocFile(m.handle, auditName, 0)
    ]);
  } catch (err) {
    outputEl.innerHTML = '❌ Error reading files: ' + err.message;
    return;
  }

  codeSession = {
    projectName,
    projectHandle: m.handle,
    mapContent:    mapResult   ? mapResult.content   : null,
    repoContent:   repoResult  ? repoResult.content  : null,
    auditContent:  auditResult ? auditResult.content : null
  };

  updateCodeBadge();

  const fmt = d => d.toLocaleString('en-AU', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
  const lines = [
    '🟢 Code mode: ' + projectName + ' (' + m.relPath + ')',
    mapResult   ? '✅ ' + mapName   + ' — ' + fmt(mapResult.date)   : '⚠️  ' + mapName   + ' — not found',
    repoResult  ? '✅ ' + repoName  + ' — ' + fmt(repoResult.date)  : '⚠️  ' + repoName  + ' — not found',
    auditResult ? '✅ ' + auditName + ' — ' + fmt(auditResult.date) : '⚠️  ' + auditName + ' — not found',
    '',
    'AI queries use Code mode with project context.',
    'Commands: Code: repo  |  Code: map  |  Code: audit  |  Code: all  |  Code: show  |  Code: end'
  ];
  outputEl.classList.remove('html-content');
  outputEl.textContent = lines.join('\n');
}

// Called when user clicks a folder in the selection list
window.codeSelectFolderByIndex = async function(index, outputEl) {
  await codeSelectFolder(window._codeFolderMatches[index], window._codeFolderProjectName, outputEl);
};

// Called when user clicks Create new folder
window.codeCreateFolder = async function(projectName, outputEl) {
  outputEl.textContent = '📁 To create a new project folder, navigate to your projects directory and create "' + projectName + '" manually, then run Code: ' + projectName + ' again.';
};

function updateCodeBadge() {
  let badge = document.getElementById('codeBadge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'codeBadge';
    badge.style.cssText = 'font-size:12px; color:#fff; background:#4a7c4e; padding:2px 8px; border-radius:2px; margin-left:8px; font-family:inherit;';
    const h1 = document.querySelector('h1');
    if (h1) h1.parentNode.insertBefore(badge, h1.nextSibling);
  }
  if (codeSession) {
    badge.textContent = '⌨ ' + codeSession.projectName;
    badge.style.display = 'inline';
  } else {
    badge.style.display = 'none';
  }
}

// ── Status (self-diagnosis) ─────────────────────────────────────────────────────

async function handleStatus(args, output, outputEl) {
  const isLocal   = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const userId    = getAuth('mobius_user_id');
  const vercelUrl = 'https://mobius-vercel.vercel.app';

  outputEl.classList.add('html-content');
  outputEl.innerHTML = '';

  // ── Render helpers ────────────────────────────────────────────────────────
  function row(icon, label, status, detail) {
    const colour = status === 'ok' ? '#4a7c4e' : status === 'warn' ? '#a06800' : '#8d3a3a';
    const d = document.createElement('div');
    d.style.cssText = 'display:flex; align-items:baseline; gap:8px; padding:3px 0; font-size:13px; border-bottom:1px solid #e2dccd;';
    d.innerHTML =
      '<span style="width:16px;text-align:center;flex-shrink:0;">' + icon + '</span>' +
      '<span style="flex:1;color:#3a2e22;">' + label + '</span>' +
      '<span style="color:' + colour + ';font-weight:bold;flex-shrink:0;">' + detail + '</span>';
    outputEl.appendChild(d);
  }

  function section(title) {
    const d = document.createElement('div');
    d.style.cssText = 'font-size:11px;color:#8d7c64;text-transform:uppercase;letter-spacing:0.08em;margin:10px 0 4px;';
    d.textContent = title;
    outputEl.appendChild(d);
  }

  function header() {
    const d = document.createElement('div');
    d.style.cssText = 'font-weight:bold;font-size:14px;color:#3a2e22;margin-bottom:6px;';
    d.textContent = '⚙️  Mobius Status — ' + new Date().toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    outputEl.appendChild(d);
  }

  function placeholder(label) {
    const d = document.createElement('div');
    d.style.cssText = 'display:flex; align-items:baseline; gap:8px; padding:3px 0; font-size:13px; border-bottom:1px solid #e2dccd; color:#8d7c64; font-style:italic;';
    d.innerHTML = '<span style="width:16px;text-align:center;">⏳</span><span style="flex:1;">' + label + '</span><span>checking…</span>';
    outputEl.appendChild(d);
    return d;
  }

  // ── Check helper: resolves { ok, detail } ────────────────────────────────
  async function ping(url, opts = {}) {
    const start = Date.now();
    try {
      const r = await fetch(url, { method: opts.method || 'GET', signal: AbortSignal.timeout(5000), ...opts.fetchOpts });
      const ms = Date.now() - start;
      return { ok: r.ok || r.status < 500, status: r.status, ms };
    } catch (e) {
      return { ok: false, status: 0, ms: Date.now() - start, err: e.message };
    }
  }

  header();

  // ── 1. Environment ────────────────────────────────────────────────────────
  section('Environment');
  const env    = isLocal ? 'localhost:' + window.location.port : window.location.hostname;
  const envIcon = isLocal ? '🏠' : '☁️';
  row(envIcon, 'Running on', 'ok', env);

  // ── 2. Network checks (all in parallel) ─────────────────────────────────
  section('Connectivity');

  const checks = {};

  // Vercel — always checked
  const pLocal       = placeholder('Local server (localhost:3000)');
  const pVercel      = placeholder('Vercel deployment');
  const pGoogleAuth  = placeholder('Google OAuth');
  const pGoogleInfo  = placeholder('Google APIs');
  const pSupabase    = placeholder('Supabase / Chat History');
  const pOllama      = isLocal ? placeholder('Ollama (local AI)') : null;
  const pSW          = placeholder('Service Worker (PWA)');

  // Fire all async checks
  const tasks = [
    // Local server — only meaningful from localhost
    (async () => {
      if (!isLocal) {
        pLocal.innerHTML = '<span style="width:16px;text-align:center;">—</span><span style="flex:1;color:#8d7c64;">Local server (localhost:3000)</span><span style="color:#8d7c64;">N/A (not on localhost)</span>';
        return;
      }
      const r = await ping('http://localhost:3000/');
      pLocal.innerHTML = '';
      row('🖥️', 'Local server (localhost:3000)', r.ok ? 'ok' : 'err',
        r.ok ? '✅ up (' + r.ms + ' ms)' : '❌ unreachable');
      pLocal.remove();
    })(),

    // Vercel
    (async () => {
      const r = await ping(vercelUrl + '/');
      pVercel.innerHTML = '';
      row('☁️', 'Vercel (' + vercelUrl.replace('https://','') + ')', r.ok ? 'ok' : 'err',
        r.ok ? '✅ up (' + r.ms + ' ms)' : '❌ unreachable (' + (r.err || r.status) + ')');
      pVercel.remove();
    })(),

    // Google OAuth status
    (async () => {
      if (!userId) {
        pGoogleAuth.innerHTML = '<span style="width:16px;">—</span><span style="flex:1;">Google OAuth</span><span style="color:#8d3a3a;">❌ not logged in</span>';
        return;
      }
      const r = await ping('/api/auth/google/status?userId=' + encodeURIComponent(userId));
      let detail = '❌ not connected';
      let status = 'err';
      if (r.ok) {
        try {
          const res  = await fetch('/api/auth/google/status?userId=' + encodeURIComponent(userId), { signal: AbortSignal.timeout(5000) });
          const data = await res.json();
          if (data.connected) { detail = '✅ connected (' + (data.email || 'unknown') + ')'; status = 'ok'; }
          else                 { detail = '⚠️  not connected'; status = 'warn'; }
        } catch { detail = '⚠️  parse error'; status = 'warn'; }
      }
      pGoogleAuth.innerHTML = '';
      row('🔑', 'Google OAuth', status, detail);
      pGoogleAuth.remove();
      // Update header dot silently
      updateGoogleDot(status === 'ok');
    })(),

    // Google API info
    (async () => {
      if (!userId) { pGoogleInfo.innerHTML = '<span style="width:16px;">—</span><span style="flex:1;">Google APIs</span><span style="color:#8d3a3a;">❌ not logged in</span>'; return; }
      try {
        const res  = await fetch('/api/google/info?userId=' + encodeURIComponent(userId), { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        pGoogleInfo.innerHTML = '';
        if (data.email) row('📂', 'Google APIs (Drive/Gmail)', 'ok', '✅ ' + data.email);
        else            row('📂', 'Google APIs (Drive/Gmail)', 'warn', '⚠️  ' + (data.error || 'no account'));
        pGoogleInfo.remove();
      } catch (e) {
        pGoogleInfo.innerHTML = '';
        row('📂', 'Google APIs (Drive/Gmail)', 'err', '❌ ' + e.message);
        pGoogleInfo.remove();
      }
    })(),

    // Supabase via chat-history endpoint
    (async () => {
      if (!userId) { pSupabase.innerHTML = '<span style="width:16px;">—</span><span style="flex:1;">Supabase / Chat History</span><span style="color:#8d3a3a;">❌ not logged in</span>'; return; }
      const r = await ping('/api/chat-history?userId=' + encodeURIComponent(userId));
      pSupabase.innerHTML = '';
      row('🗄️', 'Supabase / Chat History', r.ok ? 'ok' : 'err',
        r.ok ? '✅ reachable (' + r.ms + ' ms)' : '❌ error (status ' + r.status + ')');
      pSupabase.remove();
    })(),

    // Ollama — localhost only
    (async () => {
      if (!isLocal || !pOllama) return;
      try {
        const res  = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
        const data = await res.json();
        const models = (data.models || []).map(m => m.name).join(', ') || 'none';
        pOllama.innerHTML = '';
        row('🧠', 'Ollama (local AI)', 'ok', '✅ running — ' + models);
        pOllama.remove();
      } catch {
        pOllama.innerHTML = '';
        row('🧠', 'Ollama (local AI)', 'warn', '⚠️  not running');
        pOllama.remove();
      }
    })(),

    // Service Worker
    (async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        const active = regs.filter(r => r.active);
        pSW.innerHTML = '';
        row('📦', 'Service Worker (PWA)', active.length ? 'ok' : 'warn',
          active.length ? '✅ active (' + active.length + ')' : '⚠️  not registered');
        pSW.remove();
      } catch {
        pSW.innerHTML = '';
        row('📦', 'Service Worker (PWA)', 'warn', '⚠️  unavailable');
        pSW.remove();
      }
    })()
  ];

  await Promise.allSettled(tasks);

  // ── 3. Session summary ───────────────────────────────────────────────────
  section('Session');
  row('💬', 'Chat history (this session)', 'ok', chatHistory.length / 2 + ' exchange(s)');
  const cs = window.getCodeSession ? window.getCodeSession() : null;
  row('⌨️', 'Code mode', cs ? 'ok' : 'ok', cs ? '✅ ' + cs.projectName : 'off');
  const ff = window.getFocusFile ? window.getFocusFile() : null;
  row('📎', 'Focus file', ff ? 'ok' : 'ok', ff ? '✅ ' + ff.name : 'none');

  document.getElementById('input').value = '';
}

// ── Chat History ──────────────────────────────────────────────────────────────

async function handleChatHistory(args, output) {
  output('Loading chat history...');
  try {
    const userId = localStorage.getItem('mobius_user_id');
    const res    = await fetch('/api/chat-history?userId=' + userId);
    const data   = await res.json();
    if (window.renderChatHistoryList) {
      document.getElementById('input').value = '';
      window.renderChatHistoryList(data.sessions || []);
    } else {
      output('Error: renderChatHistoryList not available.');
    }
  } catch (err) {
    output('Error loading chat history: ' + err.message);
  }
}

// ── Google: connect / disconnect / status ───────────────────────────────────────

async function handleGoogleConnect(args, output, outputEl) {
  const userId = getAuth('mobius_user_id');
  if (!userId) { output('❌ Not logged in.'); return; }

  const trimmed = args.trim().toLowerCase();
  const LABELS  = ['personal', 'family', 'work'];

  // Google: status — show all connected accounts
  if (!trimmed || trimmed === 'status') {
    output('🔍 Checking Google accounts...');
    try {
      const res  = await fetch('/api/google/accounts?userId=' + encodeURIComponent(userId));
      const data = await res.json();
      if (data.error) { output('❌ ' + data.error); return; }
      const lines = ['🔗 Google Accounts'];
      for (const label of LABELS) {
        const acc = (data.accounts || []).find(a => a.label === label);
        lines.push(acc
          ? '✅ ' + label + ' — ' + acc.email
          : '⚪ ' + label + ' — not connected');
      }
      document.getElementById('input').value = '';
      output(lines.join('\n'));
    } catch (err) { output('❌ ' + err.message); }
    return;
  }

  // Google: connect [label]
  if (trimmed.startsWith('connect')) {
    const label = trimmed.replace('connect', '').trim() || 'personal';
    if (!LABELS.includes(label)) {
      output('❌ Unknown label "' + label + '". Use: personal, family, or work.');
      return;
    }
    const returnTo = window.location.origin;
    const url = '/auth/google?userId=' + encodeURIComponent(userId) +
                '&label=' + label +
                '&returnTo=' + encodeURIComponent(returnTo);
    document.getElementById('input').value = '';
    output('🔑 Opening Google sign-in for "' + label + '" account...');
    window.location.href = url;
    return;
  }

  // Google: disconnect [label]
  if (trimmed.startsWith('disconnect')) {
    const label = trimmed.replace('disconnect', '').trim();
    if (!label || !LABELS.includes(label)) {
      output('❌ Specify which account to disconnect: personal, family, or work.');
      return;
    }
    output('🔄 Disconnecting ' + label + '...');
    try {
      const res  = await fetch('/api/google/disconnect', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userId, label })
      });
      const data = await res.json();
      if (data.error) { output('❌ ' + data.error); return; }
      document.getElementById('input').value = '';
      output('✅ ' + label + ' account disconnected.');
    } catch (err) { output('❌ ' + err.message); }
    return;
  }

  output('Usage: Google: status  |  Google: connect [personal|family|work]  |  Google: disconnect [label]');
}

// ── Sync: calendars / emails / drive / dropbox / all / status ─────────────────

async function handleSync(args, output, outputEl) {
  const userId = getAuth('mobius_user_id');
  if (!userId) { output('❌ Not logged in.'); return; }

  const trimmed = args.trim().toLowerCase();

  // Sync: status — show last synced timestamps
  if (!trimmed || trimmed === 'status') {
    output('🔍 Checking sync status...');
    try {
      const res  = await fetch('/api/sync/status?userId=' + encodeURIComponent(userId));
      const data = await res.json();
      if (data.error) { output('❌ ' + data.error); return; }
      const lines = ['🔄 Sync Status'];
      for (const entry of (data.status || [])) {
        const ago = entry.synced_at ? timeSince(new Date(entry.synced_at)) : 'never';
        lines.push('  ' + entry.label + ' / ' + entry.type + ' — ' + ago);
      }
      document.getElementById('input').value = '';
      output(lines.join('\n'));
    } catch (err) { output('❌ ' + err.message); }
    return;
  }

  // Sync: dropbox
  if (trimmed === 'dropbox') {
    await syncDropbox(userId, output);
    document.getElementById('input').value = '';
    return;
  }

  // Sync: all — includes Dropbox
  if (!trimmed || trimmed === 'all') {
    outputEl.classList.add('html-content');
    outputEl.innerHTML = '';
    const append = msg => { const d = document.createElement('div'); d.textContent = msg; outputEl.appendChild(d); };
    append('🔄 Syncing all...');
    try {
      const res  = await fetch('/api/sync', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userId, type: 'all' })
      });
      const data = await res.json();
      if (data.error) { append('❌ ' + data.error); return; }
      const r = data.result || {};
      append('✅ Sync complete:');
      append('  📅 Calendars — ' + (r.calendars?.ok ? r.calendars.events + ' entries' : '❌ ' + r.calendars?.error));
      append('  📧 Emails    — ' + (r.emails?.ok    ? r.emails.messages  + ' entries' : '❌ ' + r.emails?.error));
      append('  📁 Drive     — ' + (r.drive?.ok     ? r.drive.files      + ' entries' : '❌ ' + r.drive?.error));
    } catch (err) { append('❌ ' + err.message); }
    // Also sync Dropbox
    await syncDropbox(userId, msg => { const d = document.createElement('div'); d.textContent = msg; outputEl.appendChild(d); });
    document.getElementById('input').value = '';
    return;
  }

  // Sync: calendars | emails | drive
  const validTypes = ['calendars', 'emails', 'drive'];
  const type = validTypes.includes(trimmed) ? trimmed : null;
  if (!type) { output('Usage: Sync: all | calendars | emails | drive | dropbox | status'); return; }

  outputEl.classList.add('html-content');
  outputEl.innerHTML = '';
  const append = msg => {
    const d = document.createElement('div');
    d.textContent = msg;
    outputEl.appendChild(d);
  };

  append('🔄 Syncing ' + type + '...');
  try {
    const res  = await fetch('/api/sync', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId, type })
    });
    const data = await res.json();
    if (data.error) { append('❌ ' + data.error); return; }

    if (type === 'all') {
      const r = data.result || {};
      append('✅ Sync complete:');
      append('  📅 Calendars — ' + (r.calendars?.ok ? r.calendars.events + ' entries' : '❌ ' + r.calendars?.error));
      append('  📧 Emails    — ' + (r.emails?.ok    ? r.emails.messages  + ' entries' : '❌ ' + r.emails?.error));
      append('  📁 Drive     — ' + (r.drive?.ok     ? r.drive.files      + ' entries' : '❌ ' + r.drive?.error));
    } else {
      append('✅ ' + type + ' synced.');
    }
    document.getElementById('input').value = '';
  } catch (err) { append('❌ ' + err.message); }
}

// ── Dropbox ───────────────────────────────────────────────────────────────────

async function syncDropbox(userId, output) {
  output('🔄 Syncing Dropbox...');
  try {
    const res  = await fetch('/api/dropbox', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId })
    });
    const data = await res.json();
    if (data.error) { output('❌ Dropbox: ' + data.error); return; }
    output('  📦 Dropbox  — ' + data.files + ' files indexed.');
  } catch (err) { output('❌ Dropbox: ' + err.message); }
}

async function handleDropbox(args, output) {
  const userId = getAuth('mobius_user_id');
  if (!userId) { output('❌ Not logged in.'); return; }
  const trimmed = (args || '').trim().toLowerCase();

  // Dropbox: connect
  if (!trimmed || trimmed === 'connect') {
    const returnTo = window.location.origin;
    const url = '/auth/dropbox?service=dropbox&action=index&userId=' + encodeURIComponent(userId) +
                '&returnTo=' + encodeURIComponent(returnTo);
    document.getElementById('input').value = '';
    output('🔑 Opening Dropbox sign-in...');
    window.location.href = url;
    return;
  }

  // Dropbox: sync
  if (trimmed === 'sync') {
    await syncDropbox(userId, output);
    document.getElementById('input').value = '';
    return;
  }

  // Dropbox: list [optional/path]
  if (trimmed === 'list' || trimmed.startsWith('list ')) {
    const path = trimmed.slice(4).trim() || '';
    output('📋 Listing Dropbox' + (path ? ': ' + path : ' root') + '...');
    try {
      const res  = await fetch('/api/dropbox/list', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userId, path })
      });
      const data = await res.json();
      if (data.error) { output('❌ ' + data.error); return; }
      const lines = (data.entries || []).map(e => (e.type === 'folder' ? '📁' : '📄') + ' ' + e.name);
      document.getElementById('input').value = '';
      output(lines.length ? lines.join('\n') : '(empty)');
    } catch (err) { output('❌ ' + err.message); }
    return;
  }

  output('Usage: Dropbox: connect | sync | list [path]');
}

// Helper — human-readable time since a date
function timeSince(date) {
  const secs = Math.floor((Date.now() - date) / 1000);
  if (secs < 60)    return secs + 's ago';
  if (secs < 3600)  return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
}

// ── Command registry ──────────────────────────────────────────────────────────

const COMMANDS = {
  'date':     { requiresAccess: false, isAI: false, handler: handleDate },
  'time':     { requiresAccess: false, isAI: false, handler: handleTime },
  'location': { requiresAccess: false, isAI: false, handler: handleLocation },
  'device':   { requiresAccess: false, isAI: false, handler: handleDevice },
  'google':   { requiresAccess: false, isAI: false, handler: handleGoogleConnect },
  'sync':     { requiresAccess: false, isAI: false, handler: handleSync },
  'dropbox':  { requiresAccess: false, isAI: false, handler: handleDropbox },
  'access':   { requiresAccess: false, isAI: false, handler: function(args, out) { return handleAccess(out); } },
  'find':     { requiresAccess: true,  isAI: false, handler: handleFind },
  'list':     { requiresAccess: true,  isAI: false, handler: handleList },
  'history':  { requiresAccess: false, isAI: false, handler: handleChatHistory },
  'status':   { requiresAccess: false, isAI: false, handler: handleStatus },
  'new':      { requiresAccess: false, isAI: false, handler: handleNew },
  'focus':    { requiresAccess: false, isAI: false, handler: handleFocus },
  'code':     { requiresAccess: false, isAI: false, handler: handleCode },
  'ask':      { requiresAccess: false, isAI: true }
};

// Commands that work as a single word with no colon needed
const SINGLE_WORD_COMMANDS = new Set(['date','time','location','device','access','list','history','google','status']);

// ── Public API (called by index.html) ─────────────────────────────────────────

function detectCommand(text) {
  const trimmed = text.trim();
  const lower   = trimmed.toLowerCase();

  // Single-word shortcut — no whitespace, no colon required
  if (SINGLE_WORD_COMMANDS.has(lower) && !/\s/.test(trimmed)) {
    return { command: lower, args: '' };
  }

  // Standard colon-prefix
  const match = trimmed.match(/^(\w+):\s*([\s\S]*)/);
  if (!match) return null;
  const command = match[1].toLowerCase();
  if (!COMMANDS[command]) return null;
  return { command, args: match[2].trim() };
}

async function runCommand(command, args, outputFn, outputEl) {
  const cmd = COMMANDS[command];
  if (!cmd || cmd.isAI) return false;
  await cmd.handler(args, outputFn, outputEl);
  return true;
}

// Returns the model for the current Ask and updates saved default if explicit.
// 'local' is an alias for 'webllm'.
function getAskModel(text) {
  const match = text.match(/^Ask:\s*(\w+)/i);
  if (match) {
    const model    = match[1].toLowerCase();
    const isMobile = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent);
    const resolved = model === 'local' ? (isMobile ? 'webllm' : 'local') : model;
    if (MODEL_CHAIN.includes(resolved)) {
      setLastModel(resolved);
      return resolved;
    }
  }
  return getLastModel();
}

// ── Mobius Self-Awareness System ──────────────────────────────────────────────
// mobius.json lives in Google Drive Mobius folder.
// Commands: Mobius? | Mobius: | Remember: | Forget: | Amend: | Review:
// Pulse checks: Google? | Dropbox? | Code? | Focus? | Sync?

const MOBIUS_FILENAME = 'mobius.json';

// Session state for ? pulse commands
let mobiusSession = {
  startedAt:    Date.now(),
  flags:        [],           // ⚠️ moments captured during session
  googleState:  { accounts: [], lastSync: null },
  dropboxState: { connected: false, lastSync: null, fileCount: null },
  syncState:    { lastSync: null, services: {} }
};

// Expose so post-processor can add flags
window.addSessionFlag = function(flag) {
  mobiusSession.flags.push({ time: new Date().toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit' }), msg: flag });
};

// ── Shared: load mobius.json from Drive ───────────────────────────────────────
async function loadMobiusJson(userId) {
  try {
    const res  = await fetch('/api/focus/find', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId, filename: MOBIUS_FILENAME })
    });
    const found = await res.json();
    if (!found.files || found.files.length === 0) return null;
    const readRes  = await fetch('/api/focus/read', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId, fileId: found.files[0].id, mimeType: 'text/plain' })
    });
    const readData = await readRes.json();
    if (readData.error || !readData.content) return null;
    return { data: JSON.parse(readData.content), fileId: found.files[0].id, folderId: found.folderId };
  } catch { return null; }
}

// ── Shared: save mobius.json to Drive ─────────────────────────────────────────
async function saveMobiusJson(userId, data, output) {
  data.updated = new Date().toISOString().slice(0, 10);
  data.session_flags = [];
  await saveToMobiusDrive(userId, MOBIUS_FILENAME, JSON.stringify(data, null, 2), output);
}

// ── Shared: flatten all list entries with global numbering ────────────────────
// Returns [ { section, key, index, text }, ... ] in display order
function flattenMobius(data) {
  const ORDER = ['preferences', 'rules', 'routing_rules', 'corrections', 'do_not'];
  const items = [];
  for (const key of ORDER) {
    const arr = data[key];
    if (!Array.isArray(arr)) continue;
    arr.forEach((text, i) => items.push({ section: key, localIndex: i, text }));
  }
  return items;
}

// ── Shared: section display label ────────────────────────────────────────────
function sectionLabel(key) {
  return {
    preferences:   'PREFERENCES',
    rules:         'RULES',
    routing_rules: 'ROUTING RULES',
    corrections:   'CORRECTIONS',
    do_not:        'DO NOT'
  }[key] || key.toUpperCase();
}

// ── Shared: render a page of items ───────────────────────────────────────────
function renderItemPage(outputEl, items, startIdx, pageSize, title, showButtons) {
  outputEl.classList.add('html-content');
  outputEl.innerHTML = '';

  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-weight:bold;font-size:14px;color:#3a2e22;margin-bottom:8px;';
  hdr.textContent = title;
  outputEl.appendChild(hdr);

  const endIdx   = Math.min(startIdx + pageSize, items.length);
  let   lastSect = null;

  for (let i = startIdx; i < endIdx; i++) {
    const item = items[i];
    if (item.section !== lastSect) {
      const sh = document.createElement('div');
      sh.style.cssText = 'font-size:11px;color:#8d7c64;text-transform:uppercase;letter-spacing:0.08em;margin:10px 0 4px;border-top:1px solid #c9bfae;padding-top:6px;';
      sh.textContent = sectionLabel(item.section);
      outputEl.appendChild(sh);
      lastSect = item.section;
    }
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:4px 0;border-bottom:1px solid #ede5d4;font-size:13px;';
    const num = document.createElement('span');
    num.style.cssText = 'color:#8d7c64;flex-shrink:0;width:24px;text-align:right;';
    num.textContent = (i + 1) + '.';
    const txt = document.createElement('span');
    txt.style.cssText = 'flex:1;color:#3a2e22;';
    txt.textContent = item.text;
    row.appendChild(num);
    row.appendChild(txt);
    if (showButtons) {
      const forgetBtn = document.createElement('button');
      forgetBtn.textContent = '✕';
      forgetBtn.title = 'Forget this rule';
      forgetBtn.style.cssText = 'background:transparent;border:none;color:#8d7c64;cursor:pointer;font-size:13px;padding:0 4px;flex-shrink:0;';
      forgetBtn.onclick = () => { document.getElementById('input').value = 'Forget: ' + (i + 1); document.getElementById('input').focus(); };
      const amendBtn = document.createElement('button');
      amendBtn.textContent = '✏️';
      amendBtn.title = 'Amend this rule';
      amendBtn.style.cssText = 'background:transparent;border:none;cursor:pointer;font-size:13px;padding:0 4px;flex-shrink:0;';
      amendBtn.onclick = () => { document.getElementById('input').value = 'Amend: ' + (i + 1) + ' ' + item.text; document.getElementById('input').focus(); };
      row.appendChild(amendBtn);
      row.appendChild(forgetBtn);
    }
    outputEl.appendChild(row);
  }

  // Pagination
  if (items.length > pageSize) {
    const pg = document.createElement('div');
    pg.style.cssText = 'font-size:12px;color:#8d7c64;margin-top:10px;display:flex;gap:8px;align-items:center;';
    const pageNum  = Math.floor(startIdx / pageSize) + 1;
    const totalPgs = Math.ceil(items.length / pageSize);
    pg.textContent = 'Page ' + pageNum + ' of ' + totalPgs + '   ';
    if (startIdx > 0) {
      const prev = document.createElement('button');
      prev.textContent = '◀ Prev';
      prev.style.cssText = 'font-size:12px;padding:2px 8px;background:#8d7c64;color:#fff;border:none;border-radius:1px;cursor:pointer;font-family:inherit;';
      prev.onclick = () => renderItemPage(outputEl, items, startIdx - pageSize, pageSize, title, showButtons);
      pg.appendChild(prev);
    }
    if (endIdx < items.length) {
      const next = document.createElement('button');
      next.textContent = 'Next ▶';
      next.style.cssText = 'font-size:12px;padding:2px 8px;background:#8d7c64;color:#fff;border:none;border-radius:1px;cursor:pointer;font-family:inherit;';
      next.onclick = () => renderItemPage(outputEl, items, startIdx + pageSize, pageSize, title, showButtons);
      pg.appendChild(next);
    }
    outputEl.appendChild(pg);
  }
}

// ── Mobius? — session pulse check ────────────────────────────────────────────
async function handleMobiusQuery(args, output, outputEl) {
  outputEl.classList.add('html-content');
  outputEl.innerHTML = '';

  const now     = new Date().toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit' });
  const elapsed = Math.floor((Date.now() - mobiusSession.startedAt) / 60000);

  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-weight:bold;font-size:14px;color:#3a2e22;margin-bottom:10px;';
  hdr.textContent = '🧠 Mobius — Session Pulse  ' + now;
  outputEl.appendChild(hdr);

  // Session duration
  const dur = document.createElement('div');
  dur.style.cssText = 'font-size:13px;color:#8d7c64;margin-bottom:8px;';
  dur.textContent = 'Session running: ' + (elapsed < 1 ? 'less than a minute' : elapsed + ' min');
  outputEl.appendChild(dur);

  // Session flags
  if (mobiusSession.flags.length === 0) {
    const ok = document.createElement('div');
    ok.style.cssText = 'font-size:13px;color:#4a7c4e;margin-bottom:8px;';
    ok.textContent = '✅ No flags raised this session';
    outputEl.appendChild(ok);
  } else {
    const fhdr = document.createElement('div');
    fhdr.style.cssText = 'font-size:12px;color:#8d7c64;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;';
    fhdr.textContent = 'Flags this session';
    outputEl.appendChild(fhdr);
    mobiusSession.flags.forEach(f => {
      const row = document.createElement('div');
      row.style.cssText = 'font-size:13px;color:#a06800;padding:2px 0;';
      row.textContent = '⚠️  [' + f.time + '] ' + f.msg;
      outputEl.appendChild(row);
    });
  }

  // Quick summary of mobius.json
  const userId = getAuth('mobius_user_id');
  const loaded = await loadMobiusJson(userId);
  if (loaded) {
    const { data } = loaded;
    const summary = document.createElement('div');
    summary.style.cssText = 'margin-top:10px;font-size:13px;color:#8d7c64;border-top:1px solid #c9bfae;padding-top:8px;';
    const counts = ['preferences','rules','routing_rules','corrections','do_not']
      .map(k => sectionLabel(k) + ': ' + (data[k]?.length || 0)).join('  |  ');
    summary.textContent = counts;
    outputEl.appendChild(summary);
    const updated = document.createElement('div');
    updated.style.cssText = 'font-size:12px;color:#8d7c64;margin-top:4px;';
    updated.textContent = 'mobius.json last updated: ' + (data.updated || 'unknown') + '   |   Project: ' + (data.project_state?.current_project || '—');
    outputEl.appendChild(updated);
  }

  // Shortcuts
  const shortcuts = document.createElement('div');
  shortcuts.style.cssText = 'margin-top:10px;font-size:12px;color:#8d7c64;';
  shortcuts.textContent = 'Mobius: all  |  Mobius: rules  |  Mobius: state  |  Review:';
  outputEl.appendChild(shortcuts);
  document.getElementById('input').value = '';
}

// ── Mobius: — view awareness sections ────────────────────────────────────────
async function handleMobius(args, output, outputEl) {
  const userId  = getAuth('mobius_user_id');
  const trimmed = args.trim().toLowerCase();

  const loaded = await loadMobiusJson(userId);
  if (!loaded) { output('❌ Could not load mobius.json from Drive.'); return; }
  const { data } = loaded;

  const PAGE = 25;

  // Mobius: state
  if (trimmed === 'state') {
    outputEl.classList.add('html-content');
    outputEl.innerHTML = '';
    const hdr = document.createElement('div');
    hdr.style.cssText = 'font-weight:bold;font-size:14px;color:#3a2e22;margin-bottom:8px;';
    hdr.textContent = '📌 Project State';
    outputEl.appendChild(hdr);
    const ps = data.project_state || {};
    const lines = [
      ['Project',         ps.current_project || '—'],
      ['Focus',           ps.current_focus   || '—'],
      ['Deployed at',     ps.deployment_url   || '—'],
      ['Local path',      ps.local_path       || '—'],
    ];
    lines.forEach(([label, val]) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;font-size:13px;padding:3px 0;border-bottom:1px solid #ede5d4;';
      row.innerHTML = '<span style="color:#8d7c64;width:100px;flex-shrink:0;">' + label + '</span><span style="color:#3a2e22;flex:1;">' + val + '</span>';
      outputEl.appendChild(row);
    });
    ['just_completed','next_steps','staged_not_deployed','known_issues'].forEach(key => {
      const arr = ps[key];
      if (!arr || arr.length === 0) return;
      const sh = document.createElement('div');
      sh.style.cssText = 'font-size:11px;color:#8d7c64;text-transform:uppercase;letter-spacing:0.08em;margin:10px 0 4px;';
      sh.textContent = key.replace(/_/g, ' ');
      outputEl.appendChild(sh);
      arr.forEach(item => {
        const d = document.createElement('div');
        d.style.cssText = 'font-size:13px;color:#3a2e22;padding:2px 0 2px 12px;border-bottom:1px solid #ede5d4;';
        d.textContent = '• ' + item;
        outputEl.appendChild(d);
      });
    });
    document.getElementById('input').value = '';
    return;
  }

  // Mobius: all — all sections paginated
  if (!trimmed || trimmed === 'all') {
    const items = flattenMobius(data);
    const title = '🧠 mobius.json — All Rules (' + items.length + ' entries)';
    renderItemPage(outputEl, items, 0, PAGE, title, true);
    document.getElementById('input').value = '';
    return;
  }

  // Mobius: [section] — single section
  const sectionMap = {
    'rules':       'rules',
    'preferences': 'preferences',
    'corrections': 'corrections',
    'routing':     'routing_rules',
    'do not':      'do_not',
    'donot':       'do_not'
  };
  const key = sectionMap[trimmed];
  if (key && Array.isArray(data[key])) {
    const items = data[key].map((text, i) => ({ section: key, localIndex: i, text }));
    // Offset global numbers correctly
    const allItems = flattenMobius(data);
    const offset   = allItems.findIndex(it => it.section === key);
    const offsetItems = items.map((it, i) => ({ ...it, _globalIndex: offset + i }));
    renderItemPage(outputEl, allItems.filter(it => it.section === key).map((it, i) => ({
      ...it, _display: allItems.indexOf(it) + 1
    })), 0, PAGE, '🧠 ' + sectionLabel(key) + ' (' + items.length + ' entries)', true);
    document.getElementById('input').value = '';
    return;
  }

  output('Usage: Mobius: all | rules | preferences | corrections | routing | do not | state');
}

// ── Remember: — append a lesson ──────────────────────────────────────────────
async function handleRemember(args, output) {
  const userId  = getAuth('mobius_user_id');
  const trimmed = args.trim();
  if (!trimmed) { output('Usage: Remember: [lesson]  or  Remember: preference/correction/route/do not [lesson]'); return; }

  // Detect section prefix
  const prefixMap = [
    { prefix: 'preference ',   key: 'preferences'   },
    { prefix: 'correction ',   key: 'corrections'   },
    { prefix: 'route ',        key: 'routing_rules' },
    { prefix: 'routing ',      key: 'routing_rules' },
    { prefix: 'do not ',       key: 'do_not'        },
    { prefix: 'donot ',        key: 'do_not'        },
  ];
  let targetKey = 'rules';
  let lesson    = trimmed;
  for (const { prefix, key } of prefixMap) {
    if (trimmed.toLowerCase().startsWith(prefix)) {
      targetKey = key;
      lesson    = trimmed.slice(prefix.length).trim();
      break;
    }
  }

  output('💾 Loading mobius.json...');
  const loaded = await loadMobiusJson(userId);
  if (!loaded) { output('❌ Could not load mobius.json from Drive.'); return; }
  const { data } = loaded;

  if (!Array.isArray(data[targetKey])) data[targetKey] = [];
  data[targetKey].push(lesson);
  const newNum = flattenMobius(data).length;

  await saveMobiusJson(userId, data, output);
  output('✅ Remembered as #' + newNum + ' in ' + sectionLabel(targetKey) + ':\n   ' + lesson);
  document.getElementById('input').value = '';
}

// ── Forget: — remove item(s) by global number ────────────────────────────────
async function handleForget(args, output) {
  const userId  = getAuth('mobius_user_id');
  const trimmed = args.trim();
  if (!trimmed) { output('Usage: Forget: 13   or   Forget: 13, 22, 27'); return; }

  const nums = trimmed.split(/[,\s]+/).map(n => parseInt(n.trim())).filter(n => !isNaN(n));
  if (nums.length === 0) { output('❌ No valid numbers found. Usage: Forget: 13, 22'); return; }

  output('💾 Loading mobius.json...');
  const loaded = await loadMobiusJson(userId);
  if (!loaded) { output('❌ Could not load mobius.json from Drive.'); return; }
  const { data } = loaded;

  const items   = flattenMobius(data);
  const toForget = nums.map(n => items[n - 1]).filter(Boolean);
  if (toForget.length === 0) { output('❌ No matching entries found.'); return; }

  // Remove from highest localIndex first to avoid index shifting
  const bySection = {};
  toForget.forEach(item => {
    if (!bySection[item.section]) bySection[item.section] = [];
    bySection[item.section].push(item.localIndex);
  });
  for (const [key, indices] of Object.entries(bySection)) {
    indices.sort((a, b) => b - a).forEach(i => data[key].splice(i, 1));
  }

  await saveMobiusJson(userId, data, output);
  const removed = toForget.map(it => '  #' + (items.indexOf(it) + 1) + ': ' + it.text).join('\n');
  output('🗑️  Forgotten:\n' + removed);
  document.getElementById('input').value = '';
}

// ── Amend: — replace item by global number ───────────────────────────────────
async function handleAmend(args, output) {
  const userId  = getAuth('mobius_user_id');
  const trimmed = args.trim();
  const match   = trimmed.match(/^(\d+)\s+(.+)/);
  if (!match) { output('Usage: Amend: 12 [new text for that rule]'); return; }

  const num     = parseInt(match[1]);
  const newText = match[2].trim();

  output('💾 Loading mobius.json...');
  const loaded = await loadMobiusJson(userId);
  if (!loaded) { output('❌ Could not load mobius.json from Drive.'); return; }
  const { data } = loaded;

  const items = flattenMobius(data);
  const item  = items[num - 1];
  if (!item) { output('❌ No entry #' + num + ' found. Use Mobius: all to see entries.'); return; }

  const oldText = item.text;
  data[item.section][item.localIndex] = newText;

  await saveMobiusJson(userId, data, output);
  output('✏️  Amended #' + num + ':\n  Was: ' + oldText + '\n  Now: ' + newText);
  document.getElementById('input').value = '';
}

// ── Review: — end-of-session debrief ─────────────────────────────────────────
async function handleReview(args, output, outputEl) {
  const userId = getAuth('mobius_user_id');
  outputEl.classList.add('html-content');
  outputEl.innerHTML = '';

  const now = new Date().toLocaleString('en-AU', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });

  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-weight:bold;font-size:14px;color:#3a2e22;margin-bottom:10px;';
  hdr.textContent = '📚 Session Review — ' + now;
  outputEl.appendChild(hdr);

  const loaded = await loadMobiusJson(userId);
  if (!loaded) { output('❌ Could not load mobius.json from Drive.'); return; }
  const { data } = loaded;

  // ── Proposed lessons from session flags ──────────────────────────────────
  const flags = mobiusSession.flags;
  if (flags.length > 0) {
    const fhdr = document.createElement('div');
    fhdr.style.cssText = 'font-size:12px;color:#8d7c64;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;';
    fhdr.textContent = 'Proposed lessons from this session';
    outputEl.appendChild(fhdr);

    flags.forEach((flag, i) => {
      const card = document.createElement('div');
      card.style.cssText = 'background:#f5eedd;border:1px solid #c9bfae;border-radius:1px;padding:10px 12px;margin-bottom:8px;';

      const flagText = document.createElement('div');
      flagText.style.cssText = 'font-size:13px;color:#a06800;margin-bottom:6px;';
      flagText.textContent = '⚠️  [' + flag.time + '] ' + flag.msg;
      card.appendChild(flagText);

      const input = document.createElement('input');
      input.type  = 'text';
      input.value = flag.msg;
      input.style.cssText = 'width:100%;padding:4px 8px;font-size:13px;font-family:inherit;border:1px solid #8d7c64;background:#ede5d4;color:#3a2e22;border-radius:1px;box-sizing:border-box;margin-bottom:6px;';
      card.appendChild(input);

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;';

      const remBtn = document.createElement('button');
      remBtn.textContent = '✅ Remember';
      remBtn.style.cssText = 'padding:4px 12px;background:#4a7c4e;color:#fff;border:none;border-radius:1px;cursor:pointer;font-family:inherit;font-size:13px;';
      remBtn.onclick = async () => {
        const lesson = input.value.trim();
        if (!lesson) return;
        if (!Array.isArray(data.rules)) data.rules = [];
        data.rules.push(lesson);
        remBtn.textContent = '✓ Saved';
        remBtn.disabled = true;
        forgetBtn.disabled = true;
        card.style.opacity = '0.5';
      };

      const forgetBtn = document.createElement('button');
      forgetBtn.textContent = '❌ Skip';
      forgetBtn.style.cssText = 'padding:4px 12px;background:#8d7c64;color:#fff;border:none;border-radius:1px;cursor:pointer;font-family:inherit;font-size:13px;';
      forgetBtn.onclick = () => {
        forgetBtn.textContent = '✓ Skipped';
        forgetBtn.disabled = true;
        remBtn.disabled = true;
        card.style.opacity = '0.5';
      };

      const reframeBtn = document.createElement('button');
      reframeBtn.textContent = '✏️ Reframe';
      reframeBtn.style.cssText = 'padding:4px 12px;background:transparent;border:1px solid #8d7c64;color:#8d7c64;border-radius:1px;cursor:pointer;font-family:inherit;font-size:13px;';
      reframeBtn.onclick = () => { input.focus(); input.select(); };

      btnRow.appendChild(remBtn);
      btnRow.appendChild(forgetBtn);
      btnRow.appendChild(reframeBtn);
      card.appendChild(btnRow);
      outputEl.appendChild(card);
    });
  } else {
    const noFlags = document.createElement('div');
    noFlags.style.cssText = 'font-size:13px;color:#4a7c4e;margin-bottom:12px;';
    noFlags.textContent = '✅ No flags raised this session.';
    outputEl.appendChild(noFlags);
  }

  // ── Add your own lesson ───────────────────────────────────────────────────
  const addHdr = document.createElement('div');
  addHdr.style.cssText = 'font-size:12px;color:#8d7c64;text-transform:uppercase;letter-spacing:0.08em;margin:12px 0 6px;border-top:1px solid #c9bfae;padding-top:10px;';
  addHdr.textContent = 'Add a lesson';
  outputEl.appendChild(addHdr);

  const addRow = document.createElement('div');
  addRow.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
  const addInput = document.createElement('input');
  addInput.type        = 'text';
  addInput.placeholder = 'Type a new rule, correction or preference...';
  addInput.style.cssText = 'flex:1;padding:4px 8px;font-size:13px;font-family:inherit;border:1px solid #8d7c64;background:#f5eedd;color:#3a2e22;border-radius:1px;';
  const addBtn = document.createElement('button');
  addBtn.textContent = '+ Add';
  addBtn.style.cssText = 'padding:4px 14px;background:#4a7c4e;color:#fff;border:none;border-radius:1px;cursor:pointer;font-family:inherit;font-size:13px;';
  addBtn.onclick = () => {
    const lesson = addInput.value.trim();
    if (!lesson) return;
    if (!Array.isArray(data.rules)) data.rules = [];
    data.rules.push(lesson);
    const conf = document.createElement('div');
    conf.style.cssText = 'font-size:12px;color:#4a7c4e;margin-top:4px;';
    conf.textContent = '✓ Added: ' + lesson;
    addRow.parentNode.insertBefore(conf, addRow.nextSibling);
    addInput.value = '';
  };
  addRow.appendChild(addInput);
  addRow.appendChild(addBtn);
  outputEl.appendChild(addRow);

  // ── Update project state ──────────────────────────────────────────────────
  const stateHdr = document.createElement('div');
  stateHdr.style.cssText = 'font-size:12px;color:#8d7c64;text-transform:uppercase;letter-spacing:0.08em;margin:12px 0 6px;border-top:1px solid #c9bfae;padding-top:10px;';
  stateHdr.textContent = 'Update project state (optional)';
  outputEl.appendChild(stateHdr);

  const stateInput = document.createElement('input');
  stateInput.type        = 'text';
  stateInput.placeholder = 'What is the current focus? (leave blank to keep existing)';
  stateInput.value       = data.project_state?.current_focus || '';
  stateInput.style.cssText = 'width:100%;padding:4px 8px;font-size:13px;font-family:inherit;border:1px solid #8d7c64;background:#f5eedd;color:#3a2e22;border-radius:1px;box-sizing:border-box;margin-bottom:8px;';
  outputEl.appendChild(stateInput);

  // ── Save all button ───────────────────────────────────────────────────────
  const saveBtn = document.createElement('button');
  saveBtn.textContent = '💾 Save Review to mobius.json';
  saveBtn.style.cssText = 'width:100%;padding:8px;background:#4a3728;color:#f5eedd;border:none;border-radius:1px;cursor:pointer;font-family:inherit;font-size:14px;margin-top:4px;';
  saveBtn.onclick = async () => {
    saveBtn.textContent = '⏳ Saving...';
    saveBtn.disabled = true;
    if (stateInput.value.trim() && data.project_state) {
      data.project_state.current_focus = stateInput.value.trim();
    }
    // Clear session flags now that review is done
    mobiusSession.flags = [];
    const appendOutput = msg => {
      const d = document.createElement('div');
      d.style.cssText = 'font-size:12px;color:#4a7c4e;margin-top:4px;';
      d.textContent = msg;
      outputEl.appendChild(d);
    };
    await saveMobiusJson(userId, data, appendOutput);
    saveBtn.textContent = '✅ Saved to mobius.json';
  };
  outputEl.appendChild(saveBtn);
  document.getElementById('input').value = '';
}

// ── Google? — Google account pulse ───────────────────────────────────────────
async function handleGoogleQuery(args, output, outputEl) {
  const userId = getAuth('mobius_user_id');
  outputEl.classList.add('html-content');
  outputEl.innerHTML = '<div style="color:#8d7c64;font-style:italic;font-size:13px;">🔍 Checking Google accounts...</div>';
  try {
    const res  = await fetch('/api/google/accounts?userId=' + encodeURIComponent(userId));
    const data = await res.json();
    outputEl.innerHTML = '';
    const hdr = document.createElement('div');
    hdr.style.cssText = 'font-weight:bold;font-size:14px;color:#3a2e22;margin-bottom:8px;';
    hdr.textContent = '🔗 Google Accounts';
    outputEl.appendChild(hdr);
    const LABELS = ['personal','family','work'];
    LABELS.forEach(label => {
      const acc = (data.accounts || []).find(a => a.label === label);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;font-size:13px;padding:4px 0;border-bottom:1px solid #ede5d4;';
      row.innerHTML = '<span style="width:70px;color:#8d7c64;flex-shrink:0;">' + label + '</span>' +
        (acc ? '<span style="color:#4a7c4e;">✅ ' + acc.email + '</span>' : '<span style="color:#a06800;">⚪ not connected</span>');
      outputEl.appendChild(row);
    });
    if (mobiusSession.googleState) {
      mobiusSession.googleState.accounts = data.accounts || [];
      mobiusSession.googleState.lastSync  = new Date().toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit' });
    }
  } catch (err) { outputEl.textContent = '❌ ' + err.message; }
  document.getElementById('input').value = '';
}

// ── Dropbox? — Dropbox pulse ──────────────────────────────────────────────────
async function handleDropboxQuery(args, output, outputEl) {
  const userId = getAuth('mobius_user_id');
  outputEl.classList.add('html-content');
  outputEl.innerHTML = '<div style="color:#8d7c64;font-style:italic;font-size:13px;">🔍 Checking Dropbox...</div>';
  try {
    const res  = await fetch('/api/dropbox/list', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId, path: '' })
    });
    const data = await res.json();
    outputEl.innerHTML = '';
    const hdr = document.createElement('div');
    hdr.style.cssText = 'font-weight:bold;font-size:14px;color:#3a2e22;margin-bottom:8px;';
    hdr.textContent = '📦 Dropbox';
    outputEl.appendChild(hdr);
    const connected = !data.error;
    const row = document.createElement('div');
    row.style.cssText = 'font-size:13px;color:' + (connected ? '#4a7c4e' : '#a06800') + ';';
    row.textContent = connected
      ? '✅ Connected — ' + (data.entries?.length || 0) + ' items at root'
      : '⚪ Not connected — use Dropbox: connect';
    outputEl.appendChild(row);
    mobiusSession.dropboxState = { connected, lastSync: connected ? new Date().toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit' }) : null, fileCount: data.entries?.length || null };
  } catch (err) { outputEl.textContent = '❌ ' + err.message; }
  document.getElementById('input').value = '';
}

// ── Code? — Code session pulse ────────────────────────────────────────────────
function handleCodeQuery(args, output, outputEl) {
  outputEl.classList.add('html-content');
  outputEl.innerHTML = '';
  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-weight:bold;font-size:14px;color:#3a2e22;margin-bottom:8px;';
  hdr.textContent = '⌨️  Code Session';
  outputEl.appendChild(hdr);
  const cs = window.getCodeSession ? window.getCodeSession() : null;
  if (!cs) {
    const none = document.createElement('div');
    none.style.cssText = 'font-size:13px;color:#8d7c64;';
    none.textContent = 'No active code session. Use Code: [projectname] to start.';
    outputEl.appendChild(none);
  } else {
    const rows = [
      ['Project',  cs.projectName],
      ['.map',     cs.mapContent   ? '✅ loaded (' + cs.mapContent.length   + ' chars)' : '⚠️  not loaded'],
      ['.repo',    cs.repoContent  ? '✅ loaded (' + cs.repoContent.length  + ' chars)' : '⚠️  not loaded'],
      ['.audit',   cs.auditContent ? '✅ loaded (' + cs.auditContent.length + ' chars)' : '⚠️  not loaded'],
    ];
    rows.forEach(([label, val]) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;font-size:13px;padding:3px 0;border-bottom:1px solid #ede5d4;';
      row.innerHTML = '<span style="color:#8d7c64;width:60px;flex-shrink:0;">' + label + '</span><span style="color:#3a2e22;">' + val + '</span>';
      outputEl.appendChild(row);
    });
  }
  document.getElementById('input').value = '';
}

// ── Focus? — Focus file pulse ─────────────────────────────────────────────────
function handleFocusQuery(args, output, outputEl) {
  outputEl.classList.add('html-content');
  outputEl.innerHTML = '';
  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-weight:bold;font-size:14px;color:#3a2e22;margin-bottom:8px;';
  hdr.textContent = '📎 Focus File';
  outputEl.appendChild(hdr);
  const ff = window.getFocusFile ? window.getFocusFile() : null;
  if (!ff) {
    const none = document.createElement('div');
    none.style.cssText = 'font-size:13px;color:#8d7c64;';
    none.textContent = 'No file in focus. Use Focus: [filename] to attach a file.';
    outputEl.appendChild(none);
  } else {
    const rows = [
      ['File',    ff.name],
      ['Size',    ff.content ? ff.content.length + ' chars' : '(empty)'],
      ['Path',    ff.path || '(Drive root)'],
      ['Origin',  ff.originalId ? 'Copied from Drive' : 'In Mobius folder'],
    ];
    rows.forEach(([label, val]) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;font-size:13px;padding:3px 0;border-bottom:1px solid #ede5d4;';
      row.innerHTML = '<span style="color:#8d7c64;width:60px;flex-shrink:0;">' + label + '</span><span style="color:#3a2e22;">' + val + '</span>';
      outputEl.appendChild(row);
    });
  }
  document.getElementById('input').value = '';
}

// ── Sync? — Sync status pulse ─────────────────────────────────────────────────
async function handleSyncQuery(args, output, outputEl) {
  const userId = getAuth('mobius_user_id');
  outputEl.classList.add('html-content');
  outputEl.innerHTML = '<div style="color:#8d7c64;font-style:italic;font-size:13px;">🔍 Checking sync status...</div>';
  try {
    const res  = await fetch('/api/sync/status?userId=' + encodeURIComponent(userId));
    const data = await res.json();
    outputEl.innerHTML = '';
    const hdr = document.createElement('div');
    hdr.style.cssText = 'font-weight:bold;font-size:14px;color:#3a2e22;margin-bottom:8px;';
    hdr.textContent = '🔄 Sync Status';
    outputEl.appendChild(hdr);
    (data.status || []).forEach(entry => {
      const ago = entry.synced_at ? timeSince(new Date(entry.synced_at)) : 'never';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;font-size:13px;padding:3px 0;border-bottom:1px solid #ede5d4;';
      row.innerHTML = '<span style="color:#8d7c64;width:120px;flex-shrink:0;">' + entry.label + ' / ' + entry.type + '</span><span style="color:#3a2e22;">' + ago + '</span>';
      outputEl.appendChild(row);
    });
    if (!data.status || data.status.length === 0) {
      const none = document.createElement('div');
      none.style.cssText = 'font-size:13px;color:#8d7c64;';
      none.textContent = 'No sync records found.';
      outputEl.appendChild(none);
    }
  } catch (err) { outputEl.textContent = '❌ ' + err.message; }
  document.getElementById('input').value = '';
}

// ── Mobius: refine — AI-powered rulebook refinement via Gemini ──────────────
async function handleRefine(args, output, outputEl) {
  const userId  = getAuth('mobius_user_id');
  outputEl.classList.add('html-content');
  outputEl.innerHTML = '';

  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-weight:bold;font-size:14px;color:#3a2e22;margin-bottom:10px;';
  hdr.textContent = '🔬 Mobius: refine — loading rulebook...';
  outputEl.appendChild(hdr);

  const append = msg => {
    const d = document.createElement('div');
    d.style.cssText = 'font-size:13px;color:#8d7c64;margin-bottom:4px;';
    d.textContent = msg;
    outputEl.appendChild(d);
  };

  // ── Step 1: Load mobius.json from Drive ───────────────────────────────────
  append('📥 Loading mobius.json from Drive...');
  const loaded = await loadMobiusJson(userId);
  if (!loaded) {
    hdr.textContent = '❌ Could not load mobius.json from Drive.';
    return;
  }
  const { data } = loaded;
  const guidelines = data.refinement_guidelines;
  if (!guidelines) {
    append('❌ No refinement_guidelines found in mobius.json. Cannot proceed.');
    return;
  }

  // ── Step 2: Count total rules ─────────────────────────────────────────────
  const allItems  = flattenMobius(data);
  const totalRules = allItems.length;
  append('📋 ' + totalRules + ' rules loaded across ' + ['preferences','rules','routing_rules','corrections','do_not'].filter(k => data[k]?.length).length + ' sections.');

  // ── Step 3: Build Gemini prompt from guidelines in the file itself ────────
  const checksText  = (guidelines.checks_to_run  || []).map((c,i) => (i+1) + '. ' + c).join('\n');
  const formatText  = (guidelines.output_format  || []).map((f,i) => (i+1) + '. ' + f).join('\n');
  const principlesText = (guidelines.refinement_principles || []).map((p,i) => (i+1) + '. ' + p).join('\n');

  const mobiusJson = JSON.stringify(data, null, 2);

  const prompt =
    'You are refining mobius.json — the deterministic rulebook for an AI assistant called Mobius.\n\n' +
    'REFINEMENT PRINCIPLES:\n' + principlesText + '\n\n' +
    'CHECKS TO RUN (apply every check to every entry in preferences, rules, routing_rules, corrections, do_not):\n' + checksText + '\n\n' +
    'OUTPUT FORMAT (follow exactly):\n' + formatText + '\n\n' +
    'IMPORTANT: Present no more than 5 proposed changes in this response. ' +
    'Number each proposal. I will ask for more when ready by saying "Mobius: refine next".\n\n' +
    'If you find no issues, say so clearly and suggest any gaps you noticed.\n\n' +
    'Here is the full mobius.json:\n\n' + mobiusJson;

  // ── Step 4: Send to Gemini ────────────────────────────────────────────────
  const thinkDiv = document.createElement('div');
  thinkDiv.style.cssText = 'color:#8d7c64;font-style:italic;margin:8px 0;font-size:13px;';
  thinkDiv.textContent = '🧠 Asking Gemini to analyse rulebook...';
  outputEl.appendChild(thinkDiv);

  let dots = 0;
  const timer = setInterval(() => {
    dots = (dots + 1) % 4;
    thinkDiv.textContent = '🧠 Asking Gemini to analyse rulebook' + '.'.repeat(dots) + ' '.repeat(3 - dots);
  }, 600);

  let geminiReply = '';
  try {
    const res  = await fetch('/ask', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        mobius_query: {
          ASK:          'gemini',
          INSTRUCTIONS: 'Long',
          HISTORY:      [],
          QUERY:        prompt,
          FILES:        [],
          CONTEXT:      'None'
        },
        userId,
        session_id: window.getCurrentSessionId ? window.getCurrentSessionId() : null,
        topic: 'refine'
      })
    });
    clearInterval(timer);
    const result = await res.json();
    if (result.error) { thinkDiv.textContent = '❌ Gemini error: ' + result.error; return; }
    geminiReply = result.reply || '';
    thinkDiv.textContent = '✅ Gemini analysis complete.';
  } catch (err) {
    clearInterval(timer);
    thinkDiv.textContent = '❌ ' + err.message;
    return;
  }

  // ── Step 5: Display Gemini proposals ─────────────────────────────────────
  const replyDiv = document.createElement('div');
  replyDiv.style.cssText = 'margin-top:10px;padding:10px;background:#f5eedd;border:1px solid #c9bfae;border-radius:1px;font-size:13px;line-height:1.6;';
  replyDiv.classList.add('html-content');
  replyDiv.innerHTML = window.markdownToHtml ? window.markdownToHtml(geminiReply) : geminiReply.replace(/\n/g,'<br>');
  outputEl.appendChild(replyDiv);

  // Store reply for 'Mobius: refine next' pagination
  window._refineSession = { data, reply: geminiReply, page: 1 };

  // ── Step 6: Action buttons ────────────────────────────────────────────────
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;';

  // Apply a correction manually
  const applyBtn = document.createElement('button');
  applyBtn.textContent = '✏️ Apply a change (Amend: or Forget:)';
  applyBtn.style.cssText = 'padding:6px 14px;background:#4a3728;color:#f5eedd;border:none;border-radius:1px;cursor:pointer;font-family:inherit;font-size:13px;';
  applyBtn.onclick = () => {
    document.getElementById('input').value = 'Amend: ';
    document.getElementById('input').focus();
  };

  // Get next batch
  const nextBtn = document.createElement('button');
  nextBtn.textContent = '▶ Next 5 proposals';
  nextBtn.style.cssText = 'padding:6px 14px;background:#8d7c64;color:#fff;border:none;border-radius:1px;cursor:pointer;font-family:inherit;font-size:13px;';
  nextBtn.onclick = () => {
    document.getElementById('input').value = 'Mobius: refine next';
    document.getElementById('input').focus();
  };

  // Save refined version
  const saveBtn = document.createElement('button');
  saveBtn.textContent = '💾 Save refined mobius.json';
  saveBtn.style.cssText = 'padding:6px 14px;background:#4a7c4e;color:#fff;border:none;border-radius:1px;cursor:pointer;font-family:inherit;font-size:13px;';
  saveBtn.onclick = async () => {
    if (!window._refineSession) return;
    saveBtn.textContent = '⏳ Saving...';
    saveBtn.disabled = true;
    const saveOutput = msg => {
      const d = document.createElement('div');
      d.style.cssText = 'font-size:12px;color:#4a7c4e;margin-top:4px;';
      d.textContent = msg;
      outputEl.appendChild(d);
    };
    await saveMobiusJson(userId, window._refineSession.data, saveOutput);
    saveBtn.textContent = '✅ Saved';
  };

  btnRow.appendChild(applyBtn);
  btnRow.appendChild(nextBtn);
  btnRow.appendChild(saveBtn);
  outputEl.appendChild(btnRow);

  // Instruction
  const instr = document.createElement('div');
  instr.style.cssText = 'font-size:12px;color:#8d7c64;margin-top:8px;';
  instr.textContent = 'Review proposals above. Use Amend: N [new text] or Forget: N to apply changes. Type "Mobius: refine next" for more proposals.';
  outputEl.appendChild(instr);

  document.getElementById('input').value = '';
}

// ── Shared: render a contextual help card ────────────────────────────────────
// rows = [ [cmd, description], ... ]
function renderHelpCard(outputEl, icon, title, rows, tip) {
  outputEl.classList.add('html-content');
  outputEl.innerHTML = '';
  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-weight:bold;font-size:14px;color:#3a2e22;margin-bottom:10px;';
  hdr.textContent = icon + '  ' + title;
  outputEl.appendChild(hdr);
  rows.forEach(([cmd, desc]) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;padding:5px 0;border-bottom:1px solid #ede5d4;font-size:13px;align-items:baseline;';
    const codeEl = document.createElement('code');
    codeEl.style.cssText = 'background:#d4c9b5;padding:1px 6px;border-radius:1px;font-size:12px;font-family:monospace;border:1px solid #8d7c64;white-space:nowrap;flex-shrink:0;min-width:160px;';
    codeEl.textContent = cmd;
    const descEl = document.createElement('span');
    descEl.style.cssText = 'color:#8d7c64;flex:1;';
    descEl.textContent = desc;
    row.appendChild(codeEl);
    row.appendChild(descEl);
    outputEl.appendChild(row);
  });
  if (tip) {
    const tipEl = document.createElement('div');
    tipEl.style.cssText = 'margin-top:10px;font-size:12px;color:#8d7c64;font-style:italic;border-top:1px solid #ede5d4;padding-top:8px;';
    tipEl.textContent = '💡 ' + tip;
    outputEl.appendChild(tipEl);
  }
  document.getElementById('input').value = '';
}

// ── ? handlers — contextual help cards ───────────────────────────────────────

function handleGoogleHelp(args, output, outputEl) {
  renderHelpCard(outputEl, '🔗', 'Google: — Account Management', [
    ['Google: connect personal',   'Connect your personal Gmail account'],
    ['Google: connect family',     'Connect your shared family Gmail account'],
    ['Google: connect work',       'Connect your work Gmail account'],
    ['Google: disconnect [label]', 'Remove a connected account'],
    ['Google: status',             'Show which accounts are connected'],
  ], 'Type Google: (no argument) to see connection status at a glance.');
}

function handleDropboxHelp(args, output, outputEl) {
  renderHelpCard(outputEl, '📦', 'Dropbox: — Dropbox Connection', [
    ['Dropbox: connect',     'Connect your Dropbox account via OAuth'],
    ['Dropbox: sync',        'Rebuild the full Dropbox file index'],
    ['Dropbox: list',        'List files at Dropbox root'],
    ['Dropbox: list /path',  'List a specific Dropbox folder'],
  ], 'Type Dropbox: (no argument) to check connection status and file count.');
}

function handleSyncHelp(args, output, outputEl) {
  renderHelpCard(outputEl, '🔄', 'Sync: — Data Synchronisation', [
    ['Sync: all',       'Full refresh — all Google accounts + Dropbox'],
    ['Sync: calendars', 'Sync calendar events only'],
    ['Sync: emails',    'Sync unread email metadata only'],
    ['Sync: drive',     'Sync Drive file listings only'],
    ['Sync: dropbox',   'Sync Dropbox file index only'],
    ['Sync: status',    'Show last sync timestamps for all services'],
  ], 'Type Sync: (no argument) to see last sync times at a glance.');
}

function handleFocusHelp(args, output, outputEl) {
  renderHelpCard(outputEl, '📎', 'Focus: — Project File Context', [
    ['Focus: filename',   'Load a Drive file as context for this session'],
    ['Focus: add [text]', 'Append a timestamped entry and save to Drive'],
    ['Focus: update',     'Write changes back to the original Drive file'],
    ['Focus: end',        'Detach the file from this session'],
  ], 'Type Focus: (no argument) to see what file is currently loaded.');
}

function handleCodeHelp(args, output, outputEl) {
  renderHelpCard(outputEl, '⌨️', 'Code: — Coding Assistant', [
    ['Code: [projectname]', 'Open a project folder and start a code session'],
    ['Code: repo',          'Build a code index — functions, imports, routes (nAI)'],
    ['Code: scan',          'Static analysis — no AI, instant, reliable'],
    ['Code: map',           'AI architectural summary via Gemini'],
    ['Code: audit new',     'Full audit — scan + Gemini briefing and fix plan'],
    ['Code: audit',         'Resume an existing audit'],
    ['Code: audit end',     'Close audit with final summary'],
    ['Code: all',           'Run repo → map → audit in one step'],
    ['Code: status',        'Save a session state snapshot to Drive'],
    ['Code: show',          'Display all loaded session content'],
    ['Code: end',           'End the code session'],
  ], 'Type Code: (no argument) to check your active session status.');
}

function handleMobiusHelp(args, output, outputEl) {
  renderHelpCard(outputEl, '🧠', 'Mobius: — Memory & Rulebook', [
    ['Mobius: all',          'Full numbered list of all rules (25 per page)'],
    ['Mobius: rules',        'View rules section'],
    ['Mobius: preferences',  'View preferences'],
    ['Mobius: corrections',  'View corrections'],
    ['Mobius: routing',      'View routing rules'],
    ['Mobius: do not',       'View do-not list'],
    ['Mobius: state',        'View current project state'],
    ['Mobius: refine',       'Ask Gemini to analyse and improve the rulebook'],
    ['Remember: [lesson]',   'Add a rule (default section)'],
    ['Remember: preference [text]', 'Add a preference'],
    ['Remember: correction [text]', 'Add a correction'],
    ['Remember: route [text]',      'Add a routing rule'],
    ['Remember: do not [text]',     'Add a do-not rule'],
    ['Forget: 13',           'Remove rule #13'],
    ['Amend: 12 [new text]', 'Replace rule #12 with new text'],
    ['Review:',              'End-of-session debrief — process flags, add lessons'],
  ], 'Type Mobius: (no argument) for a session pulse — flags, rule counts, project.');
}

// ── No-argument pulse wrappers ─────────────────────────────────────────────────
// Command: (no arg) = pulse. Command: [arg] = action. Command? = help card.
async function handleGooglePulse(args, output, outputEl) {
  if (args.trim()) return handleGoogleConnect(args, output, outputEl);
  return handleGoogleQuery(args, output, outputEl);
}
async function handleDropboxPulse(args, output, outputEl) {
  if (args.trim()) return handleDropbox(args, output, outputEl);
  return handleDropboxQuery(args, output, outputEl);
}
async function handleSyncPulse(args, output, outputEl) {
  if (args.trim()) return handleSync(args, output, outputEl);
  return handleSyncQuery(args, output, outputEl);
}
async function handleFocusPulse(args, output, outputEl) {
  if (args.trim()) return handleFocus(args, output, outputEl);
  return handleFocusQuery(args, output, outputEl);
}
function handleCodePulse(args, output, outputEl) {
  if (args.trim()) return handleCode(args, output, outputEl);
  return handleCodeQuery(args, output, outputEl);
}
function handleMobiusPulse(args, output, outputEl) {
  if (args.trim()) return handleMobius(args, output, outputEl);
  return handleMobiusQuery(args, output, outputEl);
}

// ── Register all commands ─────────────────────────────────────────────────────
Object.assign(COMMANDS, {
  // ? = contextual help cards
  'mobius?':  { requiresAccess: false, isAI: false, handler: handleMobiusHelp },
  'google?':  { requiresAccess: false, isAI: false, handler: handleGoogleHelp },
  'dropbox?': { requiresAccess: false, isAI: false, handler: handleDropboxHelp },
  'code?':    { requiresAccess: false, isAI: false, handler: handleCodeHelp },
  'focus?':   { requiresAccess: false, isAI: false, handler: handleFocusHelp },
  'sync?':    { requiresAccess: false, isAI: false, handler: handleSyncHelp },
  // base commands: no-arg = pulse, with-arg = action (via pulse wrappers)
  'google':   { requiresAccess: false, isAI: false, handler: handleGooglePulse },
  'dropbox':  { requiresAccess: false, isAI: false, handler: handleDropboxPulse },
  'sync':     { requiresAccess: false, isAI: false, handler: handleSyncPulse },
  'focus':    { requiresAccess: false, isAI: false, handler: handleFocusPulse },
  'code':     { requiresAccess: false, isAI: false, handler: handleCodePulse },
  'mobius':   { requiresAccess: false, isAI: false, handler: handleMobiusPulse },
  // memory commands
  'remember': { requiresAccess: false, isAI: false, handler: handleRemember },
  'forget':   { requiresAccess: false, isAI: false, handler: handleForget },
  'amend':    { requiresAccess: false, isAI: false, handler: handleAmend },
  'review':   { requiresAccess: false, isAI: false, handler: handleReview },
  'refine':   { requiresAccess: false, isAI: false, handler: handleRefine },
});

// ── Patch detectCommand to handle ? suffix and new single-word commands ───────
const _detectCommandOrig = detectCommand;
window._detectCommandPatched = true;

// Re-export detectCommand with ? support baked in
// (overrides the function in the same script scope via reassignment is not possible in strict mode,
//  so we patch the exported reference used by index.html — see runCommand which calls COMMANDS directly)
// The ? commands are registered in COMMANDS above with their full key (e.g. 'mobius?')
// detectCommand already handles colon-prefix; we extend it here for ? suffix:
const _origDetect = detectCommand;
function detectCommandExtended(text) {
  const trimmed = text.trim();
  // ? suffix pulse commands: Mobius? Google? Code? Focus? Dropbox? Sync?
  const qMatch = trimmed.match(/^(\w+)\?$/);
  if (qMatch) {
    const cmd = qMatch[1].toLowerCase() + '?';
    if (COMMANDS[cmd]) return { command: cmd, args: '' };
  }
  return _origDetect(text);
}
// Expose for index.html
window.detectCommandExtended = detectCommandExtended;
