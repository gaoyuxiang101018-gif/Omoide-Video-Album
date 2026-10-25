import React from "react";
import { Link, useLocation } from "react-router-dom";
import { Alert, Box, Button, LinearProgress, Stack, Typography } from "@mui/material";
import { useTaskHistory, TASK_NAMES, STEP_NAMES, taskPercent, taskStatus, isRecognitionTask } from "../context/TaskHistoryContext";
import { formatVideoDuration } from "../albumUtils";

export function TaskProgressStrip() {
  const {tasks,error,loading}=useTaskHistory();
  const location=useLocation();
  const active=tasks.filter(task=>["running","pending"].includes(task.status));
  const latest=tasks.find(isRecognitionTask),display=active.length?[...active].sort((a,b)=>(b.updated_at_epoch||0)-(a.updated_at_epoch||0)).slice(0,2):latest?[latest]:[];
  if(location.pathname==='/recognition-progress')return null;
  if(!display.length&&!error)return null;
  return <Box sx={{bgcolor:"background.paper",px:{xs:2,md:4},py:1.5,borderBottom:1,borderColor:"divider"}}>
    {error&&<Alert severity="warning" sx={{mb:display.length?1:0}} action={<Button component={Link} to="/recognition-progress">详情</Button>}>识别后台暂未连接，以下为最后读取的记录。</Alert>}
    {!loading&&display.map(task=>{
      const pct=taskPercent(task),running=["running","pending"].includes(task.status),filename=task.current_item?.split(/[\\/]/).pop();
      return <Box key={task.id} sx={{mb:display.length>1?1:0}}><Stack direction="row" gap={1.5} alignItems="center"><Typography variant="body2" fontWeight={600} sx={{flexShrink:0}}>{running?TASK_NAMES[task.task_type]||"后台任务":"上次识别任务"}</Typography><Typography variant="caption" color={task.status==="failed"?"error":"text.secondary"} noWrap sx={{flex:1}}>{running?filename||STEP_NAMES[task.current_step||""]||"准备中…":taskStatus(task)}</Typography><Typography variant="caption" sx={{flexShrink:0}}>{pct==null?"总量待确定":`${pct}% · ${task.processed}/${task.total}`}</Typography><Button component={Link} to="/recognition-progress">进度与历史</Button></Stack>{running&&<LinearProgress variant={pct==null||task.status==="pending"?"indeterminate":"determinate"} value={pct??0} sx={{mt:.8}}/>}{running&&task.current_step&&<Typography variant="caption" color="text.secondary" display="block" mt={.7}>{STEP_NAMES[task.current_step]||"后台处理中"}{typeof task.frame_current==="number"?` · 采样画面 ${task.frame_current}/${task.frame_total}`:""}{typeof task.video_second==="number"?` · 视频采样点 ${formatVideoDuration(task.video_second)}`:""}</Typography>}</Box>;
    })}
    {active.length>display.length&&<Typography variant="caption" color="text.secondary">另有 {active.length-display.length} 个后台任务，可在“进度与历史”中查看。</Typography>}
  </Box>;
}
