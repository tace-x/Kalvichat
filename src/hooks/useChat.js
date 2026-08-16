import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { firebaseEnabled } from '../firebase';
import * as api from '../services/chatService';
import panda from '../assets/avatars/panda.svg';
import fox from '../assets/avatars/fox.svg';
import penguin from '../assets/avatars/penguin.svg';

const demoPeople = [
  { id: 'rahul', name: 'Rahul', senderAvatar: panda, senderColor: '#C4613F' },
  { id: 'meera', name: 'Meera', senderAvatar: fox, senderColor: '#5B68A6' },
  { id: 'anu', name: 'Anu', senderAvatar: penguin, senderColor: '#2F7A68' },
];
const samples = [
  ['rahul','Guys, naale beachil povam? 🌊','Guys, kal beach chalein? 🌊','manglish'],
  ['meera','Yes! What time works for everyone?','','english'],
  ['anu','Evening aanel enikku okay aanu','Shaam ho toh mere liye okay hai','manglish'],
  ['rahul','5 mani set aakkam','5 baje rakhte hain','manglish'],
  ['rahul','sunset um kaanam ✨','sunset bhi dekh lenge ✨','manglish'],
  ['meera','Perfect, njan snacks konduvaram','Perfect, main snacks le aaungi','manglish'],
];
function makeDemoMessages() {
  const now = Date.now();
  return Array.from({ length: 47 }, (_, index) => {
    const sample = samples[index % samples.length];
    const person = demoPeople.find((item) => item.id === sample[0]);
    return {
      id: `demo-${index}`, ...person, senderId: person.id, senderName: person.name,
      originalText: sample[1], detectedLanguage: sample[3],
      manglishText: sample[3] === 'hinglish' ? sample[2] : undefined,
      hinglishText: sample[3] === 'manglish' ? sample[2] : undefined,
      translationStatus: sample[3] === 'english' ? 'none' : 'complete',
      createdAt: new Date(now - (47 - index) * 63000), updatedAt: new Date(now - (47 - index) * 63000),
      clientCreatedAt: now - (47 - index) * 63000, reactions: index === 44 ? {'❤️':3,'👏':1} : index === 45 ? {'🔥':2} : {},
      status: 'read', replyTo: index === 46 ? { id:'demo-44', text:samples[2][1], deleted:false } : null,
    };
  });
}
const DEMO_MESSAGES = makeDemoMessages();
const millis = (value) => value?.toDate?.()?.getTime?.() ?? new Date(value || 0).getTime();

export function useChat(user) {
  const [messages, setMessages] = useState([]);
  const [activeGeneration, setActiveGeneration] = useState(firebaseEnabled ? null : 1);
  const generationRef = useRef(activeGeneration);
  generationRef.current = activeGeneration;
  const [hasOlder, setHasOlder] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState('');
  const [members, setMembers] = useState([]);
  const [readStates, setReadStates] = useState([]);
  const [unreadAfter, setUnreadAfter] = useState(null);
  const initialReadCaptured = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const startRef = useRef(Math.max(0, DEMO_MESSAGES.length - api.PAGE_SIZE));
  const translationRequests = useRef(new Set());
  const readTimer = useRef(null);
  const deliveredTimer = useRef(null);
  const pendingRead = useRef(0);

  useEffect(() => {
    if (!firebaseEnabled) {
      setMessages(DEMO_MESSAGES.slice(startRef.current));
      setMembers(demoPeople.map((person) => ({ ...person, approved: true })));
      return undefined;
    }
    if (!user) return undefined;
    initialReadCaptured.current = false; setUnreadAfter(null);
    const stopState = api.subscribeChatState((state) => {
      setActiveGeneration(state.generation);
      const deleted = new Set(state.recentDeletedMessageIds);
      if (deleted.size) setMessages((old) => old.map((message) => {
        const replyTo = message.replyTo && deleted.has(message.replyTo.id) ? { id:message.replyTo.id, deleted:true } : message.replyTo;
        return deleted.has(message.id)
          ? { ...message, originalText:null, englishText:null, hinglishText:null, manglishText:null, detectedLanguage:null, translationStatus:'deleted', deleted:true, deletedByAdmin:true, reactions:{}, replyTo }
          : { ...message, replyTo };
      }));
    }, () => setError('Chat state is temporarily unavailable.'));
    const stopMembers = api.subscribeMembers(setMembers, () => setError('Member state is temporarily unavailable.'));
    const stopReads = api.subscribeReadStates((rows) => {
      setReadStates(rows);
      if (!initialReadCaptured.current) {
        initialReadCaptured.current = true;
        const own = rows.find((row) => row.id === user.id);
        setUnreadAfter(own?.readThrough ? millis(own.readThrough) : 0);
      }
    }, () => {});
    api.updateDeliveredState(user.id).catch(() => {});
    const delivered = () => api.updateDeliveredState(user.id).catch(() => {});
    window.addEventListener('online', delivered);
    return () => {
      stopState(); stopMembers(); stopReads(); window.removeEventListener('online', delivered);
      clearTimeout(readTimer.current); clearTimeout(deliveredTimer.current);
    };
  }, [user?.id]);

  useEffect(() => {
    if (!firebaseEnabled || !user || !Number.isInteger(activeGeneration)) return undefined;
    setHasOlder(true);
    const queued = messagesRef.current.filter((message) => message.senderId === user.id && message.status === 'queued' && message.generation !== activeGeneration);
    // A generation change invalidates all active cached history. Only genuinely
    // queued local writes are rebased; already-delivered old messages stay historical.
    setMessages(queued.map((message) => ({ ...message, generation: activeGeneration, status: 'queued' })));
    queued.forEach((message) => api.sendMessage({ ...message, generation: activeGeneration }).then(() => api.requestTranslation(message.id)).catch(() => {}));
    const stopNewest = api.subscribeToNewest(activeGeneration, (newest) => setMessages((old) => {
      const current = old.filter((message) => message.generation === activeGeneration);
      const map = new Map(current.map((message) => [message.id, message]));
      newest.forEach((message) => map.set(message.id, { ...map.get(message.id), ...message }));
      return [...map.values()].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
    }), () => setError('Connection interrupted. Firestore will reconnect automatically.'));
    return () => stopNewest();
  }, [activeGeneration, user?.id]);

  const latestMessage = messages.at(-1);
  useEffect(() => {
    if (!firebaseEnabled || !user || !latestMessage || latestMessage.senderId === user.id) return undefined;
    clearTimeout(deliveredTimer.current);
    deliveredTimer.current = window.setTimeout(() => api.updateDeliveredState(user.id).catch(() => {}), 700);
    return () => clearTimeout(deliveredTimer.current);
  }, [latestMessage?.id, user]);

  const newestIds = useMemo(() => messages.slice(-api.PAGE_SIZE).map((message) => message.id), [messages]);
  const newestKey = newestIds.join('|');
  useEffect(() => {
    if (!firebaseEnabled || !user || !newestIds.length) return undefined;
    return api.subscribeToNewestReactions(newestIds, (grouped) => setMessages((old) => old.map((message) => {
      if (!newestIds.includes(message.id)) return message;
      const value = grouped[message.id] || { counts: {}, mine: null };
      return { ...message, reactions: value.counts, myReaction: value.mine };
    })), () => {});
  // newestKey intentionally stabilizes the ID-window dependency.
  }, [newestKey, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const requestTranslation = useCallback(async (id) => {
    if (!firebaseEnabled || translationRequests.current.has(id)) return;
    translationRequests.current.add(id);
    try { await api.requestTranslation(id); }
    catch { /* A reconnect or later listener pass retries pending translations. */ }
    finally { translationRequests.current.delete(id); }
  }, []);

  useEffect(() => {
    if (!firebaseEnabled || !navigator.onLine) return undefined;
    const pending = messages.filter((message) => message.translationStatus === 'pending' && !message.deleted).slice(-5);
    pending.forEach((message) => requestTranslation(message.id));
    const processing = messages.filter((message) => message.translationStatus === 'processing' && !message.deleted).slice(-5);
    if (!processing.length) return undefined;
    const retry = window.setTimeout(() => processing.forEach((message) => requestTranslation(message.id)), 31_000);
    return () => clearTimeout(retry);
  }, [messages, requestTranslation]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasOlder) return;
    setLoadingOlder(true);
    try {
      if (!firebaseEnabled) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        const next = Math.max(0, startRef.current - api.PAGE_SIZE);
        const batch = DEMO_MESSAGES.slice(next, startRef.current);
        startRef.current = next;
        setMessages((old) => api.uniqueById([...batch, ...old]));
        setHasOlder(next > 0);
      } else {
        const batch = await api.getOlderMessages(messagesRef.current[0], generationRef.current);
        setMessages((old) => api.uniqueById([...batch, ...old]));
        setHasOlder(batch.length === api.PAGE_SIZE);
      }
    } catch { setError('Older messages could not be loaded.'); }
    finally { setLoadingOlder(false); }
  }, [loadingOlder, hasOlder]);

  const send = useCallback(async (text, replyTo) => {
    if (user.muted) { setError('Your account is muted.'); return; }
    const id = `${user.id}_${Date.now()}_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    const message = {
      id, senderId: user.id, senderName: user.name, senderColor: user.color, senderAvatar: user.avatar,
      generation: generationRef.current || 1, originalText: text, clientCreatedAt: Date.now(), createdAt: new Date(), updatedAt: new Date(),
      replyTo: replyTo || null, status: navigator.onLine ? 'sending' : 'queued', translationStatus: 'pending', reactions: {},
    };
    setMessages((old) => [...old, message]);
    if (!firebaseEnabled) {
      window.setTimeout(() => setMessages((old) => old.map((item) => item.id === id
        ? { ...item, detectedLanguage: 'english', translationStatus: 'none', status: 'sent' } : item)), 650);
      return;
    }
    try { await api.sendMessage(message); requestTranslation(id); }
    catch { setMessages((old) => old.map((item) => item.id === id ? { ...item, status: 'queued' } : item)); }
  }, [user, requestTranslation]);

  const react = useCallback((id, emoji) => {
    if (user.muted) { setError('Your account is muted.'); return; }
    const previous = messagesRef.current.find((message) => message.id === id);
    if (!previous) return;
    const counts = { ...(previous.reactions || {}) };
    if (previous.myReaction) counts[previous.myReaction] = Math.max(0, (counts[previous.myReaction] || 1) - 1);
    const next = previous.myReaction === emoji ? null : emoji;
    if (next) counts[next] = (counts[next] || 0) + 1;
    setMessages((old) => old.map((message) => message.id === id ? { ...message, reactions: counts, myReaction: next } : message));
    if (firebaseEnabled) api.setReaction(id, user.id, next).catch(() => {
      setMessages((old) => old.map((message) => message.id === id ? previous : message));
      setError('Reaction could not be saved.');
    });
  }, [user]);

  const edit = useCallback(async (id, text) => {
    const previous = messagesRef.current.find((message) => message.id === id);
    setMessages((old) => old.map((message) => message.id === id ? {
      ...message, originalText: text, edited: true, editedAt: new Date(), updatedAt: new Date(),
      translationStatus: 'pending', englishText:null, hinglishText: null, manglishText: null,
    } : message));
    if (firebaseEnabled) {
      try { await api.editMessage(id, text); requestTranslation(id); }
      catch {
        if (previous) setMessages((old) => old.map((message) => message.id === id ? previous : message));
        setError('Edit could not be saved.');
      }
    }
  }, [requestTranslation]);

  const remove = useCallback(async (id) => {
    const previous = messagesRef.current.find((message) => message.id === id);
    setMessages((old) => old.map((message) => message.id === id ? {
      ...message, originalText: null, deleted: true, deletedAt: new Date(), translationStatus: 'deleted',
    } : message));
    if (firebaseEnabled) api.deleteMessage(id).catch(() => {
      if (previous) setMessages((old) => old.map((message) => message.id === id ? previous : message));
      setError('Delete could not be completed.');
    });
  }, []);

  const markRead = useCallback((createdAt) => {
    if (!firebaseEnabled || !user) return;
    pendingRead.current = Math.max(pendingRead.current, +new Date(createdAt));
    clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => {
      const value = new Date(pendingRead.current);
      api.updateReadState(user.id, value).catch(() => {});
    }, 800);
  }, [user]);

  const eligible = useMemo(() => members.filter((member) => member.approved && !member.banned && !member.blocked && member.role !== 'admin'), [members]);
  const states = useMemo(() => new Map(readStates.map((state) => [state.id, state])), [readStates]);
  const identities = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const displayMessages = useMemo(() => messages.map((message) => {
    const identity=identities.get(message.senderId);
    const resolved=identity?{...message,senderAvatar:identity.avatar||message.senderAvatar,senderColor:identity.senderColor||message.senderColor}:message;
    if (message.senderId !== user?.id || !firebaseEnabled) return resolved;
    const others = eligible.filter((member) => member.id !== user.id);
    const created = +new Date(message.createdAt);
    const allRead = others.length > 0 && others.every((member) => millis(states.get(member.id)?.readThrough) >= created);
    const allDelivered = others.length > 0 && others.every((member) => millis(states.get(member.id)?.deliveredThrough) >= created);
    return { ...resolved, status: allRead ? 'read' : allDelivered ? 'delivered' : message.status === 'queued' ? 'queued' : 'sent' };
  }), [messages, eligible, identities, states, user]);

  return { messages: displayMessages, loadOlder, hasOlder, loadingOlder, error, send, react, edit, remove, markRead, unreadAfter };
}
