// ── api/data.js ───────────────────────────────────────────────────────────────
// GET  /api/chat-history  → action = 'history'
// GET  /api/sync/status   → action = 'sync-status'
// POST /api/sync          → action = 'sync'

const { createClient } = require('@supabase/supabase-js');
const { getChatHistory } = require('./_supabase.js');
const { google }         = require('googleapis');
const {
  getGoogleClient,
  writeDriveFileContent,
  findDriveFile,
  createDriveFile
} = require('../google_api.js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Sync helpers ──────────────────────────────────────────────────────────────

async function getConnectedLabels(userId) {
  const { data } = await supabase
    .from('google_tokens')
    .select('label, email')
    .eq('user_id', userId);
  return data || [];
}

async function writeIndexFile(userId, filename, content) {
  // Search for exact filename match in Mobius folder
  const found = await findDriveFile(userId, filename);
  // Only use files whose name exactly matches (avoid partial matches like email vs email.index)
  const exactMatch = (found.files || []).find(f => f.name === filename && f.inMobius)
                  || (found.files || []).find(f => f.name === filename);
  if (exactMatch) {
    await writeDriveFileContent(userId, exactMatch.id, content);
    return exactMatch.id;
  }
  // Create new — pass full filename including extension so Drive stores it correctly
  const newFile = await createDriveFile(userId, filename, found.folderId);
  await writeDriveFileContent(userId, newFile.id, content);
  return newFile.id;
}

async function updateSyncMeta(userId, label, type) {
  await supabase.from('sync_meta').upsert({
    user_id: userId, label, type,
    synced_at: new Date().toISOString()
  }, { onConflict: 'user_id, label, type' });
}

async function syncCalendars(userId, since) {
  const accounts = await getConnectedLabels(userId);
  const lines = ['# calendar.index', '# Generated: ' + new Date().toLocaleString('en-AU'), '# Format: [label] start → end | title', ''];
  for (const { label, email } of accounts) {
    try {
      const client   = await getGoogleClient(userId, label);
      const calendar = google.calendar({ version: 'v3', auth: client });
      const timeMin  = since ? new Date(since).toISOString() : new Date().toISOString();
      const timeMax  = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
      const res = await calendar.events.list({ calendarId: 'primary', timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 250 });
      const events = res.data.items || [];
      lines.push('## ' + label + ' (' + email + ') — ' + events.length + ' events');
      for (const e of events) {
        const start = e.start?.dateTime || e.start?.date || '';
        const end   = e.end?.dateTime   || e.end?.date   || '';
        lines.push('[' + label + '] ' + start + ' → ' + end + ' | ' + (e.summary || '(no title)') + (e.location ? ' @ ' + e.location : ''));
      }
      lines.push('');
      await updateSyncMeta(userId, label, 'calendar');
    } catch (err) { lines.push('## ' + label + ' — ERROR: ' + err.message); lines.push(''); }
  }
  await writeIndexFile(userId, 'calendar.index', lines.join('\n'));
  return { ok: true, events: lines.length };
}

async function syncEmails(userId, since) {
  const accounts = await getConnectedLabels(userId);
  const lines = ['# email.index', '# Generated: ' + new Date().toLocaleString('en-AU'), '# Format: [label] date | from | subject', ''];
  for (const { label, email } of accounts) {
    try {
      const client = await getGoogleClient(userId, label);
      const gmail  = google.gmail({ version: 'v1', auth: client });
      let q = 'is:unread';
      if (since) q += ' after:' + Math.floor(new Date(since).getTime() / 1000);
      const listRes  = await gmail.users.messages.list({ userId: 'me', maxResults: 100, q });
      const messages = listRes.data.messages || [];
      lines.push('## ' + label + ' (' + email + ') — ' + messages.length + ' unread');
      const details = await Promise.all(messages.map(m => gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] })));
      for (const d of details) {
        const h = d.data.payload?.headers || [];
        lines.push('[' + label + '] ' + (h.find(x => x.name === 'Date')?.value || '') + ' | ' + (h.find(x => x.name === 'From')?.value || '(unknown)') + ' | ' + (h.find(x => x.name === 'Subject')?.value || '(no subject)'));
      }
      lines.push('');
      await updateSyncMeta(userId, label, 'email');
    } catch (err) { lines.push('## ' + label + ' — ERROR: ' + err.message); lines.push(''); }
  }
  await writeIndexFile(userId, 'email.index', lines.join('\n'));
  return { ok: true, messages: lines.length };
}

async function syncDrive(userId, since) {
  const accounts = await getConnectedLabels(userId);
  const lines = ['# drive.index', '# Generated: ' + new Date().toLocaleString('en-AU'), '# Format: [label] modified | name', ''];
  for (const { label, email } of accounts) {
    try {
      const client = await getGoogleClient(userId, label);
      const drive  = google.drive({ version: 'v3', auth: client });
      let q = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
      if (since) q += " and modifiedTime > '" + new Date(since).toISOString() + "'";
      const res   = await drive.files.list({ q, fields: 'files(id, name, mimeType, modifiedTime)', orderBy: 'modifiedTime desc', pageSize: 500 });
      const files = res.data.files || [];
      lines.push('## ' + label + ' (' + email + ') — ' + files.length + ' files');
      for (const f of files) lines.push('[' + label + '] ' + (f.modifiedTime || '') + ' | ' + f.name);
      lines.push('');
      await updateSyncMeta(userId, label, 'drive');
    } catch (err) { lines.push('## ' + label + ' — ERROR: ' + err.message); lines.push(''); }
  }
  await writeIndexFile(userId, 'drive.index', lines.join('\n'));
  return { ok: true, files: lines.length };
}

async function syncAll(userId, since) {
  const [calendars, emails, drive] = await Promise.allSettled([
    syncCalendars(userId, since),
    syncEmails(userId, since),
    syncDrive(userId, since)
  ]);
  return {
    calendars: calendars.status === 'fulfilled' ? calendars.value : { ok: false, error: calendars.reason?.message },
    emails:    emails.status    === 'fulfilled' ? emails.value    : { ok: false, error: emails.reason?.message },
    drive:     drive.status     === 'fulfilled' ? drive.value     : { ok: false, error: drive.reason?.message }
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const { action } = req.query;

  // ── chat history ──────────────────────────────────────────────────────────
  if (action === 'history') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const sessions = await getChatHistory(userId, 10000);
    return res.status(200).json({ sessions });
  }

  // ── sync status ───────────────────────────────────────────────────────────
  if (action === 'sync-status') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const { data, error } = await supabase
        .from('sync_meta')
        .select('label, type, synced_at')
        .eq('user_id', userId)
        .order('label').order('type');
      if (error) throw error;
      return res.json({ status: data || [] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── sync ──────────────────────────────────────────────────────────────────
  if (action === 'sync') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, type, since } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      let result;
      if      (type === 'calendars') result = await syncCalendars(userId, since);
      else if (type === 'emails')    result = await syncEmails(userId, since);
      else if (type === 'drive')     result = await syncDrive(userId, since);
      else                           result = await syncAll(userId, since);
      return res.json({ ok: true, type: type || 'all', result });
    } catch (err) {
      console.error('Sync error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(400).json({ error: 'Unknown action: ' + action });
};
