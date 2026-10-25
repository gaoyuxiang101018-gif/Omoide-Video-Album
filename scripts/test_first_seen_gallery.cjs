const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const root=path.join(__dirname,'../frontend'),ts=require(path.join(root,'node_modules/typescript'));
const compiled=ts.transpileModule(fs.readFileSync(path.join(root,'src/firstSeenPeople.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const api={};vm.runInNewContext(compiled,{exports:api,Date,Intl,Map,Number});
const person=(id,date,name=null)=>({id,name,first_date:date});
let passed=0;function check(name,test){test();passed++;console.log('PASS',name);}
check('newest first appearance day is the top section',()=>assert.equal(api.groupFirstSeenPeople([person(1,'2026-10-20'),person(2,'2026-10-23')])[0].date,'2026-10-23'));
check('people share one date section and keep their identities',()=>{const groups=api.groupFirstSeenPeople([person(3,'2026-10-20'),person(1,'2026-10-20')]);assert.equal(groups.length,1);assert.equal(groups[0].people.map(p=>p.id).join(','),'1,3');});
check('missing and invalid dates go last',()=>{const groups=api.groupFirstSeenPeople([person(1,null),person(2,'2026-02-30'),person(3,'2026-10-20')]);assert.equal(groups.map(g=>g.date).join(','),'2026-10-20,');assert.equal(groups[1].people.length,2);});
check('six digit date finds its gallery section',()=>{const groups=api.groupFirstSeenPeople([person(1,'2026-10-20'),person(2,'2026-10-23')],'261020');assert.equal(groups.length,1);assert.equal(groups[0].people[0].id,1);assert.equal(api.captureDayCode(groups[0].date),'261020');});
check('names and person ids can filter the gallery',()=>{const people=[person(5,'2026-10-20','小明'),person(2,'2026-10-23')];assert.equal(api.groupFirstSeenPeople(people,'小明')[0].people[0].id,5);assert.equal(api.groupFirstSeenPeople(people,'5')[0].people[0].id,5);});
check('capture day labels do not shift with computer timezone',()=>{assert.match(api.captureDayLabel('2026-10-20'),/2026.*10.*20/);assert.equal(api.isCaptureDay('2024-02-29'),true);assert.equal(api.isCaptureDay('2026-02-29'),false);});
console.log(`${passed} first-seen gallery checks passed`);
