import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { Link } from 'react-router-dom';
import { apiFetch } from '../services/api';
import { invalidatePersonViews } from '../services/personViewCache';

interface Preview {
  profile_key: string;
  fingerprint: string;
  people_count: number;
  face_count: number;
  minimum_frontality: number;
  items: { id: number; face_count: number; max_frontality: number }[];
}
interface Entry { id: string; created_at: string; people_count: number; face_count: number; matched: number; pending: number; undone_at: string | null }

export default function FrontalReviewPanel() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [action, setAction] = useState<{ type: 'review' | 'undo'; id?: string } | null>(null);
  const refresh = async () => {
    const [candidate, journal] = await Promise.all([
      apiFetch<Preview>('/api/person/review/frontal/preview'),
      apiFetch<{ items: Entry[] }>('/api/person/review/frontal/history'),
    ]);
    setPreview(candidate); setHistory(journal.items);
  };
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, []);
  const confirm = async () => {
    if (!action || !preview) return;
    setBusy(true); setError('');
    try {
      if (action.type === 'review') {
        const result = await apiFetch<{ face_count: number; matched: number; pending: number }>('/api/person/review/frontal/reconcile', {
          method: 'POST', body: { profile_key: preview.profile_key, fingerprint: preview.fingerprint },
        });
        setNotice(`已整理 ${result.face_count} 张人脸：${result.matched} 张归入有正脸参考的人物，${result.pending} 张保留待确认。`);
      } else {
        await apiFetch(`/api/person/review/frontal/${action.id}/undo`, { method: 'POST' });
        setNotice('已恢复整理前的归属，后来新增的人脸保留。');
      }
      invalidatePersonViews(); await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setAction(null); }
  };
  return <Stack gap={2}>
    <Alert severity="info">新人物必须有可靠正脸参考。侧脸能可靠匹配就归入同一人物，匹配不稳则待确认，不会仅凭侧脸新建人物。头像优先选择正脸，同等姿态下选更清晰的图片。</Alert>
    {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
    {notice && <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert>}
    <Box>
      <Typography variant="h6">已有侧脸人物整理</Typography>
      <Typography color="text.secondary" variant="body2" mt={1}>只处理姿态已有评分、没有正脸参考的自动人物。已命名、收藏、手工纠错、手工合并或带有人物标记的分组会保留；不会删除人脸、缩略图或出现时间点。</Typography>
      <Typography mt={2}>{preview ? `当前有 ${preview.people_count} 个人物组、${preview.face_count} 张人脸可复核。` : '正在检查已有姿态评分…'}</Typography>
      <Stack direction="row" gap={1} mt={2} flexWrap="wrap">
        <Button disabled={busy} onClick={() => { setError(''); void refresh().catch(e => setError(e.message)); }}>重新检查</Button>
        <Button variant="contained" disabled={busy || !preview?.face_count} onClick={() => setAction({ type: 'review' })}>整理侧脸人物</Button>
      </Stack>
      {!!preview?.items.length && <Stack direction="row" gap={1} mt={1} flexWrap="wrap">{preview.items.slice(0, 20).map(p => <Button key={p.id} size="small" component={Link} to={`/person/${p.id}`}>人物 #{p.id} · {p.face_count} 张</Button>)}</Stack>}
    </Box>
    {!!history.length && <Box sx={{ overflowX: 'auto' }}><Table size="small" sx={{ minWidth: 600 }}><TableHead><TableRow><TableCell>整理时间</TableCell><TableCell>原人物组</TableCell><TableCell>已匹配 / 待确认</TableCell><TableCell>状态</TableCell><TableCell /></TableRow></TableHead><TableBody>{history.map(item => <TableRow key={item.id}><TableCell>{new Date(item.created_at).toLocaleString('zh-CN')}</TableCell><TableCell>{item.people_count}</TableCell><TableCell>{item.matched} / {item.pending}</TableCell><TableCell>{item.undone_at ? '已撤销' : '已整理'}</TableCell><TableCell><Button disabled={busy || !!item.undone_at} onClick={() => setAction({ type: 'undo', id: item.id })}>撤销整理</Button></TableCell></TableRow>)}</TableBody></Table></Box>}
    <Dialog open={!!action} onClose={() => { if (!busy) setAction(null); }} fullWidth maxWidth="sm"><DialogTitle>{action?.type === 'undo' ? '撤销这次侧脸整理' : '整理已有侧脸人物'}</DialogTitle><DialogContent><Typography>{action?.type === 'undo' ? '恢复这次整理前的人脸归属。后来新增的人脸保留；如相关人脸已有后续修改，会提示冲突并保护后续结果。' : `将复核 ${preview?.people_count || 0} 个人物组、${preview?.face_count || 0} 张人脸。先尝试归入有可靠正脸的人物，其余回到待确认。保留原人物记录，可在本页撤销。`}</Typography><Typography variant="body2" color="text.secondary" mt={2}>无需重新识别视频。后台分析完成后才能执行。</Typography></DialogContent><DialogActions><Button disabled={busy} onClick={() => setAction(null)}>取消</Button><Button variant="contained" disabled={busy} onClick={confirm}>{busy ? '正在整理…' : action?.type === 'undo' ? '撤销整理' : '确认整理'}</Button></DialogActions></Dialog>
  </Stack>;
}
