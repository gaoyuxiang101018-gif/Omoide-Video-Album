import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Alert,Autocomplete,Avatar,Box,Button,Checkbox,Chip,CircularProgress,Dialog,DialogContent,DialogTitle,Divider,IconButton,LinearProgress,MenuItem,Pagination,Stack,Table,TableBody,TableCell,TableHead,TableRow,TextField,Typography} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DownloadIcon from '@mui/icons-material/Download';
import {API} from '../config';
import {Person,PersonReadSimple} from '../types';
import {formatVideoDuration} from '../albumUtils';
import {encodeFilePath,withMediaCacheScope} from '../urlUtils';
import {getPeopleOverview} from '../services/personEvidence';
import {PERSON_VIEWS_CHANGED} from '../services/personViewCache';
import {pickDirectory} from '../services/config';
import {Clip,ClipPlan,ClipExport,loadClips,loadExports,exportClips,cancelExport,clipBounds} from '../services/personWorkbench';
import {VideoWithPreview} from './VideoPlayer';
import RangeReviewDialog from './RangeReviewDialog';

const label=(p:{id:number;name?:string|null})=>p.name?.trim()||`未命名人物 #${p.id}`;
const statusName:Record<string,string>={running:'导出中',pending:'等待中',completed:'已完成',failed:'失败',cancelled:'已取消'};

export default function PersonClipWorkbench({person,onClose}:{person:Person;onClose:()=>void}) {
  const [people,setPeople]=useState<PersonReadSimple[]>([]),[second,setSecond]=useState<PersonReadSimple|null>(null);
  const [gap,setGap]=useState(4),[before,setBefore]=useState(1),[after,setAfter]=useState(1),[resolution,setResolution]=useState('1080p');
  const [plan,setPlan]=useState<ClipPlan|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  const [selected,setSelected]=useState<Set<string>>(new Set()),[page,setPage]=useState(1),[search,setSearch]=useState('');
  const [folder,setFolder]=useState(''),[jobs,setJobs]=useState<ClipExport[]>([]),[submitting,setSubmitting]=useState(false),[notice,setNotice]=useState('');
  const [playlist,setPlaylist]=useState<Clip[]>([]),[index,setIndex]=useState(0),[playError,setPlayError]=useState('');
  const advancing=useRef(false);
  const [reviewClip,setReviewClip]=useState<Clip|null>(null);
  useEffect(()=>{const controller=new AbortController();getPeopleOverview(controller.signal).then(r=>setPeople(r.items)).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[refresh]);
  useEffect(()=>{const changed=()=>setRefresh(v=>v+1);window.addEventListener(PERSON_VIEWS_CHANGED,changed);return()=>window.removeEventListener(PERSON_VIEWS_CHANGED,changed);},[]);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');setPlan(null);setSelected(new Set());setPage(1);
    loadClips(person.id,second?.id??null,gap,controller.signal).then(value=>{if(!controller.signal.aborted){setPlan(value);setSelected(new Set(value.clips.map(c=>c.key)));}}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[person.id,second?.id,gap,refresh]);
  useEffect(()=>{let disposed=false;const poll=()=>loadExports().then(r=>{if(!disposed){setJobs(r.items);setFolder(old=>old||r.default_output_dir);}}).catch(e=>{if(!disposed)setError(`读取导出进度失败：${e.message}`);});void poll();const timer=setInterval(poll,2500);return()=>{disposed=true;clearInterval(timer);};},[]);
  const visible=useMemo(()=>plan?.clips.filter(c=>`${c.media.filename} ${c.media.path}`.toLowerCase().includes(search.toLowerCase()))??[],[plan,search]);
  const chosen=useMemo(()=>plan?.clips.filter(c=>selected.has(c.key))??[],[plan,selected]);
  const totalSeconds=chosen.reduce((sum,c)=>{const [s,e]=clipBounds(c,before,after);return sum+e-s;},0);
  const allVisible=!!visible.length&&visible.every(c=>selected.has(c.key));
  const toggle=(key:string)=>setSelected(old=>{const next=new Set(old);next.has(key)?next.delete(key):next.add(key);return next;});
  const play=(clips:Clip[])=>{setPlaylist(clips);setIndex(0);setPlayError('');advancing.current=false;};
  const advance=()=>{if(advancing.current)return;advancing.current=true;if(index+1<playlist.length)setIndex(v=>v+1);else{setPlaylist([]);setNotice('所选片段已播放完毕');}};
  useEffect(()=>{advancing.current=false;},[index,playlist]);
  const active=playlist[index],bounds=active?clipBounds(active,before,after):[0,0];
  const startExport=async()=>{if(!plan)return;setSubmitting(true);setError('');try{const job=await exportClips(plan,chosen.map(c=>c.key),before,after,folder,resolution);setJobs(old=>[job,...old.filter(j=>j.id!==job.id)]);setNotice('导出已开始，可以关闭窗口，稍后在人物片段中查看结果');}catch(e){setError((e as Error).message);}finally{setSubmitting(false);}};
  const busy=jobs.some(j=>['pending','running'].includes(j.status));
  return <>
    {reviewClip&&<RangeReviewDialog media={reviewClip.media} sourcePersonId={person.id} start={reviewClip.start} end={reviewClip.end} onClose={()=>setReviewClip(null)}/>}
    <Dialog open onClose={onClose} fullWidth maxWidth="lg" aria-labelledby="clip-workbench-title">
      <DialogTitle id="clip-workbench-title"><Stack direction="row" alignItems="center" justifyContent="space-between"><Box>人物片段<Typography variant="body2" color="text.secondary">{label(person)} · 连播、导出与双人同框</Typography></Box><IconButton aria-label="关闭人物片段" onClick={onClose}><CloseIcon/></IconButton></Stack></DialogTitle>
      <DialogContent dividers sx={{minHeight:400}}>
        <Stack direction={{xs:'column',sm:'row'}} gap={2} mb={2}>
          <Autocomplete sx={{flex:1,minWidth:220}} options={people.filter(p=>p.id!==person.id)} value={second} onChange={(_,p)=>setSecond(p)} getOptionLabel={label} isOptionEqualToValue={(a,b)=>a.id===b.id} renderInput={params=><TextField {...params} label="双人同框（可选）" placeholder="选择另一张人脸，未命名也可选"/>} renderOption={(props,p)=><li {...props} key={p.id}><Avatar src={p.profile_face?.thumbnail_path?withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(p.profile_face.thumbnail_path)}`):undefined} sx={{width:32,height:32,mr:1}}/>{label(p)}</li>}/>
          <TextField select label="相邻检测合为一段" value={gap} onChange={e=>setGap(Number(e.target.value))} sx={{minWidth:155}}>{[0,2,4,6,10].map(v=><MenuItem key={v} value={v}>{v} 秒</MenuItem>)}</TextField>
          <Button onClick={()=>setRefresh(v=>v+1)} disabled={loading}>刷新片段</Button>
        </Stack>
        <Typography variant="body2" color="text.secondary" mb={2}>{second?'只列出同一个采样画面中同时检测到两人的片段。':'片段由已有的人脸检测时间点生成。'}采样间隙可能有漏检；前后补时仅用于播放和导出。</Typography>
        {error&&<Alert severity="error" sx={{mb:2}} onClose={()=>setError('')}>{error}</Alert>}
        {notice&&<Alert severity="info" sx={{mb:2}} onClose={()=>setNotice('')}>{notice}</Alert>}
        <Stack direction={{xs:'column',sm:'row'}} gap={1.5} alignItems={{sm:'center'}} mb={2}>
          <Button variant="outlined" disabled={!chosen.length||loading} onClick={()=>setReviewClip(chosen[0])}>纠正首个所选片段 / 精查</Button>
          <TextField size="small" label="查找视频" value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} sx={{flex:1}}/>
          <Chip label={`已选 ${chosen.length} 段 · 约 ${formatVideoDuration(totalSeconds)}`}/>
          <Button variant="contained" startIcon={<PlayArrowIcon/>} disabled={!chosen.length||loading} onClick={()=>play(chosen)}>连播所选片段</Button>
        </Stack>
        {loading?<Box py={5} textAlign="center"><CircularProgress size={26}/><Typography mt={1}>读取检测时间点…</Typography></Box>:!visible.length?<Alert severity="info">{second?'没有找到两人出现在同一采样画面的记录，可以选择其他人物。':'没有可用的检测时间段。'}</Alert>:<Box sx={{overflowX:'auto'}}><Table size="small" sx={{minWidth:610}}><TableHead><TableRow><TableCell padding="checkbox"><Checkbox inputProps={{'aria-label':'全选当前筛选片段'}} checked={allVisible} indeterminate={!allVisible&&visible.some(c=>selected.has(c.key))} onChange={()=>setSelected(old=>{const n=new Set(old);visible.forEach(c=>allVisible?n.delete(c.key):n.add(c.key));return n;})}/></TableCell><TableCell>视频</TableCell><TableCell>检测时间段</TableCell><TableCell align="right">采样点</TableCell><TableCell/></TableRow></TableHead><TableBody>{visible.slice((page-1)*40,page*40).map(c=><TableRow key={c.key} hover><TableCell padding="checkbox"><Checkbox inputProps={{'aria-label':`选择片段 ${c.media.filename} ${formatVideoDuration(c.start)}`}} checked={selected.has(c.key)} onChange={()=>toggle(c.key)}/></TableCell><TableCell sx={{maxWidth:350}}><Typography noWrap variant="body2" title={c.media.path}>{c.media.filename}</Typography><Typography variant="caption" color="text.secondary">{c.media.created_at?.slice(0,10)||'日期未知'}</Typography></TableCell><TableCell sx={{fontFamily:'Consolas,monospace',whiteSpace:'nowrap'}}>{formatVideoDuration(c.start)} — {formatVideoDuration(c.end)}</TableCell><TableCell align="right">{c.detections}</TableCell><TableCell><Button size="small" onClick={()=>play([c])}>播放</Button></TableCell></TableRow>)}</TableBody></Table></Box>}
        {visible.length>40&&<Pagination count={Math.ceil(visible.length/40)} page={Math.min(page,Math.ceil(visible.length/40))} onChange={(_,p)=>setPage(p)} sx={{mt:2}}/>}
        <Divider sx={{my:2.5}}/>
        <Typography variant="subtitle1" fontWeight={600} mb={1.5}>导出所选片段</Typography>
        <Stack direction={{xs:'column',sm:'row'}} gap={1.5} mb={1.5}>
          <TextField select label="前补" value={before} onChange={e=>setBefore(Number(e.target.value))} sx={{minWidth:95}}>{[0,1,2,3,5,10].map(v=><MenuItem key={v} value={v}>{v} 秒</MenuItem>)}</TextField>
          <TextField select label="后补" value={after} onChange={e=>setAfter(Number(e.target.value))} sx={{minWidth:95}}>{[0,1,2,3,5,10].map(v=><MenuItem key={v} value={v}>{v} 秒</MenuItem>)}</TextField>
          <TextField select label="合辑规格" value={resolution} onChange={e=>setResolution(e.target.value)} sx={{minWidth:165}}><MenuItem value="1080p">1080p · 30帧</MenuItem><MenuItem value="4k">4K · 30帧</MenuItem></TextField>
          <TextField label="导出文件夹" value={folder} onChange={e=>setFolder(e.target.value)} sx={{flex:1}}/>
          <Button onClick={async()=>{try{const p=await pickDirectory();if(p)setFolder(p);}catch(e){setError((e as Error).message);}}}>选择位置</Button>
        </Stack>
        <Stack direction={{xs:'column',sm:'row'}} gap={2} alignItems={{sm:'center'}}><Typography variant="caption" color="text.secondary" sx={{flex:1}}>生成 MP4 合辑、逐段 MP4 和来源时间表。保留声音；无声片段补静音。沿用原视频颜色，建议优先使用还原后的成片。原视频保持完整。</Typography><Button variant="outlined" startIcon={<DownloadIcon/>} disabled={loading||!chosen.length||submitting||busy} onClick={startExport}>{submitting?'提交中…':'导出所选合辑'}</Button></Stack>
        <Divider sx={{my:2.5}}/>
        <Typography variant="subtitle1" fontWeight={600} mb={1}>导出进度与历史</Typography>
        {!jobs.length&&<Typography color="text.secondary" variant="body2">尚未导出人物片段。导出开始后可关闭窗口。</Typography>}
        {jobs.map(job=><Box key={job.id} sx={{py:1.5,borderBottom:'1px solid',borderColor:'divider'}}><Stack direction="row" alignItems="center" gap={1}><Chip size="small" label={statusName[job.status]||job.status} color={job.status==='failed'?'error':job.status==='completed'?'success':'default'}/><Typography variant="body2" sx={{flex:1}}>人物 #{job.person_id}{job.with_person_id?` + #${job.with_person_id}`:''} · {job.processed}/{job.total} · {new Date(job.created_at).toLocaleString('zh-CN')}</Typography>{['running','pending'].includes(job.status)&&<Button size="small" onClick={async()=>{try{await cancelExport(job.id);setJobs((await loadExports()).items);}catch(e){setError((e as Error).message);}}}>取消导出</Button>}{job.status==='completed'&&<Button component="a" href={`${API}/api/person/tools/exports/${job.id}/file`} download>下载合辑</Button>}</Stack>{['running','pending'].includes(job.status)&&<LinearProgress variant="determinate" value={job.total?100*job.processed/job.total:0} sx={{my:1}}/>}<Typography variant="caption" display="block" color="text.secondary" sx={{mt:.5,overflowWrap:'anywhere'}}>{job.result_path||job.output_dir}</Typography>{job.error&&<Alert severity="error" sx={{mt:1}}>{job.error}</Alert>}</Box>)}
      </DialogContent>
    </Dialog>
    <Dialog open={!!active} onClose={()=>setPlaylist([])} fullWidth maxWidth="md" aria-labelledby="clip-playlist-title"><DialogTitle id="clip-playlist-title"><Stack direction="row" justifyContent="space-between" alignItems="center"><Box>片段连播 · {index+1}/{playlist.length}<Typography variant="body2" color="text.secondary">{active?.media.filename} · {formatVideoDuration(bounds[0])} — {formatVideoDuration(bounds[1])}</Typography></Box><IconButton aria-label="关闭连播" onClick={()=>setPlaylist([])}><CloseIcon/></IconButton></Stack></DialogTitle><DialogContent>{active&&!playError&&<VideoWithPreview key={`${active.key}:${index}`} media={active.media} autoplay initialTime={bounds[0]} progressInterval={150} onProgress={seconds=>{if(seconds>=bounds[1])advance();}} onEnded={advance} onPlaybackError={()=>setPlayError('此视频暂时无法播放，可跳到下一片段，或用本地播放器打开原视频。')}/ >}{playError&&<Alert severity="warning">{playError}</Alert>}<Stack direction="row" gap={1} justifyContent="center" mt={1.5}><Button disabled={!index} onClick={()=>{setPlayError('');setIndex(v=>v-1);}}>上一段</Button><Button onClick={()=>{setPlayError('');advance();}}>{index+1>=playlist.length?'结束连播':'下一段'}</Button><Button onClick={()=>setPlaylist([])}>停止</Button></Stack></DialogContent></Dialog>
  </>;
}
