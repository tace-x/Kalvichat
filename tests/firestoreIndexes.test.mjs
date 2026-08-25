import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexes=JSON.parse(await readFile(new URL('../firestore.indexes.json',import.meta.url),'utf8')).indexes;
const fields=(index)=>index.fields.map((field)=>field.arrayConfig?`${field.fieldPath}:${field.arrayConfig}`:`${field.fieldPath}:${field.order}`);

test('DM conversation-list composite index exactly matches query',()=>{
  const index=indexes.find((candidate)=>candidate.collectionGroup==='dmConversations');
  assert.ok(index);assert.equal(index.queryScope,'COLLECTION');assert.deepEqual(fields(index),['participantIds:CONTAINS','lastMessageAt:DESCENDING']);
});

test('DM reactions composite index matches scoped realtime query',()=>{
  const index=indexes.find((candidate)=>candidate.collectionGroup==='dmReactions');
  assert.ok(index);assert.deepEqual(fields(index),['conversationId:ASCENDING','messageId:ASCENDING']);
});

test('DM message query needs only automatic createdAt single-field index',async()=>{
  const source=await readFile(new URL('../src/services/dmService.js',import.meta.url),'utf8');
  assert.match(source,/messagesRef\(conversationId\),orderBy\('createdAt','desc'\),limit\(PAGE_SIZE\)/);
  assert.match(source,/startAfter\(oldest\._snapshot\)/);
  assert.doesNotMatch(source,/messagesRef\(conversationId\),where\(/);
});
