const health = new Map();
const coolingDown = (name) => (health.get(name)?.until || 0) > Date.now();
const failed = (name) => health.set(name, { until: Date.now() + 60_000 });
const succeeded = (name) => health.delete(name);

function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Provider returned invalid JSON.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function promptFor(text,detection) {
  const hint=detection?`${detection.detectedLanguage} (${Math.round(detection.confidence*100)}% local confidence)`:'unknown';
  return `Translate one informal private-chat message into natural conversational English. The source may be Manglish (romanized Malayalam), Hinglish (romanized Hindi), Tanglish (romanized Tamil), Telglish (romanized Telugu), Kanglish (romanized Kannada), mixed English plus phonetic Indian language, slang, abbreviations, or misspelled phonetic text. Infer intent from context and tolerate repeated/missing/swapped vowels, missing spaces, repeated letters and punctuation. Preserve names, emojis, personality and tone. If the input is genuinely English, do not translate it. Do not add explanations. Return JSON only because the API contract requires it: {"detectedLanguage":"english|hinglish|manglish|tanglish|telglish|kanglish|mixed|unknown","translation":"natural English text or empty for English","confidence":0.0}. Local hint: ${hint}. Message:\n${JSON.stringify(text)}`;
}

async function gemini(text,detection) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ contents: [{ parts: [{ text: promptFor(text,detection) }] }], generationConfig: { temperature: 0.15, responseMimeType: 'application/json' } }),
  });
  if (!response.ok) throw new Error(`Gemini ${response.status}`);
  return parseJson((await response.json()).candidates?.[0]?.content?.parts?.[0]?.text || '');
}

async function openAICompatible({ name, key, url, model, jsonMode = true }, text,detection) {
  if (!key) return null;
  const payload = { model, temperature: 0.15, messages: [{ role: 'user', content: promptFor(text,detection) }] };
  if (jsonMode) payload.response_format = { type: 'json_object' };
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`${name} ${response.status}`);
  return parseJson((await response.json()).choices?.[0]?.message?.content || '');
}

const providers = {
  gemini,
  groq: (text,detection) => openAICompatible({ name:'Groq', key:process.env.GROQ_API_KEY, url:'https://api.groq.com/openai/v1/chat/completions', model:process.env.GROQ_MODEL || 'llama-3.3-70b-versatile' }, text,detection),
  nvidia: (text,detection) => openAICompatible({ name:'NVIDIA', key:process.env.NVIDIA_API_KEY, url:'https://integrate.api.nvidia.com/v1/chat/completions', model:process.env.NVIDIA_MODEL || 'meta/llama-3.1-70b-instruct', jsonMode:false }, text,detection),
};

const emojiPattern = /\p{Extended_Pictographic}/gu;
function valid(result, source) {
  if (!['english','hinglish','manglish','tanglish','telglish','kanglish','mixed','unknown'].includes(result?.detectedLanguage)) return false;
  if (result.detectedLanguage !== 'english' && !result.translation?.trim()) return false;
  const sourceEmoji = source.match(emojiPattern) || [];
  const targetEmoji = (result.translation || '').match(emojiPattern) || [];
  return sourceEmoji.join('') === targetEmoji.join('');
}

export async function routeTranslation(text,detection) {
  // Short casual text uses the efficient configured model first; complex text prefers Gemini.
  const order = text.length > 240 ? ['gemini','groq','nvidia'] : ['groq','gemini','nvidia'];
  let lastError;
  for (const name of order) {
    if (coolingDown(name)) continue;
    try {
      const result = await providers[name](text,detection);
      if (!result) continue;
      if (!valid(result, text)) throw new Error(`${name} validation failed`);
      succeeded(name);
      return { ...result, confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)), provider: name };
    } catch (error) { failed(name); lastError = error; }
  }
  throw lastError || new Error('No translation provider is configured.');
}
