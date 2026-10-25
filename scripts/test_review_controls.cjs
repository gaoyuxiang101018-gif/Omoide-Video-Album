const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.join(__dirname,'../frontend');
const ts=require(path.join(root,'node_modules/typescript'));
const source=fs.readFileSync(path.join(root,'src/services/personReview.ts'),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const exported={};vm.runInNewContext(compiled,{exports:exported,require:()=>({apiFetch:()=>{throw new Error('Network should not run in time helpers');}})});
let checks=0;function check(name,run){run();checks++;console.log('PASS '+name);}
check('plain seconds and fractional timestamps',()=>{assert.equal(exported.parseVideoTime('17.25'),17.25);assert.equal(exported.parseVideoTime('0:00.5'),.5);});
check('hour minute second timestamps',()=>assert.equal(exported.parseVideoTime('1:23:45.5'),5025.5));
check('invalid minute and second components are rejected',()=>{for(const value of ['1:60','1:60:00','0:99','1.5:20','1:2.5:30'])assert.equal(exported.parseVideoTime(value),null);});
check('empty negative infinite and malformed values are rejected',()=>{for(const value of ['',' ','-1','Infinity','1::2','a:20','1:2:3:4'])assert.equal(exported.parseVideoTime(value),null);});
check('minute rollover never produces 0:60',()=>assert.equal(exported.preciseTime(59.9999),'1:00'));
check('hour rollover is valid',()=>assert.equal(exported.preciseTime(3599.9999),'1:00:00'));
check('fractional end points round-trip',()=>{for(const value of [.25,1.5,600,3598.125,3600.5])assert.equal(exported.parseVideoTime(exported.preciseTime(value)),value);});
check('zero and negative display clamp to zero',()=>{assert.equal(exported.preciseTime(0),'0:00');assert.equal(exported.preciseTime(-1),'0:00');});
check('unnamed and unassigned groups remain distinct',()=>{assert.equal(exported.reviewLabel({id:42,name:null}),'未命名人物 #42');assert.equal(exported.reviewLabel({id:null}),'待确认人脸');});
console.log(`${checks} range control checks passed`);
