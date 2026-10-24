#!/usr/bin/env node
// 给 HyperFrames 的视频抽帧补色彩矩阵转换。上游把视频抽成 JPEG 中间帧时只把 tv 范围换成 pc 范围、没换矩阵，
// BT.709 素材（手机、相机拍的基本都是）的 YUV 被原样写进按 BT.601 解码的 JPEG，出片里饱和色偏（品红 253,0,253 → 231,0,243）。
// 补法：抽 JPEG 时在滤镜链末尾加 scale=out_color_matrix=bt601:out_range=pc；输入矩阵由 ffmpeg 按素材标记取，没标记的素材结果不变。
// 另有 Media Foundation 编码器补丁（见文件后半，桌面端用 LGPL 版 ffmpeg 时才生效）。
// pack.yaml 的 postBuild、桌面端 npm postinstall 调用（重装依赖后自动再打），verify 用 --check。幂等：打过的地方跳过。
//   node tools/patch-hyperframes.mjs [node_modules 目录] [--check]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARK = "mv-patch:jpeg-bt601";
const argv = process.argv.slice(2);
const check = argv.includes("--check");
const nm = path.resolve(argv.find((a) => !a.startsWith("--")) ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules"));
const root = path.join(nm, "@hyperframes");
if (!fs.existsSync(root)) { console.error(`没有 ${root}：先装依赖`); process.exit(1); }

/** 抽帧函数里「滤镜链交给 ffmpeg」那一行；前面插一句，拿到的是这一份代码里抽帧格式变量的名字 */
const SITE = /\n([ \t]*)if \(vfFilters\.length > 0\)\s*args\.push\("-vf", vfFilters\.join\(","\)\);/g;
const FORMAT_VAR = /args\.push\("-q:v", (\w+) === "jpg"/;

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

let sites = 0, done = 0;
const pending = [];
for (const pkg of fs.readdirSync(root)) {
  const dist = path.join(root, pkg, "dist");
  if (!fs.existsSync(dist)) continue;
  for (const file of jsFiles(dist)) {
    let src = fs.readFileSync(file, "utf8");
    if (!src.includes("vfFilters")) continue;
    const found = [...src.matchAll(SITE)];
    if (!found.length) continue;
    const todo = [];
    for (const m of found) {
      sites++;
      if (src.slice(Math.max(0, m.index - 240), m.index).includes(MARK)) { done++; continue; }
      const v = FORMAT_VAR.exec(src.slice(m.index, m.index + 800))?.[1];
      if (!v) { console.error(`${path.relative(nm, file)}：抽帧代码的样子变了（找不到格式变量），HyperFrames 升级后要重看这个补丁`); process.exit(1); }
      todo.push({ at: m.index, line: `\n${m[1]}if (${v} === "jpg") vfFilters.push("scale=out_color_matrix=bt601:out_range=pc"); // ${MARK}` });
    }
    if (!todo.length) continue;
    pending.push(path.relative(nm, file));
    if (check) continue;
    for (const t of todo.reverse()) src = src.slice(0, t.at) + t.line + src.slice(t.at);
    fs.writeFileSync(file, src);
    done += todo.length;
  }
}

if (!sites) { console.error("HyperFrames 里找不到视频抽帧代码：版本变了，补丁要重看"); process.exit(1); }
if (check) {
  if (pending.length) { console.error(`HyperFrames JPEG 抽帧色彩矩阵补丁没打：${pending.join("、")}（运行 node tools/patch-hyperframes.mjs）`); process.exit(1); }
  console.log(`HyperFrames JPEG 抽帧色彩矩阵补丁已打（${sites} 处）`);
} else {
  console.log(`HyperFrames JPEG 抽帧色彩矩阵补丁：共 ${sites} 处，本次新打 ${pending.length ? pending.join("、") : "无"}`);
}

// ---------------------------------------------------------------- 第二个补丁：Media Foundation 编码器（docs/map-video/116 §7.3）
// 桌面端带的是 LGPL 版 ffmpeg（免费商用），没有 libx264。HyperFrames 有硬件编码器（NVENC / VideoToolbox / QSV / AMF）就用，
// 没有就退回 libx264——在 LGPL 版里会直接失败。补法：把 Windows 自带的 Media Foundation（h264_mf，Win10/11 都有）加成最后一个候选。
// 只在环境变量 HYPERFRAMES_ENCODER_MF=1 时才加（src/render/producer.ts 发现 ffmpeg 里没有 libx264 时设），服务器和开发机照旧用 libx264。
const MF_MARK = "mv-patch:h264-mf";
const MF_SITES = [
  // 候选表：最后加 mf（按环境变量）
  { done: '? ["mf"] : []', re: /(GPU_ENCODER_CANDIDATES = \[[^\]]*?"amf")(,?)(\s*\];)/, put: (m) => `${m[1]}, ...(process.env.HYPERFRAMES_ENCODER_MF === "1" ? ["mf"] : []) /* ${MF_MARK} */${m[3]}` },
  // 编码器名表
  { done: 'mf: "h264_mf"', re: /(H264_ENCODER_BY_GPU = \{[^}]*?amf: "h264_amf")(,?)(\s*\};)/, put: (m) => `${m[1]}, mf: "h264_mf" /* ${MF_MARK} */${m[3]}` },
  // getGpuEncoderName
  { done: 'case "mf": return codec', re: /(case "amf":\s*return codec === "h264" \? "h264_amf" : "hevc_amf";)/, put: (m) => `${m[1]}\n    case "mf": return codec === "h264" ? "h264_mf" : "hevc_mf"; // ${MF_MARK}` },
];
// 两个编码参数构造函数（流式 / 分块）里的 amf 分支后面加 mf：High 档、不限峰值的可变码率；码率按像素率算（和 VideoToolbox 同一套档位）。
// Media Foundation 不把色彩信息写进码流（播放器会按 BT.601 解，颜色偏）：用 h264_metadata 补上 BT.709 / 有限范围，解出来和 libx264 逐像素一致
const MF_CASE = /(case "amf":\s*if \(bitrate\)\s*args\.push\("-b:v", bitrate\);\s*else\s*args\.push\("-rc", "cqp", "-qp_i", String\(quality\), "-qp_p", String\(quality\)\);\s*break;)/g;
const MF_CASE_PUT = `case "mf": { const __mvF = typeof fps === "number" ? fps : fps && typeof fps === "object" && fps.num ? fps.num / (fps.den || 1) : Number(String(fps).split("/")[0]) / (Number(String(fps).split("/")[1]) || 1); const __mvBpp = quality <= 15 ? 0.24 : quality <= 18 ? 0.16 : 0.08; args.push("-profile:v", "100", "-rate_control", "u_vbr", "-b:v", bitrate || \`\${Math.max(1, Math.round((options.width * options.height * (__mvF || 30) * __mvBpp) / 1e6))}M\`, "-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0"); break; } // ${MF_MARK}`;

let mfTables = 0, mfCases = 0;
const mfPending = [];
for (const pkg of fs.readdirSync(root)) {
  const dist = path.join(root, pkg, "dist");
  if (!fs.existsSync(dist)) continue;
  for (const file of jsFiles(dist)) {
    let src = fs.readFileSync(file, "utf8");
    const hasTables = src.includes("GPU_ENCODER_CANDIDATES = [");
    const caseHits = [...src.matchAll(MF_CASE)];
    if (!hasTables && !caseHits.length) continue;
    let changed = false;
    if (hasTables) {
      mfTables++;
      for (const s of MF_SITES) {
        if (src.includes(s.done)) continue; // 打过了
        const m = s.re.exec(src);
        if (!m) { console.error(`${path.relative(nm, file)}：GPU 编码器表的样子变了，HyperFrames 升级后要重看 Media Foundation 补丁`); process.exit(1); }
        if (src.slice(m.index, m.index + m[0].length + 160).includes(MF_MARK)) continue;
        src = src.slice(0, m.index) + s.put(m) + src.slice(m.index + m[0].length);
        changed = true;
      }
    }
    for (const m of [...src.matchAll(MF_CASE)].reverse()) {
      mfCases++;
      const after = m.index + m[0].length;
      const next = /^\s*case "mf":[^\n]*/.exec(src.slice(after, after + 1200));
      if (next) {
        if (next[0].includes("h264_metadata")) continue;
        // 早先打的版本没补色彩信息：换成新的
        src = src.slice(0, after) + `\n        ${MF_CASE_PUT}` + src.slice(after + next[0].length);
        changed = true;
        continue;
      }
      src = src.slice(0, after) + `\n        ${MF_CASE_PUT}` + src.slice(after);
      changed = true;
    }
    if (!changed) continue;
    mfPending.push(path.relative(nm, file));
    if (!check) fs.writeFileSync(file, src);
  }
}
if (!mfTables || !mfCases) { console.error("HyperFrames 里找不到 GPU 编码器代码：版本变了，Media Foundation 补丁要重看"); process.exit(1); }
if (check) {
  if (mfPending.length) { console.error(`HyperFrames Media Foundation 编码器补丁没打：${mfPending.join("、")}（运行 node tools/patch-hyperframes.mjs）`); process.exit(1); }
  console.log(`HyperFrames Media Foundation 编码器补丁已打（${mfTables} 份编码器表、${mfCases} 处编码参数）`);
} else {
  console.log(`HyperFrames Media Foundation 编码器补丁：${mfTables} 份编码器表、${mfCases} 处编码参数，本次新打 ${mfPending.length ? mfPending.join("、") : "无"}`);
}
