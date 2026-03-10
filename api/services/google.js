// ── api/services/google.js ────────────────────────────────────────────────────
// GET  /api/google/accounts   → action = 'accounts'
// POST /api/google/disconnect → action = 'disconnect'
// GET  /api/google/info       → action = 'info'
// POST /api/dropbox           → action = 'dropbox'

const { createClient }         = require('@supabase/supabase-js');
const { getGoogleAccountInfo, writeDriveFileContent, findDriveFile, createDriveFile } = require('../../google_api.js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Dropbox helpers ───────────────────────────────────────────────────────────

async function getDropboxToken(userId) {
  const { data } = await supabase
    .from('dropbox_tokens')
    .select('access_token, refresh_token, expiry_date')
    .eq('user_id', userId)
    .single();
  if (!data) throw new Error('Dropbox not connected.');
  const expiresAt = data.expiry_date || 0;
  if (data.refresh_token && Date.now() > expiresAt - 5 * 60 * 1000) {
    const refreshRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: data.refresh_token,
        client_id: process.env.DROPBOX_APP_KEY, client_secret: process.env.DROPBOX_APP_SECRET
      })
    });
    const refreshed = await refreshRes.json();
    if (refreshed.access_token) {
      const newExpiry = Date.now() + (refreshed.expires_in || 14400) * 1000;
      await supabase.from('dropbox_tokens').upsert({ user_id: userId, access_token: refreshed.access_token, expiry_date: newExpiry }, { onConflict: 'user_id' });
      return refreshed.access_token;
    }
  }
  return data.access_token;
}

async function listAllDropboxFiles(accessToken) {
  const files = [];
  async function fetchPage(cursor) {
    const url  = cursor ? 'https://api.dropboxapi.com/2/files/list_folder/continue' : 'https://api.dropboxapi.com/2/files/list_folder';
    const body = cursor ? JSON.stringify({ cursor }) : JSON.stringify({ path: '', recursive: true, limit: 2000 });
    const res  = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body });
    return await res.json();
  }
  let result = await fetchPage(null);
  while (true) {
    for (const entry of result.entries || []) {
      if (entry['.tag'] === 'file') files.push({ name: entry.name, path: entry.path_display, modified: entry.client_modified || entry.server_modified || '', size: entry.size || 0 });
    }
    if (!result.has_more) break;
    result = await fetchPage(result.cursor);
  }
  return files;
}

async function writeIndexFile(userId, filename, content) {
  // Exact name match only — never partial, never strip extension
  const found = await findDriveFile(userId, filename);
  const exactMatch = (found.files || []).find(f => f.name === filename && f.inMobius)
                  || (found.files || []).find(f => f.name === filename);
  if (exactMatch) {
    await writeDriveFileContent(userId, exactMatch.id, content);
    return exactMatch.id;
  }
  // Create new with full filename including extension
  const newFile = await createDriveFile(userId, filename, found.folderId);
  await writeDriveFileContent(userId, newFile.id, content);
  return newFile.id;
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const { action } = req.query;

  // ── accounts — GET /api/google/accounts ──────────────────────────────────
  if (action === 'accounts') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const { data, error } = await supabase.from('google_tokens').select('label, email').eq('user_id', userId).order('label');
      if (error) throw error;
      return res.json({ accounts: data || [] });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── disconnect — POST /api/google/disconnect ──────────────────────────────
  if (action === 'disconnect') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, label } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!label)  return res.status(400).json({ error: 'label required' });
    if (!['personal','family','work'].includes(label)) return res.status(400).json({ error: 'Invalid label' });
    try {
      const { error } = await supabase.from('google_tokens').delete().eq('user_id', userId).eq('label', label);
      if (error) throw error;
      return res.json({ ok: true, label });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── info — GET /api/google/info ───────────────────────────────────────────
  if (action === 'info') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    try {
      const info = await getGoogleAccountInfo(userId);
      return res.json({ connected: true, ...info });
    } catch (err) { return res.status(200).json({ connected: false, error: err.message }); }
  }

  // ── dropbox — POST /api/dropbox ───────────────────────────────────────────
  if (action === 'dropbox') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const accessToken = await getDropboxToken(userId);
      const files       = await listAllDropboxFiles(accessToken);
      const lines = ['# dropbox.index', '# Generated: ' + new Date().toLocaleString('en-AU'), '# Format: modified | size | path', '# Total: ' + files.length + ' files', ''];
      for (const f of files) lines.push(f.modified + ' | ' + (f.size > 0 ? (f.size / 1024).toFixed(1) + ' KB' : '—') + ' | ' + f.path);
      await writeIndexFile(userId, 'dropbox.index', lines.join('\n'));
      await supabase.from('sync_meta').upsert({ user_id: userId, label: 'dropbox', type: 'dropbox', synced_at: new Date().toISOString() }, { onConflict: 'user_id, label, type' });
      return res.json({ ok: true, files: files.length });
    } catch (err) {
      console.error('Dropbox sync error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── dropbox-list — POST /api/dropbox/list ───────────────────────────────
  if (action === 'dropbox-list') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, path: folderPath } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const accessToken = await getDropboxToken(userId);
      const url  = 'https://api.dropboxapi.com/2/files/list_folder';
      const body = JSON.stringify({ path: folderPath || '', recursive: false });
      const r    = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body });
      const data = await r.json();
      if (data.error_summary) throw new Error(data.error_summary);
      const entries = (data.entries || []).map(e => ({ name: e.name, type: e['.tag'], path: e.path_display }));
      return res.json({ ok: true, entries });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(400).json({ error: 'Unknown action: ' + action });
};
