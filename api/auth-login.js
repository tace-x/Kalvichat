import { getAdmin } from '../server/firebaseAdmin.js';
import { normalizeUsername, publicError } from '../server/validators.js';

const attempts = new Map();
function rateLimit(request) {
  const key=String(request.headers['x-forwarded-for']||request.socket?.remoteAddress||'unknown').split(',')[0];
  if(attempts.size>2000)attempts.clear();
  const now=Date.now();const recent=(attempts.get(key)||[]).filter((time)=>now-time<10*60_000);
  if(recent.length>=10)throw Object.assign(new Error('Too many login attempts. Please wait and try again.'),{status:429});
  recent.push(now);attempts.set(key,recent);
}

export default async function handler(request,response){
  response.setHeader('Cache-Control','no-store');
  if(request.method!=='POST')return response.status(405).json({error:'Method not allowed'});
  try{
    rateLimit(request);
    const username=normalizeUsername(request.body?.username);
    const password=String(request.body?.password||'');
    if(!password)throw Object.assign(new Error('Enter your password.'),{status:400});
    const apiKey=process.env.VITE_FIREBASE_API_KEY;
    if(!apiKey)throw new Error('Firebase web API key is not configured.');
    const {auth,db}=getAdmin();
    const reservation=await db.doc(`usernameReservations/${username}`).get();
    const uid=reservation.data()?.uid;
    if(!uid)throw Object.assign(new Error('Invalid username or password.'),{status:401});
    const account=await auth.getUser(uid);
    const verification=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,{
      method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(8000),
      body:JSON.stringify({email:account.email,password,returnSecureToken:true}),
    });
    if(!verification.ok)throw Object.assign(new Error('Invalid username or password.'),{status:401});
    const member=await db.doc(`members/${uid}`).get();
    if(!member.exists)throw Object.assign(new Error('Account profile is unavailable.'),{status:403});
    const data=member.data();const status=data.status||(data.banned?'banned':data.approved?'approved':'pending');
    if(status==='banned'||data.banned)return response.status(200).json({status:'banned'});
    const customToken=await auth.createCustomToken(uid);
    return response.status(200).json({customToken,status});
  }catch(error){
    const safe=publicError(error);return response.status(safe.status).json({error:safe.message});
  }
}
