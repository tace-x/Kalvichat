import {
  collection, deleteDoc, deleteField, doc, getDocs, limit, onSnapshot,
  orderBy, query, serverTimestamp, setDoc, startAfter, updateDoc, where,
} from 'firebase/firestore';
import { auth, db, firebaseEnabled } from '../firebase';
import { subscribeReactionWindow } from './reactionService';

export const PAGE_SIZE = 20;
const messagesRef = () => collection(db, 'chatMessages');
const asDate = (value, fallback) => value?.toDate?.() || (value ? new Date(value) : new Date(fallback));
const normalize = (snapshot) => {
  const value = snapshot.data();
  return {
    id: snapshot.id,
    ...value,
    senderColor: value.senderColor || value.color,
    senderAvatar: value.senderAvatar || value.avatar,
    createdAt: asDate(value.createdAt, value.clientCreatedAt),
    updatedAt: asDate(value.updatedAt, value.clientCreatedAt),
    editedAt: value.editedAt ? asDate(value.editedAt) : null,
    deletedAt: value.deletedAt ? asDate(value.deletedAt) : null,
    status: snapshot.metadata?.hasPendingWrites ? 'queued' : 'sent',
    _snapshot: snapshot,
  };
};

function configured() {
  if (!firebaseEnabled || !db) throw new Error('Firebase is not available.');
}
function uniqueById(messages) {
  return [...new Map(messages.map((message) => [message.id, message])).values()];
}

async function attachReactions(messages) {
  if (!messages.length) return messages;
  const ids = messages.map((message) => message.id);
  const result = new Map(messages.map((message) => [message.id, { counts: {}, mine: null }]));
  // Firestore `in` supports 30 values; page size is deliberately 20.
  const snapshot = await getDocs(query(collection(db, 'chatReactions'), where('messageId', 'in', ids)));
  snapshot.forEach((reaction) => {
    const value = reaction.data();
    const bucket = result.get(value.messageId);
    if (!bucket) return;
    bucket.counts[value.emoji] = (bucket.counts[value.emoji] || 0) + 1;
    if (value.userId === auth.currentUser?.uid) bucket.mine = value.emoji;
  });
  return messages.map((message) => ({
    ...message,
    reactions: result.get(message.id)?.counts || {},
    myReaction: result.get(message.id)?.mine || null,
  }));
}

export async function getOlderMessages(oldest, generation) {
  configured();
  if (!oldest?._snapshot || !Number.isInteger(generation)) return [];
  const snapshot = await getDocs(query(messagesRef(), where('generation', '==', generation), orderBy('createdAt', 'desc'), startAfter(oldest._snapshot), limit(PAGE_SIZE)));
  return attachReactions(snapshot.docs.map(normalize).reverse());
}

// The only message listener is restricted to the newest 20 documents in the active generation.
export function subscribeToNewest(generation, callback, onError) {
  configured();
  const newest = query(messagesRef(), where('generation', '==', generation), orderBy('createdAt', 'desc'), limit(PAGE_SIZE));
  return onSnapshot(newest, { includeMetadataChanges: true }, (snapshot) => {
    callback(snapshot.docs.map(normalize).reverse());
  }, onError);
}

export function subscribeToNewestReactions(messageIds, callback, onError) {
  return subscribeReactionWindow({collectionName:'chatReactions',messageIds,userId:auth.currentUser?.uid,onData:callback,onError});
}

export async function sendMessage(message) {
  configured();
  // A deterministic client-generated ID makes Firestore offline retries idempotent.
  await setDoc(doc(db, 'chatMessages', message.id), {
    senderId: message.senderId,
    senderName: message.senderName,
    senderColor: message.senderColor,
    senderAvatar: message.senderAvatar,
    generation: message.generation,
    originalText: message.originalText,
    detectedLanguage: 'pending',
    translationStatus: 'pending',
    replyTo: message.replyTo || null,
    clientCreatedAt: message.clientCreatedAt,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    edited: false,
    deleted: false,
    deletedByAdmin: false,
  }, { merge: false });
}

export async function requestTranslation(messageId) {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Authentication required.');
  const response = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    signal:AbortSignal.timeout(15_000),
    body: JSON.stringify({ messageId }),
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(payload.error||`Translation request failed (${response.status}).`);error.status=response.status;throw error;}
  return payload;
}

export async function editMessage(id, originalText) {
  configured();
  await updateDoc(doc(db, 'chatMessages', id), {
    originalText,
    edited: true,
    editedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    detectedLanguage: 'pending',
    translationStatus: 'pending',
    englishText: deleteField(),
    hinglishText: deleteField(),
    manglishText: deleteField(),
  });
}

export async function deleteMessage(id) {
  configured();
  await updateDoc(doc(db, 'chatMessages', id), {
    originalText: deleteField(),
    englishText: deleteField(),
    hinglishText: deleteField(),
    manglishText: deleteField(),
    deleted: true,
    deletedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    translationStatus: 'deleted',
  });
}

export async function setReaction(messageId, userId, emoji) {
  configured();
  const ref = doc(db, 'chatReactions', `${messageId}_${userId}`);
  if (!emoji) return deleteDoc(ref);
  return setDoc(ref, { messageId, userId, emoji, updatedAt: serverTimestamp() });
}

export function subscribeChatState(callback, onError) {
  return onSnapshot(doc(db, 'system', 'chatState'), (snapshot) => {
    const value = snapshot.data() || {}, generation = Number(value.activeGeneration || 1);
    callback({ generation:Number.isInteger(generation) && generation > 0 ? generation : 1, recentDeletedMessageIds:Array.isArray(value.recentDeletedMessageIds)?value.recentDeletedMessageIds:[] });
  }, onError);
}

export function subscribeMembers(callback, onError) {
  return onSnapshot(doc(db, 'system', 'chatMeta'), (snapshot) => {
    const value=snapshot.data()||{},ids=value.eligibleMemberIds||[],identities=value.identities||{};
    callback(ids.map((id) => ({ id, ...(identities[id]||{}), approved:true, banned:false, blocked:false, role:'user' })));
  }, onError);
}
export function subscribeReadStates(callback, onError) {
  return onSnapshot(collection(db, 'chatReadState'), (snapshot) => callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))), onError);
}
export async function updateReadState(userId, readThrough) {
  return setDoc(doc(db, 'chatReadState', userId), { userId, readThrough, deliveredThrough: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
}
export async function updateDeliveredState(userId) {
  return setDoc(doc(db, 'chatReadState', userId), { userId, deliveredThrough: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
}

export function subscribeTyping(callback, onError) {
  return onSnapshot(collection(db, 'typing'), (snapshot) => callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))), onError);
}
export async function setTyping(user, active) {
  const ref = doc(db, 'typing', user.id);
  if (!active) return deleteDoc(ref).catch(() => {});
  return setDoc(ref, { userId: user.id, name: user.name, expiresAt: new Date(Date.now() + 6000), updatedAt: serverTimestamp() });
}

export function subscribePresence(callback, onError) {
  return onSnapshot(collection(db, 'presence'), (snapshot) => callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))), onError);
}
export async function setPresence(userId, online) {
  return setDoc(doc(db, 'presence', userId), { userId, online, heartbeatAt: serverTimestamp() }, { merge: true });
}

export { uniqueById };
