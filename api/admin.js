// api/admin.js — Mobius Factory admin API
// Routes (via vercel.json): /api/admin/:action
//
// Actions:
//   GET  stats           — objective/pending/knowledge counts (scoped to module)
//   GET  modules         — list distinct modules in DB
//   GET  objectives      — list objectives for active module
//   POST objectives      — create objective in active module
//   POST brief-chat      — Gemini brief conversation turn
//   POST brief-end       — finalise brief: save session_notes + sources
//   POST sources         — save a single approved source
//   GET  findings        — list pending findings for active module
//   PATCH findings       — approve or discard a finding
//   GET  knowledge       — list knowledge entries for active module
//   POST review-chat     — Gemini review conversation turn
//   POST provision       — auto-create schema if missing

const { supabase, provision } = require('./_supabase');
const { askGemini, askWebSearch, detectsCutoff } = require('./_ai');

// ── Auth guard ─────────────────────────────────────────────────────────────
async function getAuthedUser(req) {
  const cookie = req.headers.cookie || '';
  const match  = cookie.match(/fh_session=([^;]+)/);
  if (!match) return null;
  const token = decodeURIComponent(match[1]);
  const { data } = await supabase
    .from('google_tokens')
    .select('user_id, email, name, picture')
    .eq('session_token', token)
    .single();
  return data || null;
}

function json(res, status, body) {
  res.status(status).json(body);
}

// ── Main handler ────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = req.query.action;

  // Auth check
  const user = await getAuthedUser(req);
  if (!user) return json(res, 401, { error: 'Not authenticated' });

  // Active module — passed as query param or request body
  const module = (req.query.module || req.body?.module || '').toLowerCase().trim();

  try {
    switch (action) {

      // ── PROVISION ──────────────────────────────────────────────────────
      case 'provision': {
        const ok = await provision();
        return json(res, 200, { ok });
      }

      // ── MODULES ────────────────────────────────────────────────────────
      case 'modules': {
        if (req.method === 'POST') {
          // Create a new module
          const { name } = req.body;
          if (!name) return json(res, 400, { error: 'name required' });
          const { error } = await supabase
            .from('modules')
            .upsert([{ name }], { onConflict: 'name' });
          if (error) throw error;
          return json(res, 201, { name });
        }
        // GET — return all modules
        const { data, error } = await supabase
          .from('modules')
          .select('name')
          .order('name');
        if (error) throw error;
        return json(res, 200, (data || []).map(r => r.name));
      }

      // ── STATS ──────────────────────────────────────────────────────────
      case 'stats': {
        if (!module) return json(res, 400, { error: 'module required' });
        const [{ count: objectives }, { count: pending }, { count: knowledge }, { count: queries }] = await Promise.all([
          supabase.from('objectives').select('*', { count: 'exact', head: true }).eq('module', module),
          supabase.from('findings').select('*', { count: 'exact', head: true }).eq('module', module).eq('status', 'pending'),
          supabase.from('knowledge').select('*', { count: 'exact', head: true }).eq('module', module),
          supabase.from('queries').select('*', { count: 'exact', head: true }).eq('module', module)
        ]);
        return json(res, 200, { objectives, pending, knowledge, queries, module });
      }

      // ── OBJECTIVES ─────────────────────────────────────────────────────
      case 'objectives': {
        if (!module) return json(res, 400, { error: 'module required' });
        if (req.method === 'GET') {
          const { data, error } = await supabase
            .from('objectives')
            .select('*')
            .eq('module', module)
            .order('created_at', { ascending: false });
          if (error) throw error;
          return json(res, 200, data);
        }
        if (req.method === 'POST') {
          const { brief } = req.body;
          if (!brief) return json(res, 400, { error: 'brief required' });
          const { data, error } = await supabase
            .from('objectives')
            .insert([{ module, brief, active: true }])
            .select()
            .single();
          if (error) throw error;
          return json(res, 201, data);
        }
        return json(res, 405, { error: 'Method not allowed' });
      }

      // ── BRIEF CHAT ─────────────────────────────────────────────────────
      case 'brief-chat': {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const { objectiveId, messages } = req.body;
        if (!objectiveId || !messages) return json(res, 400, { error: 'objectiveId and messages required' });

        const { data: obj } = await supabase
          .from('objectives')
          .select('brief, session_notes, module')
          .eq('id', objectiveId)
          .single();

        const isSummaryRequest = req.body.summaryRequest === true;

        const systemPrompt = [
          'You are Gemini, the research partner for Mobius Factory — an autonomous knowledge base system.',
          'You are working on the ' + (obj?.module || 'unknown').toUpperCase() + ' module.',
          '',
          'Your role is to converse naturally with the admin to understand their research interest for this module.',
          'Listen carefully, ask clarifying questions, and help shape their thinking.',
          '',
          obj?.session_notes ? 'Previous session notes: ' + obj.session_notes : '',
          '',
          isSummaryRequest
            ? 'The admin has clicked Save Brief. Produce a structured summary of the discussion so far in this exact format:\n\n' +
              'MISSION STATEMENT\n' +
              'A single clear paragraph describing the overarching purpose of this knowledge layer — what it is ultimately for and who it serves.\n\n' +
              'RESEARCH OBJECTIVES\n' +
              '1. [Title] — one sentence describing this research direction\n' +
              '2. [Title] — one sentence describing this research direction\n' +
              '(list as many as the conversation warrants)\n\n' +
              'PROPOSED SOURCES\n' +
              'List 3–8 high-authority sources relevant to the research objectives, one per line: Name | URL | crawl frequency (daily/weekly/monthly)\n\n' +
              'Be specific and substantive. This will be reviewed and approved by the admin before being committed.'
            : 'Converse naturally. Do not produce structured summaries unless asked. When the admin asks you to propose sources, include them at the END of your response in this exact format:\n' +
              '```sources\n[{"url":"https://...","source_name":"...","authority_weight":0.8,"crawl_frequency":"weekly"}]\n```\n' +
              'authority_weight: 0–1 (1 = highest authority). crawl_frequency: "daily", "weekly", or "monthly".'
        ].filter(Boolean).join('\n');

        const fullMessages = [
          { role: 'user', content: systemPrompt },
          { role: 'assistant', content: 'Understood. Ready to help with the brief.' },
          ...messages
        ];

        const result = await askGemini(fullMessages);
        const rawText = result.text;

        let proposedSources = [];
        const srcMatch = rawText.match(/```sources\s*([\s\S]*?)```/);
        if (srcMatch) {
          try { proposedSources = JSON.parse(srcMatch[1].trim()); } catch {}
        }
        const reply = rawText.replace(/```sources[\s\S]*?```/g, '').trim();

        return json(res, 200, { reply, proposedSources });
      }

      // ── BRIEF END ──────────────────────────────────────────────────────
      case 'brief-end': {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const { objectiveId, messages } = req.body;
        if (!objectiveId) return json(res, 400, { error: 'objectiveId required' });

        const summaryPrompt = [
          'You are summarising a Brief session for Mobius Factory — a domain knowledge base.',
          'Based on the conversation below, write concise session notes (max 200 words) covering:',
          '- The refined research objective',
          '- Key research angles and directions agreed upon',
          '- Any constraints or priorities noted',
          'Write in plain text, no markdown headers.',
          '',
          'Conversation:',
          (messages || []).map(m => m.role.toUpperCase() + ': ' + m.content).join('\n\n')
        ].join('\n');

        const summaryResult = await askGemini([{ role: 'user', content: summaryPrompt }]);
        const sessionNotes = summaryResult.text.trim();

        await supabase
          .from('objectives')
          .update({ session_notes: sessionNotes })
          .eq('id', objectiveId);

        const { count: sourcesCount } = await supabase
          .from('sources')
          .select('*', { count: 'exact', head: true })
          .eq('objective_id', objectiveId)
          .eq('approved', true);

        return json(res, 200, { sessionNotes, sources: { count: sourcesCount || 0 } });
      }

      // ── SOURCES ────────────────────────────────────────────────────────
      case 'sources': {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        if (!module) return json(res, 400, { error: 'module required' });
        const { url, source_name, authority_weight, crawl_frequency, objective_id, approved } = req.body;
        if (!url || !objective_id) return json(res, 400, { error: 'url and objective_id required' });

        const { data: existing } = await supabase
          .from('sources')
          .select('id')
          .eq('url', url)
          .eq('objective_id', objective_id)
          .single();

        if (existing) {
          await supabase.from('sources').update({ approved: !!approved }).eq('id', existing.id);
          return json(res, 200, { id: existing.id, updated: true });
        }

        const { data, error } = await supabase
          .from('sources')
          .insert([{
            module,
            url,
            source_name: source_name || url,
            authority_weight: authority_weight || 1.0,
            crawl_frequency: crawl_frequency || 'weekly',
            objective_id,
            approved: !!approved,
            proposed_by_gemini: true
          }])
          .select()
          .single();
        if (error) throw error;
        return json(res, 201, data);
      }

      // ── QUERIES ────────────────────────────────────────────────────────
      case 'queries': {
        if (!module) return json(res, 400, { error: 'module required' });

        if (req.method === 'GET') {
          const { data, error } = await supabase
            .from('queries')
            .select('*')
            .eq('module', module)
            .order('created_at', { ascending: false });
          if (error) throw error;
          return json(res, 200, data || []);
        }

        if (req.method === 'POST') {
          const { query, target_sources, objective_id } = req.body;
          if (!query) return json(res, 400, { error: 'query required' });
          const { data, error } = await supabase
            .from('queries')
            .insert([{
              module,
              query,
              target_sources: target_sources || 10,
              objective_id:   objective_id   || null,
              status:         'pending',
              findings_count: 0
            }])
            .select()
            .single();
          if (error) throw error;
          return json(res, 201, data);
        }

        if (req.method === 'PATCH') {
          const { id, status, query, target_sources } = req.body;
          if (!id) return json(res, 400, { error: 'id required' });
          const updates = {};
          if (status)         updates.status         = status;
          if (query)          updates.query          = query;
          if (target_sources) updates.target_sources = target_sources;
          await supabase.from('queries').update(updates).eq('id', id);
          return json(res, 200, { ok: true });
        }

        return json(res, 405, { error: 'Method not allowed' });
      }

      // ── QUERY CHAT ─────────────────────────────────────────────────────
      case 'query-chat': {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const { messages, objectiveId, summaryRequest } = req.body;
        if (!module) return json(res, 400, { error: 'module required' });

        // Load brief for context
        let brief = '', sessionNotes = '';
        if (objectiveId) {
          const { data: obj } = await supabase
            .from('objectives').select('brief, session_notes').eq('id', objectiveId).single();
          brief        = obj?.brief        || '';
          sessionNotes = obj?.session_notes || '';
        } else {
          const { data: objs } = await supabase
            .from('objectives').select('brief, session_notes')
            .eq('module', module).eq('active', true)
            .order('created_at', { ascending: false }).limit(1);
          brief        = objs?.[0]?.brief        || '';
          sessionNotes = objs?.[0]?.session_notes || '';
        }

        // Load existing queries for context
        const { data: existingQueries } = await supabase
          .from('queries').select('query, status, findings_count, target_sources')
          .eq('module', module).order('created_at', { ascending: false }).limit(10);

        const queryHistory = (existingQueries || []).map(q =>
          '- "' + q.query + '" (' + q.status + ', ' + q.findings_count + '/' + q.target_sources + ' sources)'
        ).join('\n');

        const systemPrompt = [
          'You are Gemini, the research partner for Mobius Factory — ' + module.toUpperCase() + ' module.',
          '',
          'Module mission: ' + brief,
          sessionNotes ? 'Research context: ' + sessionNotes : '',
          queryHistory ? '\nExisting research queries:\n' + queryHistory : '',
          '',
          summaryRequest
            ? 'The admin wants to finalise a research query. Based on the conversation, propose:\n\n' +
              'RESEARCH QUERY\n' +
              'A single specific question that Gemini will research autonomously (1-2 sentences).\n\n' +
              'TARGET SOURCES\n' +
              'How many good sources are needed to adequately answer this query (suggest a number, e.g. 8, 10, 15).\n\n' +
              'RATIONALE\n' +
              'Brief explanation of why this query and target are appropriate.\n\n' +
              'Format your response exactly as above so it can be reviewed and approved.'
            : 'Converse naturally to help the admin identify the next research query for this module.\n' +
              'Discuss what angle to explore next, what gaps exist, what would be most valuable.\n' +
              'Do NOT produce structured query proposals unless the admin clicks the Propose Query button.'
        ].filter(Boolean).join('\n');

        const fullMessages = [
          { role: 'user',      content: systemPrompt },
          { role: 'assistant', content: 'Understood. Ready to discuss the next research query.' },
          ...(messages || [])
        ];

        const result = await askGemini(fullMessages);
        return json(res, 200, { reply: result.text });
      }

      // ── FINDINGS ───────────────────────────────────────────────────────
      case 'findings': {
        if (!module) return json(res, 400, { error: 'module required' });

        if (req.method === 'GET') {
          const { data: findings, error } = await supabase
            .from('findings')
            .select('*, sources(source_name, url, objective_id)')
            .eq('module', module)
            .eq('status', 'pending')
            .order('crawled_at', { ascending: false });
          if (error) throw error;

          const { data: knowledge } = await supabase
            .from('knowledge')
            .select('topic_tags, plain')
            .eq('module', module);

          const knowledgeTags = new Set(
            (knowledge || []).flatMap(k => k.topic_tags || []).map(t => t.toLowerCase())
          );

          const flagged = (findings || []).map(f => {
            const fTags = (f.topic_tags || []).map(t => t.toLowerCase());
            const overlap = fTags.filter(t => knowledgeTags.has(t)).length;
            const redundant = fTags.length > 0 && overlap / fTags.length >= 0.6;
            return { ...f, _redundant: redundant };
          });

          return json(res, 200, flagged);
        }

        if (req.method === 'PATCH') {
          const { id, status } = req.body;
          if (!id || !['approved', 'discarded'].includes(status)) {
            return json(res, 400, { error: 'id and valid status required' });
          }

          await supabase.from('findings').update({ status }).eq('id', id);

          if (status === 'approved') {
            const { data: finding } = await supabase
              .from('findings').select('*').eq('id', id).single();
            if (finding) {
              await supabase.from('knowledge').insert([{
                module: finding.module,
                finding_id: finding.id,
                topic_tags: finding.topic_tags,
                confidence: finding.confidence,
                technical: finding.technical,
                plain: finding.plain,
                practical: finding.practical
              }]);
            }
          }

          return json(res, 200, { ok: true });
        }

        return json(res, 405, { error: 'Method not allowed' });
      }

      // ── KNOWLEDGE ──────────────────────────────────────────────────────
      case 'knowledge': {
        if (!module) return json(res, 400, { error: 'module required' });
        if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
        const { data, error } = await supabase
          .from('knowledge')
          .select('id, topic_tags, plain, confidence, approved_at')
          .eq('module', module)
          .order('approved_at', { ascending: false });
        if (error) throw error;
        return json(res, 200, data);
      }

      // ── REVIEW CHAT ────────────────────────────────────────────────────
      case 'review-chat': {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const { finding, knowledge, messages } = req.body;
        if (!finding) return json(res, 400, { error: 'finding required' });

        const isFirstMessage = !messages || messages.length === 0;
        const knowledgeSummary = (knowledge || []).slice(0, 40).map((k, i) =>
          `[${i + 1}] Tags: ${(k.topic_tags || []).join(', ')} | ${(k.plain || '').slice(0, 120)}`
        ).join('\n');

        const systemPrompt = [
          'You are Gemini, reviewing a research finding for the Mobius Factory ' + (finding.module || '') + ' Knowledge Layer.',
          'Your role: help the admin decide whether to approve or discard this finding.',
          '',
          '── FINDING ──',
          'Module: ' + (finding.module || ''),
          'Topics: ' + (finding.topic_tags || []).join(', '),
          'Source: ' + (finding.url || 'Unknown'),
          'Confidence: ' + Math.round((finding.confidence || 0) * 100) + '%',
          'Plain: ' + (finding.plain || '—'),
          'Technical: ' + (finding.technical || '—'),
          'Practical: ' + (finding.practical || '—'),
          '',
          '── EXISTING KNOWLEDGE (dedup check) ──',
          knowledgeSummary || 'Knowledge Layer is empty.',
          '',
          'Guidelines:',
          '- On first message: assess whether this finding duplicates existing knowledge.',
          '- Be honest about quality — flag low-confidence or poorly sourced findings.',
          '- If a question requires current data, say so and the system will web search.',
          '- Keep responses concise. Never approve or discard on behalf of the admin.'
        ].join('\n');

        const fullMessages = [
          { role: 'user', content: systemPrompt },
          { role: 'assistant', content: 'Understood. Ready to evaluate.' },
          ...(isFirstMessage
            ? [{ role: 'user', content: 'Please give your initial assessment of this finding.' }]
            : messages)
        ];

        let result = await askGemini(fullMessages);
        let reply = result.text;

        if (detectsCutoff(reply)) {
          const searchResult = await askWebSearch(fullMessages, 2);
          reply = searchResult.reply;
        }

        return json(res, 200, { reply });
      }

      default:
        return json(res, 404, { error: 'Unknown action: ' + action });
    }
  } catch (err) {
    console.error('[admin] error:', err.message);
    return json(res, 500, { error: err.message });
  }
};
