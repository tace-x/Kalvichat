import crypto from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdmin } from '../server/firebaseAdmin.js';
import { AVATARS, COLORS, phoneReservationId, publicError, validateRegistration } from '../server/validators.js';

const attempts = new Map();
function rateLimit(request) {
  const key = String(request.headers['x-forwarded-for'] || request.socket?.remoteAddress || 'unknown').split(',')[0];
  if (attempts.size > 2000) attempts.clear();
  const now = Date.now(); const recent = (attempts.get(key) || []).filter((time) => now - time < 10 * 60_000);
  if (recent.length >= 5) throw Object.assign(new Error('Too many registration attempts. Please wait and try again.'), { status: 429 });
  recent.push(now); attempts.set(key, recent);
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });
  let authUser = null; let reservation = null;
  try {
    rateLimit(request);
    const input = validateRegistration(request.body || {});
    const { auth, db } = getAdmin();
    const registrationRef = db.collection('registrations').doc();
    const usernameRef = db.doc(`usernameReservations/${input.username}`);
    const phoneId = phoneReservationId(input.phone);
    const phoneRef = db.doc(`phoneReservations/${phoneId}`);
    const assignmentsRef = db.doc('system/assignments');
    const avatarId = AVATARS[crypto.randomInt(AVATARS.length)];
    const leaseUntil = Timestamp.fromMillis(Date.now() + 2 * 60_000);

    const selected = await db.runTransaction(async (transaction) => {
      const [usernameSnap, phoneSnap, assignmentSnap] = await Promise.all([
        transaction.get(usernameRef), transaction.get(phoneRef), transaction.get(assignmentsRef),
      ]);
      const unavailable = (snapshot) => snapshot.exists && snapshot.data().active === true
        && (!snapshot.data().expiresAt || snapshot.data().expiresAt.toMillis() > Date.now());
      if (unavailable(usernameSnap)) throw Object.assign(new Error('That username is already in use.'), { status: 409, code: 'username-taken' });
      if (unavailable(phoneSnap)) throw Object.assign(new Error('That phone number is already registered.'), { status: 409, code: 'phone-taken' });
      const counts = assignmentSnap.data()?.colorCounts || {};
      const minimum = Math.min(...COLORS.map((color) => Number(counts[color.id] || 0)));
      const choices = COLORS.filter((color) => Number(counts[color.id] || 0) === minimum);
      const color = choices[crypto.randomInt(choices.length)];
      const owner = registrationRef.id;
      transaction.set(usernameRef, { active:true, registrationId:owner, expiresAt:leaseUntil, updatedAt:FieldValue.serverTimestamp() });
      transaction.set(phoneRef, { active:true, registrationId:owner, expiresAt:leaseUntil, updatedAt:FieldValue.serverTimestamp() });
      transaction.set(registrationRef, {
        name:input.name, username:input.username, usernameNormalized:input.username,
        phone:input.phone, phoneReservationId:phoneId, language:input.language,
        avatarId, avatar:`/avatars/${avatarId}.svg`, colorId:color.id, senderColor:color.value,
        status:'provisioning', createdAt:FieldValue.serverTimestamp(), updatedAt:FieldValue.serverTimestamp(),
      });
      transaction.set(assignmentsRef, { colorCounts:{ ...counts, [color.id]:Number(counts[color.id] || 0)+1 } }, { merge:true });
      return color;
    });
    reservation = { registrationRef, usernameRef, phoneRef, assignmentsRef, colorId:selected.id };

    const internalEmail = `${registrationRef.id}@auth.mallu-jaabi.invalid`;
    authUser = await auth.createUser({ email:internalEmail, password:input.password, displayName:input.name, disabled:false });
    await db.runTransaction(async (transaction) => {
      const [usernameSnap, phoneSnap] = await Promise.all([transaction.get(usernameRef), transaction.get(phoneRef)]);
      if (usernameSnap.data()?.registrationId !== registrationRef.id || phoneSnap.data()?.registrationId !== registrationRef.id) throw new Error('Registration reservation expired.');
      const member = {
        name:input.name, username:input.username, phone:input.phone, language:input.language,
        avatarId, avatar:`/avatars/${avatarId}.svg`, colorId:selected.id, senderColor:selected.value,
        role:'user', status:'pending', approved:false, banned:false, muted:false,
        registrationId:registrationRef.id, createdAt:FieldValue.serverTimestamp(), updatedAt:FieldValue.serverTimestamp(),
      };
      transaction.set(db.doc(`members/${authUser.uid}`), member);
      transaction.update(registrationRef, { uid:authUser.uid, status:'pending', updatedAt:FieldValue.serverTimestamp() });
      transaction.set(usernameRef, { active:true, uid:authUser.uid, registrationId:registrationRef.id, updatedAt:FieldValue.serverTimestamp() });
      transaction.set(phoneRef, { active:true, uid:authUser.uid, registrationId:registrationRef.id, updatedAt:FieldValue.serverTimestamp() });
    });
    const customToken = await auth.createCustomToken(authUser.uid);
    return response.status(201).json({ customToken, status:'pending' });
  } catch (error) {
    console.error('Registration failed:', error);
    if (authUser) await getAdmin().auth.deleteUser(authUser.uid).catch(() => {});
    if (reservation) {
      const { db } = getAdmin();
      await db.runTransaction(async (transaction) => {
        const [u,p,a] = await Promise.all([transaction.get(reservation.usernameRef), transaction.get(reservation.phoneRef), transaction.get(reservation.assignmentsRef)]);
        if (u.data()?.registrationId === reservation.registrationRef.id) transaction.delete(reservation.usernameRef);
        if (p.data()?.registrationId === reservation.registrationRef.id) transaction.delete(reservation.phoneRef);
        transaction.delete(reservation.registrationRef);
        const counts=a.data()?.colorCounts||{}; transaction.set(reservation.assignmentsRef,{colorCounts:{...counts,[reservation.colorId]:Math.max(0,Number(counts[reservation.colorId]||1)-1)}},{merge:true});
      }).catch(() => {});
    }
    const safe = publicError(error);
    return response.status(safe.status).json({ error:safe.message, code:error.code || 'registration-failed' });
  }
}
