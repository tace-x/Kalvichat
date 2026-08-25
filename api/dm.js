import crypto from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { requireApprovedUser } from '../server/firebaseAdmin.js';

export const conversationIdFor=(left,right)=>crypto.createHash('sha256').update([left,right].sort().join(':')).digest('hex').slice(0,40);
const safeProfile=(id,value)=>Object.fromEntries(Object.entries({id,name:value?.name||'User',username:value?.username||'user',avatar:value?.avatar||null,senderColor:value?.senderColor||null,language:value?.language||null}).filter(([,field])=>field!==undefined));
const validId=(value)=>/^[A-Za-z0-9_-]{10,220}$/.test(String(value||''));

export default async function handler(request,response){
  response.setHeader('Cache-Control','no-store');
  try{
    const {uid,db}=await requireApprovedUser(request);
    if(request.method==='GET'){
      const queryText=String(request.query?.q||'').trim().toLowerCase();if(queryText.length<2)return response.status(200).json({users:[]});
      const end=`${queryText}\uf8ff`,members=db.collection('chatMembers');
      const [usernameMatches,nameMatches]=await Promise.all([
        members.orderBy('username').startAt(queryText).endAt(end).limit(10).get(),
        members.orderBy('name').startAt(String(request.query?.q||'').trim()).endAt(`${String(request.query?.q||'').trim()}\uf8ff`).limit(10).get(),
      ]);
      const users=new Map();[...usernameMatches.docs,...nameMatches.docs].forEach((snapshot)=>{const value=snapshot.data();if(snapshot.id!==uid&&value.approved&&value.status==='approved'&&!value.banned)users.set(snapshot.id,safeProfile(snapshot.id,value));});
      return response.status(200).json({users:[...users.values()].slice(0,12)});
    }
    if(request.method!=='POST')return response.status(405).json({error:'Method not allowed'});
    const action=String(request.body?.action||'');
    if(action==='start'){
      const targetUserId=String(request.body?.targetUserId||'');if(!validId(targetUserId)||targetUserId===uid)return response.status(400).json({error:'Invalid recipient.'});
      const [self,target]=await Promise.all([db.doc(`chatMembers/${uid}`).get(),db.doc(`chatMembers/${targetUserId}`).get()]);
      if(!target.exists||!target.data().approved||target.data().status!=='approved'||target.data().banned)return response.status(404).json({error:'User is unavailable.'});
      const conversationId=conversationIdFor(uid,targetUserId),ref=db.doc(`dmConversations/${conversationId}`),participants=[uid,targetUserId].sort();
      await db.runTransaction(async(transaction)=>{const existing=await transaction.get(ref);if(existing.exists){if(!existing.data().unreadCounts)transaction.update(ref,{unreadCounts:{[participants[0]]:0,[participants[1]]:0},updatedAt:FieldValue.serverTimestamp()});return;}transaction.create(ref,{type:'dm',participantIds:participants,profiles:{[uid]:safeProfile(uid,self.data()||{}),[targetUserId]:safeProfile(targetUserId,target.data())},activeGeneration:1,lastMessageAt:null,lastMessagePreview:'',lastSenderId:null,unreadCounts:{[participants[0]]:0,[participants[1]]:0},createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});});
      return response.status(200).json({conversationId,participant:safeProfile(targetUserId,target.data())});
    }
    if(action==='report'){
      const conversationId=String(request.body?.conversationId||''),messageId=String(request.body?.messageId||''),reason=String(request.body?.reason||'').trim().slice(0,500);
      if(!/^[a-f0-9]{40}$/.test(conversationId)||!validId(messageId)||!reason)return response.status(400).json({error:'Conversation, message, and reason are required.'});
      const conversation=await db.doc(`dmConversations/${conversationId}`).get();if(!conversation.exists||!conversation.data().participantIds.includes(uid))return response.status(403).json({error:'Forbidden'});
      const message=await db.doc(`dmConversations/${conversationId}/messages/${messageId}`).get();if(!message.exists)return response.status(404).json({error:'Message not found.'});
      const reportedUserId=message.data().senderId;if(reportedUserId===uid)return response.status(400).json({error:'You cannot report your own message.'});
      const reportRef=db.collection('dmReports').doc();
      await reportRef.set({reporterId:uid,reportedUserId,conversationId,messageId,reason,status:'open',evidence:{senderId:reportedUserId,originalText:message.data().originalText||null,englishText:message.data().englishText||null,createdAt:message.data().createdAt||null,deleted:Boolean(message.data().deleted)},createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});
      return response.status(201).json({success:true,reportId:reportRef.id});
    }
    return response.status(400).json({error:'Unknown DM action.'});
  }catch(error){console.error(`[dm] error=${error?.name||'Error'} status=${error?.status||500}`,error?.stack||'');return response.status(error.status||500).json({error:error.status&&error.status<500?error.message:'DM request failed.'});}
}
