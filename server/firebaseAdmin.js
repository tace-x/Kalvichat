import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

function credentialFromEnvironment() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    // Useful on Google-managed runtimes; Vercel should configure the JSON secret.
    return applicationDefault();
  }
  const account = JSON.parse(raw);
  if (account.private_key) account.private_key = account.private_key.replace(/\\n/g, '\n');
  return cert(account);
}

export function getAdmin() {
  const app = getApps()[0] || initializeApp({ credential: credentialFromEnvironment() });
  return { auth: getAuth(app), db: getFirestore(app) };
}

export async function requireApprovedUser(request) {
  const authorization = request.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const { auth, db } = getAdmin();
  const token = await auth.verifyIdToken(authorization.slice(7), true);
  const member = await db.doc(`members/${token.uid}`).get();
  const data = member.data();
  if (!member.exists || data?.status !== 'approved' || !data?.approved || data?.banned || data?.muted || data?.role === 'admin') {
    throw Object.assign(new Error('Forbidden'), { status: 403 });
  }
  return { uid: token.uid, db };
}
