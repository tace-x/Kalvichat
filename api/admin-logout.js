import { clearAdminCookie, requireAdmin, requireSameOrigin } from '../server/adminSession.js';
export default async function handler(request,response){
  response.setHeader('Cache-Control','no-store');
  if(request.method!=='POST')return response.status(405).json({error:'Method not allowed'});
  try{requireSameOrigin(request);requireAdmin(request);}catch{}
  response.setHeader('Set-Cookie',clearAdminCookie());return response.status(200).json({authenticated:false});
}
