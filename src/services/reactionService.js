import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase';

export function subscribeReactionWindow({collectionName,messageIds,userId,conversationId=null,onData,onError}){
  const unique=[...new Set(messageIds)].filter(Boolean),chunks=[];for(let index=0;index<unique.length;index+=30)chunks.push(unique.slice(index,index+30));
  if(!chunks.length)return()=>{};
  const snapshots=new Map();
  const emit=()=>{const grouped={};for(const documents of snapshots.values())for(const value of documents){grouped[value.messageId]||={counts:{},mine:null};grouped[value.messageId].counts[value.emoji]=(grouped[value.messageId].counts[value.emoji]||0)+1;if(value.userId===userId)grouped[value.messageId].mine=value.emoji;}onData(grouped);};
  const unsubscribers=chunks.map((ids,index)=>{
    const constraints=[where('messageId','in',ids)];if(conversationId)constraints.unshift(where('conversationId','==',conversationId));
    return onSnapshot(query(collection(db,collectionName),...constraints),(snapshot)=>{snapshots.set(index,snapshot.docs.map((item)=>item.data()));emit();},onError);
  });
  return()=>unsubscribers.forEach((unsubscribe)=>unsubscribe());
}
