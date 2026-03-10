const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getGoogleClient(userId, label = 'personal') {
  const { data } = await supabase
    .from('google_tokens')
    .select('access_token, refresh_token, expiry_date')
    .eq('user_id', userId)
    .eq('label', label)
    .single();
  if (!data) throw new Error('Google not connected for this user.');
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_date: data.expiry_date
  });
  return client;
}

// ── Drive ─────────────────────────────────────────────────────────────────────

async function getDriveFiles(userId, query) {
  const client = await getGoogleClient(userId);
  const drive = google.drive({ version: 'v3', auth: client });

  const foldersRes = await drive.files.list({
    q: "'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: 'files(id, name)',
    orderBy: 'name'
  });

  const filesRes = await drive.files.list({
    q: "'root' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false",
    fields: 'files(id, name, mimeType)',
    orderBy: 'name'
  });

  const folders = foldersRes.data.files || [];
  const files = filesRes.data.files || [];

  let result = 'Google Drive - My Drive:\n\nFolders:\n';
  result += folders.length ? folders.map(f => `  📁 ${f.name}`).join('\n') : '  (none)';
  result += '\n\nFiles:\n';
  result += files.length ? files.map(f => `  📄 ${f.name}`).join('\n') : '  (none)';

  return result;
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

async function getTasks(userId) {
  const client = await getGoogleClient(userId);
  const tasks = google.tasks({ version: 'v1', auth: client });
  const lists = await tasks.tasklists.list();
  if (!lists.data.items || !lists.data.items.length) return 'No task lists found.';

  let result = '';
  for (const list of lists.data.items) {
    const taskItems = await tasks.tasks.list({ tasklist: list.id, showCompleted: false });
    const items = taskItems.data.items || [];
    if (items.length) {
      result += `\n${list.title}:\n` + items.map((t, i) => `  ${i+1}. ${t.title}`).join('\n');
    }
  }
  return result || 'No pending tasks found.';
}

// ── Calendar ──────────────────────────────────────────────────────────────────

async function getCalendarEvents(userId) {
  const client = await getGoogleClient(userId);
  const calendar = google.calendar({ version: 'v3', auth: client });
  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: weekAhead.toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  });

  const events = res.data.items || [];
  if (!events.length) return 'No upcoming events in the next 7 days.';

  return 'Upcoming events (next 7 days):\n' + events.map((e, i) => {
    const start = e.start.dateTime || e.start.date;
    return `  ${i+1}. ${e.summary} — ${new Date(start).toLocaleString()}`;
  }).join('\n');
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

async function getEmails(userId) {
  const client = await getGoogleClient(userId);
  const gmail = google.gmail({ version: 'v1', auth: client });

  const res = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 10,
    q: 'is:unread'
  });

  const messages = res.data.messages || [];
  if (!messages.length) return 'No unread emails.';

  const details = await Promise.all(messages.map(m =>
    gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject', 'From'] })
  ));

  return 'Unread emails:\n' + details.map((d, i) => {
    const headers = d.data.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
    const from = headers.find(h => h.name === 'From')?.value || '(unknown)';
    return `  ${i+1}. ${subject}\n     From: ${from}`;
  }).join('\n');
}

// ── Focus: Read file content ────────────────────────────────────────────────

// Resolve a file's full path by walking up parent folders
async function getFilePath(drive, fileId, fileName) {
  const parts = [fileName];
  let currentId = fileId;
  for (let i = 0; i < 6; i++) { // max 6 levels deep
    try {
      const res = await drive.files.get({ fileId: currentId, fields: 'id, name, parents' });
      const parents = res.data.parents;
      if (!parents || parents.length === 0) break;
      const parentId = parents[0];
      const parentRes = await drive.files.get({ fileId: parentId, fields: 'id, name, parents' });
      const parentName = parentRes.data.name;
      if (parentName === 'My Drive' || !parentName) break;
      parts.unshift(parentName);
      currentId = parentId;
    } catch { break; }
  }
  return '/' + parts.join('/');
}

// Get or create the Mobius folder in Drive
async function getMobiusFolderId(drive) {
  const res = await drive.files.list({
    q: "name = 'Mobius' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: 'files(id)',
    pageSize: 1
  });
  if (res.data.files.length > 0) return res.data.files[0].id;
  // Create it
  const created = await drive.files.create({
    requestBody: { name: 'Mobius', mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });
  return created.data.id;
}

async function findDriveFile(userId, filename) {
  const client = await getGoogleClient(userId);
  const drive = google.drive({ version: 'v3', auth: client });
  const folderId = await getMobiusFolderId(drive);
  const safe = filename.replace(/'/g, "\\'");

  // Check Mobius folder first — exact name match to avoid partial collisions
  const mobiusRes = await drive.files.list({
    q: `'${folderId}' in parents and name = '${safe}' and trashed = false`,
    fields: 'files(id, name, mimeType, parents)',
    pageSize: 10
  });
  const mobiusRaw = mobiusRes.data.files || [];
  if (mobiusRaw.length > 0) {
    const mobiusFiles = await Promise.all(mobiusRaw.map(async f => ({
      ...f,
      inMobius: true,
      path: await getFilePath(drive, f.id, f.name)
    })));
    return { files: mobiusFiles, folderId };
  }

  // Fall back to whole Drive search — exact match only
  const res = await drive.files.list({
    q: `name = '${safe}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
    fields: 'files(id, name, mimeType, parents)',
    pageSize: 20
  });
  const allFiles = await Promise.all((res.data.files || []).map(async f => ({
    ...f,
    path: await getFilePath(drive, f.id, f.name)
  })));
  return { files: allFiles, folderId };
}

async function copyToMobiusFolder(userId, fileId, mimeType, filename, folderId) {
  const client = await getGoogleClient(userId);
  const drive = google.drive({ version: 'v3', auth: client });
  // Read original content
  let content = '';
  try {
    if (mimeType === 'application/vnd.google-apps.document') {
      const res = await drive.files.export({ fileId, mimeType: 'text/plain' });
      content = res.data || '';
    } else {
      const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
      content = res.data || '';
    }
  } catch { /* empty or unreadable */ }
  // Create copy in Mobius folder
  const copyName = filename.replace(/\.[^.]+$/, '') + '.md';
  const created = await drive.files.create({
    requestBody: { name: copyName, mimeType: 'text/plain', parents: [folderId] },
    media: { mimeType: 'text/plain', body: content },
    fields: 'id, name'
  });
  return { id: created.data.id, name: created.data.name, content };
}

async function updateOriginalFile(userId, originalFileId, content) {
  const client = await getGoogleClient(userId);
  const drive = google.drive({ version: 'v3', auth: client });
  await drive.files.update({
    fileId: originalFileId,
    media: { mimeType: 'text/plain', body: content }
  });
}

async function readDriveFileContent(userId, fileId, mimeType) {
  const client = await getGoogleClient(userId);
  const drive = google.drive({ version: 'v3', auth: client });
  if (mimeType === 'application/vnd.google-apps.document') {
    const res = await drive.files.export({ fileId, mimeType: 'text/plain' });
    return res.data;
  }
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
  return res.data;
}

async function createDriveFile(userId, filename, folderId) {
  const client = await getGoogleClient(userId);
  const drive = google.drive({ version: 'v3', auth: client });
  const resolvedFolder = folderId || await getMobiusFolderId(drive);
  // Use filename as-is — callers are responsible for passing the correct name with extension
  const res = await drive.files.create({
    requestBody: {
      name: filename,
      mimeType: 'text/plain',
      parents: [resolvedFolder]
    },
    media: { mimeType: 'text/plain', body: '' },
    fields: 'id, name'
  });
  return res.data;
}

async function writeDriveFileContent(userId, fileId, content) {
  const client = await getGoogleClient(userId);
  const tokenRes = await client.getAccessToken();
  const accessToken = tokenRes.token;

  const boundary = 'mobius_boundary';
  const metadata = JSON.stringify({ mimeType: 'text/plain' });
  const body = '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    metadata + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: text/plain\r\n\r\n' +
    content + '\r\n' +
    '--' + boundary + '--';

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files/' + fileId + '?uploadType=multipart', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'multipart/related; boundary=' + boundary
    },
    body
  });
  if (!res.ok) throw new Error('Drive write failed: ' + res.status + ' ' + await res.text());
}

// ── Google Account Info ───────────────────────────────────────────────────────

async function getGoogleAccountInfo(userId) {
  const client = await getGoogleClient(userId);
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const res = await oauth2.userinfo.get();
  return {
    email:   res.data.email   || 'unknown',
    name:    res.data.name    || 'unknown',
    picture: res.data.picture || null
  };
}

module.exports = {
  getGoogleClient,
  getDriveFiles,
  getTasks,
  getCalendarEvents,
  getEmails,
  findDriveFile,
  copyToMobiusFolder,
  updateOriginalFile,
  readDriveFileContent,
  createDriveFile,
  writeDriveFileContent,
  getGoogleAccountInfo
};