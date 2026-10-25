# PocketRestoreCore

PocketFilm 的本地还原后端。输入原片只读，输出另存，文件同名自动加序号。独立 CLI，不需要达芬奇或 DJI Studio。

## 用户功能

- 从原 MP4/MOV 的 DJI 元数据明确区分 D-Log、D-Log 2、HLG；不凭灰画面或文件名猜。
- D-Log / D-Log 2 普通还原使用对应的大疆 Pocket 4P 官方 Rec.709 LUT。
- HDR 从大疆官方 ACES 输入曲线与色域出发，转换为 BT.2020 HLG，并以 HEVC Main10 导出。
- HLG 原片可转成普通 SDR 视频；采用固定 1000-nit HLG 到 100-nit SDR 的高光压缩。
- HLG 原片可保持 HLG 导出，已经处于 HDR 模式，不再套 Log LUT。
- 任务支持进度、取消、失败报告；NVENC 失败时尝试 CPU 编码。

HDR 的曝光、203-nit 白色、1000-nit nominal 显示和高光肩部是本工具的固定预设。它不等于已验证的 Mimo 私有渲染；显示器/手机的 HLG 播放也影响最终观感。

## 集成接口

可用源码入口 `python pocket_restore_cli.py ...`，或便携包 `PocketRestoreCoreCLI.exe ...`。所有 stdout 均为 UTF-8。

`capabilities`：一行 JSON，返回 `schema_version`、`sdr_profiles`、`hdr_profiles`、`supported_output_modes`、编码器可用性。HDR 资源和真实素材验证标记均存在时才开放 HDR。

`inspect "绝对视频路径"`：一行 JSON，返回 `color_profile`、`camera_model`、`evidence`、`warnings`、`status`、`video`。容器的 Rec.709 标记不能证明 DJI 原片没有拍 Log。

`restore --request "任务JSON绝对路径"`：输出逐行 NDJSON。示例：

```json
{
  "schema_version": 1,
  "job_id": "job-001",
  "files": [{"path": "Y:\\home\\视频.mp4", "profile": "auto"}],
  "output_dir": "D:\\已还原视频",
  "output_mode": "hlg",
  "look": "standard",
  "encoder": "auto",
  "cancel_file": "D:\\任务缓存\\job-001.cancel"
}
```

- `profile`：`auto/dlog/dlog2/hlg/rec709`。未知模式不自动转换；用户可手动声明 Log 模式。
- `output_mode`：`sdr/hlg`。原 Rec.709 转 HDR 尚未开放。HLG 转 SDR 必须有明确的 BT.2020 HLG 标记。
- `encoder`：`auto/cpu`。
- 可选 `trim_start`、`trim_duration`，单位秒，仅用于短片试验。默认完整视频。
- 取消：创建 `cancel_file`；请等待 `job_cancelled/job_done` 再清理该标记。后端会结束自己的 FFmpeg 进程并清理未完成视频。
- 事件：`job_started/item_started/progress/item_done/item_error/encoder_fallback/job_cancelled/job_done/job_error`。`index` 从 0 开始。`progress.fraction` 为 0~1 或时长未知时 `null`。
- CLI 退出码：0 成功、1 有失败、130 取消。stderr 不用于机器接口。

## 工具路径与资源

便携包优先读取同目录 `tools/ffmpeg.exe`、`tools/ffprobe.exe`；否则查找 PATH。`POCKET_RESTORE_FFMPEG` 和 `POCKET_RESTORE_FFPROBE` 可指定现有工具的绝对路径。

不发送原片到外部服务器或模型。官方输入参考文件与 hash 在 `pocket_restore/data/hdr_reference_sources/manifest.json`，普通还原 LUT 来源见 `pocket_restore/assets/lut_sources.json`。

## 验证边界

导出完成前校验 HEVC、10-bit、正确色彩标记、时长、音轨数量及首秒解码。它不代表观看设备 HDR 播放已经验证，也不代表已与 Mimo 色调完全匹配。

2026-10-02：43 项单元测试通过。用户真实原片 D-Log 和 D-Log 2 的 SDR/HLG 4K60 短片导出通过；真实 HLG 转 SDR 4K60 短片通过；取消导出退出 130、清理未完成输出、原片大小及修改时间保持不变。HDR 配对 LUT 灰轴误差最大 0.488 个 10-bit 码值。浮点颜色处理在 CPU 上运行，4K60 批量导出可能明显慢于实时。
