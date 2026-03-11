# Mobius Factory

Autonomous domain knowledge crawler, evaluator, and knowledge base. Part of the Mobius system.

Factory builds and maintains Module Knowledge Layers (KLs) — one per domain — which Mobius subscribers access live via API.

**Admin panel:** `/admin` (Google OAuth, admin-only)

---

## Architecture

Factory runs a continuous three-stage loop:

1. **Brief** — admin sets research objectives and approves sources per module
2. **Crawl / Evaluate** — scheduled crawler fetches sources; Gemini evaluates findings against existing KL
3. **Review** — admin reviews pending findings, approves or discards; approved findings enter the KL

Each module (`health`, `money`, `legal`, `wellbeing` etc.) shares the same database, distinguished by a `module` column on every table.

---

## File Structure

```
api/
  _ai.js          ← AI callers (Gemini, Groq, Mistral, GitHub, web search)
  _supabase.js    ← Supabase client + provision()
  admin.js        ← All admin API actions
  auth/
    [service].js  ← Google OAuth with admin whitelist + session cookie
  query/
    [action].js   ← Public Knowledge Layer query endpoint (for Mobius subscribers)
admin/
  index.html      ← Admin panel UI
vercel.json
package.json
deploy.bat
backup.bat
```

---

## Modules

Modules are created via the admin panel. Each module is a named KL within the shared Supabase database. Switching modules in the admin panel scopes all reads and writes to that module.

Current modules: *(none yet — create via admin panel)*

---

## Environment Variables

Set in Vercel dashboard (Settings → Environment Variables):

```
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
GEMINI_API_KEY
GROQ_API_KEY
TAVILY_API_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI     ← https://[factory-domain].vercel.app/auth/google/callback
BASE_URL                ← https://[factory-domain].vercel.app
ADMIN_EMAIL             ← your Google account email
```

---

## Local Development

```bash
npm install
vercel dev    # runs on localhost:3000
```

---

## Deploy

```bat
deploy.bat
```
