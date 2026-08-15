import { getApp, getApps, initializeApp } from 'firebase/app';
import { browserSessionPersistence, getAuth, setPersistence } from 'firebase/auth';
import {
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY?.trim(),
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim(),
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim(),
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET?.trim(),
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim(),
  appId: import.meta.env.VITE_FIREBASE_APP_ID?.trim(),
};

const required = ['apiKey', 'authDomain', 'projectId', 'appId'];
export const firebaseConfigurationPresent = Object.values(firebaseConfig).some(Boolean);
export const firebaseEnabled = required.every((key) => Boolean(firebaseConfig[key]));
export const firebaseConfigurationInvalid = firebaseConfigurationPresent && !firebaseEnabled;
export const firebaseMode = firebaseEnabled ? 'firebase' : firebaseConfigurationInvalid ? 'invalid' : 'demo';
export let firebaseInitializationError = firebaseConfigurationInvalid
  ? new Error('Firebase configuration is incomplete.')
  : null;
export let app = null;
export let auth = null;
export let db = null;
export let authPersistenceReady = Promise.resolve();

if (firebaseEnabled) {
  try {
    app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    auth = getAuth(app);
    // Session persistence survives reloads in the same browser session, but not a
    // new browser session. Passwords are managed only by Firebase Authentication.
    authPersistenceReady = setPersistence(auth, browserSessionPersistence).catch((error) => {
      firebaseInitializationError = error;
      throw error;
    });

    try {
      db = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      });
    } catch (cacheError) {
      // Some privacy modes do not permit IndexedDB. Remain usable without disk cache.
      console.warn('Persistent Firestore cache unavailable; using memory cache.', cacheError);
      try {
        db = initializeFirestore(app, { localCache: memoryLocalCache() });
      } catch {
        db = getFirestore(app);
      }
    }
  } catch (error) {
    firebaseInitializationError = error;
    console.error('Firebase initialization failed.', error);
  }
}
