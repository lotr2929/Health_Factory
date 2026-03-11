// api/query/[action].js — Mobius Factory public Knowledge Layer API
//
// This is the endpoint Mobius calls when a user activates a module.
// Read-only. No auth required — module name is the access key for now.
// Future: add API key / subscription check here.
//
// GET  /api/query/search?module=health&q=sleep+dementia
//   — semantic search of knowledge table by topic_tags and text match
//   — returns top N knowledge entries relevant to the query
//
// GET  /api/query/topics?module=health
//   — returns all distinct topic_tags for a module (for UI display)
//
// GET  /api/query/stats?module=health
//   — returns knowledge count, last updated

const { supabase } = require('../_supabase');

function json(res, status, body) {
  res.status(status).json(body);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

  const action = req.query.action;
  const module = (req.query.module || '').toLowerCase().trim();
  if (!module) return json(res, 400, { error: 'module required' });

  try {
    switch (action) {

      // ── SEARCH ───────────────────────────────────────────────────────
      case 'search': {
        const q = (req.query.q || '').toLowerCase().trim();
        const limit = Math.min(parseInt(req.query.limit) || 10, 50);

        if (!q) {
          // No query — return most recent knowledge entries
          const { data, error } = await supabase
            .from('knowledge')
            .select('id, topic_tags, plain, technical, practical, confidence, approved_at')
            .eq('module', module)
            .order('approved_at', { ascending: false })
            .limit(limit);
          if (error) throw error;
          return json(res, 200, { results: data || [], query: '', module });
        }

        // Search by topic_tags overlap and plain text contains
        // Supabase doesn't have full-text search on arrays natively,
        // so we fetch recent entries and filter in JS (sufficient for small KLs)
        const { data: all, error } = await supabase
          .from('knowledge')
          .select('id, topic_tags, plain, technical, practical, confidence, approved_at')
          .eq('module', module)
          .order('approved_at', { ascending: false })
          .limit(200);
        if (error) throw error;

        const terms = q.split(/\s+/).filter(Boolean);

        const scored = (all || []).map(entry => {
          const tags  = (entry.topic_tags || []).map(t => t.toLowerCase());
          const text  = ((entry.plain || '') + ' ' + (entry.technical || '')).toLowerCase();
          let score   = 0;
          for (const term of terms) {
            if (tags.some(t => t.includes(term))) score += 2;
            if (text.includes(term)) score += 1;
          }
          return { ...entry, _score: score };
        })
        .filter(e => e._score > 0)
        .sort((a, b) => b._score - a._score || b.confidence - a.confidence)
        .slice(0, limit)
        .map(({ _score, ...e }) => e); // strip internal score

        return json(res, 200, { results: scored, query: q, module });
      }

      // ── TOPICS ───────────────────────────────────────────────────────
      case 'topics': {
        const { data, error } = await supabase
          .from('knowledge')
          .select('topic_tags')
          .eq('module', module);
        if (error) throw error;

        const tagCounts = {};
        for (const row of (data || [])) {
          for (const tag of (row.topic_tags || [])) {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          }
        }
        const topics = Object.entries(tagCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([tag, count]) => ({ tag, count }));

        return json(res, 200, { topics, module });
      }

      // ── STATS ────────────────────────────────────────────────────────
      case 'stats': {
        const [{ count: knowledge }, { data: latest }] = await Promise.all([
          supabase.from('knowledge').select('*', { count: 'exact', head: true }).eq('module', module),
          supabase.from('knowledge').select('approved_at').eq('module', module).order('approved_at', { ascending: false }).limit(1)
        ]);
        return json(res, 200, {
          module,
          knowledge_count: knowledge || 0,
          last_updated: latest?.[0]?.approved_at || null
        });
      }

      default:
        return json(res, 404, { error: 'Unknown action: ' + action });
    }
  } catch (err) {
    console.error('[query] error:', err.message);
    return json(res, 500, { error: err.message });
  }
};
