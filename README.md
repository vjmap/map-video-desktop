# 唯杰地图动画桌面端 · 打包仓库

这个仓库只用来在 GitHub Actions 上打 Windows / macOS 安装包，**里面没有平台和地图动画的核心代码**：`dist/` 是桌面端外壳和本机出片执行器的打包结果（已压缩），
由主仓库的 `apps/desktop/scripts/export-release-repo.mjs` 生成后推到这里。改桌面端请改主仓库，再重新导出。

给用户看的下载与首次打开说明：[安装说明.md](安装说明.md)。

## 发版

1. 主仓库里改 `apps/desktop/package.json` 的版本号，跑 `node scripts/export-release-repo.mjs <本仓库目录>`；
2. 在本仓库提交、推送，再打标签：`git tag v1.0.1 && git push origin v1.0.1`；
3. Actions 跑完（约 15–30 分钟；第一次要编 macOS 版 ffmpeg，更久），Releases 里有一个版本草稿，检查后点发布；
4. 国内用户下 GitHub 慢：把安装包另放一份到官网，下载页链官网的。

版本里的 `*-latest*.yml` 是给以后的自动更新准备的（桌面端还没接自动更新）：到时把每个平台的安装包、`.blockmap` 和那份 yml
放到 `https://vjmap.com/agent/desktop/updates/<平台架构>/`，yml 去掉前缀（`win-x64-latest.yml` → `win-x64/latest.yml`）。macOS 自动更新要正式签名才行。

只想试打包、不建版本：Actions 页面选「打包桌面端」→ Run workflow，产物在那次运行的 Artifacts 里。

## 签名（可选，以后再买）

没配证书时出的是未签名包（用户第一次打开要放行一下，见安装说明）。有了证书在 Settings → Secrets and variables → Actions 里加，工作流自动用上：

| 名字 | 是什么 |
|---|---|
| `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD` | Windows 代码签名证书（.pfx 转 base64）和密码 |
| `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD` | Apple「Developer ID Application」证书（.p12 转 base64）和密码 |
| `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` | Apple 公证用的账号、App 专用密码、团队 ID |

## 里面有什么

| 路径 | 是什么 |
|---|---|
| `dist/` | 主进程、preload、本机出片执行器、本地页面（打包好的 JS） |
| `binaries.json` | 随包程序的版本和校验和：chrome-headless-shell、ffmpeg（LGPL 构建） |
| `scripts/stage-resources.mjs` | 准备随包资源：无头浏览器、ffmpeg、许可文件 |
| `scripts/build-ffmpeg-macos.sh` | 在 Mac 上从源码编 LGPL 版 ffmpeg（VideoToolbox + libvpx + libopus） |
| `scripts/patch-hyperframes.mjs` | 装依赖后给出片核打的两个补丁（视频抽帧色彩矩阵、Media Foundation 编码器） |
| `electron-builder.yml`、`build/` | 打包配置、图标、macOS 权限 |

## 许可

本仓库的代码版权归 vjmap 所有。随包的第三方软件（FFmpeg 为 LGPL，其余为 MIT / BSD / Apache 等）及许可见安装包里的「开源软件许可」。
