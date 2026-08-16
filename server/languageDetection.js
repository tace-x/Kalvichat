const ENGLISH_THRESHOLD = 0.82;

const ENGLISH_WORDS = new Set([
  'a','am','an','and','are','at','be','been','bro','but','by','can','come','coming','did','do','doing','done','for','from','get','go','going','good','got','had','has','have','hello','help','here','hey','hi','how','i','if','in','is','it','like','lol','me','morning','my','no','not','now','of','ok','okay','on','or','please','see','she','so','thanks','that','the','their','them','there','they','this','to','today','tomorrow','too','up','want','was','we','what','when','where','which','who','why','will','with','work','would','yes','you','your',
]);

const OBVIOUS_ENGLISH = new Set(['hello','hey','hi','thanks','yes','no','okay','ok','lol','please','welcome','sorry']);

const LANGUAGE_SIGNALS = {
  manglish: {
    anchors: ['sughamano','sugham aano','ninte','perentha','entha','paripadi','evideya','engotta','njan','nee','ningal','aanu','alle','illa','undu','enikku','ninakku','evide','engane','naale','sheri','veetil','povam','varam'],
    patterns: [/(?:aa|a)no$/,/(?:entha|enthu|evide|engane|engotta)/,/(?:yilla|illa|undu)$/,/(?:kk|nnu|thil|yil)/],
  },
  hinglish: {
    anchors: ['kya','kar rahe ho','kaisa hai','tum','kaha','mujhe','nahi','pata','aap','mera','meri','ghar','accha','theek','kyun','kaise','abhi','bahut'],
    patterns: [/(?:rahe|raha|rahi)ho$/,/(?:kya|kyun|kaise|kaisa)/,/(?:nahi|hain|hoon|wala|wali)$/],
  },
  tanglish: {
    anchors: ['epdi','iruka','enna','panra','saptiya','naan','nee','enga','romba','illa','iruken'],
    patterns: [/(?:tiya|riya|ruka|iruka|panra)$/,/(?:epdi|enna|enga)/],
  },
  telglish: {
    anchors: ['ela unnava','unnava','em chestunnav','chestunnav','enti','ekkada','nenu','nuvvu','bagunnava','ledu','undi'],
    patterns: [/(?:unnava|unnav|tunnav|tunnadi|ledu|undi)$/,/(?:enti|ekkada)/],
  },
  kanglish: {
    anchors: ['hegiddiya','en madtha idiya','madtha','idiya','hegide','elli','nanu','neenu','illa','beku','beda'],
    patterns: [/(?:iddiya|idiya|madtha|hegide|beku|beda)$/,/(?:elli|heg)/],
  },
};

export function normalizeForDetection(text) {
  const original = String(text || '');
  const normalized = original
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/https?:\/\/\S+|www\.\S+/g, ' ')
    .replace(/[^a-z\s']/g, ' ')
    .replace(/(.)\1{2,}/g, '$1$1')
    .replace(/\s+/g, ' ')
    .trim();
  return { original, normalized, tokens:normalized.match(/[a-z']+/g)||[], compact:normalized.replace(/[^a-z]/g,'') };
}

// Detection-only phonetic folding. It never changes the stored/displayed message.
export function phoneticKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/(.)\1+/g, '$1')
    .replace(/ph/g, 'f')
    .replace(/(?:kh|gh)/g, 'k')
    .replace(/(?:ch|sh)/g, 'c')
    .replace(/(?:th|dh)/g, 't')
    .replace(/bh/g, 'b')
    .replace(/g/g, 'k')
    .replace(/h/g, '')
    .replace(/[eiou]+/g, 'a')
    .replace(/a+/g, 'a')
    .replace(/[^a-z]/g, '');
}

function editDistance(a,b) {
  if(a===b)return 0;
  const row=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    let previous=row[0];row[0]=i;
    for(let j=1;j<=b.length;j++){
      const held=row[j];
      row[j]=Math.min(row[j]+1,row[j-1]+1,previous+(a[i-1]===b[j-1]?0:1));
      previous=held;
    }
  }
  return row[b.length];
}

const closePhoneticMatch=(left,right)=>{
  const a=phoneticKey(left),b=phoneticKey(right);
  if(!a||!b)return false;
  if(a===b)return true;
  const allowance=Math.max(1,Math.floor(Math.max(a.length,b.length)*0.16));
  return Math.min(a.length,b.length)>=4&&editDistance(a,b)<=allowance;
};

function languageScore(form,config) {
  let score=0;
  for(const anchor of config.anchors){
    const anchorForm=normalizeForDetection(anchor);
    if(anchorForm.tokens.length>1){
      if(form.normalized.includes(anchorForm.normalized))score+=2.6;
      else if(closePhoneticMatch(form.compact,anchorForm.compact))score+=2.1;
      continue;
    }
    if(form.tokens.includes(anchorForm.normalized))score+=2;
    else if(form.tokens.some((token)=>closePhoneticMatch(token,anchorForm.normalized)))score+=1.45;
    else if(closePhoneticMatch(form.compact,anchorForm.normalized))score+=1.8;
  }
  for(const pattern of config.patterns)if(pattern.test(form.compact)||form.tokens.some((token)=>pattern.test(token)))score+=1.2;
  return score;
}

function englishEvidence(tokens) {
  if(!tokens.length)return{confidence:0,coverage:0};
  const known=tokens.filter((token)=>ENGLISH_WORDS.has(token)).length;
  const coverage=known/tokens.length;
  const grammatical=tokens.some((token)=>['am','are','is','was','were','do','did','what','where','when','how','why','will','would'].includes(token));
  const obvious=tokens.length===1&&OBVIOUS_ENGLISH.has(tokens[0]);
  let confidence=coverage;
  if(grammatical&&coverage>=0.6)confidence+=0.16;
  if(obvious)confidence=0.98;
  if(tokens.length>=3&&coverage===1)confidence=0.98;
  return{coverage,confidence:Math.min(0.99,confidence)};
}

function unicodeLanguage(text) {
  if(/[\u0D00-\u0D7F]/u.test(text))return'manglish';
  if(/[\u0900-\u097F]/u.test(text))return'hinglish';
  if(/[\u0B80-\u0BFF]/u.test(text))return'tanglish';
  if(/[\u0C00-\u0C7F]/u.test(text))return'telglish';
  if(/[\u0C80-\u0CFF]/u.test(text))return'kanglish';
  return null;
}

export function detectLanguage(text) {
  const form=normalizeForDetection(text);
  const scripted=unicodeLanguage(form.original);
  if(scripted)return{detectedLanguage:scripted,confidence:0.99,shouldTranslate:true,reason:'native_indian_script',normalizedText:form.normalized||form.original.trim().toLowerCase()};
  if(!form.tokens.length)return{detectedLanguage:'unknown',confidence:0,shouldTranslate:false,reason:'no_translatable_text',normalizedText:form.normalized};
  if(form.tokens.length===1&&OBVIOUS_ENGLISH.has(form.tokens[0]))return{detectedLanguage:'english',confidence:0.98,shouldTranslate:false,reason:'obvious_english_chat_word',normalizedText:form.normalized};
  const english=englishEvidence(form.tokens);
  if(form.tokens.length>=2&&english.coverage===1)return{detectedLanguage:'english',confidence:english.confidence,shouldTranslate:false,reason:'complete_english_phrase',normalizedText:form.normalized};

  const scores=Object.entries(LANGUAGE_SIGNALS).map(([language,config])=>({language,score:languageScore(form,config)})).sort((a,b)=>b.score-a.score);
  const top=scores[0],second=scores[1];
  const indianConfidence=top.score?Math.min(0.99,1-Math.exp(-top.score/2.8)):0;
  const ambiguousIndian=second.score>0&&top.score-second.score<0.75;

  // Complete grammatical English phrases outweigh a lone fuzzy phonetic collision.
  if(english.confidence>=ENGLISH_THRESHOLD&&top.score<2){
    return{detectedLanguage:'english',confidence:english.confidence,shouldTranslate:false,reason:'strong_english_evidence',normalizedText:form.normalized};
  }

  if(top.score>0&&indianConfidence>=0.42){
    const mixed=english.coverage>=0.34||ambiguousIndian;
    return{detectedLanguage:mixed?'mixed':top.language,confidence:mixed?Math.max(0.58,indianConfidence-0.08):indianConfidence,shouldTranslate:true,reason:mixed?'indian_and_english_signals':`${top.language}_phonetic_signals`,normalizedText:form.normalized};
  }

  if(english.confidence>=ENGLISH_THRESHOLD){
    return{detectedLanguage:'english',confidence:english.confidence,shouldTranslate:false,reason:'strong_english_evidence',normalizedText:form.normalized};
  }

  return{detectedLanguage:'unknown',confidence:Math.max(0.25,1-english.confidence),shouldTranslate:true,reason:'uncertain_latin_chat',normalizedText:form.normalized};
}

export { ENGLISH_THRESHOLD };
