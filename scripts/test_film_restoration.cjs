const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const root=path.join(__dirname,'../frontend'),ts=require(path.join(root,'node_modules/typescript'));
const modules=new Map();
function load(file){file=path.resolve(file);if(modules.has(file))return modules.get(file);const exports={};modules.set(file,exports);const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;vm.runInNewContext(js,{exports,require:name=>load(path.resolve(path.dirname(file),name+'.ts')),Map,Set,Date,Number});return exports;}
const api=load(path.join(root,'src/filmRestoration.ts'));
const source='Y:\\clips\\day\\clip.mp4';
const item=(state='succeeded',available=false,src=source)=>({index:0,status:state,video:{path:src},output:'Y:\\home\\还原\\clip_HLG.mp4',output_exists:available});
const job=(items,mode='hlg',created=1)=>({id:`job-${created}`,mode,created_at:created,items});
const index=(jobs,aliases=[])=>api.indexFilmRestorations(jobs,aliases);
const state=(jobs)=>index(jobs).get(source.toLowerCase().replace(/\\/g,'/'));
let passed=0;function check(name,test){test();passed++;console.log('PASS',name);}
check('no history stays unconverted',()=>{assert.equal(state([]),undefined);assert.equal(api.canSelectUnrestored(undefined),true);});
check('successful history labels the original',()=>{const value=state([job([item()])]);assert.equal(value.kind,'completed');assert.equal(api.restorationLabel(value),'已还原 · HDR');});
check('unavailable output does not erase successful history',()=>{const value=state([job([item()])]);assert.equal(value.successes.length,1);assert.equal(value.available,undefined);assert.equal(value.needsVerification,true);});
check('available output remains playable',()=>{const value=state([job([item('succeeded',true)])]);assert.equal(value.available.item.output_exists,true);assert.equal(value.needsVerification,false);});
check('SDR and HDR successes are shown together',()=>{const value=state([job([item()]),job([item()], 'sdr',2)]);assert.equal(api.restorationLabel(value),'已还原 · SDR / HDR');});
check('mapped and UNC aliases and case match the same source',()=>{const aliases=[{path:'Y:\\clips',resolved_path:'\\\\RaiDrive-MyPC\\WebDAV\\clips'}];const value=index([job([item()])],aliases).get('//raidrive-mypc/webdav/clips/day/clip.mp4');assert.equal(value.kind,'completed');});
check('same filename in another folder is not marked',()=>assert.equal(index([job([item()])]).has('y:/other/clip.mp4'),false));
check('partial job only marks its successful item',()=>{const values=index([job([item(),item('failed',false,'Y:\\clips\\failed.mp4')])]);assert.equal(values.get('y:/clips/failed.mp4').kind,'failed');});
check('running queued and paused have distinct labels',()=>{for(const [status,label] of [['running','还原中'],['queued','排队中'],['paused','已暂停']])assert.equal(api.restorationLabel(state([job([item(status)])])),label);});
check('active work has priority over a paused earlier attempt',()=>{const value=state([job([item('paused')]),job([item('running')],'sdr',2)]);assert.equal(value.kind,'running');});
check('old failures do not replace a successful mark',()=>assert.equal(state([job([item('failed')]),job([item()],'hlg',2)]).kind,'completed'));
check('newer failure cannot erase an earlier successful conversion',()=>assert.equal(state([job([item()]),job([item('failed')],'sdr',2)]).kind,'completed'));
check('output files are recognized as restored copies',()=>{const value=index([job([item()])]).get('y:/home/还原/clip_hlg.mp4');assert.equal(value.role,'output');assert.equal(api.restorationLabel(value),'还原成片 · HDR');});
check('bulk selection skips both restored and pending items',()=>{for(const status of ['succeeded','running','queued','paused'])assert.equal(api.canSelectUnrestored(state([job([item(status)])])),false);assert.equal(api.canSelectUnrestored(state([job([item('failed')])])),true);});
check('restoration filters use success history and pending work',()=>{const value=state([job([item()]),job([item('paused')],'sdr',2)]);assert.equal(api.matchesRestoration(value,'completed'),true);assert.equal(api.matchesRestoration(value,'unrestored'),false);assert.equal(api.matchesRestoration(value,'pending'),true);assert.equal(api.matchesRestoration(value,'failed'),false);});
console.log(`${passed} restoration status checks passed`);
