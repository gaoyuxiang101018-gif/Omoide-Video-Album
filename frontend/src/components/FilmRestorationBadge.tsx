import React from 'react';
import { Chip, Tooltip } from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import { FilmRestoration, restorationLabel } from '../filmRestoration';

export function FilmRestorationBadge({ value, ready, offline }: { value?: FilmRestoration; ready: boolean; offline: boolean }) {
  const completed = value?.kind === 'completed';
  const label = !ready ? offline ? '记录不可用' : '读取记录…' : restorationLabel(value);
  const color = !ready ? 'default' : completed ? 'success' : value?.kind === 'failed' ? 'error' : value?.kind === 'paused' ? 'warning' : value?.pending ? 'info' : 'default';
  const explanation = !ready ? '还原记录尚未读取，暂不能判断是否还原过。'
    : completed ? `${value.successes.length} 条成功记录${value.needsVerification ? '；历史成片需核验，文件可能已移动、更改或暂不可访问。' : '；已有可用成片。'}${value.pending ? ' 另有尚未结束的还原任务。' : ''}`
    : value?.pending ? '此视频已在还原队列中，可在“还原任务与成片”里查看或继续。'
    : value?.kind === 'failed' ? '存在失败记录，尚无成功还原记录。' : '当前资料库没有此视频的成功还原记录。';
  return <Tooltip title={explanation}><Chip size="small" color={color} label={label} icon={completed ? <CheckCircleOutlineIcon /> : undefined}
    data-film-restoration={ready ? value?.kind || 'unrestored' : 'unknown'}
    sx={{ maxWidth: '100%', height: 25, fontSize: 11, boxShadow: '0 1px 5px #0002' }} /></Tooltip>;
}
