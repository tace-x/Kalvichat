import { FieldValue } from 'firebase-admin/firestore';
import { requireAdmin, requireSameOrigin } from '../server/adminSession.js';
import { getAdmin } from '../server/firebaseAdmin.js';
import { ensureIdentityPool } from '../server/identityPool.js';
import { safeReason } from '../server/validators.js';

const allowed=new Set(['approve','reject','mute','unmute','ban','unban','deleteMessage','clearChat']);
const validId=(value)=>/^[A-Za-z0-9_-]{10,220}$/.test(value);

async function deleteMessage(db,messageId,adminId){
  const messageRef=db.doc(`chatMessages/${messageId}`),stateRef=db.doc('system/chatState');
  await db.runTransaction(async(transaction)=>{
    const [messageSnap,stateSnap]=await Promise.all([transaction.get(messageRef),transaction.get(stateRef)]);
    if(!messageSnap.exists)throw Object.assign(new Error('Message not found.'),{status:404});
    const message=messageSnap.data(),activeGeneration=Number(stateSnap.data()?.activeGeneration||1);
    if(!message.senderId||!message.createdAt||!Number.isInteger(message.generation))throw Object.assign(new Error('Target is not a valid chat message.'),{status:400});
    if(message.generation!==activeGeneration)throw Object.assign(new Error('Message is not in the active conversation.'),{status:409});
    if(message.deleted||message.deletedByAdmin)throw Object.assign(new Error('Message is already deleted.'),{status:409});
    const recent=[...(stateSnap.data()?.recentDeletedMessageIds||[]).filter((id)=>id!==messageId),messageId].slice(-50);
    transaction.update(messageRef,{
      originalText:FieldValue.delete(),hinglishText:FieldValue.delete(),manglishText:FieldValue.delete(),translation:FieldValue.delete(),translationText:FieldValue.delete(),
      detectedLanguage:FieldValue.delete(),translatedAt:FieldValue.delete(),translationLeaseUntil:FieldValue.delete(),translationProvider:FieldValue.delete(),translationModel:FieldValue.delete(),translationError:FieldValue.delete(),
      translationStatus:'deleted',deleted:true,deletedByAdmin:true,deletedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp(),
    });
    transaction.set(stateRef,{activeGeneration, recentDeletedMessageIds:recent, updatedAt:FieldValue.serverTimestamp()},{merge:true});
    transaction.set(db.collection('moderationAudit').doc(),{action:'delete_message',adminId,targetMessageId:messageId,timestamp:FieldValue.serverTimestamp()});
  });
  // Reactions and embedded reply previews are normally small fan-outs for one
  // message. Cleanup happens server-side and never scans unrelated history.
  try{
    const [reactions,replies]=await Promise.all([
      db.collection('chatReactions').where('messageId','==',messageId).get(),
      db.collection('chatMessages').where('replyTo.id','==',messageId).get(),
    ]);
    const writer=db.bulkWriter();
    reactions.docs.forEach((item)=>writer.delete(item.ref));
    replies.docs.forEach((item)=>writer.update(item.ref,{replyTo:{id:messageId,deleted:true},updatedAt:FieldValue.serverTimestamp()}));
    await writer.close();
  }catch(cleanupError){console.error('Post-delete cleanup failed:',cleanupError);}
}

async function clearChat(db,adminId){
  const stateRef=db.doc('system/chatState');
  return db.runTransaction(async(transaction)=>{
    const state=await transaction.get(stateRef),previousGeneration=Number(state.data()?.activeGeneration||1);
    if(!Number.isSafeInteger(previousGeneration)||previousGeneration<1)throw new Error('Chat generation is invalid.');
    const newGeneration=previousGeneration+1;
    transaction.set(stateRef,{activeGeneration:newGeneration,recentDeletedMessageIds:[],clearedAt:FieldValue.serverTimestamp(),clearedByAdmin:adminId,updatedAt:FieldValue.serverTimestamp()},{merge:true});
    transaction.set(db.collection('moderationAudit').doc(),{action:'clear_chat',adminId,timestamp:FieldValue.serverTimestamp(),previousGeneration,newGeneration});
    return{previousGeneration,newGeneration};
  });
}

export default async function handler(request,response){
  response.setHeader('Cache-Control','no-store');
  if(request.method!=='POST')return response.status(405).json({error:'Method not allowed'});
  try{
    requireSameOrigin(request);const session=requireAdmin(request);
    const action=String(request.body?.action||''),targetId=String(request.body?.targetId||'');
    if(!allowed.has(action))throw Object.assign(new Error('Invalid moderation action.'),{status:400});
    if(action!=='clearChat'&&!validId(targetId))throw Object.assign(new Error('Invalid moderation target.'),{status:400});
    const{db,auth}=getAdmin();const adminId=session.adminId||'primary-admin';let affectedUid=null;
    if(action==='deleteMessage'){
      await deleteMessage(db,targetId,adminId);
    }else if(action==='clearChat'){
      const generations=await clearChat(db,adminId);return response.status(200).json({success:true,...generations});
    }else if(action==='approve'||action==='reject'){
      await ensureIdentityPool(db);
      const registrationRef=db.doc(`registrations/${targetId}`);
      await db.runTransaction(async(transaction)=>{
        const registrationSnap=await transaction.get(registrationRef),registration=registrationSnap.data();
        if(!registrationSnap.exists||registration.status!=='pending')throw Object.assign(new Error('Registration is no longer pending.'),{status:409});
        const memberRef=db.doc(`members/${registration.uid}`),usernameRef=db.doc(`usernameReservations/${registration.usernameNormalized}`),phoneRef=db.doc(`phoneReservations/${registration.phoneReservationId}`),assignmentsRef=db.doc('system/assignments'),chatStateRef=db.doc('system/chatState');
        const [memberSnap,usernameSnap,phoneSnap,assignmentSnap,chatStateSnap]=await Promise.all([transaction.get(memberRef),transaction.get(usernameRef),transaction.get(phoneRef),transaction.get(assignmentsRef),transaction.get(chatStateRef)]);
        if(!memberSnap.exists)throw new Error('Member record is missing.');affectedUid=registration.uid;
        if(action==='approve'){
          transaction.update(registrationRef,{status:'approved',approvedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp(),rejectionReason:FieldValue.delete()});
          transaction.update(memberRef,{status:'approved',approved:true,banned:false,muted:false,approvedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});
          transaction.set(db.doc(`chatMembers/${registration.uid}`),{name:registration.name,username:registration.username,language:registration.language,avatarId:registration.avatarId,avatar:registration.avatar,colorId:registration.colorId,senderColor:registration.senderColor,status:'approved',approved:true,banned:false,blocked:false,muted:false,role:'user',createdAt:memberSnap.data().createdAt,approvedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});
          transaction.set(db.doc('system/chatMeta'),{eligibleMemberIds:FieldValue.arrayUnion(registration.uid),updatedAt:FieldValue.serverTimestamp()},{merge:true});
          if(!chatStateSnap.exists)transaction.set(chatStateRef,{activeGeneration:1,createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});
        }else{
          const reason=safeReason(request.body?.reason);
          transaction.update(registrationRef,{status:'rejected',rejectedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp(),rejectionReason:reason||FieldValue.delete()});
          transaction.update(memberRef,{status:'rejected',approved:false,banned:false,muted:false,rejectedAt:FieldValue.serverTimestamp(),rejectionReason:reason||FieldValue.delete(),updatedAt:FieldValue.serverTimestamp()});
          if(usernameSnap.data()?.registrationId===targetId)transaction.set(usernameRef,{active:false,uid:registration.uid,registrationId:targetId,updatedAt:FieldValue.serverTimestamp()});
          if(phoneSnap.data()?.registrationId===targetId)transaction.set(phoneRef,{active:false,uid:registration.uid,registrationId:targetId,updatedAt:FieldValue.serverTimestamp()});
          const assignment=assignmentSnap.data()||{},counts=assignment.colorCounts||{},avatarOwners={...(assignment.avatarOwners||{})};
          if(avatarOwners[registration.avatarId]===targetId)delete avatarOwners[registration.avatarId];
          const poolUpdate={colorCounts:{...counts,[registration.colorId]:Math.max(0,Number(counts[registration.colorId]||1)-1)}};
          if(assignment.identityPoolVersion===1){poolUpdate.identityPoolVersion=1;poolUpdate.avatarOwners=avatarOwners;}
          transaction.set(assignmentsRef,poolUpdate,{merge:true});
          transaction.set(db.doc(`presence/${registration.uid}`),{userId:registration.uid,online:false,heartbeatAt:FieldValue.serverTimestamp()},{merge:true});
        }
        transaction.set(db.collection('moderationAudit').doc(),{action:action==='approve'?'approved':'rejected',adminId,targetUserId:registration.uid,timestamp:FieldValue.serverTimestamp()});
      });
    }else{
      const memberRef=db.doc(`members/${targetId}`),chatRef=db.doc(`chatMembers/${targetId}`);affectedUid=targetId;
      await db.runTransaction(async(transaction)=>{
        const memberSnap=await transaction.get(memberRef);if(!memberSnap.exists)throw Object.assign(new Error('User not found.'),{status:404});
        const member=memberSnap.data();
        if(action==='mute'||action==='unmute'){
          if(member.status!=='approved')throw Object.assign(new Error('Only approved users can be muted.'),{status:409});
          const muted=action==='mute';transaction.update(memberRef,{muted,updatedAt:FieldValue.serverTimestamp()});transaction.set(chatRef,{muted,updatedAt:FieldValue.serverTimestamp()},{merge:true});
          if(muted){transaction.set(db.doc(`presence/${targetId}`),{userId:targetId,online:false,heartbeatAt:FieldValue.serverTimestamp()},{merge:true});transaction.delete(db.doc(`typing/${targetId}`));}
        }else if(action==='ban'){
          if(member.status!=='approved')throw Object.assign(new Error('Only approved users can be banned.'),{status:409});
          transaction.update(memberRef,{status:'banned',approved:false,banned:true,muted:false,bannedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});
          transaction.set(chatRef,{status:'banned',approved:false,banned:true,muted:false,bannedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()},{merge:true});
          transaction.set(db.doc(`presence/${targetId}`),{userId:targetId,online:false,heartbeatAt:FieldValue.serverTimestamp()},{merge:true});transaction.delete(db.doc(`typing/${targetId}`));
          transaction.set(db.doc('system/chatMeta'),{eligibleMemberIds:FieldValue.arrayRemove(targetId),updatedAt:FieldValue.serverTimestamp()},{merge:true});
        }else if(action==='unban'){
          if(member.status!=='banned')throw Object.assign(new Error('User is not banned.'),{status:409});
          transaction.update(memberRef,{status:'approved',approved:true,banned:false,muted:false,unbannedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});
          transaction.set(chatRef,{status:'approved',approved:true,banned:false,muted:false,unbannedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()},{merge:true});
          transaction.set(db.doc('system/chatMeta'),{eligibleMemberIds:FieldValue.arrayUnion(targetId),updatedAt:FieldValue.serverTimestamp()},{merge:true});
        }
        transaction.set(db.collection('moderationAudit').doc(),{action:action==='mute'?'muted':action==='unmute'?'unmuted':action==='ban'?'banned':'unbanned',adminId,targetUserId:targetId,timestamp:FieldValue.serverTimestamp()});
      });
    }
    if(action==='ban'&&affectedUid)await auth.revokeRefreshTokens(affectedUid);
    return response.status(200).json({success:true});
  }catch(error){console.error(error);return response.status(error.status||500).json({error:error.status?error.message:'Moderation action failed.'});}
}
