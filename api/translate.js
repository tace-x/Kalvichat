import crypto from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { requireApprovedUser } from '../server/firebaseAdmin.js';
import { routeTranslation } from '../server/translationProviders.js';

const hinglishWords = new Set(['kya','kyun','kaise','kaisa','kaunsi','kaunsa','tum','tumhara','tumhari','aap','mera','meri','mujhe','ham','hum','hamara','hai','hain','hoon','nahi','kal','aaj','abhi','chalo','ja','jana','raha','rahi','bahut','accha','acha','theek','ghar','kaam','kar','karo','karna','wala','wali','se','ko','mein','par','aur','lekin','phir','kab','kidhar','kaun','yeh','woh','yaar','mast','bhai','mat','kyunki','thoda','zyada']);
const manglishWords = new Set(['ninte','ente','namude','entha','enthanu','enthokke','enthokkeyaanu','evide','engane','eppo','aaru','njan','nee','ningal','avan','aval','aanu','alle','illa','undu','venam','venda','povam','pokunnu','varam','varunnu','naale','innu','ippo','mani','aanel','enikku','ninakku','konduvaram','kaanam','veedu','veetil','pani','cheyyam','cheyyunnu','pinne','pakshe','kollam','sheri','sughamano','sukham','eda','edi','machane','polichu','ishtam']);
const trustedPhrases = new Map([
  ['ninte hobbies enthokkeyaanu?', { detectedLanguage:'manglish', translation:'tumhari hobbies kya hain?', confidence:1 }],
  ['tumhara favorite movie kaunsa hai?', { detectedLanguage:'hinglish', translation:'ninte favorite movie ethaanu?', confidence:1 }],
]);
const normalize = (text) => text.trim().toLowerCase().replace(/\s+/g, ' ');
const exactHash = (text) => crypto.createHash('sha256').update(text).digest('hex');

function localDetection(text) {
  const normalized = normalize(text);
  const trusted = trustedPhrases.get(normalized);
  if (trusted) return trusted;
  const words = normalized.match(/[a-z]+/g) || [];
  const hi = words.filter((word) => hinglishWords.has(word)).length;
  const ml = words.filter((word) => manglishWords.has(word)).length;
  if (ml > hi) return { detectedLanguage:'manglish', confidence:ml >= 2 ? .99 : .9 };
  if (hi > ml) return { detectedLanguage:'hinglish', confidence:hi >= 2 ? .99 : .9 };
  // With no romanized Hindi/Malayalam markers, preserve the text as English.
  // Loan words remain safe because any surrounding language marker wins above.
  if (!hi && !ml) return { detectedLanguage:'english', translation:'', confidence:.98 };
  return null;
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });
  let messageRef;
  try {
    const { uid, db } = await requireApprovedUser(request);
    const messageId = String(request.body?.messageId || '');
    if (!/^[A-Za-z0-9_-]{10,220}$/.test(messageId)) return response.status(400).json({ error: 'Invalid message ID' });
    messageRef = db.doc(`chatMessages/${messageId}`);
    const snapshot = await messageRef.get();
    if (!snapshot.exists) return response.status(404).json({ error: 'Message not found' });
    const message = snapshot.data();
    const chatState = await db.doc('system/chatState').get();
    const activeGeneration = Number(chatState.data()?.activeGeneration || 1);
    if (message.generation !== activeGeneration) return response.status(409).json({ error: 'Message is not in the active conversation' });
    if (message.deleted || !message.originalText) return response.status(409).json({ error: 'Message is deleted' });
    if (['complete','none'].includes(message.translationStatus)) return response.status(200).json({ status: message.translationStatus, cached: true });
    const original = message.originalText;
    if (typeof original !== 'string' || original.length < 1 || original.length > 8000) return response.status(413).json({ error: 'Message is too large to translate' });

    // A short server lease prevents duplicate provider calls from retries or multiple clients.
    const leased = await db.runTransaction(async (transaction) => {
      const fresh = await transaction.get(messageRef); const value = fresh.data();
      if (['complete','none'].includes(value.translationStatus)) return false;
      const leaseUntil = value.translationLeaseUntil?.toMillis?.() || 0;
      if (leaseUntil > Date.now()) return false;
      transaction.update(messageRef, { translationStatus:'processing', translationLeaseUntil:Timestamp.fromMillis(Date.now()+30_000) });
      return true;
    });
    if (!leased) return response.status(202).json({ status: 'processing' });

    const locallyDetected = localDetection(original);
    const memoryRef = db.doc(`translationMemory/${exactHash(original)}`);
    let result;
    // Strong English detection happens before any memory read or AI request.
    if (locallyDetected?.detectedLanguage === 'english') {
      result = locallyDetected;
    } else {
      const memory = await memoryRef.get();
      if (memory.exists && memory.data().trusted === true && memory.data().source === original) {
        result = { ...memory.data(), fromMemory: true };
      } else {
        result = locallyDetected;
        if (!result || !result.translation) result = await routeTranslation(original);
      }
    }

    const update = {
      detectedLanguage: result.detectedLanguage,
      translationStatus: result.detectedLanguage === 'english' ? 'none' : 'complete',
      translatedAt: FieldValue.serverTimestamp(), translationLeaseUntil: FieldValue.delete(),
      hinglishText: FieldValue.delete(), manglishText: FieldValue.delete(),
    };
    if (result.detectedLanguage === 'hinglish') update.manglishText = result.translation;
    if (result.detectedLanguage === 'manglish') update.hinglishText = result.translation;
    const applied = await db.runTransaction(async (transaction) => {
      const [fresh,state] = await Promise.all([transaction.get(messageRef),transaction.get(db.doc('system/chatState'))]);
      const value=fresh.data(),generation=Number(state.data()?.activeGeneration||1);
      if(!fresh.exists||value.deleted||value.generation!==generation)return false;
      transaction.update(messageRef,update);return true;
    });
    if(!applied)return response.status(409).json({error:'Message is no longer active'});

    // Only validated high-confidence results become shared exact memory.
    if (!result.fromMemory && result.detectedLanguage !== 'english' && result.confidence >= .95) {
      await memoryRef.set({ source:original, detectedLanguage:result.detectedLanguage, translation:result.translation, confidence:result.confidence, trusted:true, provider:result.provider || 'curated', updatedAt:FieldValue.serverTimestamp() });
    }
    return response.status(200).json({ status:update.translationStatus, detectedLanguage:result.detectedLanguage, cached:Boolean(result.fromMemory) });
  } catch (error) {
    console.error('Translation failed:', error);
    if (messageRef) await messageRef.update({ translationStatus:'failed', translationLeaseUntil:FieldValue.delete() }).catch(() => {});
    const status = error.status || 503;
    return response.status(status).json({ error: status < 500 ? error.message : 'Translation unavailable' });
  }
}
