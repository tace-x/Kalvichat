import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { requireAdmin } from '../server/adminSession.js';
import { getAdmin } from '../server/firebaseAdmin.js';
import { ensureIdentityPool } from '../server/identityPool.js';
import { AVATARS } from '../server/validators.js';

const iso=(value)=>value?.toDate?.().toISOString?.()||null;
const clean=(snapshot)=>{const d=snapshot.data();return{id:snapshot.id,...d,createdAt:iso(d.createdAt),updatedAt:iso(d.updatedAt),approvedAt:iso(d.approvedAt),rejectedAt:iso(d.rejectedAt),bannedAt:iso(d.bannedAt)};};
async function count(query){return (await query.count().get()).data().count;}
export default async function handler(request,response){
  response.setHeader('Cache-Control','no-store');
  if(request.method!=='GET')return response.status(405).json({error:'Method not allowed'});
  try{
    requireAdmin(request);const{db}=getAdmin();const section=String(request.query?.section||'dashboard');
    if(section==='avatarPool'){
      const targetId=String(request.query?.targetId||'');
      if(!/^[A-Za-z0-9_-]{10,128}$/.test(targetId))return response.status(400).json({error:'Invalid user ID'});
      await ensureIdentityPool(db);
      const [targetSnap,membersSnap]=await Promise.all([
        db.doc(`members/${targetId}`).get(),
        db.collection('members').where('avatarId','in',AVATARS).get(),
      ]);
      if(!targetSnap.exists)return response.status(404).json({error:'User not found'});
      const target=targetSnap.data(),active=(member)=>member.status==='pending'||member.status==='approved'||member.status==='banned'||member.approved===true||member.banned===true;
      const usage=Object.fromEntries(AVATARS.map((id)=>[id,[]]));
      membersSnap.forEach((snapshot)=>{const member=snapshot.data();if(active(member))usage[member.avatarId].push({id:snapshot.id,name:member.name,username:member.username});});
      const avatars=AVATARS.map((id)=>({id,url:`/avatars/${id}.svg`,status:id===target.avatarId?'current':usage[id].some((owner)=>owner.id!==targetId)?'in_use':'available',conflict:id===target.avatarId&&usage[id].some((owner)=>owner.id!==targetId),owners:usage[id]}));
      return response.status(200).json({target:{id:targetId,name:target.name,avatarId:target.avatarId,avatar:target.avatar,senderColor:target.senderColor,colorId:target.colorId},avatars});
    }
    if(section==='dashboard'){
      const registrations=db.collection('registrations'),members=db.collection('members');
      const cutoff=Timestamp.fromMillis(Date.now()-125000);
      const [pending,approved,rejected,banned,online]=await Promise.all([
        count(registrations.where('status','==','pending')),count(members.where('status','==','approved')),
        count(registrations.where('status','==','rejected')),count(members.where('status','==','banned')),
        count(db.collection('presence').where('online','==',true).where('heartbeatAt','>=',cutoff)),
      ]);
      return response.status(200).json({counts:{pending,approved,rejected,banned,online}});
    }
    if(section==='messages'){
      const state=await db.doc('system/chatState').get(),generation=Number(state.data()?.activeGeneration||1);
      let messages=db.collection('chatMessages').where('generation','==',generation).orderBy('createdAt','desc').orderBy(FieldPath.documentId(),'desc').limit(21);
      const rawCursor=String(request.query?.cursor||'');
      if(rawCursor){try{const cursor=JSON.parse(Buffer.from(rawCursor,'base64url').toString());messages=messages.startAfter(Timestamp.fromMillis(cursor.createdAt),cursor.id);}catch{throw Object.assign(new Error('Invalid pagination cursor.'),{status:400});}}
      const snapshot=await messages.get(),hasMore=snapshot.docs.length>20,docs=snapshot.docs.slice(0,20);
      const items=docs.map((item)=>{const value=item.data();return{id:item.id,senderName:value.senderName,senderAvatar:value.senderAvatar,senderColor:value.senderColor,originalText:value.originalText||'',deleted:Boolean(value.deleted),deletedByAdmin:Boolean(value.deletedByAdmin),createdAt:iso(value.createdAt),generation:value.generation};});
      const lastDoc=docs.at(-1),lastTime=lastDoc?.data()?.createdAt?.toMillis?.();
      const nextCursor=hasMore&&lastDoc&&lastTime?Buffer.from(JSON.stringify({createdAt:lastTime,id:lastDoc.id})).toString('base64url'):null;
      return response.status(200).json({items,nextCursor,generation});
    }
    const config={
      pending:{collection:'registrations',status:'pending'},rejected:{collection:'registrations',status:'rejected'},
      approved:{collection:'members',status:'approved'},banned:{collection:'members',status:'banned'},
    }[section];
    if(!config)return response.status(400).json({error:'Unknown section'});
    let query=db.collection(config.collection).where('status','==',config.status).orderBy('createdAt','desc').orderBy(FieldPath.documentId(),'desc').limit(21);
    const rawCursor=String(request.query?.cursor||'');
    if(rawCursor){
      try{const cursor=JSON.parse(Buffer.from(rawCursor,'base64url').toString());query=query.startAfter(Timestamp.fromMillis(cursor.createdAt),cursor.id);}
      catch{throw Object.assign(new Error('Invalid pagination cursor.'),{status:400});}
    }
    const snapshot=await query.get(),hasMore=snapshot.docs.length>20,docs=snapshot.docs.slice(0,20);
    const items=docs.map(clean);
    if(['approved','banned'].includes(section)&&items.length){
      const presence=await db.getAll(...items.map((item)=>db.doc(`presence/${item.id}`)));
      presence.forEach((row,index)=>{const p=row.data();items[index].online=Boolean(p?.online&&Date.now()-(p.heartbeatAt?.toMillis?.()||0)<125000);});
    }
    const lastDoc=docs.at(-1),lastTime=lastDoc?.data()?.createdAt?.toMillis?.();
    const nextCursor=hasMore&&lastDoc&&lastTime?Buffer.from(JSON.stringify({createdAt:lastTime,id:lastDoc.id})).toString('base64url'):null;
    return response.status(200).json({items,nextCursor});
  }catch(error){console.error(error);return response.status(error.status||500).json({error:error.status?error.message:'Admin data could not be loaded.'});}
}
