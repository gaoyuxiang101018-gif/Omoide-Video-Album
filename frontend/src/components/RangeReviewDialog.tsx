import React,{useEffect,useState} from 'react';
import {Alert,Autocomplete,Avatar,Box,Button,Dialog,DialogActions,DialogContent,DialogTitle,IconButton,MenuItem,Stack,Tab,Tabs,TextField,Typography} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import {Link} from 'react-router-dom';
import {API} from '../config';
import {MediaPreview,PersonReadSimple} from '../types';
import {getPeopleOverview,getPersonCacheState} from '../services/personEvidence';
import {correctRange,preciseTime,parseVideoTime,RangePreview,refineRange,reviewLabel,reviewPreview} from '../services/personReview';
import {encodeFilePath,withMediaCacheScope} from '../urlUtils';

export default function RangeReviewDialog({media,sourcePersonId,start,end,onClose}:{media:MediaPreview;sourcePersonId:number|null;start:number;end:number;onClose:()=>void}){
  const [tab,setTab]=useState('correct'),[from,setFrom]=useState(preciseTime(start)),[to,setTo]=useState(preciseTime(Math.min(media.duration??end,Math.max(end,start+.5))));
  const [people,setPeople]=useState<PersonReadSimple[]>([]),[source,setSource]=useState(sourcePersonId),[target,setTarget]=useState<PersonReadSimple|null>(null),[mode,setMode]=useState('assign');
  const [interval,setIntervalValue]=useState(.5),[preview,setPreview]=useState<RangePreview|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{const c=new AbortController();getPeopleOverview(c.signal).then(r=>setPeople(r.items)).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[]);
  useEffect(()=>{setPreview(null);setNotice('');},[source,from,to]);
  const a=parseVideoTime(from),b=parseVideoTime(to),valid=a!==null&&b!==null&&b>=a&&b<=(media.duration??0);
  const range={media_id:media.id,start:a??0,end:b??0,source_person_id:source};
  const check=async()=>{setBusy(true);setError('');try{setPreview(await reviewPreview(range));}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const apply=async()=>{if(!preview)return;setBusy(true);setError('');try{const r=await correctRange({...range,profile_key:preview.profile_key,fingerprint:preview.fingerprint,mode,target_person_id:target?.id??null});setPreview(null);setNotice(`已纠正 ${r.face_count} 张人脸${r.target_person_id?`，目标人物 #${r.target_person_id}`:'，已排除自动归类'}。可到“纠错与限制”撤销。`);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const refine=async()=>{setBusy(true);setError('');try{const stamp=await getPersonCacheState(true);await refineRange({media_id:media.id,start:a!,end:b!,interval,profile_key:stamp.profile_key});setNotice('局部精查已开始。只补充新结果，旧人脸保留；可到“纠错与限制”查看进度或取消。');}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <Dialog open onClose={()=>{if(!busy)onClose();}} maxWidth="sm" fullWidth aria-labelledby="range-review-title"><DialogTitle id="range-review-title"><Stack direction="row" justifyContent="space-between" alignItems="center"><Box>片段纠错与精查<Typography variant="body2" color="text.secondary" noWrap sx={{maxWidth:400}}>{media.filename}</Typography></Box><IconButton disabled={busy} aria-label="关闭片段纠错" onClick={onClose}><CloseIcon/></IconButton></Stack></DialogTitle><DialogContent dividers>
    <Tabs value={tab} onChange={(_,v)=>setTab(v)} sx={{mb:2}}><Tab value="correct" label="整段纠错"/><Tab value="refine" label="局部密集补查"/></Tabs>
    <Stack direction="row" gap={2} mb={2}><TextField label="开始时间" value={from} onChange={e=>setFrom(e.target.value)} helperText="秒数或 时:分:秒" fullWidth/><TextField label="结束时间" value={to} onChange={e=>setTo(e.target.value)} helperText={`视频时长 ${preciseTime(media.duration??0)}`} fullWidth/></Stack>
    {!valid&&<Alert severity="warning" sx={{mb:2}}>请输入视频范围内的有效时间，结束时间须不早于开始。</Alert>}
    {error&&<Alert severity="error" sx={{mb:2}}>{error}</Alert>}{notice&&<Alert severity="success" sx={{mb:2}}>{notice}<Button component={Link} to="/face-review" onClick={onClose}>查看记录与进度</Button></Alert>}
    {tab==='correct'?<>
      <Autocomplete options={people} value={people.find(p=>p.id===source)??null} onChange={(_,p)=>setSource(p?.id??null)} getOptionLabel={reviewLabel} isOptionEqualToValue={(a,b)=>a.id===b.id} renderInput={p=><TextField {...p} label="只纠正这个人物的人脸" placeholder="留空表示待确认人脸"/>} sx={{mb:2}}/>
      <TextField select label="纠正方式" value={mode} onChange={e=>setMode(e.target.value)} fullWidth sx={{mb:2}}><MenuItem value="assign">移给另一位人物</MenuItem><MenuItem value="new">拆成新人物，无需先命名</MenuItem><MenuItem value="exclude">排除自动归类</MenuItem></TextField>
      {mode==='assign'&&<Autocomplete options={people.filter(p=>p.id!==source)} value={target} onChange={(_,p)=>setTarget(p)} getOptionLabel={reviewLabel} isOptionEqualToValue={(a,b)=>a.id===b.id} renderInput={p=><TextField {...p} label="目标人物"/>} renderOption={(props,p)=><li {...props} key={p.id}><Avatar src={p.profile_face?.thumbnail_path?withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(p.profile_face.thumbnail_path)}`):undefined} sx={{width:32,height:32,mr:1}}/>{reviewLabel(p)}</li>} sx={{mb:2}}/>}
      <Typography variant="body2" color="text.secondary" mb={2}>只修改该人物在此范围内已检测到的人脸。纠正后锁定这些人脸，排除项不再自动归类；新补查画面需按实际结果核对。原视频与人脸图片保留。</Typography>
      <Button variant="outlined" disabled={!valid||busy} onClick={check}>预览受影响人脸</Button>
      {preview&&<Box mt={2}><Typography>{preview.source_label} · 共 {preview.face_count} 张人脸</Typography><Stack direction="row" flexWrap="wrap" gap={.8} mt={1}>{preview.faces.map(f=><Avatar key={f.id} variant="rounded" src={f.thumbnail_path?withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(f.thumbnail_path)}`):undefined} alt={`采样点 ${preciseTime(f.timestamp)}`} sx={{width:50,height:50}}/>)}</Stack><Typography variant="caption" color="text.secondary">仅展示前16张，操作作用于所选范围内全部匹配的人脸。</Typography></Box>}
    </>:<>
      <TextField select label="补查采样间隔" fullWidth value={interval} onChange={e=>setIntervalValue(Number(e.target.value))} sx={{mb:2}}>{[2,1,.5,.25].map(n=><MenuItem key={n} value={n}>{n} 秒/帧{n===.5?' · 推荐':''}</MenuItem>)}</TextField>
      <Alert severity="info">仅处理这个视频的所选范围，单次最多10分钟、2400帧。使用当前识别模型匹配已有人物，无法确定的新脸保留待确认。取消或失败时不会清空旧识别结果。</Alert>
      {valid&&b!>a!&&<Typography mt={2}>预计采样 {Math.ceil((b!-a!)/interval)} 帧</Typography>}
    </>}
  </DialogContent><DialogActions><Button disabled={busy} onClick={onClose}>关闭</Button>{tab==='correct'?<Button variant="contained" disabled={busy||!valid||!preview?.face_count||(mode==='assign'&&!target)} onClick={apply}>{busy?'处理中…':'应用整段纠错'}</Button>:<Button variant="contained" disabled={busy||!valid||b!<=a!||b!-a!>600||Math.ceil((b!-a!)/interval)>2400} onClick={refine}>{busy?'提交中…':'开始局部精查'}</Button>}</DialogActions></Dialog>;
}
