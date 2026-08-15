import { adminCookie, createAdminSession, requireSameOrigin, safeEqual } from '../server/adminSession.js';

const attempts=new Map();
export default async function handler(request,response){
  response.setHeader('Cache-Control','no-store');
  if(request.method!=='POST')return response.status(405).json({error:'Method not allowed'});
  try{
    requireSameOrigin(request);
    if(attempts.size>2000)attempts.clear();
    const key=String(request.headers['x-forwarded-for']||'unknown').split(',')[0],now=Date.now();
    const recent=(attempts.get(key)||[]).filter((time)=>now-time<15*60_000);
    if(recent.length>=8)throw Object.assign(new Error('Too many attempts. Try again later.'),{status:429});
    recent.push(now);attempts.set(key,recent);
    if(!process.env.ADMIN_USERNAME||!process.env.ADMIN_PASSWORD)throw new Error('Admin credentials are not configured.');
    const usernameValid=safeEqual(request.body?.username,process.env.ADMIN_USERNAME),passwordValid=safeEqual(request.body?.password,process.env.ADMIN_PASSWORD);
    if(!usernameValid||!passwordValid)throw Object.assign(new Error('Invalid admin credentials.'),{status:401});
    response.setHeader('Set-Cookie',adminCookie(createAdminSession()));
    return response.status(200).json({authenticated:true});
  }catch(error){return response.status(error.status||500).json({error:error.status?error.message:'Admin authentication is unavailable.'});}
}
