import { initDatabase, setRegisteredGroup, getAllRegisteredGroups } from './dist/db.js';
initDatabase();
setRegisteredGroup('harness:test', {
  name: 'harness-test', folder: 'test', trigger: '@sagri-ai',
  added_at: new Date().toISOString(), requiresTrigger: false, isMain: true,
});
console.log('seeded:', JSON.stringify(getAllRegisteredGroups(), null, 2));
