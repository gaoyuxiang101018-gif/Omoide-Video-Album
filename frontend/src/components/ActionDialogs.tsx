import React from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
} from "@mui/material";

interface ActionDialogsProps {
  dialogType: "convert" | "deleteRecord" | "deleteFile" | null;
  onClose: () => void;
  onConfirmConvert: () => void;
  onConfirmDeleteRecord: () => void;
  onConfirmDeleteFile: () => void;
}

export function ActionDialogs({
  dialogType,
  onClose,
  onConfirmConvert,
  onConfirmDeleteRecord,
  onConfirmDeleteFile,
}: ActionDialogsProps) {
  return (
    <>
      {/* Convert Dialog */}
      <Dialog open={dialogType === "convert"} onClose={onClose}>
        <DialogTitle>{"转换视频格式？"}</DialogTitle>
        <DialogActions>
          <Button onClick={onClose}>{"取消"}</Button>
          <Button variant="contained" onClick={onConfirmConvert}>
            {" 确认 "}</Button>
        </DialogActions>
      </Dialog>

      {/* Delete Record Dialog */}
      <Dialog open={dialogType === "deleteRecord"} onClose={onClose}>
        <DialogTitle>{"从资料库中移除？"}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {" 该记录将从数据库中移除。磁盘上的文件会保留，可通过扫描重新导入。 "}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{"取消"}</Button>
          <Button variant="outlined" color="error" onClick={onConfirmDeleteRecord}>
            {" 移除记录 "}</Button>
        </DialogActions>
      </Dialog>

      {/* Delete File Dialog */}
      <Dialog open={dialogType === "deleteFile"} onClose={onClose}>
        <DialogTitle>{"从磁盘删除文件？"}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {" 文件将从磁盘永久删除。此操作无法撤销。 "}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{"取消"}</Button>
          <Button variant="contained" color="error" onClick={onConfirmDeleteFile}>
            {" 删除文件 "}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
