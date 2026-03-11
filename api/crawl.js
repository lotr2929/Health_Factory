// api/crawl.js — Mobius Factory autonomous research engine
//
// POST /api/crawl { module, queryId }
//
// Per run:
//   1. Load the active query (agreed text + target source count)
//   2. Load brief (mission + research objectives) for context
//   3. Gemini generates Tavily search queries from the research query
//   4. Search + evaluate loop — keeps going until target met or exhausted
//   5. Save findings linked to the query
//   6. Update query status (running → complete when target met)

const { supabase } = require('./_supabase');
const { askGemini } = require('./_ai');

// ── Auth guard ─────────────────────────────────────────────────────────────
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

function json(res, status, body) { res.status(status).json(body); }

// ── Generate Tavily search queries from research query + brief ────────────
async function generateSearchQueries(researchQuery, brief, sessionNotes, module) {
  const prompt = [
    'You are a research assistant for the Mobius Factory ' + module.toUpperCase() + ' Knowledge Layer.',
    '',
    'Module mission: ' + brief,
    sessionNotes ? 'Research context: ' + sessionNotes : '',
    '',
    'The admin wants to research this specific question:',
    '"' + researchQuery + '"',
    '',
    'Generate 4–6 specific web search queries to find authoritative, high-quality sources that answer this question.',
    'Each query should target a different angle — different source types, different aspects of the question.',
    '',
    'Target: peer-reviewed research, clinical guidelines, government health bodies, reputable institutions.',
    'Avoid: news articles, opinion pieces, commercial sites unless uniquely authoritative.',
    '',
    'Respond ONLY with a JSON array of query strings:',
    '["query 1", "query 2", "query 3", "query 4"]'
  ].filter(Boolean).join('\n');

  const result = await askGemini([{ role: 'user', content: prompt }]);
  const raw = result.text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    const queries = JSON.parse(raw);
    if (!Array.isArray(queries)) throw new Error('Not array');
    return queries.slice(0, 6).filter(q => typeof q === 'string' && q.length > 0);
  } catch {
    const matches = raw.match(/"([^"]+)"/g);
    if (matches) return matches.map(m => m.replace(/"/g, '')).slice(0, 6);
    throw new Error('Could not parse queries: ' + raw.slice(0, 200));
  }
}

// ── Tavily search ─────────────────────────────────────────────────────────
async function tavilySearch(query) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY not set');
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key:             key,
      query,
      search_depth:        'advanced',
      max_results:         10,
      include_answer:      true,
      include_raw_content: true
    })
  });
  const data = await r.json();
  if (data.error) throw new Error('Tavily: ' + (data.error.message || JSON.stringify(data.error)));
  return data.results || [];
}

// ── Gemini evaluates a batch of results ──────────────────────────────────
async function evaluateBatch(results, researchQuery, brief, sessionNotes, module, existingUrls) {
  const fresh = results.filter(r => !existingUrls.has(r.url));
  if (fresh.length === 0) return [];

  const context = fresh.map((r, i) => [
    '[' + (i + 1) + '] ' + r.title,
    'URL: ' + r.url,
    'Summary: ' + (r.content || '').slice(0, 500),
    r.raw_content ? 'Detail: ' + r.raw_content.slice(0, 1500) : ''
  ].filter(Boolean).join('\n')).join('\n\n---\n\n');

  const prompt = [
    'You are evaluating web search results for the Mobius Factory ' + module.toUpperCase() + ' Knowledge Layer.',
    '',
    'Module mission: ' + brief,
    sessionNotes ? 'Research context: ' + sessionNotes : '',
    '',
    'Research question being answered: "' + researchQuery + '"',
    '',
    'Search results:',
    context,
    '',
    'For each result that meaningfully answers the research question and is high quality, extract a finding.',
    'Be selective — only include results that genuinely contribute to answering the question.',
    'Skip: off-topic, low quality, purely commercial, duplicate information.',
    '',
    'Respond ONLY with a JSON array (empty array if nothing qualifies):',
    '[{',
    '  "url": "exact URL",',
    '  "topic_tags": ["tag1", "tag2"],',
    '  "confidence": 0.85,',
    '  "plain": "2-3 sentence plain language summary",',
    '  "technical": "2-3 sentence technical detail",',
    '  "practical": "1-2 sentence practical implication"',
    '}]',
    '',
    'confidence: 0–1 (source authority + relevance to question). Only include ≥ 0.6.',
    'Return ONLY the JSON array.'
  ].filter(Boolean).join('\n');

  const result = await askGemini([{ role: 'user', content: prompt }]);
  const raw = result.text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    const findings = JSON.parse(raw);
    if (!Array.isArray(findings)) return [];
    return findings.filter(f => f.url && (f.confidence || 0) >= 0.6);
  } catch {
    console.warn('[crawl] JSON parse failed:', raw.slice(0, 200));
    return [];
  }
}

// ── Main handler ───────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  // Auth
  const cronSecret = req.headers['x-cron-secret'];
  const isCron     = cronSecret && cronSecret === process.env.CRON_SECRET;
  if (!isCron) {
    const user = await getAuthedUser(req);
    if (!user) return json(res, 401, { error: 'Not authenticated' });
  }

  let module  = (req.body?.module  || '').toLowerCase().trim();
  let queryId =  req.body?.queryId || null;

  // Cron — pick least-recently-crawled module + its active query
  if (isCron && !module) {
    const { data: mods } = await supabase
      .from('modules')
      .select('name, last_cron_crawled_at')
      .order('last_cron_crawled_at', { ascending: true, nullsFirst: true })
      .limit(1);
    if (!mods?.length) return json(res, 200, { processed: false, message: 'No modules' });
    module = mods[0].name;
    await supabase.from('modules')
      .update({ last_cron_crawled_at: new Date().toISOString() })
      .eq('name', module);
  }

  if (!module) return json(res, 400, { error: 'module required' });

  try {
    // ── 1. Load active query ───────────────────────────────────────────
    let queryRow;
    if (queryId) {
      const { data } = await supabase
        .from('queries')
        .select('*')
        .eq('id', queryId)
        .single();
      queryRow = data;
    } else {
      // Pick the most recent running or pending query for this module
      const { data } = await supabase
        .from('queries')
        .select('*')
        .eq('module', module)
        .in('status', ['pending', 'running'])
        .order('created_at', { ascending: false })
        .limit(1);
      queryRow = data?.[0];
    }

    if (!queryRow) {
      return json(res, 200, {
        processed: false,
        message: 'No active query found for module "' + module + '". Discuss and agree on a query in the Brief session first.'
      });
    }

    // Check if already met target
    if (queryRow.findings_count >= queryRow.target_sources) {
      return json(res, 200, {
        processed: false,
        message: 'Query target already met (' + queryRow.findings_count + '/' + queryRow.target_sources + '). Start a new query or review findings.'
      });
    }

    // Mark as running
    await supabase.from('queries').update({ status: 'running' }).eq('id', queryRow.id);

    // ── 2. Load brief for context ──────────────────────────────────────
    const { data: objectives } = await supabase
      .from('objectives')
      .select('brief, session_notes')
      .eq('module', module)
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(1);

    const brief        = objectives?.[0]?.brief        || 'General ' + module + ' knowledge';
    const sessionNotes = objectives?.[0]?.session_notes || '';

    // ── 3. Load existing URLs for dedup ───────────────────────────────
    const { data: existing } = await supabase
      .from('findings')
      .select('url')
      .eq('module', module);
    const existingUrls = new Set((existing || []).map(f => f.url).filter(Boolean));

    // ── 4. Generate search queries ─────────────────────────────────────
    const searchQueries = await generateSearchQueries(
      queryRow.query, brief, sessionNotes, module
    );

    if (!searchQueries.length) {
      await supabase.from('queries').update({ status: 'pending' }).eq('id', queryRow.id);
      return json(res, 200, { processed: false, message: 'Could not generate search queries' });
    }

    // ── 5. Search + evaluate loop ──────────────────────────────────────
    let allFindings   = [];
    const target      = queryRow.target_sources;
    const alreadyHave = queryRow.findings_count;
    const stillNeed   = target - alreadyHave;

    for (const sq of searchQueries) {
      if (allFindings.length >= stillNeed) break; // target met

      let results;
      try { results = await tavilySearch(sq); }
      catch (e) { console.warn('[crawl] Tavily failed:', e.message); continue; }

      let batch;
      try {
        batch = await evaluateBatch(
          results, queryRow.query, brief, sessionNotes, module, existingUrls
        );
      } catch (e) { console.warn('[crawl] Eval failed:', e.message); continue; }

      for (const f of batch) { if (f.url) existingUrls.add(f.url); }
      allFindings = allFindings.concat(batch);
    }

    // ── 6. Save findings ───────────────────────────────────────────────
    let savedCount = 0;
    if (allFindings.length > 0) {
      const rows = allFindings.map(f => ({
        module,
        query_id:   queryRow.id,
        source_id:  null,
        url:        f.url,
        topic_tags: f.topic_tags || [],
        confidence: f.confidence || 0.7,
        technical:  f.technical  || '',
        plain:      f.plain      || '',
        practical:  f.practical  || '',
        status:     'pending'
      }));
      const { error } = await supabase.from('findings').insert(rows);
      if (error) throw error;
      savedCount = rows.length;
    }

    // ── 7. Update query progress ───────────────────────────────────────
    const newCount = alreadyHave + savedCount;
    const newStatus = newCount >= target ? 'complete' : 'running';
    await supabase.from('queries').update({
      findings_count: newCount,
      status:         newStatus,
      completed_at:   newStatus === 'complete' ? new Date().toISOString() : null
    }).eq('id', queryRow.id);

    return json(res, 200, {
      processed:  true,
      queryId:    queryRow.id,
      query:      queryRow.query,
      target:     target,
      found:      newCount,
      newFindings: savedCount,
      complete:   newStatus === 'complete',
      message:    savedCount + ' new finding' + (savedCount !== 1 ? 's' : '') + ' added' +
                  (newStatus === 'complete' ? ' — target reached! Ready for review.' : ' (' + newCount + '/' + target + ')')
    });

  } catch (err) {
    console.error('[crawl] error:', err.message);
    return json(res, 500, { error: err.message });
  }
};
