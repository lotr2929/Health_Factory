// api/auth/[service].js — Factory Google OAuth
// GET /auth/google          → action=index   — initiates OAuth
// GET /auth/google/callback → action=callback — handles redirect from Google
// GET /auth/google/status   → action=status  — checks session cookie

const { google } = require('googleapis');
const { supabase } = require('../_supabase');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { service, action } = req.query;
  if (service !== 'google') return res.status(400).json({ error: 'Unknown service' });

  const ADMIN_EMAIL   = process.env.ADMIN_EMAIL;
  const BASE_URL      = process.env.BASE_URL || '';
  const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI;

  // ── Initiate OAuth ────────────────────────────────────────────────────────
  if (action === 'index') {
    const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile'
      ],
      prompt: 'consent'
    });
    return res.redirect(url);
  }

  // ── OAuth callback ────────────────────────────────────────────────────────
  if (action === 'callback') {
    try {
      const { code } = req.query;
      if (!code) return res.status(400).json({ error: 'No authorization code' });

      const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
      const { tokens } = await oauth2Client.getToken(code);

      // Get user profile
      const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: 'Bearer ' + tokens.access_token }
      });
      const profile = await profileRes.json();

      // Admin whitelist check
      if (!ADMIN_EMAIL || profile.email !== ADMIN_EMAIL) {
        return res.status(403).send(`
          <html><body style="font-family:sans-serif;padding:40px;background:#e2dccd">
            <h2 style="color:#574d3e">Access denied</h2>
            <p style="color:#8d7c64">${profile.email} is not authorised to access Factory admin.</p>
            <a href="/admin" style="color:#8d7c64">Back</a>
          </body></html>
        `);
      }

      // Generate session token
      const sessionToken = crypto.randomBytes(32).toString('hex');

      // Upsert into google_tokens
      const { error } = await supabase.from('google_tokens').upsert({
        user_id:       profile.id,
        email:         profile.email,
        name:          profile.name,
        picture:        profile.picture,
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token || null,
        expiry_date:   tokens.expiry_date   || null,
        session_token: sessionToken
      }, { onConflict: 'user_id' });

      if (error) throw new Error('Failed to save session: ' + error.message);

      // Set session cookie — httpOnly, secure in production
      const isProd = !BASE_URL.includes('localhost');
      res.setHeader('Set-Cookie',
        `fh_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax${isProd ? '; Secure' : ''}; Max-Age=604800`
      );
      return res.redirect(BASE_URL + '/admin');

    } catch (err) {
      console.error('[auth] callback error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Session status ────────────────────────────────────────────────────────
  if (action === 'status') {
    try {
      const cookie = req.headers.cookie || '';
      const match  = cookie.match(/fh_session=([^;]+)/);
      if (!match) return res.status(200).json({ authenticated: false });

      const token = decodeURIComponent(match[1]);
      const { data, error } = await supabase
        .from('google_tokens')
        .select('user_id, email, name, picture')
        .eq('session_token', token)
        .single();

      if (error || !data) return res.status(200).json({ authenticated: false });
      return res.status(200).json({ authenticated: true, ...data });

    } catch {
      return res.status(200).json({ authenticated: false });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
};
