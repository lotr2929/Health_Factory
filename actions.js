// ── Mobius Action Layer ────────────────────────────────────────────────────────
// Sits between user input and everything else.
// Called by index.html handleAsk() — resolves what to do before any AI or server
// call is made.
//
// Decision order:
//   1. COMMAND    — colon-prefix commands (Find:, List:, History: etc.)
//   2. LOCAL DATA — queries answerable from client-side context (time, date, location)
//   3. GOOGLE     — queries that should route to Google APIs
//   4. AI         — everything else → /parse then /ask
//
// Returns: { type, command?, args?, answer? }
//   type: 'command' | 'local' | 'google' | 'ai'

// ── 1. Command detection ──────────────────────────────────────────────────────

function resolveCommand(text) {
  const detected = detectCommand(text); // from commands.js
  if (!detected) return null;
  return { type: 'command', command: detected.command, args: detected.args };
}

// ── 2. Local data detection ───────────────────────────────────────────────────

const LOCAL_PATTERNS = [
  { pattern: /\b(what('s| is) the (time|date|day)|(current|today'?s?) (time|date|day))\b/i, key: 'datetime' },
  { pattern: /\b(what (time|day|date) is it)\b/i,                                            key: 'datetime' },
  { pattern: /\b(where am i|my location|what city|what country|what region)\b/i,             key: 'location' },
  { pattern: /\b(what (browser|device|os|operating system) am i (using|on))\b/i,             key: 'device'   },
  { pattern: /\b(my (timezone|time zone|utc offset))\b/i,                                    key: 'timezone' },
  { pattern: /\b(am i online|internet connection|my connection|my bandwidth)\b/i,            key: 'network'  },
  { pattern: /\b(my (currency|local currency))\b/i,                                          key: 'currency' },
  { pattern: /\b(my (screen|resolution|display))\b/i,                                        key: 'screen'   },
];

function resolveLocalData(text, context) {
  if (!context) return null;

  for (const { pattern, key } of LOCAL_PATTERNS) {
    if (!pattern.test(text)) continue;

    // Extract the relevant part from already-collected context
    const lines = context.split('\n');
    let answer = null;

    if (key === 'datetime') {
      const dt  = lines.find(l => l.startsWith('Date/Time:'));
      const tz  = lines.find(l => l.startsWith('Timezone:'));
      if (dt) answer = dt.replace('Date/Time: ', '') + (tz ? ' (' + tz.replace('Timezone: ', '') + ')' : '');
    } else if (key === 'location') {
      const loc = lines.find(l => l.startsWith('Location:'));
      if (loc) answer = loc.replace('Location: ', '');
    } else if (key === 'device') {
      const os  = lines.find(l => l.startsWith('OS:'));
      const br  = lines.find(l => l.startsWith('Browser:'));
      const dev = lines.find(l => l.startsWith('Device:'));
      answer = [os, br, dev].filter(Boolean).map(l => l.split(': ')[1]).join(', ');
    } else if (key === 'timezone') {
      const tz  = lines.find(l => l.startsWith('Timezone:'));
      if (tz) answer = tz.replace('Timezone: ', '');
    } else if (key === 'network') {
      const on  = lines.find(l => l.startsWith('Online:'));
      const bw  = lines.find(l => l.startsWith('Bandwidth:'));
      const lat = lines.find(l => l.startsWith('Latency:'));
      const con = lines.find(l => l.startsWith('Connection:'));
      answer = [on, con, bw, lat].filter(Boolean).map(l => l.split(': ').slice(1).join(': ')).join(', ');
    } else if (key === 'currency') {
      const cur = lines.find(l => l.startsWith('Currency:'));
      if (cur) answer = cur.replace('Currency: ', '');
    } else if (key === 'screen') {
      const scr = lines.find(l => l.startsWith('Screen:'));
      if (scr) answer = scr.replace('Screen: ', '');
    }

    if (answer) return { type: 'local', answer };
  }
  return null;
}

// ── 3. Google service detection ───────────────────────────────────────────────

const GOOGLE_PATTERNS = [
  { pattern: /\b(drive|my files|google drive|gdrive)\b/i,          model: 'google_drive'    },
  { pattern: /\b(task|todo|to-do|to do list)\b/i,                  model: 'google_tasks'    },
  { pattern: /\b(calendar|schedule|my events|appointments)\b/i,    model: 'google_calendar' },
  { pattern: /\b(email|gmail|inbox|my emails|my mail)\b/i,         model: 'google_gmail'    },
];

function resolveGoogle(text) {
  // Only match if no explicit Ask: model override
  if (/^Ask:\s*\w+/i.test(text)) return null;

  for (const { pattern, model } of GOOGLE_PATTERNS) {
    if (pattern.test(text)) return { type: 'google', model };
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

function resolveAction(text, context) {
  return resolveCommand(text)
      || resolveLocalData(text, context)
      || resolveGoogle(text)
      || { type: 'ai' };
}
