// ── api/auth/user/[action].js ─────────────────────────────────────────────────
// POST /api/login   → action = 'login'
// POST /api/signup  → action = 'signup'

const { createClient } = require('@supabase/supabase-js');
const { supabase: db } = require('../../_supabase.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end(JSON.stringify({ error: 'Method not allowed' }));

  res.setHeader('Content-Type', 'application/json');

  const { action } = req.query;
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).end(JSON.stringify({ error: 'Username and password are required' }));
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  // ── login ─────────────────────────────────────────────────────────────────
  if (action === 'login') {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: username, password });
      if (error || !data.user) {
        return res.status(401).end(JSON.stringify({ error: 'Invalid username or password' }));
      }
      const maxAge = 365 * 24 * 60 * 60;
      res.setHeader('Set-Cookie', [
        `mobius_user_id=${data.user.id}; Max-Age=${maxAge}; Path=/; SameSite=Lax`,
        `mobius_username=${encodeURIComponent(data.user.email)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`
      ]);
      return res.status(200).end(JSON.stringify({
        userId: data.user.id,
        username: data.user.email,
        message: 'Login successful'
      }));
    } catch (err) {
      console.error('Login error:', err);
      return res.status(500).end(JSON.stringify({ error: 'Login failed', details: err.message }));
    }
  }

  // ── signup ────────────────────────────────────────────────────────────────
  if (action === 'signup') {
    try {
      const { data, error } = await supabase.auth.signUp({ email: username, password });
      if (error || !data.user) {
        return res.status(400).end(JSON.stringify({ error: error?.message || 'Signup failed' }));
      }
      await db.from('users').upsert({
        id: data.user.id,
        username: data.user.email,
        password
      }, { onConflict: 'id' });
      return res.status(200).end(JSON.stringify({
        userId: data.user.id,
        username: data.user.email,
        message: 'User created successfully'
      }));
    } catch (err) {
      console.error('Signup error:', err);
      return res.status(500).end(JSON.stringify({ error: 'Signup failed', details: err.message }));
    }
  }

  res.status(400).end(JSON.stringify({ error: 'Unknown action: ' + action }));
};
