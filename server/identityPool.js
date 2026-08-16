import { FieldValue } from 'firebase-admin/firestore';
import { AVATARS, COLORS } from './validators.js';

let initialization;
const activeIdentity = (member) => member.status === 'pending' || member.status === 'approved'
  || member.status === 'banned' || member.approved === true || member.banned === true;

/**
 * One-time compatibility migration for deployments created before avatar
 * reservations existed. Normal registrations never scan members after v1 is set.
 * Legacy duplicates are quarantined as conflicts instead of being overwritten.
 */
export function ensureIdentityPool(db) {
  if (initialization) return initialization;
  initialization = (async () => {
    const assignmentRef = db.doc('system/assignments');
    const current = await assignmentRef.get();
    if (current.data()?.identityPoolVersion === 1) return;

    const members = await db.collection('members').get();
    const avatarAccounts = Object.fromEntries(AVATARS.map((id) => [id, []]));
    const colorCounts = Object.fromEntries(COLORS.map(({ id }) => [id, 0]));
    const identities = {};

    members.forEach((snapshot) => {
      const member = snapshot.data();
      if (!activeIdentity(member)) return;
      if (AVATARS.includes(member.avatarId)) avatarAccounts[member.avatarId].push({ id:snapshot.id, owner:member.registrationId || snapshot.id });
      if (colorCounts[member.colorId] !== undefined) colorCounts[member.colorId] += 1;
      identities[snapshot.id] = { avatarId:member.avatarId, avatar:member.avatar, colorId:member.colorId, senderColor:member.senderColor };
    });

    const avatarOwners = {}, avatarConflicts = {};
    for (const [avatarId, accounts] of Object.entries(avatarAccounts)) {
      if (accounts.length === 1) avatarOwners[avatarId] = accounts[0].owner;
      if (accounts.length > 1) avatarConflicts[avatarId] = accounts.map(({ id }) => id);
    }

    await db.runTransaction(async (transaction) => {
      const latest = await transaction.get(assignmentRef);
      if (latest.data()?.identityPoolVersion === 1) return;
      transaction.set(assignmentRef, { identityPoolVersion:1, avatarOwners, avatarConflicts, colorCounts }, { merge:true });
      transaction.set(db.doc('system/chatMeta'), { identities, updatedAt:FieldValue.serverTimestamp() }, { merge:true });
    });
  })().catch((error) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}

export { activeIdentity };
