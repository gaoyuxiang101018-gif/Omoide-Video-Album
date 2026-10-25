const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('node:assert/strict');
const base = path.join(__dirname, '../frontend'), ts = require(path.join(base, 'node_modules/typescript'));
function moduleFrom(file) {
  const source = fs.readFileSync(path.join(base, 'src', file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {}; vm.runInNewContext(js, { exports, Date, Map, Set, Number, String }); return exports;
}
const utils = moduleFrom('albumUtils.ts'), segments = moduleFrom('appearanceSegments.ts');
const aliases = [{path:'Y:\\clips',resolved_path:'\\\\RaiDrive-MyPC\\WebDAV\\clips'}];
let passed = 0;
function check(name, action) { action(); passed++; console.log('PASS', name); }
const face = (id, timestamp, media_id=1) => ({ id, timestamp, media_id, thumbnail_path: 'face.jpg' });
const shape = result => JSON.parse(JSON.stringify(result));
check('duration rolls over minute', () => assert.equal(utils.formatVideoDuration(59.8), '1:00'));
check('duration rolls over hour', () => assert.equal(utils.formatVideoDuration(3599.9), '1:00:00'));
check('unknown duration stays unknown', () => assert.equal(utils.formatVideoDuration(NaN), '—'));
check('negative duration clamps to zero', () => assert.equal(utils.formatVideoDuration(-1), '0:00'));
check('timestamps include zero', () => assert.equal(segments.buildAppearanceSegments([face(1,0)], 10, 4)[0].start, 0));
check('isolated detection is a point', () => assert.equal(segments.buildAppearanceSegments([face(1,2)], 10, 4)[0].end, 2));
check('separated appearances remain separate', () => assert.equal(segments.buildAppearanceSegments([face(1,0),face(2,2),face(3,8)], 20, 4).length, 2));
check('gap equality merges', () => assert.equal(segments.buildAppearanceSegments([face(1,0),face(2,4)], 20, 4).length, 1));
check('missing, invalid, negative and out-of-bounds timestamps are excluded', () => assert.equal(segments.buildAppearanceSegments([face(1,null),face(2,undefined),face(3,NaN),face(4,-1),face(5,21),face(6,0)],20,4)[0].detections,1));
check('input order does not affect segments', () => assert.deepEqual(shape(segments.buildAppearanceSegments([face(1,4),face(2,0),face(3,2)],20,2)).map(s=>[s.start,s.end,s.detections]),[[0,4,3]]));
check('zero gap keeps distinct timepoints separate', () => assert.equal(segments.buildAppearanceSegments([face(1,0),face(2,2)],20,0).length,2));
check('media boundaries are preserved', () => assert.equal(segments.getVideoAppearances([{id:1,duration:10},{id:2,duration:10}], [face(1,0,1),face(2,2,2)],4).length,2));
check('photos excluded from video time results', () => assert.equal(segments.getVideoAppearances([{id:1,duration:null},{id:2,duration:10}],[],4).length,1));
check('missing times reported, not invented', () => assert.equal(segments.getVideoAppearances([{id:1,duration:10}], [face(1,null)],4)[0].missingTimestamps,1));
check('newest video sort uses capture time, not import time', () => assert.deepEqual(shape(utils.sortVideos([{id:1,created_at:'2026-10-20',inserted_at:'2026-10-01'},{id:2,created_at:'2026-10-01',inserted_at:'2026-10-20'}],'newest')).map(x=>x.id),[1,2]));
check('latest import sort is independent', () => assert.deepEqual(shape(utils.sortVideos([{id:1,created_at:'2026-10-20',inserted_at:'2026-10-01'},{id:2,created_at:'2026-10-01',inserted_at:'2026-10-20'}],'latest')).map(x=>x.id),[2,1]));
check('face sort uses actual detections', () => assert.ok(segments.comparePersonMetrics({id:1,faceCount:30,videoCount:1},{id:2,faceCount:2,videoCount:3},'face_count')<0));
check('latest appearance sort uses video date, not person id', () => assert.ok(segments.comparePersonMetrics({id:1,latestVideo:'2026-10-20'},{id:9,latestVideo:'2026-01-01'},'latest_video')<0));
check('video count sort uses video count', () => assert.ok(segments.comparePersonMetrics({id:1,faceCount:2,videoCount:3},{id:2,faceCount:30,videoCount:1},'video_count')<0));
check('Windows folder matching ignores case', () => assert.ok(utils.isInDirectory('Y:\\Videos\\day\\a.mp4','y:\\videos')));
check('folder siblings do not leak into results', () => assert.equal(utils.isInDirectory('Y:\\Videos2\\a.mp4','Y:\\Videos'),false));
check('UNC source folder works', () => assert.ok(utils.isInDirectory('\\\\NAS\\share\\video\\a.mp4','\\\\nas\\share\\video\\')));
check('directory root matching works', () => assert.ok(utils.isInDirectory('P:\\test.mp4','P:\\')));
check('empty directory never matches every file', () => assert.equal(utils.isInDirectory('Y:\\a.mp4',''),false));
check('mapped source includes resolved network files', () => assert.ok(utils.isInDirectory('\\\\RaiDrive-MyPC\\WebDAV\\clips\\day\\new.mp4','Y:\\clips',aliases)));
check('resolved source includes mapped files', () => assert.ok(utils.isInDirectory('Y:\\clips\\day\\old.mp4','\\\\RaiDrive-MyPC\\WebDAV\\clips',aliases)));
check('path aliases preserve source boundaries', () => assert.equal(utils.isInDirectory('\\\\RaiDrive-MyPC\\WebDAV\\clips2\\a.mp4','Y:\\clips',aliases),false));
check('same file merges visually and preserves recognized record', () => {
  const rows=[{id:20,path:'\\\\RaiDrive-MyPC\\WebDAV\\clips\\a.mp4'},{id:10,path:'Y:\\clips\\a.mp4'},{id:30,path:'Y:\\clips\\other\\a.mp4'}];
  assert.deepEqual(shape(utils.deduplicateLibraryVideos(rows,aliases,item=>item.id===10?3:1)).map(item=>item.id),[10,30]);
  assert.equal(rows.length,3);
});
check('deduplication is stable regardless of API ordering', () => {
  const rows=[{id:20,path:'\\\\RaiDrive-MyPC\\WebDAV\\clips\\a.mp4'},{id:10,path:'Y:\\clips\\a.mp4'}];
  assert.equal(utils.deduplicateLibraryVideos(rows,aliases,()=>1)[0].id,10);
  assert.equal(utils.deduplicateLibraryVideos([...rows].reverse(),aliases,()=>1)[0].id,10);
});
check('restored originals hide across mapped and network paths only', () => {
  const rows=[{id:1,path:'Y:\\clips\\a.mp4'},{id:2,path:'Y:\\clips\\other\\a.mp4'}];
  const result=utils.splitRestoredOriginals(rows,['\\\\RaiDrive-MyPC\\WebDAV\\clips\\a.mp4'],aliases);
  assert.deepEqual(shape(result.hidden).map(item=>item.id),[1]);
  assert.deepEqual(shape(result.visible).map(item=>item.id),[2]);
  assert.equal(rows.length,2);
});
check('missing or unavailable restoration status leaves originals visible', () => {
  const rows=[{id:1,path:'Y:\\clips\\a.mp4'}];
  assert.equal(utils.splitRestoredOriginals(rows,[],aliases).visible.length,1);
});
check('restored output belongs to original folder while keeping physical output path', () => {
  const links=[{media_id:2,source_path:'Y:\\clips\\day\\a.mp4',output_path:'Y:\\home\\还原\\a_HLG.mp4',valid:true,mode:'hlg'}];
  const output={id:2,path:links[0].output_path};
  assert.ok(utils.belongsToLibraryDirectory(output.path,'Y:\\clips',aliases,links));
  assert.ok(utils.belongsToLibraryDirectory(output.path,'Y:\\home\\还原',aliases,links));
  assert.equal(utils.attachRestoredOutputs([output],links)[0].path,output.path);
});
check('original stays visible until valid restored record is actually indexed', () => {
  const links=[{media_id:2,source_path:'Y:\\clips\\a.mp4',output_path:'Y:\\out\\a.mp4',valid:true,mode:'sdr'}];
  assert.equal(utils.readyRestoredSources([{id:1}],['Y:\\clips\\a.mp4'],links,aliases).length,0);
  assert.equal(utils.readyRestoredSources([{id:1},{id:2}],['Y:\\clips\\a.mp4'],links,aliases).length,1);
});
check('missing restored output is excluded and cannot hide its original', () => {
  const links=[{media_id:2,source_path:'Y:\\clips\\a.mp4',output_path:'Y:\\out\\a.mp4',valid:false,mode:'sdr'}];
  assert.deepEqual(shape(utils.attachRestoredOutputs([{id:1},{id:2}],links)).map(item=>item.id),[1]);
  assert.equal(utils.readyRestoredSources([{id:1},{id:2}],['Y:\\clips\\a.mp4'],links,aliases).length,0);
});
check('bulk recognition excludes restored originals across path aliases, but keeps outputs and other same-name files', () => {
  const rows=[{id:1,path:'Y:\\clips\\a.mp4'},{id:2,path:'\\\\RaiDrive-MyPC\\WebDAV\\clips\\a.mp4'},{id:3,path:'Y:\\out\\a.mp4'},{id:4,path:'Y:\\clips\\other\\a.mp4'}];
  const links=[{media_id:3,source_path:rows[0].path,output_path:rows[2].path,valid:true,mode:'hlg'}];
  assert.deepEqual(Array.from(utils.getRestoredOriginalIds(rows,links,aliases)).sort(),[1,2]);
});
check('successful restoration history still excludes originals when output validation later fails', () => {
  const links=[{media_id:2,source_path:'Y:\\clips\\a.mp4',output_path:'Y:\\out\\a.mp4',valid:false,mode:'hlg'}];
  assert.deepEqual(Array.from(utils.getRestoredOriginalIds([{id:1,path:links[0].source_path}],links,aliases)),[1]);
});
check('verified successful output excludes its original while album registration is pending', () => {
  const rows=[{id:1,path:'Y:\\clips\\a.mp4'},{id:2,path:'Y:\\clips\\b.mp4'}];
  assert.deepEqual(Array.from(utils.getRestoredOriginalIds(rows,[],aliases,['\\\\RaiDrive-MyPC\\WebDAV\\clips\\a.mp4'])),[1]);
  assert.equal(utils.getRestoredOriginalIds(rows,[],aliases).size,0);
});
check('recognition activity follows physical paths and preserves running priority', () => {
  const items=[{id:1,path:'Y:\\clips\\a.mp4'},{id:2,path:'Y:\\clips\\other\\a.mp4'}];
  const activity=[{media_id:10,path:'\\\\RaiDrive-MyPC\\WebDAV\\clips\\a.mp4',task_id:'a',state:'queued'},{media_id:11,path:'Y:\\clips\\a.mp4',task_id:'b',state:'running'}];
  const states=utils.getRecognitionStates(items,activity,aliases);
  assert.equal(states.get(1),'running');assert.equal(states.has(2),false);
});
check('bulk selection skips originals and every item reserved by the active batch', () => {
  const items=[1,2,3,4,5].map(id=>({id})), faceStates=new Map(items.map(item=>[item.id,'pending']));
  faceStates.set(5,'faces');
  const work=new Map([[2,'queued'],[3,'completed']]);
  assert.deepEqual(shape(utils.bulkRecognitionCandidates(items,faceStates,new Set([1]),work,true,false)).map(item=>item.id),[4]);
});
check('batch selection waits for current profile history and activity state', () => {
  const items=[{id:1}], states=new Map([[1,'pending']]);
  assert.equal(utils.bulkRecognitionCandidates(items,states,null,new Map(),true,false).length,0);
  assert.equal(utils.bulkRecognitionCandidates(items,states,new Set(),new Map(),false,false).length,0);
  assert.equal(utils.bulkRecognitionCandidates(items,states,new Set(),new Map(),true,true).length,0);
});
check('video version filter uses actual restoration links rather than filename guesses', () => {
  const original={id:1,filename:'ordinary_HLG.mp4'}, output={id:2,filename:'custom-name.mp4',restored_source_path:'Y:\\clips\\source.mp4'};
  assert.equal(utils.matchesVideoVersion(original,'restored'),false);
  assert.equal(utils.matchesVideoVersion(output,'restored'),true);
  assert.equal(utils.matchesVideoVersion(output,'original'),false);
  assert.equal(utils.matchesVideoVersion(original,'original'),true);
  assert.equal(utils.matchesVideoVersion(output,'all'),true);
});
console.log(`${passed} meaningful checks passed`);
