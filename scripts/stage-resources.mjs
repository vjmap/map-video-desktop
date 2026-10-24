// 准备随包资源（docs/map-video/116 §7.3、§9）：
//   staging/<os>-<arch>/bin   chrome-headless-shell、ffmpeg、ffprobe（LGPL 版），SHA256SUMS
//   staging/licenses          第三方许可：FFmpeg（LGPL 原文 + 对应源码在哪 + 构建配置）、chrome-headless-shell、THIRD_PARTY_NOTICES.txt
//   staging/seed              字体、vendor、运行时（执行器的种子缓存；在插件仓库里打包才有，CI 里没有也行——执行器按需从服务器取）
//   node scripts/stage-resources.mjs                     按本机平台架构
//   node scripts/stage-resources.mjs --target mac-arm64   给别的平台架构（在对应的机器上跑最稳）
// 版本和校验和在 binaries.json。来源：
//   · 无头浏览器：插件里装着同一版本就用（plugins/map-video/browsers），否则 @puppeteer/browsers 从 Chrome for Testing 下（PUPPETEER_DOWNLOAD_BASE_URL 可换镜像）
//   · ffmpeg：FFMPEG_DIR=<放着 ffmpeg、ffprobe 的目录> 优先；否则 Windows 下 binaries.json 里钉死的 LGPL 构建（核 sha256），macOS 用
//     scripts/build-ffmpeg-macos.sh 编好的 staging/ffmpeg-<target>/（没有就报错）
// 下载走 curl（Windows 10+ 和 macOS 自带），认 HTTPS_PROXY / HTTP_PROXY。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pins = JSON.parse(fs.readFileSync(path.join(root, "binaries.json"), "utf8"));
const plugin = path.resolve(root, "../../plugins/map-video"); // 在插件仓库里才有
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const osName = { win32: "win", darwin: "mac", linux: "linux" }[process.platform];
const target = opt("target", `${osName}-${process.arch}`);
const [tos] = target.split("-");
const exe = (n) => (tos === "win" ? `${n}.exe` : n);
const staging = path.join(root, "staging");
const outBin = path.join(staging, target, "bin");
const licenses = path.join(staging, "licenses");
const seed = path.join(staging, "seed");
const dl = path.join(staging, ".download");
fs.rmSync(outBin, { recursive: true, force: true });
fs.mkdirSync(outBin, { recursive: true });
fs.mkdirSync(dl, { recursive: true });
fs.rmSync(licenses, { recursive: true, force: true });
fs.mkdirSync(licenses, { recursive: true });

const die = (m) => { console.error(m); process.exit(1); };
const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const run = (cmd, args, o = {}) => { const r = spawnSync(cmd, args, { stdio: "inherit", ...o }); if (r.status !== 0) die(`${cmd} ${args.join(" ")} 失败（${r.status}）`); return r; };
const copyTree = (from, to) => fs.cpSync(from, to, { recursive: true, dereference: true, filter: (src) => !/\.log$/i.test(src) });
const newestDir = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];

/** 下到 .download/（已经有、校验和对得上就不再下） */
function fetchPinned(url, sha) {
  const file = path.join(dl, path.basename(new URL(url).pathname));
  if (fs.existsSync(file) && sha256(file) === sha) return file;
  run("curl", ["-fL", "--retry", "3", "--ssl-no-revoke", "-o", file, url].filter((a) => process.platform === "win32" || a !== "--ssl-no-revoke"));
  const got = sha256(file);
  if (got !== sha) { fs.rmSync(file, { force: true }); die(`${path.basename(file)} 校验和对不上：${got}（应为 ${sha}）`); }
  return file;
}

// ---- 无头浏览器
const version = pins.chromeHeadlessShell;
// @puppeteer/browsers 的平台名（也是缓存目录名的前缀：win64-155…、mac_arm-155…）
const cftPlatform = { "win-x64": "win64", "mac-arm64": "mac_arm", "mac-x64": "mac", "linux-x64": "linux" }[target];
if (!cftPlatform) die(`不支持的目标 ${target}（Chrome for Testing 没有这个平台的无头浏览器）`);
const shellOut = path.join(outBin, "chrome-headless-shell");
const localShell = path.join(plugin, "browsers", "chrome-headless-shell", `${cftPlatform}-${version}`);
if (fs.existsSync(localShell)) {
  copyTree(localShell, shellOut);
} else {
  const cli = path.join(root, "node_modules", "@puppeteer", "browsers", "lib", "main-cli.js");
  if (!fs.existsSync(cli)) die("缺少 @puppeteer/browsers：先 npm ci");
  const cache = path.join(dl, "chrome");
  run(process.execPath, [cli, "install", `chrome-headless-shell@${version}`, "--platform", cftPlatform, "--path", cache, ...(process.env.PUPPETEER_DOWNLOAD_BASE_URL ? ["--base-url", process.env.PUPPETEER_DOWNLOAD_BASE_URL] : [])]);
  const base = path.join(cache, "chrome-headless-shell");
  const dir = fs.readdirSync(base).find((n) => n.startsWith(`${cftPlatform}-${version}`)) ?? newestDir(base);
  copyTree(path.join(base, dir), shellOut);
}
const shellLicense = (() => { const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isFile() && /^LICENSE/.test(e.name)) return p; if (e.isDirectory()) { const r = walk(p); if (r) return r; } } return null; }; return walk(shellOut); })();
if (shellLicense) fs.copyFileSync(shellLicense, path.join(licenses, "chrome-headless-shell-LICENSE.txt"));

// ---- ffmpeg / ffprobe（LGPL）
let ffDir = process.env.FFMPEG_DIR || "";
let ffLicense = "";
let ffSource = "";
if (!ffDir && tos === "win") {
  const pin = pins.ffmpeg[target];
  if (!pin) die(`binaries.json 里没有 ${target} 的 ffmpeg`);
  const zip = fetchPinned(pin.url, pin.sha256);
  const x = path.join(dl, `ffmpeg-${target}`);
  fs.rmSync(x, { recursive: true, force: true });
  fs.mkdirSync(x, { recursive: true });
  // Windows 自带的 bsdtar 解得开 zip；PATH 里先碰到 Git 的 GNU tar 会把「D:」当成远程主机
  const sysTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  run(fs.existsSync(sysTar) ? sysTar : "tar", ["-xf", zip, "-C", x]);
  const top = path.join(x, newestDir(x));
  ffDir = path.join(top, "bin");
  ffLicense = path.join(top, "LICENSE.txt");
  ffSource = `Windows 版来自 ${pin.builder}\n下载地址：${pin.url}\nsha256：${pin.sha256}\n对应 FFmpeg 源码：${pin.source}`;
}
if (!ffDir && tos === "mac") {
  ffDir = path.join(staging, `ffmpeg-${target}`, "bin");
  if (!fs.existsSync(path.join(ffDir, "ffmpeg"))) die(`没有 ${ffDir}/ffmpeg：先跑 scripts/build-ffmpeg-macos.sh ${target}，或设 FFMPEG_DIR`);
  ffLicense = path.join(staging, `ffmpeg-${target}`, "LICENSE");
  const s = pins.ffmpeg["mac-sources"];
  ffSource = `macOS 版用 scripts/build-ffmpeg-macos.sh 从源码编译（不带 --enable-gpl / --enable-nonfree）：\n  FFmpeg ${s.ffmpeg.url}（sha256 ${s.ffmpeg.sha256}）\n  libvpx ${s.libvpx.url}（${s.libvpx.license}）\n  opus ${s.opus.url}（${s.opus.license}）\n  zimg ${s.zimg.url}（${s.zimg.license}）\n  dav1d ${s.dav1d.url}（${s.dav1d.license}）`;
}
if (!ffDir) die(`给 ${target} 准备 ffmpeg：设 FFMPEG_DIR=<放着 ${exe("ffmpeg")} 和 ${exe("ffprobe")} 的目录>`);
for (const n of ["ffmpeg", "ffprobe"]) {
  const f = path.join(ffDir, exe(n));
  if (!fs.existsSync(f)) die(`缺少 ${f}`);
  fs.copyFileSync(f, path.join(outBin, exe(n)));
  if (tos !== "win") fs.chmodSync(path.join(outBin, exe(n)), 0o755);
}
// shared 构建：ffmpeg / ffprobe 旁边的 DLL（avcodec、avformat…）一起带上
for (const n of fs.readdirSync(ffDir)) if (/.(dll|dylib)$/i.test(n)) fs.copyFileSync(path.join(ffDir, n), path.join(outBin, n));
// 只认 LGPL 构建：带 --enable-gpl / --enable-nonfree 的不能随包分发（本机能跑才查得了）
const canRun = tos === osName;
let buildconf = "";
if (canRun) {
  const r = spawnSync(path.join(outBin, exe("ffmpeg")), ["-hide_banner", "-buildconf"], { encoding: "utf8" });
  buildconf = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (/--enable-(gpl|nonfree)\b/.test(buildconf)) die("这个 ffmpeg 是 GPL / nonfree 构建，不能随桌面端分发：换 LGPL 构建（binaries.json）");
}
if (ffLicense && fs.existsSync(ffLicense)) fs.copyFileSync(ffLicense, path.join(licenses, "FFmpeg-LICENSE.txt"));
fs.writeFileSync(path.join(licenses, "FFmpeg-SOURCE.txt"), [
  `本软件附带的 ffmpeg / ffprobe（FFmpeg ${pins.ffmpeg.version}）按 ${pins.ffmpeg.license} 授权，以独立程序的形式随附，可以替换。`,
  "FFmpeg 是 FFmpeg 项目的商标。",
  "",
  ffSource || `来源：${ffDir}`,
  "",
  "需要源码的，也可以联系 vjmap（https://vjmap.com）索取。",
  ...(buildconf ? ["", "构建配置（ffmpeg -buildconf）：", buildconf.trim()] : []),
].join("\n") + "\n");

// ---- 种子
fs.rmSync(seed, { recursive: true, force: true });
const web = path.join(plugin, "web");
if (["fonts", "vendor", "runtime"].every((d) => fs.existsSync(path.join(web, d)))) {
  for (const d of ["fonts", "vendor", "runtime"]) copyTree(path.join(web, d), path.join(seed, d));
} else {
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, "README.txt"), "这个安装包没带种子文件：第一次出片时执行器按需从服务器取字体、vendor 和运行时。\n");
}

// ---- 许可汇总
fs.writeFileSync(path.join(licenses, "THIRD_PARTY_NOTICES.txt"), [
  "唯杰地图动画桌面端使用的第三方软件",
  "",
  `· FFmpeg ${pins.ffmpeg.version}（ffmpeg、ffprobe，独立程序）—— ${pins.ffmpeg.license}。许可原文见 FFmpeg-LICENSE.txt，源码在哪见 FFmpeg-SOURCE.txt。`,
  "  其中带的 libvpx、libopus、dav1d 等组件为 BSD 许可，zimg 为 WTFPL。",
  `· chrome-headless-shell ${version}（Chrome for Testing，独立程序）—— BSD 许可及 Chromium 所含组件的许可，见 chrome-headless-shell-LICENSE.txt。`,
  "· Electron —— MIT 许可；Chromium 组件的许可见安装目录里的 LICENSES.chromium.html。",
  "· HyperFrames（@hyperframes/*）、puppeteer-core 等 npm 包 —— 各自 package.json 里写明的开源许可（MIT / Apache-2.0）。",
  "",
].join("\n"));

// ---- 校验和
const sums = [];
const walk = (d, rel = "") => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(p, r); else if (e.isFile()) sums.push(`${sha256(p)}  ${r}`); } };
walk(outBin);
fs.writeFileSync(path.join(outBin, "SHA256SUMS"), sums.join("\n") + "\n");
const size = (d) => { let n = 0; const w = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); if (e.isDirectory()) w(p); else n += fs.statSync(p).size; } }; w(d); return n; };
console.log(`staging/${target}/bin：chrome-headless-shell ${version}、ffmpeg、ffprobe（LGPL），${(size(outBin) / 1e6).toFixed(0)} MB；staging/seed ${(size(seed) / 1e6).toFixed(0)} MB；staging/licenses ${fs.readdirSync(licenses).length} 个文件`);
