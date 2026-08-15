import { AVATARS, COLORS } from './validators.js';

let initialization;

/**
 * One-time compatibility migration for deployments created before avatar
 * reservations existed. Normal registrations never scan members after v1 is set.
 */
export function ensureIdentityPool(db) {
  if (initialization) return initialization;
  initialization = (async () => {
    const assignmentRef = db.doc('system/assignments');
    const current = await assignmentRef.get();
    if (current.data()?.identityPoolVersion === 1) return;

    const members = await db.collection('members').get();
    const avatarOwners = {};
    const colorCounts = Object.fromEntries(COLORS.map(({ id }) => [id, 0]));
    const duplicates = [];

    members.forEach((snapshot) => {
      const member = snapshot.data();
      const activeIdentity = member.status === 'pending' || member.status === 'approved'
        || member.status === 'banned' || member.approved === true || member.banned === true;
      if (!activeIdentity) return;
      if (AVATARS.includes(member.avatarId)) {
        if (avatarOwners[member.avatarId] && avatarOwners[member.avatarId] !== snapshot.id) duplicates.push(member.avatarId);
        else avatarOwners[member.avatarId] = member.registrationId || snapshot.id;
      }
      if (colorCounts[member.colorId] !== undefined) colorCounts[member.colorId] += 1;
    });

    if (duplicates.length) {
      throw Object.assign(new Error(`Existing active accounts share reserved avatars: ${[...new Set(duplicates)].join(', ')}. Resolve these legacy duplicates before new registration.`), { status: 409, code: 'avatar-migration-conflict' });
    }

    await db.runTransaction(async (transaction) => {
      const latest = await transaction.get(assignmentRef);
      if (latest.data()?.identityPoolVersion === 1) return;
      transaction.set(assignmentRef, { identityPoolVersion: 1, avatarOwners, colorCounts }, { merge: true });
    });
  })().catch((error) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}
