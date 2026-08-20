// Provider health is intentionally request-scoped. A module-level cooldown would
// persist in a warm serverless instance and let one failed message poison later ones.
const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;
const DEFAULT_PROVIDER_BUDGET_MS = 18_000;
const MIN_ATTEMPT_WINDOW_MS = 750;
const RESERVED_FALLBACK_WINDOW_MS = 3_000;
const GOOGLE_RETRY_TIMEOUT_MS = 3_000;
const GOOGLE_RETRY_DELAY_MS = 120;
const GOOGLE_RETRY_PROVIDERS = new Set(['gemma','gemini']);
const GOOGLE_RETRY_CATEGORIES = new Set(['transient_http','rate_limited','network_error']);
const envValue=(name)=>String(process.env[name]||'').trim();

export function getProviderTimeoutMs() {
  const configured=Number(process.env.TRANSLATION_PROVIDER_TIMEOUT_MS);
  if(!Number.isFinite(configured))return DEFAULT_PROVIDER_TIMEOUT_MS;
  return Math.min(12_000,Math.max(2_000,Math.round(configured)));
}

export function getProviderBudgetMs() {
  const configured=Number(process.env.TRANSLATION_PROVIDER_BUDGET_MS);
  if(!Number.isFinite(configured))return DEFAULT_PROVIDER_BUDGET_MS;
  return Math.min(22_000,Math.max(8_000,Math.round(configured)));
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

function promptFor(text,detection,knowledgeContext) {
  const hint=detection?`${detection.detectedLanguage} (${Math.round(detection.confidence*100)}% local confidence)`:'unknown';
  const knowledge=knowledgeContext?` Relevant trusted knowledge (context only; choose the best meaning for the full message): ${JSON.stringify(knowledgeContext)}.`:'';
  return `Translate one informal private-chat message into natural conversational English. The source may be Manglish (romanized Malayalam), Hinglish (romanized Hindi), Tanglish (romanized Tamil), Telglish (romanized Telugu), Kanglish (romanized Kannada), mixed English plus phonetic Indian language, slang, abbreviations, or misspelled phonetic text. Infer intent from context and tolerate repeated/missing/swapped vowels, missing spaces, repeated letters and punctuation. Preserve names, emojis, personality and tone. If the input is genuinely English, do not translate it. Do not add explanations. Return JSON only because the API contract requires it: {"detectedLanguage":"english|hinglish|manglish|tanglish|telglish|kanglish|mixed|unknown","translation":"natural English text or empty for English","confidence":0.0}. Local hint: ${hint}.${knowledge} Message:\n${JSON.stringify(text)}`;
}

const modelFor=(provider)=>provider==='gemma'
  ? envValue('GEMMA_MODEL')||'google/gemma-4-31b-it:free'
  : provider==='gemini'
    ? envValue('GEMINI_MODEL')||'gemini-3.5-flash'
    : provider==='nvidia'
      ? envValue('NVIDIA_MODEL')||'meta/llama-3.3-70b-instruct'
      : envValue('GROQ_MODEL')||'llama-3.3-70b-versatile';

async function googleGenerate(provider,key,model,text,detection,timeoutMs,knowledgeContext,{jsonMode=true}={}) {
  if(!key||!model)return null;
  const generationConfig={temperature:0.15};
  if(jsonMode)generationConfig.responseMimeType='application/json';
  const response=await providerFetch({provider,model,timeoutMs,url:`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,options:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:promptFor(text,detection,knowledgeContext)}]}],generationConfig})}});
  return parseJson((await response.json()).candidates?.[0]?.content?.parts?.[0]?.text||'');
}

async function openAICompatible({provider,key,url,model,jsonMode=true},text,detection,timeoutMs,knowledgeContext) {
  if(!key)return null;
  const payload={model,temperature:0.15,messages:[{role:'user',content:promptFor(text,detection,knowledgeContext)}]};
  if(jsonMode)payload.response_format={type:'json_object'};
  const response=await providerFetch({provider,model,timeoutMs,url,options:{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify(payload)}});
  return parseJson((await response.json()).choices?.[0]?.message?.content||'');
}

const providers={
  gemma:(text,detection,timeoutMs,knowledgeContext)=>openAICompatible({provider:'gemma',key:envValue('OPENROUTER_API_KEY'),url:'https://openrouter.ai/api/v1/chat/completions',model:modelFor('gemma'),jsonMode:false},text,detection,timeoutMs,knowledgeContext),
  nvidia:(text,detection,timeoutMs,knowledgeContext)=>openAICompatible({provider:'nvidia',key:envValue('NVIDIA_API_KEY'),url:'https://integrate.api.nvidia.com/v1/chat/completions',model:modelFor('nvidia'),jsonMode:false},text,detection,timeoutMs,knowledgeContext),
  gemini:(text,detection,timeoutMs,knowledgeContext)=>googleGenerate('gemini',envValue('GEMINI_API_KEY'),modelFor('gemini'),text,detection,timeoutMs,knowledgeContext),
  groq:(text,detection,timeoutMs,knowledgeContext)=>openAICompatible({provider:'groq',key:envValue('GROQ_API_KEY'),url:'https://api.groq.com/openai/v1/chat/completions',model:modelFor('groq')},text,detection,timeoutMs,knowledgeContext),
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

async function runAttempt(provider,text,detection,timeoutMs,retry,knowledgeContext) {
  const model=modelFor(provider),startedAt=Date.now();
  try {
    console.info(`[translation] provider=${provider} model=${model} event=provider_fetch_start attempt=${retry+1} timeoutMs=${timeoutMs}`);
    const result=await providers[provider](text,detection,timeoutMs,knowledgeContext);
    if(result===null)return{missing:true};
    if(!valid(result,text))throw new ProviderError(`${provider} response validation failed`,{provider,model,category:'invalid_response'});
    console.info(`[translation] provider=${provider} model=${model} event=provider_fetch_response result=success elapsedMs=${Date.now()-startedAt} attempt=${retry+1}`);
    return{result};
  }catch(error){
    const failure=normalizeProviderError(error,provider,model),status=failure.status?` status=${failure.status}`:'';
    console.error(`[translation] provider=${provider} model=${model} event=provider_fetch_error error=${failure.category}${status} timeoutMs=${timeoutMs} elapsedMs=${Date.now()-startedAt} attempt=${retry+1}`);
    throw failure;
  }
}

const providerConfigured=(provider)=>provider==='gemma'
  ? Boolean(envValue('OPENROUTER_API_KEY'))
  : Boolean(provider==='gemini'?envValue('GEMINI_API_KEY'):provider==='nvidia'?envValue('NVIDIA_API_KEY'):envValue('GROQ_API_KEY'));

export async function diagnoseProvider(provider,text,detection) {
  if(!providers[provider]||!providerConfigured(provider))throw new ProviderError(`${provider} is not fully configured`,{provider,model:modelFor(provider)||'missing',category:'configuration_missing'});
  const attempt=await runAttempt(provider,text,detection,getProviderTimeoutMs(),0,null);
  if(attempt.missing)throw new ProviderError(`${provider} is not configured`,{provider,model:modelFor(provider)||'missing',category:'configuration_missing'});
  return{...attempt.result,confidence:Math.max(0,Math.min(1,Number(attempt.result.confidence)||0)),provider};
}

export async function routeTranslation(text,detection,knowledgeContext=null) {
  if(!envValue('OPENROUTER_API_KEY')&&envValue('GEMMA_MODEL'))console.error('[translation] provider=gemma model=missing_key error=configuration_missing');
  const order=['gemma','nvidia','gemini','groq'].filter(providerConfigured);
  const startedAt=Date.now(),providerTimeout=getProviderTimeoutMs(),budget=getProviderBudgetMs();
  console.info(`[translation] provider=router model=none result=start budgetMs=${budget} timeoutMs=${providerTimeout} configured=${order.join(',')||'none'}`);
  let lastError;

  for(let index=0;index<order.length;index++){
    const provider=order[index],laterProviders=order.length-index-1;
    let remaining=budget-(Date.now()-startedAt);
    if(remaining<MIN_ATTEMPT_WINDOW_MS)break;
    const reservedForFallback=laterProviders*RESERVED_FALLBACK_WINDOW_MS;
    const attemptWindow=Math.max(MIN_ATTEMPT_WINDOW_MS,remaining-reservedForFallback);
    try{
      const attempt=await runAttempt(provider,text,detection,Math.min(providerTimeout,attemptWindow),0,knowledgeContext);
      if(attempt.missing)continue;
      return{...attempt.result,confidence:Math.max(0,Math.min(1,Number(attempt.result.confidence)||0)),provider};
    }catch(error){
      lastError=error;
      const retryable=GOOGLE_RETRY_PROVIDERS.has(provider)&&GOOGLE_RETRY_CATEGORIES.has(error.category);
      remaining=budget-(Date.now()-startedAt);
      let retryWindow=remaining-reservedForFallback;
      if(retryable&&retryWindow>MIN_ATTEMPT_WINDOW_MS+GOOGLE_RETRY_DELAY_MS){
        await wait(GOOGLE_RETRY_DELAY_MS);
        remaining=budget-(Date.now()-startedAt);retryWindow=remaining-reservedForFallback;
        try{
          const retry=await runAttempt(provider,text,detection,Math.min(GOOGLE_RETRY_TIMEOUT_MS,providerTimeout,retryWindow),1,knowledgeContext);
          if(!retry.missing){
            return{...retry.result,confidence:Math.max(0,Math.min(1,Number(retry.result.confidence)||0)),provider};
          }
        }catch(retryError){lastError=retryError;}
      }
    }
  }

  if(budget-(Date.now()-startedAt)<MIN_ATTEMPT_WINDOW_MS)console.error(`[translation] provider=router model=none error=budget_exhausted budgetMs=${budget} elapsedMs=${Date.now()-startedAt}`);
  throw lastError||new Error('No translation provider is configured or the provider budget was exhausted.');
}
