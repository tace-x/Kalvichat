import crypto from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { requireAdmin, requireSameOrigin } from '../server/adminSession.js';
import { getAdmin } from '../server/firebaseAdmin.js';
import { buildKnowledgeDocuments, MAX_CANONICAL_ENTRIES, MAX_LOOKUP_KEYS, MAX_UPLOAD_BYTES, mergeKnowledgeEntries, parseDataset, trainingTxt } from '../server/translationKnowledge.js';

console.info('[admin-training] module_load=success');

const cleanFileName=(value)=>String(value||'dataset').replace(/[^a-z0-9._-]+/gi,'_').slice(0,100);
const iso=(value)=>value?.toDate?.().toISOString?.()||null;
const serialize=(snapshot)=>{const value=snapshot.data();return{id:snapshot.id,...value,createdAt:iso(value.createdAt),updatedAt:iso(value.updatedAt),completedAt:iso(value.completedAt)};};

export async function summary(db){
  const [state,versions,batches]=await Promise.all([
    db.doc('system/translationKnowledge').get(),
    db.collection('translationDatasetVersions').orderBy('createdAt','desc').limit(10).get(),
    db.collection('translationTrainingBatches').orderBy('createdAt','desc').limit(10).get(),
  ]);
  const value=state.data()||{};
  return{state:{activeVersion:value.activeVersion||null,currentBatchId:value.currentBatchId||null,pendingCount:Number(value.pendingCount||0),nextVersion:Number(value.nextVersion||1),updatedAt:iso(value.updatedAt)},versions:versions.docs.map(serialize),batches:batches.docs.map(serialize),limits:{maxUploadBytes:MAX_UPLOAD_BYTES,maxCanonicalEntries:MAX_CANONICAL_ENTRIES,maxLookupKeys:MAX_LOOKUP_KEYS,formats:['json','csv','txt']}};
}

export async function uploadDataset(db,{content,type,fileName},adminId){
  const rawContent=String(content||''),uploadedBytes=Buffer.byteLength(rawContent,'utf8'),contentHash=crypto.createHash('sha256').update(rawContent).digest('hex');
  const parsed=parseDataset(rawContent,type),stateRef=db.doc('system/translationKnowledge');
  const stateSnap=await stateRef.get(),activeVersion=stateSnap.data()?.activeVersion;
  let existing=[];
  if(activeVersion){const snapshot=await db.collection('translationKnowledgeEntries').where('version','==',activeVersion).get();existing=snapshot.docs.map((item)=>item.data());}
  const merged=mergeKnowledgeEntries([...existing,...parsed.entries]);
  const oldKeys=new Set(existing.map((entry)=>entry.normalizedSource));
  const nextVersion=await db.runTransaction(async(transaction)=>{
    const current=await transaction.get(stateRef),number=Math.max(1,Number(current.data()?.nextVersion||1)),version=`v${number}`;
    transaction.set(stateRef,{nextVersion:number+1,updatedAt:FieldValue.serverTimestamp()},{merge:true});
    transaction.set(db.doc(`translationDatasetVersions/${version}`),{version,status:'importing',createdAt:FieldValue.serverTimestamp(),createdByAdmin:adminId,fileName:cleanFileName(fileName),format:type,uploadedBytes,contentHash,storageMode:'firestore_structured_only'},{merge:true});
    return version;
  });
  try{
    const documents=buildKnowledgeDocuments(merged,nextVersion),writer=db.bulkWriter();
    documents.entries.forEach(({id,...value})=>writer.set(db.doc(`translationKnowledgeEntries/${id}`),{...value,createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()}));
    documents.lookup.forEach(({id,...value})=>writer.set(db.doc(`translationKnowledgeLookup/${id}`),{...value,createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()}));
    await writer.close();
    await db.runTransaction(async(transaction)=>{
      const current=await transaction.get(stateRef),oldVersion=current.data()?.activeVersion;
      if(oldVersion)transaction.set(db.doc(`translationDatasetVersions/${oldVersion}`),{status:'inactive',updatedAt:FieldValue.serverTimestamp()},{merge:true});
      transaction.set(db.doc(`translationDatasetVersions/${nextVersion}`),{status:'active',entryCount:documents.entries.length,lookupCount:documents.lookup.length,invalidCount:parsed.invalidCount,activatedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()},{merge:true});
      transaction.set(stateRef,{activeVersion:nextVersion,updatedAt:FieldValue.serverTimestamp()},{merge:true});
    });
    return{version:nextVersion,processed:parsed.entries.length,newEntries:merged.filter((entry)=>!oldKeys.has(entry.normalizedSource)).length,mergedEntries:parsed.entries.length-merged.filter((entry)=>!oldKeys.has(entry.normalizedSource)).length,invalidEntries:parsed.invalidCount,entryCount:documents.entries.length,lookupCount:documents.lookup.length};
  }catch(error){await db.doc(`translationDatasetVersions/${nextVersion}`).set({status:'failed',errorCategory:error?.name||'Error',updatedAt:FieldValue.serverTimestamp()},{merge:true}).catch(()=>{});throw error;}
}

export async function rollback(db,version,adminId){
  if(!/^v\d+$/.test(version))throw Object.assign(new Error('Invalid dataset version.'),{status:400});
  const stateRef=db.doc('system/translationKnowledge'),targetRef=db.doc(`translationDatasetVersions/${version}`);
  return db.runTransaction(async(transaction)=>{
    const [state,target]=await Promise.all([transaction.get(stateRef),transaction.get(targetRef)]);if(!target.exists||target.data().status==='failed')throw Object.assign(new Error('Dataset version is unavailable.'),{status:404});
    const previous=state.data()?.activeVersion;if(previous===version)return{activeVersion:version,changed:false};
    if(previous)transaction.set(db.doc(`translationDatasetVersions/${previous}`),{status:'inactive',updatedAt:FieldValue.serverTimestamp()},{merge:true});
    transaction.set(targetRef,{status:'active',reactivatedAt:FieldValue.serverTimestamp(),reactivatedByAdmin:adminId,updatedAt:FieldValue.serverTimestamp()},{merge:true});
    transaction.set(stateRef,{activeVersion:version,updatedAt:FieldValue.serverTimestamp()},{merge:true});return{activeVersion:version,previousVersion:previous,changed:true};
  });
}

export async function completeTraining(db,adminId){
  const stateRef=db.doc('system/translationKnowledge');
  return db.runTransaction(async(transaction)=>{
    const state=await transaction.get(stateRef),currentId=state.data()?.currentBatchId;if(!currentId)throw Object.assign(new Error('There is no pending training batch.'),{status:409});
    const currentRef=db.doc(`translationTrainingBatches/${currentId}`),current=await transaction.get(currentRef);if(!current.exists||current.data().status!=='pending')throw Object.assign(new Error('Training batch is not pending.'),{status:409});
    const nextId=`batch_${Date.now().toString(36)}`,now=FieldValue.serverTimestamp();
    transaction.set(currentRef,{status:'completed',completedAt:now,completedByAdmin:adminId,updatedAt:now},{merge:true});
    transaction.set(db.doc(`translationTrainingBatches/${nextId}`),{batchId:nextId,status:'pending',entryCount:0,observationCount:0,createdAt:now,updatedAt:now});
    transaction.set(stateRef,{currentBatchId:nextId,pendingCount:0,updatedAt:now},{merge:true});return{completedBatchId:currentId,newBatchId:nextId};
  });
}

export async function exportTraining(db,batchId){
  if(!/^[a-z0-9_-]{6,80}$/i.test(batchId))throw Object.assign(new Error('Invalid training batch.'),{status:400});
  const snapshot=await db.collection('translationTrainingItems').where('batchId','==',batchId).limit(5000).get(),items=snapshot.docs.map((item)=>item.data()),text=trainingTxt(items);
  await db.doc(`translationTrainingBatches/${batchId}`).set({lastExportAt:FieldValue.serverTimestamp(),lastExportCount:items.length},{merge:true});return{text,count:items.length};
}

export default async function handler(request,response){
  const startedAt=Date.now(),method=String(request.method||'UNKNOWN'),action=String(method==='GET'?request.query?.action||'summary':request.body?.action||'unknown');
  response.setHeader('Cache-Control','no-store');response.setHeader('Content-Type','application/json; charset=utf-8');
  console.info(`[admin-training] method=${method} action=${action} phase=start`);
  try{
    const session=requireAdmin(request),{db}=getAdmin(),adminId=session.adminId||'primary-admin';
    console.info(`[admin-training] method=${method} action=${action} phase=auth result=success elapsedMs=${Date.now()-startedAt}`);
    if(method==='GET'){
      if(action==='summary'){const result=await summary(db);console.info(`[admin-training] method=GET action=summary status=200 elapsedMs=${Date.now()-startedAt}`);return response.status(200).json(result);}
      if(action==='export'){const result=await exportTraining(db,String(request.query?.batchId||''));response.setHeader('Content-Type','text/plain; charset=utf-8');response.setHeader('Content-Disposition',`attachment; filename="kalvi-training-${String(request.query?.batchId||'batch')}.txt"`);console.info(`[admin-training] method=GET action=export status=200 entries=${result.count} elapsedMs=${Date.now()-startedAt}`);return response.status(200).send?response.status(200).send(result.text):response.status(200).end(result.text);}
      return response.status(400).json({error:'Unknown training action.'});
    }
    if(method!=='POST')return response.status(405).json({error:'Method not allowed'});
    requireSameOrigin(request);
    if(action==='upload'){const result=await uploadDataset(db,request.body,adminId);console.info(`[admin-training] method=POST action=upload status=200 entries=${result.entryCount} elapsedMs=${Date.now()-startedAt}`);return response.status(200).json({success:true,...result});}
    if(action==='rollback')return response.status(200).json({success:true,...await rollback(db,String(request.body?.version||''),adminId)});
    if(action==='complete')return response.status(200).json({success:true,...await completeTraining(db,adminId)});
    return response.status(400).json({error:'Unknown training action.'});
  }catch(error){const status=error.status||500;console.error(`[admin-training] method=${method} action=${action} status=${status} error=${error?.name||'Error'} errorCode=${error?.code||'none'} elapsedMs=${Date.now()-startedAt}`,error?.stack||'');return response.status(status).json({error:status<500?error.message:'Training operation failed.',code:error?.code||'training_failed'});}
}
