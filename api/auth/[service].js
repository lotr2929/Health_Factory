// ── api/auth/[service].js ─────────────────────────────────────────────────────
// GET /auth/google          → service=google&action=index
// GET /auth/google/callback → service=google&action=callback
// GET /auth/google/status   → service=google&action=status
// GET /auth/dropbox         → service=dropbox&action=index
// GET /auth/dropbox/callback→ service=dropbox&action=callback

const { google }   = require('googleapis');
const { supabase } = require('../_supabase.js');
const { createClient } = require('@supabase/supabase-js');

const dbx = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { service, action } = req.query;

  // ── Google OAuth ──────────────────────────────────────────────────────────

  if (service === 'google') {

    if (action === 'index') {
      try {
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          process.env.GOOGLE_REDIRECT_URI
        );
        const scopes = [
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/tasks',
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/userinfo.profile'
        ];
        const returnTo = req.query.returnTo || process.env.BASE_URL || '';
        const label    = req.query.label    || 'personal';
        const state    = JSON.stringify({ userId: req.query.userId || '', returnTo, label });
        const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: scopes, prompt: 'consent', state });
        return res.redirect(url);
      } catch (err) {
        console.error('Google auth error:', err);
        return res.status(500).json({ error: 'Failed to initiate Google auth' });
      }
    }

    if (action === 'callback') {
      try {
        const { code, state: rawState } = req.query;
        if (!code) return res.status(400).json({ error: 'Authorization code is required' });
        let userId = '', returnTo = process.env.BASE_URL || '', label = 'personal';
        try {
          const parsed = JSON.parse(rawState);
          userId   = parsed.userId   || '';
          returnTo = parsed.returnTo || returnTo;
          label    = parsed.label    || 'personal';
        } catch { userId = rawState || ''; }

        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          process.env.GOOGLE_REDIRECT_URI
        );
        const { tokens } = await oauth2Client.getToken(code);
        const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: 'Bearer ' + tokens.access_token }
        });
        const userInfo = await userinfoRes.json();
        if (!userId) return res.status(400).json({ error: 'No userId provided in OAuth state' });

        const { error: upsertError } = await supabase.from('google_tokens').upsert({
          user_id: userId, label, email: userInfo.email,
          access_token: tokens.access_token, refresh_token: tokens.refresh_token, expiry_date: tokens.expiry_date
        }, { onConflict: 'user_id, label' });
        if (upsertError) return res.status(500).json({ error: 'Failed to save tokens: ' + upsertError.message });
        if (!returnTo) throw new Error('BASE_URL not set.');
        return res.redirect(`${returnTo}?google_email=${encodeURIComponent(userInfo.email)}`);
      } catch (err) {
        console.error('Google callback error:', err);
        return res.status(500).json({ error: 'Failed to complete Google auth' });
      }
    }

    if (action === 'status') {
      const { userId } = req.query;
      if (!userId) return res.status(200).json({ connected: false });
      try {
        const { data } = await supabase.from('google_tokens').select('user_id').eq('user_id', userId).single();
        return res.status(200).json({ connected: !!data });
      } catch { return res.status(200).json({ connected: false }); }
    }
  }

  // ── Dropbox OAuth ─────────────────────────────────────────────────────────

  if (service === 'dropbox') {

    if (action === 'index') {
      const userId   = req.query.userId   || '';
      const returnTo = req.query.returnTo || process.env.BASE_URL || '';
      if (!userId) return res.status(400).json({ error: 'userId required' });
      const state  = JSON.stringify({ userId, returnTo });
      const params = new URLSearchParams({
        client_id: process.env.DROPBOX_APP_KEY, redirect_uri: process.env.DROPBOX_REDIRECT_URI,
        response_type: 'code', state, token_access_type: 'offline'
      });
      return res.redirect('https://www.dropbox.com/oauth2/authorize?' + params.toString());
    }

    if (action === 'callback') {
      const { code, state: rawState } = req.query;
      if (!code) return res.status(400).json({ error: 'Authorization code required' });
      let userId = '', returnTo = process.env.BASE_URL || '';
      try {
        const parsed = JSON.parse(rawState);
        userId   = parsed.userId   || '';
        returnTo = parsed.returnTo || returnTo;
      } catch { userId = rawState || ''; }
      if (!userId) return res.status(400).json({ error: 'No userId in state' });
      try {
        const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code, grant_type: 'authorization_code',
            client_id: process.env.DROPBOX_APP_KEY, client_secret: process.env.DROPBOX_APP_SECRET,
            redirect_uri: process.env.DROPBOX_REDIRECT_URI
          })
        });
        const tokens = await tokenRes.json();
        if (tokens.error) throw new Error(tokens.error_description || tokens.error);
        const { error: upsertError } = await dbx.from('dropbox_tokens').upsert({
          user_id: userId, access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || null,
          expiry_date: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null
        }, { onConflict: 'user_id' });
        if (upsertError) throw new Error('Failed to save tokens: ' + upsertError.message);
        return res.redirect(returnTo + '?dropbox_connected=true');
      } catch (err) {
        console.error('Dropbox callback error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }
  }

  res.status(400).json({ error: 'Unknown service/action: ' + service + '/' + action });
};
