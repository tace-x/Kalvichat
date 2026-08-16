import { detectLanguage } from '../server/languageDetection.js';
import { getProviderBudgetMs, getProviderTimeoutMs, routeTranslation } from '../server/translationProviders.js';

const keyConfigured=Boolean(process.env.GEMINI_API_KEY);
const model=process.env.GEMINI_MODEL||'gemini-3.5-flash';
console.log(`GEMINI_API_KEY=${keyConfigured?'configured':'missing'}`);
console.log(`GEMINI_MODEL=${model}`);
console.log(`TRANSLATION_PROVIDER_TIMEOUT_MS=${getProviderTimeoutMs()}`);
console.log(`TRANSLATION_PROVIDER_BUDGET_MS=${getProviderBudgetMs()}`);
if(!keyConfigured)process.exitCode=1;
else{
  const text='sughamaano?',detection=detectLanguage(text),startedAt=Date.now();
  try{
    const result=await routeTranslation(text,detection);
    console.log(JSON.stringify({status:'success',provider:result.provider,detectedLanguage:result.detectedLanguage,durationMs:Date.now()-startedAt,responseValid:Boolean(result.translation?.trim())}));
  }catch(error){
    console.error(JSON.stringify({status:'failed',model,durationMs:Date.now()-startedAt,error:error?.name||'Error',message:String(error?.message||'Translation failed').replace(/key=[^&\s]+/g,'key=REDACTED')}));
    process.exitCode=1;
  }
}
