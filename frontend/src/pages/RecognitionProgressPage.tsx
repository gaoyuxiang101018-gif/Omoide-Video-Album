import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Alert, Box, Button, Chip, Container, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Stack, Tab, Tabs, Typography } from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useTaskHistory, HistoricalTask, TASK_NAMES, STEP_NAMES, taskStatus, taskPercent, isRecognitionTask } from "../context/TaskHistoryContext";
import { apiFetch } from "../services/api";
import { formatVideoDuration } from "../albumUtils";

interface ProgressItem { media_id:number;processor:string;path:string;status:string;reason:string;updated_at:number; }
const basename=(path?:string)=>path?.split(/[\\/]/).pop() || "尚未开始处理视频";
export function TaskProgressDetails({task}:{task:HistoricalTask}) {
  const percent=taskPercent(task),active=["running","pending"].includes(task.status);
  return <>
    <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center"><Typography fontWeight={600}>{TASK_NAMES[task.task_type]||"后台分析任务"}</Typography><Chip size="small" label={taskStatus(task)} color={task.status==="failed"||task.failure_count?"error":task.status==="completed"?"success":"default"}/><Box sx={{flex:1}}/><Typography variant="body2" sx={{fontVariantNumeric:"tabular-nums"}}>{percent==null?"总量待确定":`${percent}% · ${task.processed} / ${task.total}`}</Typography></Stack>
    <LinearProgress variant={percent==null?"indeterminate":"determinate"} value={percent??0} sx={{mt:1.4,mb:1.4,height:6,borderRadius:1}}/>
    <Typography variant="body2" sx={{overflowWrap:"anywhere"}}>{active?"当前视频：":"最后处理："}{task.current_item?basename(task.current_item):active?"等待后台提供文件名…":"旧任务未保留最后文件名"}</Typography>
    {task.current_item&&<Typography variant="caption" color="text.secondary" sx={{display:"block",overflowWrap:"anywhere",mt:.4}}>{task.current_item}</Typography>}
    <Typography variant="caption" color="text.secondary" display="block" mt={.7}>{active?(STEP_NAMES[task.current_step||""] || "等待后台更新阶段"):taskStatus(task)}{task.started_at?` · 开始 ${new Date(task.started_at).toLocaleString("zh-CN")}`:""}</Typography>
    {active&&typeof task.frame_current==="number"&&typeof task.frame_total==="number"&&<Typography variant="body2" color="primary.main" mt={1}>采样画面 {task.frame_current} / {task.frame_total}{typeof task.video_second==="number"?` · 当前采样点 ${formatVideoDuration(task.video_second)}${typeof task.video_duration==="number"?` / ${formatVideoDuration(task.video_duration)}`:""}`:""}</Typography>}
    {!!task.failure_count&&<Typography variant="body2" color="error" mt={1}>已记录 {task.failure_count} 个失败项；整体进度包含跳过项，不代表全部识别成功。</Typography>}
    {(task.fatal_error||task.last_error)&&<Alert severity="error" sx={{mt:1.5,overflowWrap:"anywhere"}}>{task.fatal_error||task.last_error}</Alert>}
    {!!task.item_counts&&!!Object.keys(task.item_counts).length&&<Typography variant="caption" color="text.secondary" display="block" mt={1}>成功 {task.item_counts.completed||0} · 失败 {task.item_counts.failed||0} · 正在处理 {task.item_counts.running||0}</Typography>}
    {task.status==="failed"&&task.total>task.processed&&<Alert severity="warning" sx={{mt:1.5}}>本批还有 {task.total-task.processed} 个处理项未完成。已完成部分保留，没有自动重跑。</Alert>}
  </>;
}

export default function RecognitionProgressPage() {
  const {tasks,loading,error,updatedAt,refresh}=useTaskHistory();
  const [params,setParams]=useSearchParams(),filter=params.get("status")||"all";
  const [detail,setDetail]=useState<HistoricalTask|null>(null),[items,setItems]=useState<ProgressItem[]>([]),[itemTotal,setItemTotal]=useState(0),[itemError,setItemError]=useState(""),[itemLoading,setItemLoading]=useState(false);
  const records=useMemo(()=>tasks.filter(isRecognitionTask),[tasks]);
  const counts={active:records.filter(task=>["running","pending"].includes(task.status)).length,failed:records.filter(task=>task.status==="failed"||!!task.failure_count).length};
  const visible=records.filter(task=>filter==="active"?["running","pending"].includes(task.status):filter==="failed"?task.status==="failed"||!!task.failure_count:true);
  const selected=detail?tasks.find(task=>task.id===detail.id)||detail:null;
  useEffect(()=>{
    if(!selected)return;
    const controller=new AbortController();setItemLoading(true);setItemError("");
    apiFetch<{items:ProgressItem[];total:number}>(`/api/tasks/${selected.id}/items`,{query:{limit:500},signal:controller.signal,errorMessage:"读取逐项记录失败"}).then(data=>{if(!controller.signal.aborted){setItems(data.items);setItemTotal(data.total);}}).catch(err=>{if(!controller.signal.aborted)setItemError(err.message);}).finally(()=>{if(!controller.signal.aborted)setItemLoading(false);});
    return()=>controller.abort();
  },[selected?.id,selected?.processed,selected?.status]);
  return <Container maxWidth="lg" sx={{px:{xs:2,md:4},py:3.5}}>
    <Stack direction={{xs:"column",sm:"row"}} justifyContent="space-between" gap={2} mb={2.5}><Box><Typography component="h1" variant="h4">识别进度与历史</Typography><Typography variant="body2" color="text.secondary" mt={.8}>查看当前视频、处理数量和逐项失败原因。任务结束、刷新或重开软件后仍可查看。</Typography></Box><Stack direction="row" gap={1}><Button startIcon={<RefreshIcon/>} onClick={refresh}>刷新进度</Button><Button component={Link} to="/videos?status=pending" variant="outlined">查看未完成视频</Button></Stack></Stack>
    {error&&<Alert severity="warning" sx={{mb:2}}>{error} 已显示的内容为最后一次读取的记录，不代表任务仍在运行。</Alert>}
    <Typography variant="caption" color="text.secondary">{updatedAt?`最近更新 ${new Date(updatedAt).toLocaleTimeString("zh-CN")}`:"正在连接后台…"} · 这里只查看，不会自动重跑识别或清理数据。</Typography>
    <Tabs value={["all","active","failed"].includes(filter)?filter:"all"} onChange={(_,value)=>setParams(value==="all"?{}:{status:value})} sx={{mt:2,mb:2.5,borderBottom:1,borderColor:"divider"}}><Tab value="all" label={`最近记录 ${records.length}`}/><Tab value="active" label={`进行中 ${counts.active}`}/><Tab value="failed" label={`失败或中断 ${counts.failed}`}/></Tabs>
    {loading&&<LinearProgress/>}
    {!loading&&!visible.length&&<Box py={7} textAlign="center"><Typography color="text.secondary">{filter==="active"?"当前没有正在进行的识别任务。":filter==="failed"?"最近记录中没有失败任务。":"尚无识别任务记录。"}</Typography></Box>}
    <Stack gap={2}>{visible.map(task=><Box key={task.id} data-task-id={task.id} sx={{p:{xs:2,sm:2.5},bgcolor:"background.paper",border:1,borderColor:task.status==="failed"?"error.light":"divider",borderRadius:1.5,minWidth:0}}><TaskProgressDetails task={task}/><Stack direction="row" justifyContent="space-between" alignItems="center" mt={1.5}><Typography variant="caption" color="text.secondary">{task.created_at?new Date(task.created_at).toLocaleString("zh-CN"):""}</Typography><Button onClick={()=>{setItems([]);setItemTotal(0);setDetail(task);}}>逐个视频与失败详情</Button></Stack></Box>)}</Stack>
    <Typography variant="caption" color="text.secondary" display="block" mt={3}>采样点表示正在分析的视频画面，并不表示连续逐秒检查。旧版本的任务没有逐项记录时，会保留已有数量和日志中的异常原因。</Typography>
    <Dialog open={!!selected} onClose={()=>setDetail(null)} maxWidth="md" fullWidth><DialogTitle>识别任务详情</DialogTitle><DialogContent>{selected&&<TaskProgressDetails task={selected}/>}<Typography variant="h6" mt={3} mb={1.5}>逐项处理记录</Typography>{itemLoading&&<LinearProgress/>}{itemError&&<Alert severity="error">{itemError}</Alert>}{!itemLoading&&!items.length&&<Alert severity="info">这个任务没有保存逐项记录，可能由旧版本运行；不会推测它处理了哪些视频。</Alert>}<Stack gap={1.5}>{items.map(item=><Box key={`${item.media_id}-${item.processor}`} sx={{p:1.5,border:1,borderColor:"divider",borderRadius:1}}><Stack direction="row" gap={1} alignItems="center"><Typography variant="body2" fontWeight={600} sx={{flex:1,minWidth:0,overflowWrap:"anywhere"}}>{basename(item.path)}</Typography><Chip size="small" label={item.status==="completed"?"已完成":item.status==="failed"?"失败":"处理中"} color={item.status==="failed"?"error":item.status==="completed"?"success":"default"}/></Stack><Typography variant="caption" color="text.secondary" sx={{display:"block",overflowWrap:"anywhere",mt:.5}}>{item.path}</Typography>{item.reason&&<Typography variant="body2" color="error" sx={{overflowWrap:"anywhere",mt:.7}}>{item.reason}</Typography>}<Button component={Link} to={`/medium/${item.media_id}`} onClick={()=>setDetail(null)} size="small" sx={{mt:.7}}>打开视频</Button></Box>)}</Stack>{itemTotal>items.length&&<Typography variant="caption" display="block" mt={2}>显示最近 {items.length} / {itemTotal} 项。</Typography>}</DialogContent><DialogActions><Button onClick={()=>setDetail(null)}>关闭</Button></DialogActions></Dialog>
  </Container>;
}
