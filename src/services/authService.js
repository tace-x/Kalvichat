import { signInWithCustomToken, signOut } from 'firebase/auth';
import { auth, db, firebaseEnabled } from '../firebase';
import { clearIndexedDbPersistence, terminate } from 'firebase/firestore';

async function post(url,body){
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||'Request failed.');
  return data;
}
export async function login(username,password){
  if(!firebaseEnabled)throw new Error('Login requires Firebase configuration.');
  const result=await post('/api/auth-login',{username,password});
  if(result.customToken)await signInWithCustomToken(auth,result.customToken);
  return result;
}
export async function register(values){
  if(!firebaseEnabled)throw new Error('Registration requires Firebase configuration.');
  const result=await post('/api/auth-register',values);
  await signInWithCustomToken(auth,result.customToken);
  return result;
}
export const logout=async(clearPrivateCache=true)=>{if(!auth)return;await signOut(auth);if(clearPrivateCache&&db){try{await terminate(db);await clearIndexedDbPersistence(db);}catch{/* Another tab may still own persistence; authorization remains enforced. */}if(typeof window!=='undefined')window.location.replace('/');}};

export async function adminSession(){const r=await fetch('/api/admin-session',{credentials:'same-origin'});return r.ok;}
export const adminLogin=(username,password)=>post('/api/admin-login',{username,password});
export const adminLogout=()=>post('/api/admin-logout',{});
export async function adminData(section,cursor,targetId){
  const query=new URLSearchParams({section});if(cursor)query.set('cursor',cursor);if(targetId)query.set('targetId',targetId);
  const r=await fetch(`/api/admin-data?${query}`,{credentials:'same-origin'});const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Object.assign(new Error(data.error||'Could not load data.'),{status:r.status});return data;
}
export const adminAction=(action,targetId,reason='',avatarId='')=>post('/api/admin-action',{action,targetId,reason,avatarId});
async function trainingPost(body){const response=await fetch('/api/admin-training',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)});const data=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(data.error||`Training API request failed (HTTP ${response.status}).`),{status:response.status,code:data.code});return data;}
export async function adminTrainingSummary(){const response=await fetch('/api/admin-training?action=summary',{credentials:'same-origin'});const data=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(data.error||`Could not load training data (HTTP ${response.status}).`),{status:response.status,code:data.code});return data;}
export const adminTrainingUpload=(payload)=>trainingPost({action:'upload',...payload});
export const adminTrainingComplete=()=>trainingPost({action:'complete'});
export const adminTrainingRollback=(version)=>trainingPost({action:'rollback',version});
export async function adminTrainingExport(batchId){const response=await fetch(`/api/admin-training?action=export&batchId=${encodeURIComponent(batchId)}`,{credentials:'same-origin'});if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||'Could not export training data.');}const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`kalvi-training-${batchId}.txt`;link.click();URL.revokeObjectURL(url);}
async function dmRequest(url,options={}){const token=await auth.currentUser?.getIdToken();if(!token)throw new Error('Authentication required.');const response=await fetch(url,{...options,headers:{'content-type':'application/json',authorization:`Bearer ${token}`,...options.headers}});const data=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(data.error||`DM request failed (${response.status}).`),{status:response.status});return data;}
export const searchDmUsers=(query)=>dmRequest(`/api/dm?q=${encodeURIComponent(query)}`);
export const startDm=(targetUserId)=>dmRequest('/api/dm',{method:'POST',body:JSON.stringify({action:'start',targetUserId})});
export const reportDmMessage=(conversationId,messageId,reason)=>dmRequest('/api/dm',{method:'POST',body:JSON.stringify({action:'report',conversationId,messageId,reason})});
export async function adminDmReports(){const response=await fetch('/api/admin-dm-reports',{credentials:'same-origin'});const data=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(data.error||'Could not load DM reports.'),{status:response.status});return data;}
export const dismissDmReport=(reportId)=>post('/api/admin-dm-reports',{action:'dismiss',reportId});
