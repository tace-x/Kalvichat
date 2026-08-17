import crypto from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { requireApprovedUser } from '../server/firebaseAdmin.js';
import { detectLanguage } from '../server/languageDetection.js';
import { routeTranslation } from '../server/translationProviders.js';

const exactHash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const logPhase=(phase,startedAt,details='')=>console.info(`[translate] phase=${phase} elapsedMs=${Date.now()-startedAt}${details?` ${details}`:''}`);

async function settleOwnedLease(db,messageRef,leaseId){
  if(!db||!messageRef||!leaseId)return false;
  const startedAt=Date.now();
  try{
    const settled=await db.runTransaction(async(transaction)=>{
      const snapshot=await transaction.get(messageRef);
      if(!snapshot.exists)return true;
      const value=snapshot.data();
      if(value.translationLeaseId!==leaseId)return true; // A newer request owns the message.
      const update={translationLeaseId:FieldValue.delete(),translationLeaseUntil:FieldValue.delete()};
      if(value.translationStatus==='processing'&&!value.deleted)update.translationStatus='failed';
      transaction.update(messageRef,update);
      return true;
    });
    logPhase('lease_cleanup',startedAt,`result=${settled?'settled':'not_settled'}`);return settled;
  }catch(error){
    console.error(`[translation] cleanup=failed error=${error?.name||'Error'}`);
    return false;
  }
}

export default async function handler(request, response) {
  const requestStartedAt=Date.now();let outcome='unknown';
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });
  let messageRef,db,leaseId,leaseAcquired=false,settled=false;
  try {
    const authStartedAt=Date.now();const approved=await requireApprovedUser(request);db=approved.db;logPhase('authentication',authStartedAt);
    const messageId = String(request.body?.messageId || '');
    if (!/^[A-Za-z0-9_-]{10,220}$/.test(messageId)) return response.status(400).json({ error: 'Invalid message ID' });
    messageRef = db.doc(`chatMessages/${messageId}`);
    const readStartedAt=Date.now();
    const [snapshot,chatState]=await Promise.all([messageRef.get(),db.doc('system/chatState').get()]);
    logPhase('firestore_read',readStartedAt);
    if (!snapshot.exists) return response.status(404).json({ error: 'Message not found' });
    const message = snapshot.data();
    const activeGeneration = Number(chatState.data()?.activeGeneration || 1);
    if (message.generation !== activeGeneration) return response.status(409).json({ error: 'Message is not in the active conversation' });
    if (message.deleted || !message.originalText) return response.status(409).json({ error: 'Message is deleted' });
    if (['complete','none'].includes(message.translationStatus)) return response.status(200).json({ status: message.translationStatus, cached: true });
    if (typeof message.originalText !== 'string' || message.originalText.length < 1 || message.originalText.length > 8000) {
      await messageRef.update({translationStatus:'failed',translationLeaseId:FieldValue.delete(),translationLeaseUntil:FieldValue.delete()});
      return response.status(413).json({ error: 'Message is too large to translate' });
    }

    leaseId=crypto.randomUUID();
    const leaseStartedAt=Date.now();
    const lease = await db.runTransaction(async (transaction) => {
      const fresh = await transaction.get(messageRef),value=fresh.data();
      if(!fresh.exists||value.deleted)return{acquired:false};
      if(['complete','none'].includes(value.translationStatus))return{acquired:false,terminal:true,status:value.translationStatus};
      const leaseUntil=value.translationLeaseUntil?.toMillis?.()||0;
      if(value.translationStatus==='processing'&&leaseUntil>Date.now())return{acquired:false,status:'processing'};
      transaction.update(messageRef,{translationStatus:'processing',translationLeaseId:leaseId,translationLeaseUntil:Timestamp.fromMillis(Date.now()+30_000)});
      return{acquired:true,originalText:value.originalText};
    });
    logPhase('lease',leaseStartedAt,`result=${lease.acquired?'acquired':lease.status||'not_acquired'}`);
    if(!lease.acquired)return response.status(lease.terminal?200:202).json({status:lease.status||'processing',cached:Boolean(lease.terminal)});
    leaseAcquired=true;
    const original=lease.originalText;
    if(typeof original!=='string'||original.length<1||original.length>8000)throw Object.assign(new Error('Message is too large to translate'),{status:413});

    const detectionStartedAt=Date.now(),detection=detectLanguage(original);logPhase('detection',detectionStartedAt,`result=${detection.detectedLanguage}`);
    const normalizedSource=detection.normalizedText||original.trim().toLowerCase();
    const memoryRef = db.doc(`translationMemory/${exactHash(normalizedSource)}`);
    let result;
    if (detection.detectedLanguage === 'english' && detection.shouldTranslate === false) {
      result = detection;
    } else {
      const memoryStartedAt=Date.now(),memory=await memoryRef.get(),saved=memory.data();
      const reusable = memory.exists && saved?.trusted === true
        && (saved?.normalizedSource === normalizedSource || saved?.source === original)
        && saved?.targetLanguage === 'english' && typeof saved?.translation === 'string' && saved.translation.trim();
      logPhase('translation_memory',memoryStartedAt,`result=${reusable?'hit':'miss'}`);
      if(reusable)result={...saved,detectedLanguage:saved.sourceLanguage||detection.detectedLanguage,fromMemory:true};
      else{
        const routerStartedAt=Date.now();
        try{result=await routeTranslation(original,detection);logPhase('router',routerStartedAt,`result=success provider=${result.provider}`);}
        catch(error){logPhase('router',routerStartedAt,`result=failed category=${error?.category||error?.name||'error'}`);throw error;}
      }
    }

    const update={
      detectedLanguage:result.detectedLanguage,
      translationStatus:result.detectedLanguage==='english'?'none':'complete',
      translatedAt:FieldValue.serverTimestamp(),translationLeaseId:FieldValue.delete(),translationLeaseUntil:FieldValue.delete(),
      englishText:FieldValue.delete(),hinglishText:FieldValue.delete(),manglishText:FieldValue.delete(),
    };
    if(result.detectedLanguage!=='english')update.englishText=result.translation;
    const writeStartedAt=Date.now();
    const applied=await db.runTransaction(async(transaction)=>{
      const [fresh,state]=await Promise.all([transaction.get(messageRef),transaction.get(db.doc('system/chatState'))]);
      if(!fresh.exists)return false;
      const value=fresh.data(),generation=Number(state.data()?.activeGeneration||1);
      if(value.deleted||value.generation!==generation||value.translationLeaseId!==leaseId||value.originalText!==original)return false;
      transaction.update(messageRef,update);return true;
    });
    logPhase('firestore_write',writeStartedAt,`result=${applied?'applied':'stale'}`);
    if(!applied){outcome='stale';return response.status(409).json({error:'Message is no longer active'});}
    settled=true;outcome=update.translationStatus;

    if(!result.fromMemory&&result.detectedLanguage!=='english'&&result.confidence>=.95){
      await memoryRef.set({source:original,normalizedSource,sourceLanguage:result.detectedLanguage,targetLanguage:'english',translation:result.translation,confidence:result.confidence,trusted:true,provider:result.provider,updatedAt:FieldValue.serverTimestamp()})
        .catch((error)=>console.error(`[translation] memoryWrite=failed error=${error?.name||'Error'}`));
    }
    const source=result.fromMemory?'memory':(result.provider||'local');
    return response.status(200).json({status:update.translationStatus,detectedLanguage:result.detectedLanguage,cached:Boolean(result.fromMemory),source});
  } catch (error) {
    outcome='failed';settled=await settleOwnedLease(db,messageRef,leaseId);
    console.error('Translation failed:', error);
    const status = error.status || 503;
    return response.status(status).json({ error: status < 500 ? error.message : 'Translation unavailable' });
  } finally {
    if(leaseAcquired&&!settled)await settleOwnedLease(db,messageRef,leaseId);
    logPhase('request_total',requestStartedAt,`result=${outcome}`);
  }
}
