import { FieldValue } from 'firebase-admin/firestore';
import { requireAdmin, requireSameOrigin } from '../server/adminSession.js';
import { getAdmin } from '../server/firebaseAdmin.js';
const iso=(value)=>value?.toDate?.().toISOString?.()||null;
export default async function handler(request,response){
  response.setHeader('Cache-Control','no-store');
  try{
    const admin=requireAdmin(request),{db}=getAdmin();
    if(request.method==='GET'){
      const snapshot=await db.collection('dmReports').where('status','==','open').orderBy('createdAt','desc').limit(20).get(),ids=[...new Set(snapshot.docs.flatMap((item)=>[item.data().reporterId,item.data().reportedUserId]))],profiles=new Map();
      if(ids.length){const members=await db.getAll(...ids.map((id)=>db.doc(`members/${id}`)));members.forEach((member)=>profiles.set(member.id,member.data()?.name||member.data()?.username||'User'));}
      return response.status(200).json({reports:snapshot.docs.map((item)=>{const value=item.data();return{id:item.id,...value,reporterName:profiles.get(value.reporterId),reportedName:profiles.get(value.reportedUserId),createdAt:iso(value.createdAt),updatedAt:iso(value.updatedAt),evidence:{...value.evidence,createdAt:iso(value.evidence?.createdAt)}};})});
    }
    if(request.method!=='POST')return response.status(405).json({error:'Method not allowed'});requireSameOrigin(request);
    const reportId=String(request.body?.reportId||''),action=String(request.body?.action||'');if(!/^[A-Za-z0-9_-]{10,80}$/.test(reportId)||action!=='dismiss')return response.status(400).json({error:'Invalid report action.'});
    const ref=db.doc(`dmReports/${reportId}`);await db.runTransaction(async(transaction)=>{const report=await transaction.get(ref);if(!report.exists||report.data().status!=='open')throw Object.assign(new Error('Report is unavailable.'),{status:409});transaction.update(ref,{status:'dismissed',reviewedAt:FieldValue.serverTimestamp(),reviewedByAdmin:admin.adminId||'primary-admin',updatedAt:FieldValue.serverTimestamp()});transaction.set(db.collection('moderationAudit').doc(),{action:'dismiss_dm_report',targetUserId:report.data().reportedUserId,reportId,timestamp:FieldValue.serverTimestamp()});});
    return response.status(200).json({success:true});
  }catch(error){return response.status(error.status||500).json({error:error.status&&error.status<500?error.message:'Report operation failed.'});}
}
