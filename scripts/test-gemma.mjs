import { detectLanguage } from '../server/languageDetection.js';
import { diagnoseProvider, getProviderBudgetMs, getProviderTimeoutMs } from '../server/translationProviders.js';

const keyConfigured=Boolean(String(process.env.OPENROUTER_API_KEY||'').trim()),model=String(process.env.GEMMA_MODEL||'').trim()||'google/gemma-4-31b-it:free';
console.log(`OPENROUTER_API_KEY=${keyConfigured?'configured':'missing'}`);
console.log(`GEMMA_MODEL=${model||'missing'}`);
console.log(`TRANSLATION_PROVIDER_TIMEOUT_MS=${getProviderTimeoutMs()}`);
console.log(`TRANSLATION_PROVIDER_BUDGET_MS=${getProviderBudgetMs()}`);
if(!keyConfigured||!model)process.exitCode=1;
else{
  const text='sughamaano?',detection=detectLanguage(text),startedAt=Date.now();
  try{
    const result=await diagnoseProvider('gemma',text,detection);
    console.log(JSON.stringify({status:'success',provider:result.provider,model,detectedLanguage:result.detectedLanguage,durationMs:Date.now()-startedAt,responseValid:Boolean(result.translation?.trim())}));
  }catch(error){
    console.error(JSON.stringify({status:'failed',provider:'gemma',model,durationMs:Date.now()-startedAt,error:error?.category||error?.name||'Error',statusCode:error?.status||null}));
    process.exitCode=1;
  }
}
