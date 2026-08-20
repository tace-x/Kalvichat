import test from 'node:test';
import assert from 'node:assert/strict';

test('admin-training Vercel module graph imports as Node ESM',async()=>{
  const module=await import('../api/admin-training.js');
  assert.equal(typeof module.default,'function');
  for(const name of ['summary','uploadDataset','rollback','completeTraining','exportTraining'])assert.equal(typeof module[name],'function',name);
});
