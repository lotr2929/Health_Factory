async function askGroq(messages) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.GROQ_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages })
  });
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content;
  if (!content) throw new Error(JSON.stringify(data));
  if (content.includes('"error"')) {
    try {
      const parsed = JSON.parse(content);
      if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    } catch {}
  }
  return content;
}

async function askGemini(messages, imageParts = []) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set on the server.');
  const contents = messages.map((m, i) => {
    const isLastUser = i === messages.length - 1 && m.role === 'user';
    const parts = [];
    if (isLastUser && imageParts.length > 0) parts.push(...imageParts);
    parts.push({ text: m.content });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents })
  });
  const data = await r.json();
  if (data.error) throw new Error('Gemini API error: ' + data.error.message);
  if (!data.candidates?.[0]) throw new Error('No candidates in Gemini response: ' + JSON.stringify(data));
  const text = data.candidates[0].content.parts[0].text;
  const usage = data.usageMetadata || {};
  return { text, tokensIn: usage.promptTokenCount || 0, tokensOut: usage.candidatesTokenCount || 0 };
}

async function askMistral(messages) {
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.MISTRAL_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: 'codestral-latest', messages })
  });
  const data = await r.json();
  return data.choices?.[0]?.message?.content || JSON.stringify(data);
}

async function askGitHub(messages) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set on the server.');
  const r = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: 'gpt-4o', messages })
  });
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(JSON.stringify(data));
  return content;
}

// Cloud-only fallback chain — local models (Ollama, WebLLM) are client-side only
const MODEL_CHAIN = ['groq', 'gemini', 'mistral', 'github'];

const MODEL_FULL_NAMES = {
  groq:    'Groq Llama 3.3 70B',
  gemini:  'Gemini 2.5 Flash',
  mistral: 'Mistral Codestral',
  github:  'GitHub GPT-4o',
  ollama:    'Ollama (local)',
  qwen:      'Ollama Qwen 2.5 Coder',
  deepseek:  'Ollama DeepSeek R1 7B'
};

async function askWithFallback(messages, imageParts = [], startModel = 'groq') {
  const startIdx = MODEL_CHAIN.indexOf(startModel);
  const chain = startIdx !== -1 ? MODEL_CHAIN.slice(startIdx) : MODEL_CHAIN;
  let lastErr = null;
  for (const model of chain) {
    try {
      let result;
      if (model === 'groq')         result = await askGroq(messages);
      else if (model === 'gemini')  result = await askGemini(messages, imageParts);
      else if (model === 'mistral') result = await askMistral(messages);
      else if (model === 'github')  result = await askGitHub(messages);
      const fullName  = MODEL_FULL_NAMES[model] || model;
      const startName = MODEL_FULL_NAMES[startModel] || startModel;
      const label     = model === startModel ? fullName : fullName + ' (fallback from ' + startName + ')';
      // Gemini returns { text, tokensIn, tokensOut }, others return a plain string
      if (result && typeof result === 'object' && result.text !== undefined) {
        return { reply: result.text, modelUsed: label, tokensIn: result.tokensIn, tokensOut: result.tokensOut };
      }
      return { reply: result, modelUsed: label };
    } catch (err) {
      console.warn('[Mobius] ' + model + ' failed:', err.message);
      lastErr = err;
    }
  }
  throw lastErr || new Error('All models failed');
}

async function askOllama(messages, model = 'qwen2.5-coder:7b') {
  const r = await fetch('http://localhost:11434/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages })
  });
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(JSON.stringify(data));
  return content;
}

// Phrases that indicate the AI lacks current/live data
const CUTOFF_PHRASES = [
  'knowledge cutoff', 'training cutoff', 'training data',
  'as of my last update', 'as of my knowledge', 'i don\'t have access to real-time',
  'i cannot browse', 'i can\'t browse', 'no internet access',
  'i don\'t have internet', 'i cannot access the internet',
  'my information may be outdated', 'i don\'t have current',
  'i cannot provide real-time', 'not able to access current'
];

function detectsCutoff(text) {
  const lower = text.toLowerCase();
  return CUTOFF_PHRASES.some(p => lower.includes(p));
}

// depth: 1=web (basic,5), 2=web2 (advanced,8,+answer), 3=web3 (advanced,12,+raw)
async function askWebSearch(messages, depth = 1) {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) throw new Error('TAVILY_API_KEY is not set on the server.');
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const query = lastUserMsg ? lastUserMsg.content : '';

  const searchDepth  = depth === 1 ? 'basic' : 'advanced';
  const maxResults   = depth === 1 ? 5 : depth === 2 ? 8 : 12;
  const includeAnswer     = depth >= 2;
  const includeRawContent = depth >= 3;

  const searchRes = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: tavilyKey,
      query,
      search_depth: searchDepth,
      max_results: maxResults,
      include_answer: includeAnswer,
      include_raw_content: includeRawContent
    })
  });
  const searchData = await searchRes.json();
  if (searchData.error) throw new Error('Tavily: ' + (searchData.error.message || JSON.stringify(searchData.error)));

  let context = searchData.results
    .map((r, i) => {
      const raw = includeRawContent && r.raw_content ? '\nFull content: ' + r.raw_content.slice(0, 1500) : '';
      return `[${i + 1}] ${r.title}\n${r.content}${raw}\nSource: ${r.url}`;
    })
    .join('\n\n');

  if (includeAnswer && searchData.answer) {
    context = 'Tavily summary: ' + searchData.answer + '\n\n' + context;
  }

  const augmented = messages.map((m, i) => {
    if (i === messages.length - 1 && m.role === 'user') {
      return {
        role: 'user',
        content: `Answer using the web search results below. Be concise and cite sources where relevant.\n\nQuestion: ${m.content}\n\nSearch Results:\n${context}`
      };
    }
    return m;
  });
  return await askWithFallback(augmented);
}

module.exports = {
  askGroq,
  askGemini,
  askMistral,
  askGitHub,
  askOllama,
  askWithFallback,
  askWebSearch,
  detectsCutoff,
  MODEL_FULL_NAMES
};
