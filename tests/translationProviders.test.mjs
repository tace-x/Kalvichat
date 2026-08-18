import test from 'node:test';
import assert from 'node:assert/strict';

const detection={detectedLanguage:'manglish',confidence:.82,shouldTranslate:true};
const providerName=(url)=>url.includes('openrouter.ai')?'gemma':url.includes('googleapis.com')?'gemini':url.includes('nvidia.com')?'nvidia':'groq';
const payload=(provider)=>provider==='gemini'
  ? {candidates:[{content:{parts:[{text:JSON.stringify({detectedLanguage:'manglish',translation:'How are you?',confidence:.99})}]}}]}
  : {choices:[{message:{content:JSON.stringify({detectedLanguage:'manglish',translation:'How are you?',confidence:.99})}}]};
const response=(provider,status=200)=>({ok:status>=200&&status<300,status,json:async()=>payload(provider)});

let sequence=0;
async function loadRouter({gemma=false,gemmaModel='google/gemma-4-31b-it:free',gemini=true,nvidia=true,groq=true,timeout=10000,budget=18000}={}){
  process.env.OPENROUTER_API_KEY=gemma?'openrouter-secret-for-test':'';
  process.env.GEMMA_MODEL=gemma?gemmaModel:'';
  process.env.GEMINI_API_KEY=gemini?'gemini-secret-for-test':'';
  process.env.NVIDIA_API_KEY=nvidia?'nvidia-secret-for-test':'';
  process.env.GROQ_API_KEY=groq?'groq-secret-for-test':'';
  process.env.TRANSLATION_PROVIDER_TIMEOUT_MS=String(timeout);
  process.env.TRANSLATION_PROVIDER_BUDGET_MS=String(budget);
  return import(`../server/translationProviders.js?test=${sequence++}`);
}

async function captureLogs(run){
  const originalInfo=console.info,originalError=console.error,logs=[];
  console.info=(...parts)=>logs.push(parts.join(' '));console.error=(...parts)=>logs.push(parts.join(' '));
  try{return{value:await run(),logs};}finally{console.info=originalInfo;console.error=originalError;}
}

test('Gemma uses OpenRouter and stops all fallback providers',async()=>{
  const {routeTranslation}=await loadRouter({gemma:true});const calls=[];
  globalThis.fetch=async(url,options)=>{const provider=providerName(String(url));calls.push({provider,url:String(url),options});return response(provider)};
  const {value}=await captureLogs(()=>routeTranslation('sughamaano?',detection));
  assert.equal(value.provider,'gemma');assert.equal(calls.length,1);assert.equal(calls[0].provider,'gemma');assert.equal(calls[0].url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(calls[0].options.headers.authorization,'Bearer openrouter-secret-for-test');assert.equal(JSON.parse(calls[0].options.body).model,'google/gemma-4-31b-it:free');
});

test('Gemma failure falls back to NVIDIA',async()=>{
  const {routeTranslation}=await loadRouter({gemma:true});const calls=[];
  globalThis.fetch=async(url)=>{const provider=providerName(String(url));calls.push(provider);return response(provider,provider==='gemma'?503:200)};
  const {value}=await captureLogs(()=>routeTranslation('sughamaano?',detection));
  assert.equal(value.provider,'nvidia');assert.deepEqual(calls,['gemma','gemma','nvidia']);
});

test('Gemma and NVIDIA failure falls back to Gemini',async()=>{
  const {routeTranslation}=await loadRouter({gemma:true});const calls=[];
  globalThis.fetch=async(url)=>{const provider=providerName(String(url));calls.push(provider);return response(provider,['gemma','nvidia'].includes(provider)?503:200)};
  const {value}=await captureLogs(()=>routeTranslation('sughamaano?',detection));
  assert.equal(value.provider,'gemini');assert.deepEqual(calls,['gemma','gemma','nvidia','gemini']);
});

test('Gemma missing or whitespace-only key is skipped without breaking NVIDIA fallback',async()=>{
  const {routeTranslation}=await loadRouter({gemma:true,gemini:false});process.env.OPENROUTER_API_KEY='   ';const calls=[];
  globalThis.fetch=async(url)=>{const provider=providerName(String(url));calls.push(provider);return response(provider)};
  const {value}=await captureLogs(()=>routeTranslation('sughamaano?',detection));
  assert.equal(value.provider,'nvidia');assert.deepEqual(calls,['nvidia']);
});

test('invalid Gemma model response falls back safely',async()=>{
  const {routeTranslation}=await loadRouter({gemma:true});const calls=[];
  globalThis.fetch=async(url)=>{const provider=providerName(String(url));calls.push(provider);return response(provider,provider==='gemma'?404:200)};
  const {value,logs}=await captureLogs(()=>routeTranslation('sughamaano?',detection));
  assert.equal(value.provider,'nvidia');assert.deepEqual(calls,['gemma','nvidia']);assert.match(logs.join('\n'),/error=permanent_http status=404/);
});

test('six consecutive requests remain on healthy Gemma',async()=>{
  const {routeTranslation}=await loadRouter({gemma:true});const calls=[];
  globalThis.fetch=async(url)=>{const provider=providerName(String(url));calls.push(provider);return response(provider)};
  for(const text of ['sughamaano?','ninte perentha?','evide pokunnu?','work aakunnundo?','ashish is dumb','ashish kaha h']){
    const result=await captureLogs(()=>routeTranslation(text,detection));assert.equal(result.value.provider,'gemma');
  }
  assert.deepEqual(calls,['gemma','gemma','gemma','gemma','gemma','gemma']);
});

test('Gemini success stops fallback',async()=>{
  const {routeTranslation}=await loadRouter({nvidia:false});const calls=[];
  globalThis.fetch=async(url)=>{const provider=providerName(String(url));calls.push(provider);return response(provider)};
  const {value,logs}=await captureLogs(()=>routeTranslation('sughamaano?',detection));
  assert.equal(value.provider,'gemini');assert.deepEqual(calls,['gemini']);assert.match(logs.join('\n'),/result=success/);
});

test('Gemini 503 receives one short retry and succeeds',async()=>{
  const {routeTranslation}=await loadRouter({nvidia:false});const calls=[];
  globalThis.fetch=async(url)=>{const provider=providerName(String(url));calls.push(provider);return response(provider,calls.length===1?503:200)};
  const {value,logs}=await captureLogs(()=>routeTranslation('sughamaano?',detection));
  assert.equal(value.provider,'gemini');assert.deepEqual(calls,['gemini','gemini']);assert.match(logs.join('\n'),/error=transient_http status=503/);assert.match(logs.join('\n'),/attempt=2/);
});

test('Gemini 429 is classified and retried once',async()=>{
  const {routeTranslation}=await loadRouter({nvidia:false});const calls=[];
  globalThis.fetch=async(url)=>{const provider=providerName(String(url));calls.push(provider);return response(provider,calls.length===1?429:200)};
  const {value,logs}=await captureLogs(()=>routeTranslation('sughamaano?',detection));
  assert.equal(value.provider,'gemini');assert.deepEqual(calls,['gemini','gemini']);assert.match(logs.join('\n'),/error=rate_limited status=429/);
});

test('Gemini repeated 503 falls back to Groq when NVIDIA is absent',async()=>{
  const {routeTranslation}=await loadRouter({nvidia:false});const calls=[];
  globalThis.fetch=async(url)=>{const provider=providerName(String(url));calls.push(provider);return response(provider,provider==='gemini'?503:200)};
  const {value}=await captureLogs(()=>routeTranslation('sughamaano?',detection));
  assert.equal(value.provider,'groq');assert.deepEqual(calls,['gemini','gemini','groq']);
});

test('Gemini timeout falls back immediately without retry',async()=>{
  const {routeTranslation}=await loadRouter({nvidia:false});const calls=[];
  globalThis.fetch=async(url)=>{const provider=providerName(String(url));calls.push(provider);if(provider==='gemini')throw new DOMException('timed out','TimeoutError');return response(provider)};
  const {value}=await captureLogs(()=>routeTranslation('sughamaano?',detection));
  assert.equal(value.provider,'groq');assert.deepEqual(calls,['gemini','groq']);
});

test('NVIDIA timeout falls back to Groq',async()=>{
  const {routeTranslation}=await loadRouter({gemini:false});const calls=[];
  globalThis.fetch=async(url)=>{const provider=providerName(String(url));calls.push(provider);if(provider==='nvidia')throw new DOMException('timed out','TimeoutError');return response(provider)};
  const {value}=await captureLogs(()=>routeTranslation('sughamaano?',detection));
  assert.equal(value.provider,'groq');assert.deepEqual(calls,['nvidia','groq']);
});

test('missing keys are skipped and all missing fails quickly',async()=>{
  let module=await loadRouter({gemini:false,nvidia:true,groq:false});let calls=[];
  globalThis.fetch=async(url)=>{const provider=providerName(String(url));calls.push(provider);return response(provider)};
  let result=await captureLogs(()=>module.routeTranslation('sughamaano?',detection));assert.equal(result.value.provider,'nvidia');assert.deepEqual(calls,['nvidia']);
  module=await loadRouter({gemini:false,nvidia:false,groq:false});calls=[];globalThis.fetch=async()=>{calls.push('unexpected')};
  await assert.rejects(()=>module.routeTranslation('sughamaano?',detection));assert.deepEqual(calls,[]);
});

test('overall budget bounds sequential hanging providers',async()=>{
  const {routeTranslation,getProviderBudgetMs}=await loadRouter({timeout:2000,budget:8000});const started=Date.now();
  globalThis.fetch=async(_url,{signal})=>new Promise((_,reject)=>{const keepAlive=setTimeout(()=>{},5000);signal.addEventListener('abort',()=>{clearTimeout(keepAlive);reject(signal.reason)},{once:true});});
  const {logs}=await captureLogs(async()=>{await assert.rejects(()=>routeTranslation('sughamaano?',detection));});
  const elapsed=Date.now()-started;assert.equal(getProviderBudgetMs(),8000);assert.ok(elapsed<8000,`elapsed ${elapsed}`);assert.match(logs.join('\n'),/error=timeout/);
});

test('configured fallbacks receive meaningful independent attempt windows',async()=>{
  const {routeTranslation}=await loadRouter({gemma:true});const windows=[],originalTimeout=AbortSignal.timeout;
  AbortSignal.timeout=(duration)=>{windows.push(duration);return new AbortController().signal};
  globalThis.fetch=async(url)=>response(providerName(String(url)),503);
  try{await captureLogs(async()=>{await assert.rejects(()=>routeTranslation('fallback allocation',detection));});}
  finally{AbortSignal.timeout=originalTimeout;}
  assert.equal(windows.length,6);assert.ok(windows[0]>=8900&&windows[0]<=9000);assert.equal(windows[1],3000);assert.ok(windows[2]>=9000);assert.ok(windows[3]>=9000);assert.equal(windows[4],3000);assert.ok(windows[5]>=2500);
});

test('fresh request still attempts providers after previous request exhausts all providers',async()=>{
  const {routeTranslation}=await loadRouter({gemma:true});const calls=[];
  globalThis.fetch=async(url)=>{const provider=providerName(String(url));calls.push(`failed:${provider}`);return response(provider,503)};
  await captureLogs(async()=>{await assert.rejects(()=>routeTranslation('first failing message',detection));});
  globalThis.fetch=async(url)=>{const provider=providerName(String(url));calls.push(`fresh:${provider}`);return response(provider)};
  const {value}=await captureLogs(()=>routeTranslation('second legitimate message',detection));
  assert.equal(value.provider,'gemma');assert.ok(calls.includes('fresh:gemma'),JSON.stringify(calls));
});

test('diagnostics never contain API keys',async()=>{
  const {routeTranslation}=await loadRouter();globalThis.fetch=async(url)=>response(providerName(String(url)),503);
  const {logs}=await captureLogs(async()=>{await assert.rejects(()=>routeTranslation('sughamaano?',detection));});
  const output=logs.join('\n');for(const secret of ['openrouter-secret-for-test','gemini-secret-for-test','nvidia-secret-for-test','groq-secret-for-test'])assert.equal(output.includes(secret),false);
});
