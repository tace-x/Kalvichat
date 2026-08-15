import { useEffect, useState } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, authPersistenceReady, db, firebaseEnabled, firebaseConfigurationInvalid, firebaseInitializationError } from '../firebase';
import penguin from '../assets/avatars/penguin.svg';

export const DEMO_USER = {
  id: 'anu', name: 'Anu', username: 'anu', avatar: penguin,
  color: '#2F7A68', language: 'Manglish', approved: true,
};

export function useSession() {
  const [state, setState] = useState(() => firebaseEnabled
    ? { status: 'loading', user: null, error: null }
    : firebaseConfigurationInvalid
      ? { status: 'error', user: null, error: 'Firebase configuration is incomplete. Demo mode was not activated.' }
      : { status: 'ready', user: DEMO_USER, error: null });

  useEffect(() => {
    if (!firebaseEnabled) return undefined;
    if (firebaseInitializationError || !auth || !db) {
      setState({ status: 'error', user: null, error: 'Firebase could not be initialized.' });
      return undefined;
    }

    let active = true;
    let unsubscribeAuth = () => {};
    let unsubscribeMember = () => {};

    // Do not begin account restoration until session-only persistence is active.
    authPersistenceReady.then(() => {
      if (!active) return;
      unsubscribeAuth = onAuthStateChanged(auth, (account) => {
        unsubscribeMember();
        unsubscribeMember = () => {};
        if (!account) {
          setState({ status: 'signed-out', user: null, error: null });
          return;
        }
        unsubscribeMember = onSnapshot(doc(db, 'members', account.uid), (snapshot) => {
          if (!snapshot.exists()) {
            setState({ status: 'blocked', user: null, error: 'Your member profile is unavailable.' });
            return;
          }
          const profile = snapshot.data();
          const accountStatus = profile.status || (profile.banned ? 'banned' : profile.approved ? 'approved' : 'pending');
          const safeAccount = { id: account.uid, name: profile.name, username: profile.username, rejectionReason: profile.rejectionReason || '', status: accountStatus };
          if (profile.role === 'admin') {
            setState({ status: 'error', user: null, account: null, error: 'Admin accounts cannot participate in chat.' });
            return;
          }
          if (accountStatus !== 'approved' || profile.banned) {
            setState({ status: accountStatus === 'banned' ? 'banned' : accountStatus, user: null, account: safeAccount, error: null });
            return;
          }
          setState({
            status: 'ready', error: null, account: safeAccount,
            user: {
              id: account.uid, name: profile.name, username: profile.username,
              avatar: profile.avatar, color: profile.senderColor || profile.color,
              language: profile.language, approved: true, muted: Boolean(profile.muted),
            },
          });
        }, () => setState({ status: 'error', user: null, error: 'Could not verify account approval.' }));
      }, () => setState({ status: 'error', user: null, error: 'Authentication is temporarily unavailable.' }));
    }).catch(() => {
      if (active) setState({ status: 'error', user: null, error: 'Secure session storage is unavailable.' });
    });

    return () => {
      active = false;
      unsubscribeAuth();
      unsubscribeMember();
    };
  }, []);

  return { ...state, logout: () => auth ? signOut(auth) : Promise.resolve() };
}
