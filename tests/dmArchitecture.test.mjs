import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { conversationIdFor } from '../api/dm.js';

test('DM conversation identity is deterministic and direction independent',()=>{const ab=conversationIdFor('user_A_123456','user_B_123456'),ba=conversationIdFor('user_B_123456','user_A_123456');assert.equal(ab,ba);assert.match(ab,/^[a-f0-9]{40}$/);assert.notEqual(ab,conversationIdFor('user_A_123456','user_C_123456'));});

test('DM translation waits for persistence and reads shared knowledge without private learning',async()=>{const source=await readFile(new URL('../api/translate.js',import.meta.url),'utf8'),hook=await readFile(new URL('../src/hooks/useDM.js',import.meta.url),'utf8');assert.match(source,/lookupKnowledge\(db,normalizedSource,detection\)/);assert.match(source,/if\(aiProvider&&!isDM\)/);assert.match(source,/if\(!isDM&&!result\.fromMemory/);assert.match(hook,/message\._snapshot&&message\.translationStatus==='pending'/);});

test('DM rules require participant membership and preserve ten-minute deletion policy',async()=>{const rules=await readFile(new URL('../firestore.rules',import.meta.url),'utf8');assert.match(rules,/function dmParticipant/);assert.match(rules,/request\.auth\.uid in get\([\s\S]*dmConversations/);assert.match(rules,/duration\.value\(10, 'm'\)/);assert.match(rules,/match \/dmReports\/\{reportId\} \{ allow read, write: if false; \}/);});

test('shared reaction service subscribes to all supplied message IDs in bounded chunks',async()=>{const service=await readFile(new URL('../src/services/reactionService.js',import.meta.url),'utf8');const hook=await readFile(new URL('../src/hooks/useChat.js',import.meta.url),'utf8');assert.match(service,/index\+=30/);assert.match(service,/where\('messageId','in',ids\)/);assert.match(hook,/messages\.map\(\(message\) => message\.id\)/);});
