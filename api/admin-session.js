import { requireAdmin } from '../server/adminSession.js';
export default async function handler(request,response){
  response.setHeader('Cache-Control','no-store');
  if(request.method!=='GET')return response.status(405).json({error:'Method not allowed'});
  try{requireAdmin(request);return response.status(200).json({authenticated:true});}
  catch(error){return response.status(error.status||401).json({authenticated:false});}
}
