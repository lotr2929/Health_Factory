const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function saveConversation(userId, query, reply, modelUsed, topic, sessionId) {
  try {
    const { error } = await supabase
      .from('conversations')
      .insert([{
        user_id: userId,
        question: query,
        answer: reply,
        model: modelUsed,
        topic,
        session_id: sessionId || null,
        created_at: new Date().toISOString()
      }]);
    if (error) console.error('Error saving conversation:', error.message);
    // Don't throw — saving failure should never crash the ask response
  } catch (err) {
    console.error('Failed to save conversation:', err.message);
  }
}

async function getChatHistory(userId, limit = 10000) {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('question, answer, model, topic, session_id, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    // Group into sessions by session_id where available, fall back to 30-min gap
    const sessions = [];
    let current = null;
    const GAP_MS = 30 * 60 * 1000;
    for (const row of (data || [])) {
      const t = new Date(row.created_at).getTime();
      const sid = row.session_id || null;
      const newSession =
        !current ||
        (sid && current.session_id !== sid) ||
        (!sid && t - current.lastTime > GAP_MS);
      if (newSession) {
        current = { title: row.question, started_at: row.created_at, lastTime: t, session_id: sid, messages: [] };
        sessions.push(current);
      }
      current.lastTime = t;
      current.messages.push({ question: row.question, answer: row.answer, model: row.model, created_at: row.created_at });
    }
    sessions.reverse();
    return sessions;
  } catch (err) {
    console.error('Failed to get chat history:', err.message);
    return [];
  }
}

module.exports = { supabase, saveConversation, getChatHistory };
