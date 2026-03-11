// api/crawl.js — Mobius Factory crawler + evaluator
//
// POST /api/crawl { module }
//   — picks the next approved source for the module (least recently crawled)
//   — fetches its content
//   — sends to Gemini for evaluation against the module's active brief
//   — saves structured findings to the findings table
//
// Also used by the Vercel cron job (vercel.json crons entry).

const { supabase } = require('./_supabase');
const { askGemini } = require('./_ai');

// ── Auth guard (same cookie check as admin.js) ────────────────────────────
async function getAuthedUser(req) {
  const cookie = req.headers.cookie || '';
  const match  = cookie.match(/fh_session=([^;]+)/);
  if (!match) return null;
  const token = decodeURIComponent(match[1]);
  const { data } = await supabase
    .from('google_tokens')
    .select('user_id')
    .eq('session_token', token)
    .single();
  return data || null;
}

function json(res, status, body) {
  res.status(status).json(body);
}

// ── Fetch and extract text from a URL ─────────────────────────────────────
async function fetchPageText(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MobiusFactory/1.0; +https://mobius-factory.vercel.app)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    signal: AbortSignal.timeout(8000)
  });

  if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching ' + url);

  const contentType = r.headers.get('content-type') || '';
  const html = await r.text();

  // Strip HTML tags and collapse whitespace
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000); // Keep first 6000 chars — enough for Gemini to evaluate

  if (!text || text.length < 100) throw new Error('Insufficient content extracted from ' + url);
  return text;
}

// ── Evaluate content against brief using Gemini ───────────────────────────
async function evaluateContent(text, url, module, brief, sessionNotes) {
  const prompt = [
    'You are evaluating a web page for the Mobius Factory ' + module.toUpperCase() + ' Knowledge Layer.',
    '',
    'Module brief: ' + brief,
    sessionNotes ? 'Research context: ' + sessionNotes : '',
    '',
    'Page URL: ' + url,
    'Page content (first 6000 chars):',
    text,
    '',
    'Your task: Extract 1–4 distinct knowledge findings from this page that are relevant to the module brief.',
    'For each finding, respond ONLY with a JSON array in this exact format — no preamble, no markdown:',
    '[',
    '  {',
    '    "topic_tags": ["tag1", "tag2"],',
    '    "confidence": 0.85,',
    '    "plain": "Plain language summary (1-2 sentences, for general users)",',
    '    "technical": "Technical detail (1-2 sentences, for specialists)",',
    '    "practical": "Practical implication or action (1 sentence)"',
    '  }',
    ']',
    '',
    'Rules:',
    '- confidence: 0.0–1.0 (consider source authority, specificity, evidence quality)',
    '- topic_tags: 2–5 lowercase tags, specific to the finding',
    '- If the page has no relevant content, return an empty array: []',
    '- Return ONLY the JSON array, nothing else'
  ].filter(Boolean).join('\n');

  const result = await askGemini([{ role: 'user', content: prompt }]);
  const raw = result.text.trim();

  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  let findings;
  try {
    findings = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Gemini returned invalid JSON: ' + raw.slice(0, 200));
  }

  if (!Array.isArray(findings)) throw new Error('Gemini response is not an array');
  return findings;
}

// ── Main handler ───────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  // Auth — allow both session cookie (manual) and cron secret (scheduled)
  const cronSecret = req.headers['x-cron-secret'];
  const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;
  if (!isCron) {
    const user = await getAuthedUser(req);
    if (!user) return json(res, 401, { error: 'Not authenticated' });
  }

  const module = (req.body?.module || '').toLowerCase().trim();
  if (!module) return json(res, 400, { error: 'module required' });

  try {
    // ── 1. Get next approved source to crawl ────────────────────────────
    // Pick the approved source that was least recently crawled (or never crawled)
    const { data: sources, error: srcErr } = await supabase
      .from('sources')
      .select('id, url, source_name, objective_id, last_crawled_at')
      .eq('module', module)
      .eq('approved', true)
      .order('last_crawled_at', { ascending: true, nullsFirst: true })
      .limit(1);

    if (srcErr) throw srcErr;
    if (!sources || sources.length === 0) {
      return json(res, 200, { processed: false, message: 'No approved sources to crawl. Add and approve sources in the Brief.' });
    }

    const source = sources[0];

    // ── 2. Get active brief + session notes for this module ─────────────
    const { data: objectives } = await supabase
      .from('objectives')
      .select('brief, session_notes')
      .eq('module', module)
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(1);

    const brief       = objectives?.[0]?.brief       || 'General ' + module + ' knowledge';
    const sessionNotes = objectives?.[0]?.session_notes || '';

    // ── 3. Fetch page content ────────────────────────────────────────────
    let pageText;
    try {
      pageText = await fetchPageText(source.url);
    } catch (fetchErr) {
      // Mark as attempted even on fetch failure so we don't retry immediately
      await supabase.from('sources').update({ last_crawled_at: new Date().toISOString() }).eq('id', source.id);
      return json(res, 200, {
        processed: false,
        message: 'Could not fetch ' + source.url + ': ' + fetchErr.message,
        source: source.source_name || source.url
      });
    }

    // ── 4. Evaluate with Gemini ──────────────────────────────────────────
    let findings;
    try {
      findings = await evaluateContent(pageText, source.url, module, brief, sessionNotes);
    } catch (evalErr) {
      await supabase.from('sources').update({ last_crawled_at: new Date().toISOString() }).eq('id', source.id);
      return json(res, 200, {
        processed: false,
        message: 'Evaluation failed for ' + source.url + ': ' + evalErr.message,
        source: source.source_name || source.url
      });
    }

    // ── 5. Save findings ─────────────────────────────────────────────────
    let savedCount = 0;
    if (findings.length > 0) {
      const rows = findings.map(f => ({
        module,
        source_id:  source.id,
        url:        source.url,
        topic_tags: f.topic_tags  || [],
        confidence: f.confidence  || 0.5,
        technical:  f.technical   || '',
        plain:      f.plain       || '',
        practical:  f.practical   || '',
        status:     'pending'
      }));

      const { error: insertErr } = await supabase.from('findings').insert(rows);
      if (insertErr) throw insertErr;
      savedCount = rows.length;
    }

    // ── 6. Update last_crawled_at on source ──────────────────────────────
    await supabase
      .from('sources')
      .update({ last_crawled_at: new Date().toISOString() })
      .eq('id', source.id);

    return json(res, 200, {
      processed:  true,
      source:     source.source_name || source.url,
      url:        source.url,
      findings:   savedCount,
      message:    savedCount > 0
        ? 'Crawled ' + (source.source_name || source.url) + ' — ' + savedCount + ' finding' + (savedCount !== 1 ? 's' : '') + ' added'
        : 'Crawled ' + (source.source_name || source.url) + ' — no relevant content found'
    });

  } catch (err) {
    console.error('[crawl] error:', err.message);
    return json(res, 500, { error: err.message });
  }
};
