import React,{useEffect,useState} from 'react';
import {Alert,Avatar,Box,Button,Chip,CircularProgress,Stack,Tooltip,Typography} from '@mui/material';
import {Link} from 'react-router-dom';
import {API} from '../config';
import config from '../config';
import {encodeFilePath,withMediaCacheScope} from '../urlUtils';
import {FaceTimelineData,loadTimeline,preciseTime,reviewLabel,TimelineSegment} from '../services/personReview';
import {PERSON_VIEWS_CHANGED} from '../services/personViewCache';
import RangeReviewDialog from './RangeReviewDialog';

export default function FaceTimeline({mediaId,onSeekRequest}:{mediaId:number;onSeekRequest:(time:number)=>void}){
  const [data,setData]=useState<FaceTimelineData|null>(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[expanded,setExpanded]=useState(false);
  const [selected,setSelected]=useState<{personId:number|null;segment:TimelineSegment}|null>(null),[review,setReview]=useState(false);
  useEffect(()=>{const changed=()=>setRefresh(v=>v+1);window.addEventListener(PERSON_VIEWS_CHANGED,changed);return()=>window.removeEventListener(PERSON_VIEWS_CHANGED,changed);},[]);
  useEffect(()=>{const c=new AbortController();setError('');loadTimeline(mediaId,c.signal).then(value=>{if(!c.signal.aborted)setData(value);}).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[mediaId,refresh]);
  if(error)return <Alert severity="warning">人脸时间轴暂时无法读取：{error}<Button onClick={()=>setRefresh(v=>v+1)}>重试</Button></Alert>;
  if(!data)return <Box p={2}><CircularProgress size={22}/> 正在读取人脸时间轴…</Box>;
  const duration=data.media.duration??1,shown=expanded?data.items:data.items.slice(0,8),thumb=(path:string|null)=>path?withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(path)}`):undefined;
  return <Box sx={{border:'1px solid',borderColor:'divider',bgcolor:'background.paper',borderRadius:2,p:2,mb:2}}>
    <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1}><Box><Typography fontWeight={650}>人脸时间轴</Typography><Typography variant="caption" color="text.secondary">点击色段定位播放，停留查看人脸；采样间隙可能有漏检。</Typography></Box><Chip size="small" label={`${data.items.length} 个人物/分组`}/></Stack>
    {!data.items.length?<Alert severity="info">尚无带时间点的人脸记录。可通过“局部精查”补查选定范围。</Alert>:<Box sx={{overflowX:'auto'}}><Box sx={{minWidth:620}}>
      <Box sx={{display:'flex',ml:'150px',justifyContent:'space-between',fontFamily:'Consolas,monospace',fontSize:11,color:'text.secondary',mb:1}}>{[0,.25,.5,.75,1].map(n=><span key={n}>{preciseTime(duration*n)}</span>)}</Box>
      {shown.map((p,index)=><Stack direction="row" alignItems="center" key={p.id??'unknown'} gap={1} sx={{minHeight:47,borderTop:'1px solid',borderColor:'divider'}}>
        <Stack direction="row" alignItems="center" gap={.75} sx={{width:142,flexShrink:0}}><Avatar src={thumb(p.thumbnail_path)} sx={{width:29,height:29}}/><Typography component={p.id===null?'span':Link} to={p.id===null?undefined:`/person/${p.id}`} variant="caption" noWrap title={reviewLabel(p)} sx={{color:'text.primary',textDecoration:'none'}}>{reviewLabel(p)}</Typography></Stack>
        <Box sx={{position:'relative',flex:1,height:30,bgcolor:'action.hover',borderRadius:1}}>{p.segments.map((s,i)=><Tooltip key={i} arrow title={<Box><Box component="img" src={thumb(s.thumbnail_path)} alt={reviewLabel(p)} sx={{width:100,height:100,objectFit:'cover',display:'block',mb:.5}}/>{preciseTime(s.start)} — {preciseTime(s.end)} · {s.detections} 次</Box>}><Box component="button" type="button" aria-label={`${reviewLabel(p)} ${preciseTime(s.start)} 至 ${preciseTime(s.end)}`} onClick={()=>{setSelected({personId:p.id,segment:s});onSeekRequest(Math.max(0,s.start-1));}} sx={{position:'absolute',top:5,height:20,left:`${Math.min(99.6,100*s.start/duration)}%`,width:`${Math.max(.4,100*(s.end-s.start)/duration)}%`,minWidth:3,maxWidth:`${100-100*s.start/duration}%`,border:0,p:0,cursor:'pointer',borderRadius:.5,bgcolor:p.id===null?'text.disabled':index%3===0?'primary.main':index%3===1?'#2F8275':'#8064AE','&:focus-visible':{outline:'2px solid',outlineColor:'text.primary',outlineOffset:2}}}/></Tooltip>)}</Box>
      </Stack>)}
    </Box></Box>}
    <Stack direction={{xs:'column',sm:'row'}} gap={1} alignItems={{sm:'center'}} mt={1.5}>
      {data.items.length>8&&<Button size="small" onClick={()=>setExpanded(v=>!v)}>{expanded?'收起人物':'展开全部人物'}</Button>}
      <Typography variant="caption" color="text.secondary" sx={{flex:1}}>{selected?`已选 ${preciseTime(selected.segment.start)} — ${preciseTime(selected.segment.end)}`:'先点选一段，或直接打开范围工具指定时间。'}</Typography>
      {!config.PRESENTATION_MODE&&<Button size="small" variant="outlined" onClick={()=>setReview(true)}>整段纠错 / 局部精查</Button>}
    </Stack>
    {review&&<RangeReviewDialog media={data.media} sourcePersonId={selected?.personId??data.items[0]?.id??null} start={selected?.segment.start??0} end={selected?.segment.end??Math.min(duration,60)} onClose={()=>setReview(false)}/>}
  </Box>;
}
