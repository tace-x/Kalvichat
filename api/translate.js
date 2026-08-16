import crypto from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { requireApprovedUser } from '../server/firebaseAdmin.js';
import { detectLanguage } from '../server/languageDetection.js';
import { routeTranslation } from '../server/translationProviders.js';

const exactHash = (text) => crypto.createHash('sha256').update(text).digest('hex');

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

    const detection = detectLanguage(original);
    const normalizedSource=detection.normalizedText||original.trim().toLowerCase();
    const memoryRef = db.doc(`translationMemory/${exactHash(normalizedSource)}`);
    let result;
    // Only high-confidence English bypasses memory/providers. Unknown and mixed
    // Latin-script chat deliberately continues to translation routing.
    if (detection.detectedLanguage === 'english' && detection.shouldTranslate === false) {
      result = detection;
    } else {
      const memory = await memoryRef.get();
      const saved = memory.data();
      const reusable = memory.exists && saved?.trusted === true
        && (saved?.normalizedSource === normalizedSource || saved?.source === original)
        && saved?.targetLanguage === 'english' && typeof saved?.translation === 'string' && saved.translation.trim();
      if (reusable) {
        result = { ...saved, detectedLanguage:saved.sourceLanguage||detection.detectedLanguage, fromMemory:true };
      } else {
        result = await routeTranslation(original,detection);
      }
    }

    const update = {
      detectedLanguage: result.detectedLanguage,
      translationStatus: result.detectedLanguage === 'english' ? 'none' : 'complete',
      translatedAt: FieldValue.serverTimestamp(), translationLeaseUntil: FieldValue.delete(),
      englishText: FieldValue.delete(), hinglishText: FieldValue.delete(), manglishText: FieldValue.delete(),
    };
    if (result.detectedLanguage !== 'english') update.englishText = result.translation;
    const applied = await db.runTransaction(async (transaction) => {
      const [fresh,state] = await Promise.all([transaction.get(messageRef),transaction.get(db.doc('system/chatState'))]);
      const value=fresh.data(),generation=Number(state.data()?.activeGeneration||1);
      if(!fresh.exists||value.deleted||value.generation!==generation)return false;
      transaction.update(messageRef,update);return true;
    });
    if(!applied)return response.status(409).json({error:'Message is no longer active'});

    // Only validated high-confidence results become shared exact memory.
    if (!result.fromMemory && result.detectedLanguage !== 'english' && result.confidence >= .95) {
      await memoryRef.set({ source:original, normalizedSource, sourceLanguage:result.detectedLanguage, targetLanguage:'english', translation:result.translation, confidence:result.confidence, trusted:true, provider:result.provider, updatedAt:FieldValue.serverTimestamp() });
    }
    const source=result.fromMemory?'memory':(result.provider||'local');
    return response.status(200).json({ status:update.translationStatus, detectedLanguage:result.detectedLanguage, cached:Boolean(result.fromMemory), source });
  } catch (error) {
    console.error('Translation failed:', error);
    if (messageRef) await messageRef.update({ translationStatus:'failed', translationLeaseUntil:FieldValue.delete() }).catch(() => {});
    const status = error.status || 503;
    return response.status(status).json({ error: status < 500 ? error.message : 'Translation unavailable' });
  }
}
