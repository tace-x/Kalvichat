import crypto from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { detectLanguage, normalizeForDetection, phoneticKey } from './languageDetection.js';

const configuredLimit=(name,fallback,min,max)=>{const value=Number(process.env[name]);return Number.isFinite(value)?Math.min(max,Math.max(min,Math.round(value))):fallback;};
export const KNOWLEDGE_CONFIDENCE_THRESHOLD=.85;
export const MAX_UPLOAD_BYTES=configuredLimit('TRANSLATION_DATASET_MAX_BYTES',2*1024*1024,64*1024,10*1024*1024);
export const MAX_CANONICAL_ENTRIES=configuredLimit('TRANSLATION_DATASET_MAX_ENTRIES',1000,10,10000);
export const MAX_LOOKUP_KEYS=configuredLimit('TRANSLATION_DATASET_MAX_LOOKUP_KEYS',5000,50,50000);
const hash=(value)=>crypto.createHash('sha256').update(value).digest('hex');
const cleanText=(value,max=500)=>String(value||'').trim().replace(/\s+/g,' ').slice(0,max);
const clamp=(value,fallback=.9)=>Math.max(0,Math.min(1,Number.isFinite(Number(value))?Number(value):fallback));
const unique=(values,max=25)=>[...new Set(values.map((value)=>cleanText(value)).filter(Boolean))].slice(0,max);

export function sanitizeLearningSource(source){
  const value=cleanText(source,500);
  if(!value||value.length>240)return null;
  if(/https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(value))return null;
  if(/(?:\+?\d[\s().-]?){7,}/.test(value))return null;
  if(/\b(password|passwd|otp|one.?time.?password|api.?key|access.?token|auth.?token|secret)\b/i.test(value))return null;
  if(/@[a-z0-9_.-]{2,}/i.test(value))return null;
  return value;
}

function normalizeMeanings(entry){
  const raw=entry.possibleMeanings||entry.meanings||entry.translations||entry.translation||entry.target||[];
  const list=Array.isArray(raw)?raw:[raw];
  return unique(list.map((item)=>typeof item==='string'?item:item?.text),10);
}

export function normalizeKnowledgeEntry(entry){
  const source=cleanText(entry?.source||entry?.text||entry?.phrase,500);
  if(!source)return null;
  const normalizedSource=normalizeForDetection(source).normalized;
  if(!normalizedSource)return null;
  const meanings=normalizeMeanings(entry);if(!meanings.length)return null;
  const detected=detectLanguage(source);
  const language=cleanText(entry.language||entry.detectedLanguage||detected.detectedLanguage,30).toLowerCase();
  const variants=unique([source,...(Array.isArray(entry.variants)?entry.variants:String(entry.variants||'').split(/[|;]/))]);
  return{source,normalizedSource,language,variants,meanings,confidence:clamp(entry.confidence,.9),observations:Math.max(1,Number(entry.observations||entry.usageCount||1)||1)};
}

function parseCsvRows(text){
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const char=text[i];
    if(char==='"'&&quoted&&text[i+1]==='"'){cell+='"';i++;}
    else if(char==='"')quoted=!quoted;
    else if(char===','&&!quoted){row.push(cell);cell='';}
    else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some((value)=>value.trim()))rows.push(row);row=[];cell='';}
    else cell+=char;
  }
  row.push(cell);if(row.some((value)=>value.trim()))rows.push(row);return rows;
}

function parseCsv(text){
  const rows=parseCsvRows(text);if(rows.length<2)return[];
  const headers=rows[0].map((value)=>value.trim().toLowerCase());
  return rows.slice(1).map((row)=>Object.fromEntries(headers.map((header,index)=>[header,row[index]||'']))).map((row)=>({source:row.source||row.phrase,language:row.language,variants:row.variants,translation:row.translation||row.meaning||row.target,confidence:row.confidence,observations:row.observations||row.usagecount}));
}

function parseTxt(text){
  const blocks=text.split(/\n\s*----+\s*\n/g),entries=[];
  for(const block of blocks){
    const fields={};let current;
    for(const raw of block.split(/\r?\n/)){
      const line=raw.trim();if(!line)continue;
      const match=line.match(/^([A-Z _]+):\s*(.*)$/i);
      if(match){current=match[1].trim().toLowerCase().replace(/\s+/g,'');fields[current]=match[2]? [match[2]]:[];}
      else if(current)fields[current].push(line.replace(/^[-*]\s*/,''));
    }
    if(fields.source?.[0])entries.push({source:fields.source[0],language:fields.language?.[0],variants:fields.variants||[],possibleMeanings:fields.possibletranslations||fields.translations||fields.translation||[],confidence:fields.confidence?.[0],observations:fields.observations?.[0]});
  }
  if(entries.length)return entries;
  return text.split(/\r?\n/).map((line)=>line.trim()).filter(Boolean).map((line)=>{const parts=line.split(/\s*(?:=>|\t)\s*/);return parts.length>=2?{source:parts[0],translation:parts.slice(1).join(' => ')}:null;}).filter(Boolean);
}

export function parseDataset(content,type){
  const text=String(content||'');if(Buffer.byteLength(text,'utf8')>MAX_UPLOAD_BYTES)throw Object.assign(new Error(`Dataset exceeds the configured ${MAX_UPLOAD_BYTES}-byte upload limit.`),{status:413});
  let raw;
  if(type==='json'){const parsed=JSON.parse(text);raw=Array.isArray(parsed)?parsed:parsed.entries;}
  else if(type==='csv')raw=parseCsv(text);
  else if(type==='txt')raw=parseTxt(text);
  else throw Object.assign(new Error('Only JSON, CSV, and TXT datasets are supported.'),{status:400});
  if(!Array.isArray(raw))throw Object.assign(new Error('Dataset must contain an entries array.'),{status:400});
  const valid=[],invalid=[];for(const entry of raw){const normalized=normalizeKnowledgeEntry(entry);normalized?valid.push(normalized):invalid.push(entry);}
  if(!valid.length)throw Object.assign(new Error('Dataset contains no valid translation entries.'),{status:400});
  if(valid.length>MAX_CANONICAL_ENTRIES)throw Object.assign(new Error(`Dataset exceeds ${MAX_CANONICAL_ENTRIES} canonical entries.`),{status:413});
  return{entries:valid,invalidCount:invalid.length};
}

export function mergeKnowledgeEntries(entries){
  const merged=new Map();
  for(const entry of entries){
    const current=merged.get(entry.normalizedSource);
    if(!current){merged.set(entry.normalizedSource,{...entry,variants:[...entry.variants],meanings:[...entry.meanings]});continue;}
    current.variants=unique([...current.variants,...entry.variants]);current.meanings=unique([...current.meanings,...entry.meanings],10);current.confidence=Math.max(current.confidence,entry.confidence);current.observations+=entry.observations;
  }
  return[...merged.values()];
}

export function buildKnowledgeDocuments(entries,version){
  const canonical=mergeKnowledgeEntries(entries),lookup=new Map();
  for(const entry of canonical){
    const entryId=`${version}_${hash(entry.normalizedSource)}`;
    const forms=unique([entry.source,...entry.variants]);
    forms.forEach((form,index)=>{
      const normalized=normalizeForDetection(form).normalized;if(!normalized)return;
      const matchConfidence=entry.confidence>=.85 ? Math.max(entry.confidence,index===0 ? .98 : .9) : entry.confidence*(index===0 ? 1 : .94);
      lookup.set(`${version}_${hash(normalized)}`,{version,entryId,keyType:index===0?'exact':'variant',matchedForm:normalized,canonicalSource:entry.normalizedSource,language:entry.language,meanings:entry.meanings,confidence:Math.min(.99,matchConfidence),observations:entry.observations,status:'active'});
      const phonetic=phoneticKey(normalized);if(phonetic){const id=`${version}_p_${hash(phonetic)}`,existing=lookup.get(id),context={canonicalSource:entry.normalizedSource,language:entry.language,meanings:entry.meanings};lookup.set(id,{version,keyType:'phonetic',matchedForm:phonetic,candidates:[...(existing?.candidates||[]),context].slice(0,8),confidence:.8,status:'active'});}
    });
  }
  if(lookup.size>MAX_LOOKUP_KEYS)throw Object.assign(new Error(`Dataset produces more than ${MAX_LOOKUP_KEYS} lookup keys.`),{status:413});
  return{entries:canonical.map((entry)=>({id:`${version}_${hash(entry.normalizedSource)}`,...entry,version,status:'active'})),lookup:[...lookup.entries()].map(([id,value])=>({id,...value}))};
}

export async function lookupKnowledge(db,normalizedSource,detection){
  const state=await db.doc('system/translationKnowledge').get(),version=state.data()?.activeVersion;if(!version)return null;
  let snapshot=await db.doc(`translationKnowledgeLookup/${version}_${hash(normalizedSource)}`).get(),match=snapshot.data();
  if(!match){const phonetic=phoneticKey(normalizedSource);if(phonetic){snapshot=await db.doc(`translationKnowledgeLookup/${version}_p_${hash(phonetic)}`).get();match=snapshot.data();}}
  if(!match)return null;
  const languageCompatible=!detection?.detectedLanguage||['unknown','mixed',match.language].includes(detection.detectedLanguage);
  const confidence=clamp(match.confidence*(languageCompatible?1:.72),0);
  const meanings=match.meanings||match.candidates?.flatMap((candidate)=>candidate.meanings||[])||[];
  return{version,confidence,language:match.language||match.candidates?.[0]?.language||detection?.detectedLanguage,meanings:unique(meanings,10),canonicalSource:match.canonicalSource||match.candidates?.[0]?.canonicalSource,matchType:match.keyType,strong:confidence>=KNOWLEDGE_CONFIDENCE_THRESHOLD&&meanings.length>0};
}

export function knowledgeContext(match){
  if(!match?.meanings?.length)return null;
  return{language:match.language,knownPhrase:match.canonicalSource,possibleMeanings:match.meanings.slice(0,5),confidence:match.confidence,matchType:match.matchType};
}

export async function captureLearning(db,{source,normalizedSource,language,translation,provider,confidence,knowledgeMatch}){
  const safeSource=sanitizeLearningSource(source),safeTranslation=cleanText(translation,500);if(!safeSource||!safeTranslation)return{captured:false,reason:'privacy_or_validation'};
  const key=normalizedSource||normalizeForDetection(safeSource).normalized;if(!key)return{captured:false,reason:'empty'};
  const stateRef=db.doc('system/translationKnowledge');
  return db.runTransaction(async(transaction)=>{
    const stateSnap=await transaction.get(stateRef),state=stateSnap.data()||{};
    const batchId=state.currentBatchId||`batch_${Date.now().toString(36)}`,itemRef=db.doc(`translationTrainingItems/${batchId}_${hash(key)}`),batchRef=db.doc(`translationTrainingBatches/${batchId}`);
    const [itemSnap,batchSnap]=await Promise.all([transaction.get(itemRef),transaction.get(batchRef)]),existing=itemSnap.data(),translations=[...(existing?.translations||[])];
    const translationIndex=translations.findIndex((item)=>item.text===safeTranslation);
    if(translationIndex>=0)translations[translationIndex]={...translations[translationIndex],count:Number(translations[translationIndex].count||0)+1,provider};
    else translations.push({text:safeTranslation,count:1,provider});
    const isNew=!itemSnap.exists,now=FieldValue.serverTimestamp();
    transaction.set(itemRef,{batchId,normalizedSource:key,source:safeSource,language,translations:translations.slice(0,10),observations:Number(existing?.observations||0)+1,aiFallbackCount:Number(existing?.aiFallbackCount||0)+1,lastProvider:provider,confidence:clamp(confidence,.5),datasetMatch:knowledgeMatch?{version:knowledgeMatch.version,confidence:knowledgeMatch.confidence,meanings:knowledgeMatch.meanings?.slice(0,5)||[],disagreed:!knowledgeMatch.meanings?.includes(safeTranslation)}:null,status:'pending_training',createdAt:existing?.createdAt||now,updatedAt:now},{merge:true});
    transaction.set(batchRef,{batchId,status:'pending',entryCount:Number(batchSnap.data()?.entryCount||0)+(isNew?1:0),observationCount:Number(batchSnap.data()?.observationCount||0)+1,createdAt:batchSnap.data()?.createdAt||now,updatedAt:now},{merge:true});
    transaction.set(stateRef,{currentBatchId:batchId,pendingCount:Number(state.pendingCount||0)+(isNew?1:0),updatedAt:now},{merge:true});
    return{captured:true,isNew,batchId};
  });
}

export function trainingTxt(items){
  return items.map((item)=>[`SOURCE:\n${item.source}`,`LANGUAGE:\n${item.language||'unknown'}`,`VARIANTS:\n${(item.variants||[]).join('\n')}`,`POSSIBLE TRANSLATIONS:\n${(item.translations||[]).map((translation)=>`${translation.text} (${translation.count})`).join('\n')}`,`CONFIDENCE:\n${Number(item.confidence||0).toFixed(2)}`,`OBSERVATIONS:\n${item.observations||0}`].join('\n\n')).join('\n\n----\n\n');
}
