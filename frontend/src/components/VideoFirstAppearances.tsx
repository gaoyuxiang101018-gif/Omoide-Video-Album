import React,{useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {Alert,Avatar,Box,Button,CircularProgress,MenuItem,Stack,Table,TableBody,TableCell,TableContainer,TableHead,TableRow,TextField,Typography} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import {API} from '../config';
import {formatVideoDuration} from '../albumUtils';
import {encodeFilePath,withMediaCacheScope} from '../urlUtils';
import {FirstAppearance,getMediaFirstAppearances} from '../services/personEvidence';
import {invalidatePersonViews,PERSON_VIEWS_CHANGED} from '../services/personViewCache';
import {useLocalStorageNumber} from '../hooks/useLocalStoragePreference';
export default function VideoFirstAppearances({mediaId,onSeekRequest}:{mediaId:number;onSeekRequest:(time:number)=>void}) {
  const [items,setItems]=useState<FirstAppearance[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  const [gap,setGap]=useLocalStorageNumber('personSegmentGap',4,{min:0,max:10});
  useEffect(()=>{const changed=()=>setRevision(value=>value+1);window.addEventListener(PERSON_VIEWS_CHANGED,changed);return ()=>window.removeEventListener(PERSON_VIEWS_CHANGED,changed);},[]);
  useEffect(()=>{const controller=new AbortController();setLoading(true);setError('');getMediaFirstAppearances(mediaId,gap,controller.signal).then(result=>{if(!controller.signal.aborted)setItems(result.items);}).catch(err=>{if(!controller.signal.aborted&&err.name!=='AbortError')setError(err instanceof Error?err.message:'读取首次出现时间失败');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return ()=>controller.abort();},[mediaId,gap,revision]);
  return <Box><Stack direction={{xs:'column',sm:'row'}} justifyContent="space-between" gap={1.5} mb={2}><Box><Typography variant="h6">人物首次出现时间表</Typography><Typography variant="body2" color="text.secondary">按视频中的首次出现时间排列，未命名人物也会显示。</Typography></Box><Stack direction="row" gap={1}><TextField select size="small" label="相邻检测合并间隔" value={gap} onChange={e=>setGap(Number(e.target.value))} sx={{minWidth:170}}>{[0,2,4,6,10].map(value=><MenuItem key={value} value={value}>{value?`${value} 秒`:'不合并'}</MenuItem>)}</TextField><Button onClick={invalidatePersonViews} disabled={loading}>刷新</Button></Stack></Stack>
    <Alert severity="info" icon={false} sx={{mb:2}}>时间来自采样检测点，边界可能有误差；点击“回看”从首次出现前 1 秒开始播放。</Alert>
    {!!error&&<Alert severity="error">{error}</Alert>}{loading&&<Box py={2} textAlign="center"><CircularProgress size={24}/></Box>}
    {!loading&&!error&&!items.length&&<Typography color="text.secondary" py={3}>尚无已归类人物的有效时间记录，请先识别并归类这个视频。</Typography>}
    {!!items.length&&<TableContainer sx={{border:1,borderColor:'divider',borderRadius:1}}><Table size="small" aria-label="视频人物首次出现时间表"><TableHead><TableRow><TableCell>人物</TableCell><TableCell>首次出现</TableCell><TableCell>首次片段结束</TableCell><TableCell>回看</TableCell></TableRow></TableHead><TableBody>{items.map(item=><TableRow key={item.person_id} data-first-person={item.person_id}><TableCell><Stack component={Link} to={`/person/${item.person_id}`} direction="row" alignItems="center" gap={1} sx={{color:'inherit',textDecoration:'none'}}><Avatar sx={{width:36,height:36}} src={item.thumbnail_path?withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(item.thumbnail_path)}`):undefined}/><Typography variant="body2">{item.name?.trim()||`未命名人物 ${item.person_id}`}</Typography></Stack></TableCell><TableCell sx={{whiteSpace:'nowrap',fontVariantNumeric:'tabular-nums'}}>{formatVideoDuration(item.start)}</TableCell><TableCell sx={{whiteSpace:'nowrap',fontVariantNumeric:'tabular-nums'}}>{item.end>item.start?formatVideoDuration(item.end):'单次检测'}</TableCell><TableCell><Button size="small" startIcon={<PlayArrowIcon/>} onClick={()=>onSeekRequest(Math.max(0,item.start-1))}>回看</Button></TableCell></TableRow>)}</TableBody></Table></TableContainer>}
  </Box>;
}
