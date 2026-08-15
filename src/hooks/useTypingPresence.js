import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { firebaseEnabled } from '../firebase';
import * as api from '../services/chatService';

export function useTypingPresence(user) {
  const [typingRows, setTypingRows] = useState([]);
  const [presenceRows, setPresenceRows] = useState([]);
  const [clock, setClock] = useState(Date.now());
  const stopTimer = useRef(null);
  const lastWrite = useRef(0);

  useEffect(() => {
    if (!firebaseEnabled || !user) return undefined;
    const stopTyping = api.subscribeTyping(setTypingRows, () => {});
    const stopPresence = api.subscribePresence(setPresenceRows, () => {});
    let interval = null;
    let heartbeat = null;
    let offline = null;
    if (!user.muted) {
      heartbeat = () => api.setPresence(user.id, document.visibilityState === 'visible' && navigator.onLine).catch(() => {});
      offline = () => api.setPresence(user.id, false).catch(() => {});
      heartbeat();
      interval = window.setInterval(heartbeat, 60000);
      document.addEventListener('visibilitychange', heartbeat);
      window.addEventListener('online', heartbeat);
      window.addEventListener('offline', offline);
      window.addEventListener('pagehide', offline);
    }
    return () => {
      stopTyping(); stopPresence(); clearTimeout(stopTimer.current);
      if (interval) clearInterval(interval);
      if (heartbeat) {
        document.removeEventListener('visibilitychange', heartbeat);
        window.removeEventListener('online', heartbeat);
        window.removeEventListener('offline', offline);
        window.removeEventListener('pagehide', offline);
        api.setTyping(user, false); api.setPresence(user.id, false).catch(() => {});
      }
    };
  }, [user?.id, user?.muted]);

  useEffect(()=>{
    if(!typingRows.length&&!presenceRows.length)return undefined;
    const delay=typingRows.length?1000:15000;
    const timer=window.setInterval(()=>setClock(Date.now()),delay);
    return()=>clearInterval(timer);
  },[typingRows.length,presenceRows.length]);

  const signalTyping = useCallback((hasText) => {
    if (!firebaseEnabled || !user || user.muted) return;
    clearTimeout(stopTimer.current);
    if (!hasText) { api.setTyping(user, false); return; }
    const now = Date.now();
    if (now - lastWrite.current >= 3000) {
      lastWrite.current = now;
      api.setTyping(user, true).catch(() => {});
    }
    stopTimer.current = window.setTimeout(() => api.setTyping(user, false), 4000);
  }, [user]);

  const activeTypers = useMemo(() => typingRows
    .filter((row) => row.userId !== user?.id && (row.expiresAt?.toMillis?.() || +new Date(row.expiresAt || 0)) > clock)
    .map((row) => row.name), [typingRows, user, clock]);

  const typingText = useMemo(() => {
    if (activeTypers.length === 1) return `${activeTypers[0]} is typing…`;
    if (activeTypers.length === 2) return `${activeTypers[0]} and ${activeTypers[1]} are typing…`;
    if (activeTypers.length > 2) return `${activeTypers[0]}, ${activeTypers[1]} and ${activeTypers.length - 2} others are typing…`;
    return '';
  }, [activeTypers]);

  const anyoneOnline = useMemo(() => presenceRows.some((row) => row.userId !== user?.id && row.online
    && clock - (row.heartbeatAt?.toMillis?.() || 0) < 125000), [presenceRows, user, clock]);

  return { typingText, anyoneOnline, signalTyping };
}
