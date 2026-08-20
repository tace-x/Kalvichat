import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeDocuments, lookupKnowledge, MAX_CANONICAL_ENTRIES, MAX_LOOKUP_KEYS, MAX_UPLOAD_BYTES, mergeKnowledgeEntries, normalizeKnowledgeEntry, parseDataset, sanitizeLearningSource, trainingTxt } from '../server/translationKnowledge.js';

test('beta limits retain safe defaults',()=>{assert.equal(MAX_UPLOAD_BYTES,2097152);assert.equal(MAX_CANONICAL_ENTRIES,1000);assert.equal(MAX_LOOKUP_KEYS,5000);});

test('JSON dataset parses rich entries and merges duplicates',()=>{
  const parsed=parseDataset(JSON.stringify({entries:[{source:'sughamaano',language:'manglish',variants:['sughamano'],possibleMeanings:['How are you?'],confidence:.94},{source:'SUGHAMAANO?',language:'manglish',variants:['sugham ano'],possibleMeanings:['Are you okay?'],usageCount:2}]}),'json');
  const merged=mergeKnowledgeEntries(parsed.entries);assert.equal(merged.length,1);assert.deepEqual(new Set(merged[0].meanings),new Set(['How are you?','Are you okay?']));assert.ok(merged[0].variants.length>=3);
});

test('CSV and TXT formats normalize into entries',()=>{
  const csv=parseDataset('source,language,translation,variants,confidence\n"ninte perentha",manglish,"What is your name?","ninte peru entha",0.95','csv');assert.equal(csv.entries[0].meanings[0],'What is your name?');
  const txt=parseDataset('SOURCE:\nkoode varunno\n\nLANGUAGE:\nmanglish\n\nPOSSIBLE TRANSLATIONS:\nAre you coming with me?\n\nCONFIDENCE:\n0.93','txt');assert.equal(txt.entries[0].meanings[0],'Are you coming with me?');
});

test('lookup documents create exact, variant and conservative phonetic keys',()=>{
  const entry=normalizeKnowledgeEntry({source:'sughamaano',language:'manglish',variants:['sugham ano','sukhamano'],possibleMeanings:['How are you?'],confidence:.94});const docs=buildKnowledgeDocuments([entry],'v1');
  assert.equal(docs.entries.length,1);assert.ok(docs.lookup.some((item)=>item.keyType==='exact'&&item.confidence>=.85));assert.ok(docs.lookup.some((item)=>item.keyType==='variant'&&item.confidence>=.85));assert.ok(docs.lookup.some((item)=>item.keyType==='phonetic'&&item.confidence<.85));
});

test('strong deterministic lookup resolves without scanning',async()=>{
  const entry=normalizeKnowledgeEntry({source:'ninte perentha',language:'manglish',translation:'What is your name?',confidence:.95});const docs=buildKnowledgeDocuments([entry],'v3'),records=new Map([['system/translationKnowledge',{activeVersion:'v3'}],...docs.lookup.map(({id,...value})=>[`translationKnowledgeLookup/${id}`,value])]);let reads=0;
  const db={doc:(path)=>({get:async()=>{reads++;const value=records.get(path);return{exists:Boolean(value),data:()=>value};}})};
  const match=await lookupKnowledge(db,'ninte perentha',{detectedLanguage:'manglish'});assert.equal(match.strong,true);assert.equal(match.meanings[0],'What is your name?');assert.equal(reads,2);
});

test('low-confidence uploads cannot become fast-path matches',()=>{
  const entry=normalizeKnowledgeEntry({source:'ambiguous phrase',translation:'Possible meaning',confidence:.4});const docs=buildKnowledgeDocuments([entry],'v1');const exact=docs.lookup.find((item)=>item.keyType==='exact');assert.ok(exact.confidence<.85);
});

test('sensitive learning sources are rejected',()=>{
  for(const value of ['email me at person@example.com','my password is secret','OTP 12345678','https://private.example'])assert.equal(sanitizeLearningSource(value),null);
  assert.equal(sanitizeLearningSource('evide pokunnu?'),'evide pokunnu?');
});

test('training TXT excludes identity fields and remains structured',()=>{
  const text=trainingTxt([{source:'sughamaano',language:'manglish',translations:[{text:'How are you?',count:3}],confidence:.94,observations:3,userId:'private'}]);assert.match(text,/SOURCE:/);assert.match(text,/How are you\?/);assert.doesNotMatch(text,/private|userId/);
});
