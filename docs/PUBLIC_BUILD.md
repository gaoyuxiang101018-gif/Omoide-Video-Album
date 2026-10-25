# Windows 发布构建

此仓库是 Omoide v0.7.5 的中文衍生版，来源提交见 `UPSTREAM.json`。普通使用请下载 Releases 中完整便携包。运行不需要安装 Python。

## 从源码完整构建

需要 Windows x64、Python 3.12、Node.js 和 `uv`。

```powershell
uv sync --group dev
cd frontend
npm ci
npm run build
cd ..
uv run pyinstaller main.spec
```

`main.spec` 沿用上游的 CPU/DirectML 打包配置。按其参数准备依赖及外部工具；模型文件在用户首次识别时下载，不打入发行包。源码运行默认使用 HDBSCAN，当前桌面构建使用 Chinese Whispers，参数页会区分实际生效算法。

## 重建配套启动器

```powershell
python -m pip install pyinstaller
./desktop/build_launcher.ps1 -Destination ./portable
```

把主程序及其完整 `_internal` 放到 `portable/omoide-0.7.5-cpu/`，把还原组件放到 `portable/pocketfilm/restore/`。还原源码在 `restore-core/`，工具来源和许可见相应 notices。

## 对兼容基础包做增量重建

`scripts/patch_runtime.py` 可把修改后的 Python 模块重新编译进一个已有的、兼容 Python 3.12 的 PyInstaller 程序，保留基础包本机依赖与启动器。输出必须是新文件，不能覆盖运行中的程序。

```powershell
python scripts/patch_runtime.py --base path/to/base.exe --output portable/omoide-0.7.5-cpu/omoide-0.7.5-cpu.exe --modules app.frontal_policy app.persons app.tasks.face_matching
```

应包含所有更改及新增模块，不限于这个示例的三个模块。前端还须单独构建并替换 `_internal/dist`。每个正式资产附带校验值及构建清单，发布前在空白资料库验证。

## 隔离检查

在包含自检入口的改进版基础包中，可以运行 `--album-frontal-selftest`、`--album-review-selftest` 等检查。参数必须为一个新的、可写的绝对目录。`OMOIDE_TEST_FFMPEG` 指向 FFmpeg；只有明确设置 `OMOIDE_TEST_MODEL_ROOT` 才执行真实模型检查。检查生成合成素材，不读取真实资料库。

```powershell
./Omoide.exe --selftest C:/temporary/omoide-launcher-check
```

不要把测试目录、真实视频、数据库、模型权重、`storage.json` 或生成的配置提交到仓库。发布截图使用合成数据。
