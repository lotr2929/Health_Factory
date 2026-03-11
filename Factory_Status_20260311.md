# Factory_Health — Session Summary
*For continuation in next chat session*

---

## What We Built Today

Scaffolded Factory_Health — an autonomous health domain knowledge crawler, evaluator, and knowledge base. Cloned from Mobius_Vercel, pruned down to a clean base, and designed the full architecture.

---

## Project Details

- **Folder:** `C:\Users\263350F\Mobius\Factory_Health`
- **Vercel project:** Factory_Health (newly created, domain TBD — check Vercel dashboard)
- **Supabase project:** Health_Factory (fresh project, separate from Mobius)
- **Gemini key:** Shared with Mobius for now
- **GitHub repo:** Factory_Health

### Environment Variables (set in Vercel)
| Name | Source |
|------|--------|
| `SUPABASE_URL` | Health_Factory Supabase project |
| `SUPABASE_PUBLISHABLE_KEY` | Health_Factory Supabase project |
| `GEMINI_API_KEY` | Shared with Mobius |

**Note:** `_supabase.js` currently references `SUPABASE_KEY` — needs updating to `SUPABASE_PUBLISHABLE_KEY`.

### Current File Structure
```
Factory_Health/
  api/
    _ai.js          — AI callers (Gemini, Groq, etc.) — inherited from Mobius
    _supabase.js    — Supabase client — inherited from Mobius
    auth/           — empty, reserved for Google OAuth
    query/          — empty, will become Knowledge API endpoint
  .env.local
  vercel.json
  package.json
  deploy.bat
  backup.bat
  cleanup.bat
```

---

## Architecture

Three-layer system:

1. **Factory** (this project) — autonomous crawler + Gemini evaluator + knowledge base
2. **Knowledge API** — clean query endpoint Mobius calls
3. **Mobius** — personal AI layer that calls the API and delivers to user

### Factory Internals
- `objectives` — research briefs you write
- `sources` — URLs Gemini proposes, you approve
- `findings` — Gemini's evaluated content, pending your review
- `knowledge` — approved, production knowledge entries

### Operational Modes
- **Autonomous mode** — scheduled crawl + evaluate, queues findings
- **Meeting mode** — you open admin page, Gemini briefs you, you review findings, approve/discard, redirect focus

---

## Design Decisions Made

- **Research objective:** You type a brief → Gemini proposes research plan (sources, angles, traditions)
- **Exploratory:** Gemini explores freely, surfaces unexpected connections, you validate
- **Meeting cadence:** Daily or weekly review sessions
- **Admin access:** Google OAuth — reusing Mobius OAuth client (Mobius PWA Google Cloud project)
- **Google OAuth:** Add Factory_Health Vercel domain to existing Mobius OAuth client in Google Cloud Console

---

## Next Steps (in order)

### 1. Get Factory Vercel domain
Check Vercel dashboard → Factory_Health project → Domains tab. Note the exact URL.

### 2. Add to Google Cloud Console
- Go to console.cloud.google.com → Mobius PWA project
- APIs & Services → Credentials → existing OAuth 2.0 Client ID
- Add to Authorised redirect URIs: `https://[factory-domain].vercel.app/api/auth/google/callback`
- Add to Authorised JavaScript origins: `https://[factory-domain].vercel.app`

### 3. Fix SUPABASE_KEY reference
In `api/_supabase.js` line 3, change `SUPABASE_KEY` to `SUPABASE_PUBLISHABLE_KEY`.

### 4. Design Supabase schema
Four tables:
- `objectives` — id, brief, created_at, active
- `sources` — id, url, source_name, authority_weight, crawl_frequency, approved, proposed_by_gemini, created_at
- `findings` — id, source_id, url, topic_tags, confidence, technical, plain, practical, crawled_at, status (pending/approved/discarded)
- `knowledge` — id, finding_id, topic_tags, confidence, technical, plain, practical, approved_at

### 5. Build admin page (`admin/index.html`)
- Brief input panel → Gemini proposes research plan
- Meeting view → Gemini narrative briefing + finding cards (approve/discard)
- Google login gate

### 6. Build crawler (`api/crawl.js`)
### 7. Build evaluator (`api/evaluate.js`)
### 8. Set up Vercel cron scheduler

---

## How to Start the Next Session

1. Upload this file
2. Upload `api/_ai.js`, `api/_supabase.js`, `vercel.json`, `package.json` from Factory_Health
3. Say: "Continue Factory_Health build — next step is Supabase schema"
