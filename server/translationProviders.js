const health = new Map();
const coolingDown = (name) => (health.get(name)?.until || 0) > Date.now();
const failed = (name) => health.set(name, { until: Date.now() + 60_000 });
const succeeded = (name) => health.delete(name);

const DEFAULT_PROVIDER_TIMEOUT_MS = 5_000;
const DEFAULT_PROVIDER_BUDGET_MS = 9_000;
const MIN_ATTEMPT_WINDOW_MS = 750;
const GEMINI_RETRY_TIMEOUT_MS = 3_000;
const GEMINI_RETRY_DELAY_MS = 120;
const GEMINI_RETRY_CATEGORIES = new Set(['transient_http','rate_limited','network_error']);

export function getProviderTimeoutMs() {
  const configured=Number(process.env.TRANSLATION_PROVIDER_TIMEOUT_MS);
  if(!Number.isFinite(configured))return DEFAULT_PROVIDER_TIMEOUT_MS;
  return Math.min(5_000,Math.max(1_000,Math.round(configured)));
}

export function getProviderBudgetMs() {
  const configured=Number(process.env.TRANSLATION_PROVIDER_BUDGET_MS);
  if(!Number.isFinite(configured))return DEFAULT_PROVIDER_BUDGET_MS;
  return Math.min(10_000,Math.max(4_000,Math.round(configured)));
}

class ProviderError extends Error {
  constructor(message,{provider,model,category,status}={}) {
    super(message);this.name='ProviderError';this.provider=provider;this.model=model;this.category=category||'network_error';this.status=status;
  }
}

const classifyStatus=(status)=>status===429?'rate_limited':status===408||status>=500?'transient_http':'permanent_http';
const isTimeout=(error)=>error?.name==='TimeoutError'||error?.code==='ABORT_ERR';
const wait=(duration)=>new Promise((resolve)=>setTimeout(resolve,duration));

async function providerFetch({provider,model,url,options,timeoutMs}) {
  try {
    const response=await fetch(url,{...options,signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok)throw new ProviderError(`${provider} HTTP ${response.status}`,{provider,model,category:classifyStatus(response.status),status:response.status});
    return response;
  } catch(error) {
    if(error instanceof ProviderError)throw error;
    throw new ProviderError(isTimeout(error)?`${provider} timed out`:`${provider} network failure`,{provider,model,category:isTimeout(error)?'timeout':'network_error'});
  }
}

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

const modelFor=(provider)=>provider==='gemini'
  ? process.env.GEMINI_MODEL||'gemini-3.5-flash'
  : provider==='nvidia'
    ? process.env.NVIDIA_MODEL||'meta/llama-3.3-70b-instruct'
    : process.env.GROQ_MODEL||'llama-3.3-70b-versatile';

async function gemini(text,detection,timeoutMs) {
  const key=process.env.GEMINI_API_KEY;if(!key)return null;
  const model=modelFor('gemini');
  const response=await providerFetch({provider:'gemini',model,timeoutMs,url:`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,options:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:promptFor(text,detection)}]}],generationConfig:{temperature:0.15,responseMimeType:'application/json'}})}});
  return parseJson((await response.json()).candidates?.[0]?.content?.parts?.[0]?.text||'');
}

async function openAICompatible({provider,key,url,model,jsonMode=true},text,detection,timeoutMs) {
  if(!key)return null;
  const payload={model,temperature:0.15,messages:[{role:'user',content:promptFor(text,detection)}]};
  if(jsonMode)payload.response_format={type:'json_object'};
  const response=await providerFetch({provider,model,timeoutMs,url,options:{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify(payload)}});
  return parseJson((await response.json()).choices?.[0]?.message?.content||'');
}

const providers={
  gemini,
  nvidia:(text,detection,timeoutMs)=>openAICompatible({provider:'nvidia',key:process.env.NVIDIA_API_KEY,url:'https://integrate.api.nvidia.com/v1/chat/completions',model:modelFor('nvidia'),jsonMode:false},text,detection,timeoutMs),
  groq:(text,detection,timeoutMs)=>openAICompatible({provider:'groq',key:process.env.GROQ_API_KEY,url:'https://api.groq.com/openai/v1/chat/completions',model:modelFor('groq')},text,detection,timeoutMs),
};

const emojiPattern=/\p{Extended_Pictographic}/gu;
function valid(result,source) {
  if(!['english','hinglish','manglish','tanglish','telglish','kanglish','mixed','unknown'].includes(result?.detectedLanguage))return false;
  if(result.detectedLanguage!=='english'&&!result.translation?.trim())return false;
  const sourceEmoji=source.match(emojiPattern)||[],targetEmoji=(result.translation||'').match(emojiPattern)||[];
  return sourceEmoji.join('')===targetEmoji.join('');
}

function normalizeProviderError(error,provider,model) {
  if(error instanceof ProviderError)return error;
  return new ProviderError(error?.message||`${provider} invalid response`,{provider,model,category:'invalid_response'});
}

async function runAttempt(provider,text,detection,timeoutMs,retry) {
  const model=modelFor(provider),startedAt=Date.now();
  try {
    const result=await providers[provider](text,detection,timeoutMs);
    if(result===null)return{missing:true};
    if(!valid(result,text))throw new ProviderError(`${provider} response validation failed`,{provider,model,category:'invalid_response'});
    console.info(`[translation] provider=${provider} model=${model} result=success elapsedMs=${Date.now()-startedAt} retry=${retry}`);
    return{result};
  }catch(error){
    const failure=normalizeProviderError(error,provider,model),status=failure.status?` status=${failure.status}`:'';
    console.error(`[translation] provider=${provider} model=${model} error=${failure.category}${status} timeoutMs=${timeoutMs} elapsedMs=${Date.now()-startedAt} retry=${retry}`);
    throw failure;
  }
}

export async function routeTranslation(text,detection) {
  const order=['gemini','nvidia','groq'];
  const startedAt=Date.now(),providerTimeout=getProviderTimeoutMs(),budget=getProviderBudgetMs();
  let lastError;

  for(const provider of order){
    if(coolingDown(provider))continue;
    let remaining=budget-(Date.now()-startedAt);
    if(remaining<MIN_ATTEMPT_WINDOW_MS)break;
    try{
      const attempt=await runAttempt(provider,text,detection,Math.min(providerTimeout,remaining),0);
      if(attempt.missing)continue;
      succeeded(provider);
      return{...attempt.result,confidence:Math.max(0,Math.min(1,Number(attempt.result.confidence)||0)),provider};
    }catch(error){
      lastError=error;
      const retryable=provider==='gemini'&&GEMINI_RETRY_CATEGORIES.has(error.category);
      remaining=budget-(Date.now()-startedAt);
      if(retryable&&remaining>MIN_ATTEMPT_WINDOW_MS+GEMINI_RETRY_DELAY_MS){
        await wait(GEMINI_RETRY_DELAY_MS);
        remaining=budget-(Date.now()-startedAt);
        try{
          const retry=await runAttempt(provider,text,detection,Math.min(GEMINI_RETRY_TIMEOUT_MS,providerTimeout,remaining),1);
          if(!retry.missing){
            succeeded(provider);
            return{...retry.result,confidence:Math.max(0,Math.min(1,Number(retry.result.confidence)||0)),provider};
          }
        }catch(retryError){lastError=retryError;}
      }
      failed(provider);
    }
  }

  if(budget-(Date.now()-startedAt)<MIN_ATTEMPT_WINDOW_MS)console.error(`[translation] provider=router model=none error=budget_exhausted budgetMs=${budget} elapsedMs=${Date.now()-startedAt}`);
  throw lastError||new Error('No translation provider is configured or the provider budget was exhausted.');
}
