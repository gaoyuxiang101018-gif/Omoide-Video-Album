import React, { useState } from "react";
import {
  Button,
  Divider,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import BlockIcon from "@mui/icons-material/Block";
import SelectAllIcon from "@mui/icons-material/SelectAll";
import ClearAllIcon from "@mui/icons-material/ClearAll";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";

import ConfirmDialog from "./ConfirmDialog";
import { formatBytes } from "../formatUtils";

export type BulkResolveAction = "DELETE_FILES" | "DELETE_RECORDS" | "BLACKLIST_RECORDS";

export type FeedbackSeverity = "success" | "error" | "warning";

export const resolveConfirmCopy = (action: BulkResolveAction, count: number) => {
  switch (action) {
    case "DELETE_FILES":
      return {
        title: "从磁盘删除文件",
        message: ("将从磁盘永久删除 {0} 个文件，并从资料库中移除。此操作无法撤销。".replace(/\{(\d+)\}/g, (_, i) => String([count][Number(i)]))),
        confirmLabel: "删除文件",
      };
    case "DELETE_RECORDS":
      return {
        title: "移除记录",
        message: ("将从资料库中移除 {0} 条记录。文件保留在磁盘上，可通过后续扫描重新导入。".replace(/\{(\d+)\}/g, (_, i) => String([count][Number(i)]))),
        confirmLabel: "移除记录",
      };
    case "BLACKLIST_RECORDS":
      return {
        title: "将项目加入黑名单",
        message: ("将 {0} 个项目加入黑名单，使其永不重新导入，并从资料库中移除其记录。文件保留在磁盘上。".replace(/\{(\d+)\}/g, (_, i) => String([count][Number(i)]))),
        confirmLabel: "Blacklist",
      };
  }
};

interface BulkResolveToolbarProps {
  statsText: string;
  shownCount: number;
  shownSize: number;
  total: number;
  selectedIds: Set<number>;
  onSelectVisible: () => void;
  onClearSelection: () => void;
  resolve: (params: {
    action: BulkResolveAction;
    mediaIds?: number[];
    selectAll?: boolean;
  }) => Promise<{ removed: number }>;
  onResolved: (removedIds: number[], removed: number, selectAll: boolean) => void;
  onFeedback: (message: string, severity: FeedbackSeverity) => void;
  extraActions?: React.ReactNode;
}

const BulkResolveToolbar: React.FC<BulkResolveToolbarProps> = ({
  statsText,
  shownCount,
  shownSize,
  total,
  selectedIds,
  onSelectVisible,
  onClearSelection,
  resolve,
  onResolved,
  onFeedback,
  extraActions,
}) => {
  const [pending, setPending] = useState<{ action: BulkResolveAction; selectAll: boolean } | null>(null);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [allMenuAnchor, setAllMenuAnchor] = useState<null | HTMLElement>(null);

  const selectedCount = selectedIds.size;

  const requestAction = (action: BulkResolveAction, selectAll = false) => {
    setAllMenuAnchor(null);
    if (!selectAll && selectedCount === 0) return;
    setPending({ action, selectAll });
  };

  const handleConfirm = async () => {
    if (!pending) return;
    const ids = pending.selectAll ? [] : Array.from(selectedIds);
    setIsActionLoading(true);
    try {
      const { removed } = await resolve(
        pending.selectAll
          ? { action: pending.action, selectAll: true }
          : { action: pending.action, mediaIds: ids }
      );
      if (removed > 0) {
        onFeedback(`${removed} item(s) processed`, "success");
      } else {
        onFeedback("没有匹配的项目", "warning");
      }
      onResolved(ids, removed, pending.selectAll);
      setPending(null);
    } catch (e) {
      onFeedback(e instanceof Error ? e.message : "操作失败", "error");
      setPending(null);
    } finally {
      setIsActionLoading(false);
    }
  };

  const copy = pending
    ? resolveConfirmCopy(pending.action, pending.selectAll ? total : selectedCount)
    : null;

  return (
    <>
      <Paper variant="outlined" sx={{ mb: 3, position: "sticky", top: 64, zIndex: 10 }}>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={2}
          alignItems={{ md: "center" }}
          justifyContent="space-between"
          sx={{ p: 2 }}
        >
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
            <Typography variant="subtitle1">{statsText}</Typography>
            <Typography variant="body2" color="text.secondary">
              {" 显示： "}{shownCount} · {formatBytes(shownSize)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {" 已选择： "}{selectedCount}
            </Typography>
          </Stack>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
            <Button
              size="small"
              startIcon={<SelectAllIcon />}
              onClick={onSelectVisible}
              disabled={shownCount === 0}
            >
              {" 选择可见项 "}</Button>
            <Button
              size="small"
              startIcon={<ClearAllIcon />}
              onClick={onClearSelection}
              disabled={selectedCount === 0}
            >
              {" 清除选择 "}</Button>
            {extraActions}
            <Divider flexItem orientation="vertical" sx={{ display: { xs: "none", sm: "block" } }} />
            <Tooltip title="从磁盘删除文件">
              <span>
                <Button
                  size="small"
                  variant="contained"
                  color="error"
                  startIcon={<DeleteForeverIcon />}
                  onClick={() => requestAction("DELETE_FILES")}
                  disabled={selectedCount === 0 || isActionLoading}
                >
                  {" 删除文件 "}</Button>
              </span>
            </Tooltip>
            <Tooltip title="从资料库移除记录（保留文件）">
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  color="error"
                  startIcon={<DeleteIcon />}
                  onClick={() => requestAction("DELETE_RECORDS")}
                  disabled={selectedCount === 0 || isActionLoading}
                >
                  {" 移除记录 "}</Button>
              </span>
            </Tooltip>
            <Tooltip title="加入黑名单并从资料库移除">
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<BlockIcon />}
                  onClick={() => requestAction("BLACKLIST_RECORDS")}
                  disabled={selectedCount === 0 || isActionLoading}
                >
                  {" 加入黑名单 "}</Button>
              </span>
            </Tooltip>
            <Tooltip title="对匹配当前筛选条件的所有项目执行操作，而不仅是已加载的项目">
              <span>
                <Button
                  size="small"
                  color="error"
                  endIcon={<ArrowDropDownIcon />}
                  onClick={(e) => setAllMenuAnchor(e.currentTarget)}
                  disabled={total === 0 || isActionLoading}
                >
                  {" 全部 "}{total.toLocaleString()} {" 匹配 "}</Button>
              </span>
            </Tooltip>
            <Menu
              anchorEl={allMenuAnchor}
              open={Boolean(allMenuAnchor)}
              onClose={() => setAllMenuAnchor(null)}
            >
              <MenuItem onClick={() => requestAction("DELETE_FILES", true)}>
                {" 删除全部 "}{total.toLocaleString()} {" 文件 "}</MenuItem>
              <MenuItem onClick={() => requestAction("DELETE_RECORDS", true)}>
                {" 移除全部 "}{total.toLocaleString()} {" 记录 "}</MenuItem>
              <MenuItem onClick={() => requestAction("BLACKLIST_RECORDS", true)}>
                {" 全部加入黑名单 "}{total.toLocaleString()}
              </MenuItem>
            </Menu>
          </Stack>
        </Stack>
      </Paper>

      <ConfirmDialog
        open={Boolean(pending)}
        title={copy?.title ?? ""}
        message={copy?.message ?? ""}
        confirmLabel={copy?.confirmLabel}
        loading={isActionLoading}
        onConfirm={handleConfirm}
        onClose={() => setPending(null)}
      />
    </>
  );
};

export default BulkResolveToolbar;
