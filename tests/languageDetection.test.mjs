import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, normalizeForDetection } from '../server/languageDetection.js';

const cases={
  english:['hello','how are you?','what are you doing?','where are you?','I am coming tomorrow'],
  manglish:['sughamaano?','sughamaano','sugham ano?','sugam ano?','sukhamano?','sukhamaano?','ninte perentha?','entha paripadi?','evideya?','engotta?','nee evideya?'],
  hinglish:['kya kar rahe ho?','tum kaha ho?','mujhe nahi pata'],
  tanglish:['epdi iruka?','enna panra?','saptiya?'],
  telglish:['ela unnava','em chestunnav'],
  kanglish:['hegiddiya','en madtha idiya'],
  mixed:['bro sughamaano?','njan coming tomorrow','entha bro how are you?'],
  variants:['sughamaano','sughamaanooo','sugamaano','sugham ano','sughamanno','sughamanooo','sughamaano???','sughamaano!!!','"sughamaano?"','sughamaano...'],
};

for(const [expected,messages] of Object.entries(cases)){
  test(`${expected} detection`,()=>{
    for(const message of messages){
      const result=detectLanguage(message);
      if(expected==='variants')assert.notEqual(result.detectedLanguage,'english',`${message} was English`);
      else if(expected==='mixed')assert.equal(result.detectedLanguage,'mixed',`${message}: ${JSON.stringify(result)}`);
      else assert.equal(result.detectedLanguage,expected,`${message}: ${JSON.stringify(result)}`);
      assert.equal(result.shouldTranslate,expected!=='english',`${message}: translate flag`);
    }
  });
}

test('native Indian scripts route to translation',()=>{
  for(const message of ['സുഖമാണോ','क्या कर रहे हो','எப்படி இருக்க','ఎలా ఉన్నావు','ಹೇಗಿದ್ದೀಯ']){
    const result=detectLanguage(message);assert.equal(result.shouldTranslate,true,message);
  }
});

test('normalization never changes original',()=>{
  const input='Sughamaano???';const form=normalizeForDetection(input);
  assert.equal(form.original,input);assert.equal(form.normalized,'sughamaano');
});
