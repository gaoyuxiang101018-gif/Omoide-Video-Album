import React,{useEffect,useState} from 'react';
import {Alert,Avatar,Box,Button,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,Radio,RadioGroup,Stack,Typography} from '@mui/material';
import {API} from '../config';
import {encodeFilePath,withMediaCacheScope} from '../urlUtils';
import {mergeMultiplePersons,MergeResult} from '../services/personActions';
import type {PersonReadSimple} from '../types';

export default function MergePeopleDialog({open,people,onClose,onMerged}:{open:boolean;people:PersonReadSimple[];onClose:()=>void;onMerged:(target:number,result:MergeResult)=>void}) {
  const [target,setTarget]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(open){setError('');setTarget(value=>people.some(person=>person.id===value)?value:(people.find(person=>person.name?.trim())||people[0])?.id||0);}},[open,people]);
  const merge=async()=>{
    if(busy || people.length<2 || !people.some(person=>person.id===target))return;
    setBusy(true);setError('');
    try {const result=await mergeMultiplePersons(target,people.filter(person=>person.id!==target).map(person=>person.id));onMerged(target,result);}
    catch(err){setError(err instanceof Error?err.message:'合并失败，请重试。');}
    finally{setBusy(false);}
  };
  return <Dialog open={open} onClose={busy?undefined:onClose} maxWidth="sm" fullWidth>
    <DialogTitle>合并选中的人物</DialogTitle>
    <DialogContent><Typography variant="body2" color="text.secondary" mb={2}>选择合并后保留的人物。未命名人物也可以直接合并。</Typography>
      {!!error && <Alert severity="error" sx={{mb:2}}>{error}</Alert>}
      <RadioGroup aria-label="合并后保留的人物" value={target} onChange={e=>setTarget(Number(e.target.value))}>
        {people.map(person=><Box key={person.id} sx={{border:1,borderColor:target===person.id?'primary.main':'divider',borderRadius:1,mb:1,px:1}}><FormControlLabel disabled={busy} value={person.id} control={<Radio/>} sx={{width:'100%',m:0,py:1}} label={<Stack direction="row" alignItems="center" gap={1.5}>
          <Avatar variant="rounded" src={person.profile_face?.thumbnail_path?withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(person.profile_face.thumbnail_path)}`):undefined}/>
          <Box><Typography>{person.name?.trim()||`未命名人物 ${person.id}`}</Typography><Typography variant="caption" color="text.secondary">编号 {person.id}{target===person.id?' · 保留此人物':''}</Typography></Box>
        </Stack>}/></Box>)}
      </RadioGroup>
    </DialogContent><DialogActions><Button onClick={onClose} disabled={busy}>取消</Button><Button variant="contained" onClick={merge} disabled={busy||people.length<2}>{busy?'正在合并…':`合并 ${people.length} 个人物`}</Button></DialogActions>
  </Dialog>;
}
