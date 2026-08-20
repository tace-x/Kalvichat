import { signInWithCustomToken, signOut } from 'firebase/auth';
import { auth, firebaseEnabled } from '../firebase';

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
export const logout=()=>auth?signOut(auth):Promise.resolve();

export async function adminSession(){const r=await fetch('/api/admin-session',{credentials:'same-origin'});return r.ok;}
export const adminLogin=(username,password)=>post('/api/admin-login',{username,password});
export const adminLogout=()=>post('/api/admin-logout',{});
export async function adminData(section,cursor,targetId){
  const query=new URLSearchParams({section});if(cursor)query.set('cursor',cursor);if(targetId)query.set('targetId',targetId);
  const r=await fetch(`/api/admin-data?${query}`,{credentials:'same-origin'});const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Object.assign(new Error(data.error||'Could not load data.'),{status:r.status});return data;
}
export const adminAction=(action,targetId,reason='',avatarId='')=>post('/api/admin-action',{action,targetId,reason,avatarId});
export async function adminTrainingSummary(){const response=await fetch('/api/admin-training?action=summary',{credentials:'same-origin'});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'Could not load training data.');return data;}
export const adminTrainingUpload=(payload)=>post('/api/admin-training',{action:'upload',...payload});
export const adminTrainingComplete=()=>post('/api/admin-training',{action:'complete'});
export const adminTrainingRollback=(version)=>post('/api/admin-training',{action:'rollback',version});
export async function adminTrainingExport(batchId){const response=await fetch(`/api/admin-training?action=export&batchId=${encodeURIComponent(batchId)}`,{credentials:'same-origin'});if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||'Could not export training data.');}const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`kalvi-training-${batchId}.txt`;link.click();URL.revokeObjectURL(url);}
