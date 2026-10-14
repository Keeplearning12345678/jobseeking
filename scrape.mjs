#!/usr/bin/env node
/**
 * 求职工作台 · 抓取脚本（第一阶段）
 *
 * 只读抓取 `求职/` 的 markdown 台账 → 结构化缓存 `cache.json`。
 *
 *   node scrape.mjs                 # 抓取 → cache.json（顺带打印覆盖率自检）
 *   node scrape.mjs --quiet         # 只写文件，不打印
 *
 * 范围：**只抓「已投递的公司.md」的已投公司**。
 *   · 权威名单 = `已投递的公司.md` 的 **§一、总览**（编号 / 投递日 / 岗位 / 城市）。
 *     其它来源（§二 行业线 / §四 逐家详情 / 面试.md §四 速查 / §五 口碑）都是对这批公司的
 *     **补充观察**，靠公司名匹配挂回来；**匹配不上的不新建公司**，进 `_meta.unmatched` 备查。
 *   · §三「已评估后放弃」单独放 `dropped`，**不计入总数**，界面默认不展示。
 *
 * 设计原则
 *   - **只读**：从不写 求职/ 下的任何文件。
 *   - **markdown 是唯一事实来源**：缓存只是它的一次快照，带 sha1 / 字节数 / 行数指纹。
 *   - **不猜**：抓不到的字段一律 null / 空；缺失与匹配不上的清单写进 `_meta`，
 *     绝不用"看起来合理"的值填充（AGENTS.md §二.8 第一条）。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "求职");
const QUIET = process.argv.includes("--quiet");
const SCRAPER_VERSION = 1;

// ───────────────────────── 读 + 小工具 ─────────────────────────

/** 台账是 CRLF；不归一化会让 `^##…$` 这类锚点静默失效（踩过） */
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n?/g, "\n");
const exists = (f) => fs.existsSync(path.join(ROOT, f));
const fp = (f) => {
  const p = path.join(ROOT, f);
  const buf = fs.readFileSync(p);
  return {
    file: f, bytes: buf.length, lines: buf.toString("utf8").split("\n").length,
    sha1: crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12),
    // 北京时间（不能直接用 toISOString —— 那是 UTC，界面上会差 8 小时，看着像文件被改过）
    mtime: fs.statSync(p).mtime.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
  };
};

const clean = (s) =>
  String(s ?? "").replace(/\*\*/g, "").replace(/~~/g, "").replace(/[`*]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();

/** 尾部括号配对扫描（支持嵌套）—— 不能用 /[（(][^）)]*[）)]$/（内部含括号时静默失败） */
function stripTrailingParens(s) {
  if (!/[）)]\s*$/.test(s)) return s;
  let depth = 0, start = -1;
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i];
    if (c === "）" || c === ")") depth++;
    else if (c === "（" || c === "(") { depth--; if (depth === 0) { start = i; break; } if (depth < 0) return s; }
  }
  return start < 0 ? s : s.slice(0, start).trimEnd();
}

/** 按深度剥掉所有括号说明（支持嵌套） */
function stripParens(s) {
  let out = "", depth = 0;
  for (const ch of String(s ?? "")) {
    if (ch === "（" || ch === "(") { depth++; continue; }
    if (ch === "）" || ch === ")") { if (depth > 0) depth--; continue; }
    if (depth === 0) out += ch;
  }
  return out;
}

const NOISE = /[★☆⭐⏸⏳🚩✅❌⚠️⏰🆕🔔♻️🔍📌｜|]/gu;
const SUFFIX = /(有限责任公司|股份有限公司|有限公司|集团|控股|股份|公司)$/g;

/** 严格归一化：去标记 / 去尾部括号 / 去企业后缀噪声 */
function norm(name) {
  let s = clean(String(name ?? "").replace(NOISE, " "));
  s = stripTrailingParens(s);
  s = s.replace(SUFFIX, "");
  return s.replace(/[·・\s\-—]/g, "");
}

/** 宽松归一化：连括号内容一起去掉，只留中日韩文字 / 字母 / 数字（用于包含与相似度匹配） */
function looseNorm(name) {
  let s = stripParens(clean(String(name ?? "").replace(NOISE, " ")));
  for (let i = 0; i < 3; i++) s = s.replace(SUFFIX, "");       // 「集团有限公司」要剥两轮
  return s.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
}

/** 中文 bigram 集合（相似度用） */
function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  if (!out.size && s) out.add(s);
  return out;
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 少数台账里"同一家两套叫法"、字面完全对不上的，只能显式登记别名。
 * 每条都注明依据（出处），并在 `_meta.matching.byAlias` 里报告命中情况 —— 别名表空了也不会静默出错。
 */
const ALIAS = {
  // 同一家公司在台账不同小节里用了对不上的叫法时，在这里显式登记（左全称 / 右简称，左右都可能）：
  //   "某某大学科技园有限公司": "某某科技园",
};

/** 取某个 `## ` 小节（含标题行）到下一个 `## ` 之前 */
function sliceSection(text, heading) {
  const A = text.split("\n");
  const i = A.findIndex((l) => l.startsWith(heading));
  if (i < 0) return "";
  let j = A.length;
  for (let k = i + 1; k < A.length; k++) if (/^## /.test(A[k])) { j = k; break; }
  return A.slice(i, j).join("\n");
}

/**
 * 取任意级 `#{2,6} ` 小节，按正则命中标题。
 * ⚠️ 必须在**同级或更高级**的标题处停 —— 只在「任意 `#{2,4}` 标题」处停会把
 *    `### 5.1 逐公司笔记清单` 的正文（全是 `#### 公司（N 条）`）整段吃掉、返回空 body
 *    （2026-10-07 踩过：口碑一家都没解析出来）。
 */
function grabSection(text, re) {
  const A = text.split("\n");
  const i = A.findIndex((l) => /^#{2,6}\s/.test(l) && re.test(l));
  if (i < 0) return null;
  const lvl = (A[i].match(/^#+/) ?? ["##"])[0].length;
  let j = A.length;
  for (let k = i + 1; k < A.length; k++) {
    const m = A[k].match(/^#+/);
    if (m && m[0].length <= lvl) { j = k; break; }
  }
  return { title: clean(A[i]), body: A.slice(i + 1, j).join("\n") };
}

const coalesce = (s) => clean(s);

/** markdown 表格 → {head, rows}（只取第一张表） */
function firstTable(text) {
  const A = text.split("\n");
  let head = null;
  const rows = [];
  for (const raw of A) {
    const t = raw.trim();
    if (!t.startsWith("|")) { if (head) break; else continue; }
    if (/^\|[\s:|-]+\|$/.test(t)) continue;
    const cells = t.replace(/^\||\|$/g, "").split("|").map(coalesce);
    if (!head) { head = cells; continue; }
    if (cells.length !== head.length) continue;
    rows.push(cells);
  }
  return head ? { head, rows } : null;
}

/** 逐行抽表格行（可跨多张表） */
function tableRows(text, { minCols = 3, filter } = {}) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    if (/^\|[\s:|-]+\|$/.test(t)) continue;
    const cells = t.replace(/^\||\|$/g, "").split("|").map(coalesce);
    if (cells.length < minCols) continue;
    if (filter && !filter(cells, t)) continue;
    out.push({ cells, raw: t });
  }
  return out;
}

/** 题目正文清洗：保留换行、表格转成内联行（别用 clean，会把换行压掉） */
function cleanBody(md, max = 2400) {
  const out = [];
  for (const raw of md.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (/^\|[\s:|-]+\|$/.test(l)) continue;
    if (/^```/.test(l)) continue;
    if (/^#{1,6}\s/.test(l)) { out.push(l.replace(/^#{1,6}\s*/, "▸ ").replace(/\*\*/g, "")); continue; }
    if (l.startsWith("|")) {
      const cells = l.replace(/^\||\|$/g, "").split("|").map(coalesce).filter(Boolean);
      if (cells.length) out.push(cells.join(" ｜ "));
      continue;
    }
    out.push(l.replace(/^[-*]\s+/, "· ").replace(/\*\*/g, ""));
  }
  return out.join("\n").slice(0, max);
}

// ───────────────────────── 阶段口径 ─────────────────────────

/** ⚠️ 标签归一化：**只留 Unicode 的「字」与数字**（去掉 emoji、空格、全角空格、「·」等）。
 *  —— 必须用这一套拿去做两侧的 key（define + 查表），
 *  因为原来的「去 emoji 字符集」漏了 🔵（U+1F535 不在 1F7E0–1FAFF 区间里）→
 *  台账写「🔵 AI面试」时标签会带着 emoji 去匹配、匹配不上，**静默落到「筛选中」**
 *  （踩到：台账写「🔵 AI面试」时标签会带着 emoji 去匹配，匹配不上、静默落到「筛选中」）。 */
const normLabel = (s) => String(s ?? "").replace(/[^\p{Letter}\p{Number}]/gu, "");

/** §四 详情的「阶段」字段口径（出厂 9 档 · **2026-10-08 用户重排** · 与 已投递的公司.md §〇.7 一致）
 *  改动：去掉「⏳ 排期待发 / ⚪ 未受理 / ❔ 未知」三档；「🔵 面试」→ **AI面试**，并依次新增 HR面试 / 技术面试 / 综合面试；「🟥 已拒」→ **人才库**。
 *  ⚠️ 面试 4 轮**共用 🔵 emoji** → 认阶段必须按「文字标签」，只按 emoji 会把 4 轮全落到第一档（见 STAGE_BY_LABEL）。
 *
 *  ═══ 每一档就是一条**定义**（2026-10-13 起，为了「自定义档位」）═══
 *   · key    稳定标识。**台账里永远不写 key**，写的是词 —— 所以改名字不会把哪一家弄丢
 *   · label / emoji / color / rank   显示用（rank 只在报表里当次序号，界面顺序看数组顺序）
 *   · match  台账里写成**哪些词**算这一档（比对前先 normLabel 归一：emoji / 空格 / 「·」全不算）
 *   · trait  性质：start | normal | interview | offer | reject
 *            它的作用 = 「今天做什么 / 统计 / 行业线分布条」不必再认死 key（自定义档也有合理待遇）
 *  这张表会跟着 data.json 一起进浏览器（`DATA.stages`），所以 🎨 面板能**在浏览器里重映射**
 *  —— 改词表 / 加档 / 停用档都不用重跑抓取。 */
const STAGES = {
  screening:      { emoji: "🟡", label: "筛选中",   rank: 0, color: "screen",   trait: "start",     match: ["筛选中"] },
  assessment:     { emoji: "🟣", label: "已测评 · 等面试", rank: 1, color: "assess", trait: "normal", match: ["已测评 · 等面试"] },
  written:        { emoji: "🟠", label: "笔试",     rank: 2, color: "written",  trait: "normal",    match: ["笔试"] },
  aiInterview:    { emoji: "🔵", label: "AI面试",   rank: 3, color: "ivi",      trait: "interview", match: ["AI面试"] },
  hrInterview:    { emoji: "🔵", label: "HR面试",   rank: 4, color: "ivh",      trait: "interview", match: ["HR面试"] },
  techInterview:  { emoji: "🔵", label: "技术面试", rank: 5, color: "ivt",      trait: "interview", match: ["技术面试"] },
  finalInterview: { emoji: "🔵", label: "综合面试", rank: 6, color: "ivf",      trait: "interview", match: ["综合面试"] },
  offer:          { emoji: "🟩", label: "offer",    rank: 7, color: "offer",    trait: "offer",     match: ["offer"] },
  talentPool:     { emoji: "🟥", label: "人才库",   rank: 8, color: "rejected", trait: "reject",    match: ["人才库"] },
};
/** 旧口径（2026-10-08 前的 9 档）也要能认：排期待发 / 未受理 / 未知 三档已取消 → 一律归「筛选中」；
 *  「测评」现在同一档只是标签变长；「面试」→ AI面试；「已拒」→ 人才库。
 *  ⚠️ 这些词**合并进上面那张表的 match**（不再单独一张表）—— 否则「认哪些词」就有两处口径。 */
const STAGE_LEGACY = [
  ["排期待发", "screening"], ["未受理", "screening"], ["未知", "screening"],
  ["测评", "assessment"], ["面试", "aiInterview"], ["已拒", "talentPool"],
];
for (const [w, k] of STAGE_LEGACY) if (!STAGES[k].match.some((m) => normLabel(m) === normLabel(w))) STAGES[k].match.push(w);
/** 归一词 → key（词表驱动；同一个词被两档认领时**先注册的赢**，也就是顺序在前的那一档） */
const STAGE_BY_LABEL = {};
for (const [k, v] of Object.entries(STAGES)) for (const w of v.match) { const n = normLabel(w); if (n && STAGE_BY_LABEL[n] === undefined) STAGE_BY_LABEL[n] = k; }
const STAGE_BY_EMOJI = {};          // 同 emoji 只记第一个（🔵 → AI面试），只在标签认不出时兼底
for (const [k, v] of Object.entries(STAGES)) if (!STAGE_BY_EMOJI[v.emoji]) STAGE_BY_EMOJI[v.emoji] = k;
const unparsedStages = [];          // 阶段文案没认出来的块（不会静默：末尾写进 gaps 与覆盖率）

// ───────────────────────── ① 已投递的公司.md ─────────────────────────

const sources = [];
const gaps = [];
const canon = [];                 // 全部已投公司（= §一 总览，权威名单）
const canonByKey = new Map();     // 严格 norm → record
const byLoose = new Map();        // 宽松 norm → record
const unmatched = [];             // 匹配不上的补充观察（不建新公司）
const matchLog = { exact: 0, loose: 0, contain: 0, similar: 0, alias: 0, none: 0 };
let inherited = 0;              // 集团汇总节兜底阶段的公司数
let filled = 0;                // 缺口回填（速查表）的公司数
let ledger = null;
let statsTables = [];
let statsNotes = [];
const dropped = [];               // §三 已评估后放弃（不计入总数）

/* ── 投递日统一成 YYYY-MM-DD（2026-10-08 第二十六轮修）──────────────────────
   台账里日期有两种写法：§四 逐家详情写全日期（2026-09-07），§一 总览常只写 MM-DD（10-05），
   #36 写的是「（日期待补）」。#一 那条路径以前只取 MM-DD 原样存进 applyDate
   → 同一个字段里两种格式混着（有的人全写全日期、有的人习惯只写 MM-DD），后果：
     ①「按投递日排序」按字符串比 → 10 月的行被排到 9 月前面；
     ② 表格里同一列有的带年有的不带；③ 没法按日期铺热力图。
   现在一律补齐年份：MM-DD 取「离今天最近」的那个年份（今天 10-08 时 09-01 → 今年，
   12-25 → 去年）；年份是推断出来的就在条目上记 applyDateInferred，页面如实标。 */
const TODAY_REF = new Date();
function isFullDate(s){ return /\d{4}-\d{2}-\d{2}/.test(String(s || "")); }
function normDate(s){
  if (!s) return null;
  const m4 = /(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (m4) return `${m4[1]}-${m4[2]}-${m4[3]}`;
  const m2 = /(\d{2})-(\d{2})/.exec(String(s));
  if (!m2) return null;
  const mm = +m2[1], dd = +m2[2];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const y = TODAY_REF.getFullYear();
  const cand = [y - 1, y].map((yy) => new Date(yy, mm - 1, dd));
  const pick = cand.sort((a, b) => Math.abs(a - TODAY_REF) - Math.abs(b - TODAY_REF))[0];
  const p = (n) => String(n).padStart(2, "0");
  return `${pick.getFullYear()}-${p(pick.getMonth() + 1)}-${p(pick.getDate())}`;
}

function makeRecord(name, no, patch) {
  const rec = {
    key: norm(name), no, name: clean(name), nameRaw: patch.nameRaw ?? "",
    applyDate: null, city: "", roles: "", fit: 0, fitRaw: "",
    dispatch: "sent",             // sent | scheduled
    stage: null, stageEmoji: null, stageLabel: null, stageEvidence: "", stageHard: false,
    line: null, lineName: "",
    channel: "", note: "", detailHead: "", speedref: null,
    reputation: null, themes: [], matchedBy: [], sources: [],
    ...patch,
  };
  if (rec.applyDate) {
    if (!isFullDate(rec.applyDate)) rec.applyDateInferred = true;
    rec.applyDate = normDate(rec.applyDate);
  }
  return rec;
}

/** 把一条「补充观察」挂到已投名单里的某一家；匹配不上则进 unmatched（不新建公司） */
function observe(nameStr, patch = {}, src = "") {
  const strict = norm(nameStr);
  let target = null, how = "";

  // ① 显式别名
  const aliasedKey = ALIAS[clean(nameStr)] ?? ALIAS[stripParens(clean(nameStr))];
  if (aliasedKey && canonByKey.has(norm(aliasedKey))) { target = canonByKey.get(norm(aliasedKey)); how = "alias"; }

  // ② 严格 norm 相等
  if (!target && canonByKey.has(strict)) { target = canonByKey.get(strict); how = "exact"; }

  // ③ 宽松 norm 相等 / 包含
  const loose = looseNorm(nameStr);
  if (!target && loose) {
    if (byLoose.has(loose)) { target = byLoose.get(loose); how = "loose"; }
    if (!target) {
      for (const rec of canon) {
        const rl = looseNorm(rec.name) || looseNorm(rec.nameRaw);
        // 阈值降到 2：「天加(TICA)→天加」「芬尼 PHNIX→芬尼」这类 2 字名会因 `>= 3` 静默漏掉（踩过）
        if (!rl || rl.length < 2) continue;
        if (rl.includes(loose) || loose.includes(rl)) {
          target = rec; how = "contain"; break;
        }
      }
      // ④ 双向包含（严格 norm）兜底
      if (!target) {
        for (const rec of canon) {
          if (!rec.key || rec.key.length < 3) continue;
          if (rec.key.includes(strict) || strict.includes(rec.key)) { target = rec; how = "contain"; break; }
        }
      }
    }
    // ⑤ bigram 相似度 ≥ 0.55
    if (!target && loose.length >= 4) {
      const nb = bigrams(loose);
      let best = null, bestScore = 0;
      for (const rec of canon) {
        const rb = bigrams(looseNorm(rec.name) || looseNorm(rec.nameRaw));
        const s = jaccard(nb, rb);
        if (s > bestScore) { bestScore = s; best = rec; }
      }
      if (best && bestScore >= 0.55) { target = best; how = "similar"; }
    }
  }

  if (!target) {
    matchLog.none++;
    unmatched.push({ source: src, name: clean(stripParens(nameStr)).slice(0, 60) });
    return null;
  }
  matchLog[how]++;
  target.matchedBy.push(how);
  if (src && !target.sources.includes(src)) target.sources.push(src);
  // 阶段只升不降
  if (patch.stage && target.stage && STAGES[patch.stage] && STAGES[target.stage]
      && STAGES[patch.stage].rank <= STAGES[target.stage].rank) delete patch.stage;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === "") continue;
    // 投递日一律补成 YYYY-MM-DD；年份是推断的就在条目上留标记（后来补上全日期就撤掉标记）
    if (k === "applyDate") {
      const nd = normDate(v);                        // 认不出是日期就什么都不动（不写 null、不来回设标记）
      if (nd) {
        if (isFullDate(v)) delete target.applyDateInferred;
        else target.applyDateInferred = true;
        target.applyDate = nd;
      }
      continue;
    }
    target[k] = v;
  }
  return target;
}

if (exists("已投递的公司.md")) {
  const F = "已投递的公司.md";
  sources.push({ ...fp(F), role: "已投公司主台账（§〇 统计 / §一 总览 / §二 行业线 / §三 已放弃 / §四 逐家详情）" });
  const t = read(F);

  // ── 抬头声明（对账用） ──
  const declaredTotal = t.match(/已投递合计\s*\**\s*(\d+)\s*\**\s*家/);
  const sentN = t.match(/已发出\s*\**\s*(\d+)\s*\**\s*家/);
  const schedN = t.match(/已排期待发\s*\**\s*(\d+)\s*\**\s*家/);
  const jobsN = t.match(/约\s*\**\s*(\d+)\s*\**\s*个/);
  // 排期序号：抬头写法是「已排期待发 N 家**（第 1 / 2 / 4 家：…）」——
  // ⚠️ 只在**同一个 bracket 里**找序号：抬头那一行很长，bracket 后面还写着别的
  //    「第 N 家…」，原来用 `[\s\S]{0,240}?第(…?)家` 整行扫，
  //    会把后面那些也当成排期件（误标 scheduled）。
  // ⚠️ 序号里夹着 markdown 粗体 `**`，所以**不能用 `[\d\s/、]+` 这类字符集去接**，
  //    否则 133 那个 `**` 会让整个匹配失败、静默退回空集（2026-10-07 踩过：#126 变成「已发出」）。
  const schedParen = t.match(/已排期待发\s*\**\s*\d+\s*\**\s*家\s*\**（([^）]{0,160})）/);
  const schedBody = (schedParen?.[1] ?? "").match(/第\s*([\d\s/、*]+?)\s*家/)?.[1] ?? "";
  const scheduledNos = new Set(schedBody.match(/\d+/g)?.map(Number).filter((n) => n >= 1 && n <= 999) ?? []);
  ledger = {
    appliedTotal: declaredTotal ? +declaredTotal[1] : null,
    sent: sentN ? +sentN[1] : null,
    scheduled: schedN ? +schedN[1] : null,
    scheduledNos: [...scheduledNos].sort((a, b) => a - b),
    jobsText: jobsN ? `约 ${jobsN[1]} 个` : null,
    headline: clean((t.split("\n").find((l) => /已投递合计/.test(l)) ?? "").slice(0, 400)),
  };
  if (!declaredTotal) gaps.push("已投递的公司.md 抬头未找到「已投递合计 N 家」→ 无法对账");
  // 排期那一档：抬头没写 / 写 0 / 写了但序号个数不符 —— 三种情况分开报（写 0 不算缺口）
  const schedDeclared = schedN ? +schedN[1] : null;
  if (schedDeclared === null) gaps.push("抬头未写「已排期待发 N 家」→ 排期件只能靠行内文字判断");
  else if (schedDeclared !== scheduledNos.size) gaps.push(`「已排期待发 ${schedDeclared} 家」与抬头里解析出的序号个数 ${scheduledNos.size} 不符`);

  // ── §一 总览（权威名单） ──
  // ⚠️ 日期列不能当筛选条件：台账里有两行不是标准 `MM-DD` ——
  //    某行写「（日期待补）」、某行写「**09-28（首投）/ 10-02（补 2 志愿）**」。
  //    按 `^\d{2}-\d{2}$` 过滤会**静默少 2 家**（2026-10-07 踩过：136 → 134），所以只认首列数字。
  const s1 = sliceSection(t, "## 一、总览");
  for (const { cells } of tableRows(s1, { minCols: 5, filter: (c) => /^\d+$/.test(c[0]) && !!c[2] })) {
    const [no, dateCell, nameCell, roles, city] = cells;
    const nm = nameCell.match(/^\*\*(.+?)\*\*(.*)$/);
    const shortName = nm ? clean(nm[1]) : clean(stripParens(nameCell));
    const rec = makeRecord(shortName, +no, {
      applyDate: dateCell.match(/(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})/)?.[1] ?? null,
      applyDateRaw: clean(dateCell),
      roles, city,
      nameRaw: clean(nameCell),
      dispatch: scheduledNos.has(+no) ? "scheduled" : "sent",
      sources: ["已投递的公司.md#一、总览"],
    });
    canon.push(rec);
    canonByKey.set(rec.key, rec);
    const lk = looseNorm(shortName) || looseNorm(rec.nameRaw);
    if (lk && !byLoose.has(lk)) byLoose.set(lk, rec);
  }

  // ── §〇 统计总览：7 张表 + 说明块，整段照抄给界面渲染 ──
  const s0 = sliceSection(t, "## 〇、");
  if (s0) {
    const A = s0.split("\n");
    for (let i = 0; i < A.length; i++) {
      const m = A[i].match(/^###\s+〇\.(\d)\s*(.+)$/);
      if (!m) continue;
      let j = i + 1;
      while (j < A.length && !/^#{2,3}\s/.test(A[j])) j++;
      const body = A.slice(i + 1, j).join("\n");
      const tb = firstTable(body);
      statsTables.push({ id: "s0." + m[1], title: clean(m[2]), head: tb?.head ?? [], rows: tb?.rows ?? [] });
      for (const n of body.split("\n").filter((l) => /^>\s?/.test(l)).map((l) => clean(l.slice(l.indexOf(">") + 1)))) {
        if (n) statsNotes.push({ id: "s0." + m[1], text: n });
      }
    }
    if (!statsTables.length) gaps.push("§〇 统计总览里没抓到任何 ### 〇.N 表");
  }

  // ── §二 按行业线分组：**A. 分组名（N 家）** + `- 公司 ｜ 岗位 ｜ 城市` ──
  const s2 = sliceSection(t, "## 二、按行业线分组");
  let curLine = null, lineHits = 0;
  for (const line of s2.split("\n")) {
    const h = line.match(/^\*\*([A-G])\.\s*(.+?)（\s*\d+\s*家\s*）\*\*\s*$/);
    if (h) { curLine = { letter: h[1], name: clean(h[2]) }; continue; }
    if (!curLine) continue;
    const b = line.match(/^-\s+(.*)$/);
    if (!b) continue;
    const seg = b[1].split(/[｜|]/);
    if (seg.length < 2) continue;
    const nm = seg[0].match(/^\*\*(.+?)\*\*/);
    const name = nm ? clean(nm[1]) : clean(stripParens(seg[0]));
    if (!name || /^\d+$/.test(name)) continue;
    if (observe(name, { line: curLine.letter, lineName: curLine.name }, "已投递的公司.md#二、行业线分组")) lineHits++;
  }
  if (!lineHits) gaps.push("§二 行业线分组一条都没匹配上 → 行业线维度为空");

  // ── §三 已评估后放弃（不计入总数） ──
  const s3 = sliceSection(t, "## 三、已评估后放弃");
  let bucket = "";
  for (const line of s3.split("\n")) {
    const h = line.match(/^\*\*([A-D])\.\s*(.+?)（\s*\d+\s*家\s*）\*\*\s*$/);
    if (h) { bucket = clean(`${h[1]}. ${h[2]}`); continue; }
    const m = line.match(/^-\s+\*\*(.+?)\*\*\s*(?:[（(][^）)]*[）)])?\s*[｜|]\s*(.+)$/);
    if (!m) continue;
    const name = clean(m[1]);
    const rest = clean(m[2]);
    const reason = rest.match(/原因[：:]\s*([^；;❌]+)/)?.[1]?.trim() ?? rest.slice(0, 160);
    dropped.push({ name, key: norm(name), bucket, roles: rest.split(/原因/)[0].replace(/[｜|]\s*$/, "").trim(), reason });
  }
    // 家数只跟「§三 标题里自己写的（N 家）」对账，不写死——家里几家公司本来就会变
  const s3head = t.split("\n").find((l) => l.startsWith("## 三、")) ?? "";
  const droppedDeclared = Number((s3head.match(/（\s*(\d+)\s*家/) ?? [])[1] ?? 0);
  if (droppedDeclared && dropped.length !== droppedDeclared) gaps.push(`§三 已评估后放弃抓到 ${dropped.length} 家（标题写 ${droppedDeclared} 家）→ 需要人工看一眼`);

  // ── §四 逐家详情 ──
  const s4 = sliceSection(t, "## 四、逐家详情");
  const blocks = s4.split(/\n(?=###\s)/).filter((b) => /^###\s/.test(b));
  const platformSections = [];      // 集团级汇总节（一节写多家那种）→ 给其下属单位兜底阶段
  for (const b of blocks) {
    const head = clean(b.split("\n")[0].replace(/^###\s*/, ""));
    if (/^(核对结论|未在飞书|从飞书)/.test(head)) continue;
    const namePart = head.split(/[｜|]/)[0].trim();
    const dir = head.split(/[｜|]/).slice(1).join(" ｜ ").trim();
    const isPlatform = /届校招|hotjob\.cn|iguopin|共投|新增\s*\d+\s*家/.test(head);

    const stRaw = b.match(/\*\*阶段\*\*[：:]\s*([^\n]+)/)?.[1] ?? "";
    const EMOJI_ONLY = /[\u{1F7E0}-\u{1FAFF}\u{1F535}\u{26AA}\u{2B1B}\u{2753}\u{23F3}]/u;
    const emoji = (stRaw.match(EMOJI_ONLY) ?? [""])[0];
    // 「｜ 证据：」前那段里的文字（用 normLabel 归一，emoji/空格/「·」一律不算）
    const labelRaw = normLabel(stRaw.split(/｜|\|/)[0]);
    const stageFound = STAGE_BY_LABEL[labelRaw] ?? STAGE_BY_EMOJI[emoji] ?? null;
    const stage = stageFound ?? "screening";       // 认不出不静默：下面进 unparsedStages
    if (!stageFound) unparsedStages.push({ head: head.slice(0, 40), raw: labelRaw });
    const stageLabel = STAGES[stage]?.label ?? "";
    const stageEvidence = clean(stRaw.replace(/^.*?证据[：:]/, ""));
    const stageHard = /硬证据|平台状态|回执|已完成/.test(stageEvidence) && !/推定/.test(stageEvidence);

    const date = b.match(/\*\*投递日\*\*[：:]\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{2}-[0-9]{2})/)?.[1];
    const city = b.match(/\*\*城市\*\*[：:]\s*([^｜|\n]+)/)?.[1];
    const fitRaw = b.match(/\*\*对口度\*\*[：:]\s*([★☆]+)/)?.[1] ?? "";
    const channel = b.match(/\*\*渠道\*\*[：:]\s*([^\n]+)/)?.[1];

    // 区块正文全文（
    //   不能只抓 `**备注**` —— 实测 124 块里只有 64 块写了「备注」，其余用的是
    //   「岗位 JD 要点 / 投递明细 / 名称说明」等标题。全文才是最有用也最不容易漏的。
    const detail = cleanBody(b.replace(/^###[^\n]*\n?/, ""), 3200);

    if (isPlatform) platformSections.push({ head, stage, stageRaw: labelRaw || null, body: clean(b) });

    observe(namePart, {
      stage, stageEmoji: emoji || null, stageLabel, stageRaw: labelRaw || null, stageEvidence, stageHard,
      applyDate: date, city: city ? clean(city) : undefined,
      fit: (fitRaw.match(/★/g) ?? []).length, fitRaw: fitRaw || undefined,
      channel: channel ? clean(channel) : undefined,
      detail,
      roles: dir || undefined,
      detailHead: head,
      platformSection: isPlatform || undefined,
    }, "已投递的公司.md#四、逐家详情");
  }

  // ── // 集团级汇总节兜底阶段：那几家没有单列详情、只有汇总节
  //    → 继承汇总节的阶段，但**明确标 `stageInherited`**（不是逐家核实的结果）
  let inheritedLocal = 0;
  for (const rec of canon) {
    if (rec.stage) continue;
    for (const ps of platformSections) {
      const byName = ps.body.includes(rec.name) || (rec.nameRaw && ps.body.includes(clean(rec.nameRaw)));
      // 最强的一条：汇总节正文里写「第 N 家」（汇总节正文里逐条写着「岗位 ｜ 部门 ｜ 城市 ｜ **第 N 家**」）
      const byNo = rec.no && new RegExp(`第\\s*${rec.no}\\s*家`).test(ps.body);
      if (byName || byNo) {
        rec.stage = ps.stage;
        rec.stageEmoji = STAGES[ps.stage]?.emoji ?? null;
        rec.stageLabel = STAGES[ps.stage]?.label ?? "";
        rec.stageRaw = ps.stageRaw ?? null;          // 汇总节那行写的词也带上（🎨 里重映射要用）
        rec.stageInherited = true;
        rec.stageEvidence = `集团级汇总节继承（${ps.head.slice(0, 40)}）· 非逐家核实`;
        rec.sources.push("已投递的公司.md#四、逐家详情（集团汇总节）");
        inherited++;
        inheritedLocal++;
        break;
      }
    }
  }
  if (!blocks.length) gaps.push("§四 逐家详情一个块都没匹配上");
  if (unparsedStages.length) gaps.push(`§四 有 ${unparsedStages.length} 个块的「阶段」文案没认出来（已按「🟡 筛选中」计）：` + unparsedStages.map((u) => `${u.head}[${u.raw}]`).join(" / "));
    // 与抬头声明的家数对账（抬头没写就不报，交给 build.mjs 的 reconcile 处理）
  if (declaredTotal && canon.length !== +declaredTotal[1]) gaps.push(`§一 总览抓到 ${canon.length} 家（台账抬头写 ${declaredTotal[1]} 家）→ 必须看一眼`);
}

// ───────────────────────── ② 面试.md ─────────────────────────

const generalQuestions = [];
const themes = [];
const interviewCards = [];

if (exists("面试.md")) {
  const F = "面试.md";
  sources.push({ ...fp(F), role: "面试题源（§一 通用题 / §四 逐家速查 / §五 口碑）" });
  const t = read(F);

  // ── §一 通用问答与追问预案 ──
  const s1 = sliceSection(t, "## 一、通用问答与追问预案");
  if (s1) {
    const A = s1.split("\n");
    const push = (id, title, body, star) => {
      const bd = cleanBody(body, 2200);
      if (bd) generalQuestions.push({ id, title: clean(title), star, body: bd });
    };
    const until = (i, stopRe) => { let j = i + 1; while (j < A.length && !stopRe.test(A[j])) j++; return A.slice(i + 1, j).join("\n"); };
    A.forEach((l, i) => {
      const m = l.match(/^####\s*问题([一二三])[：:]\s*(.+)$/);
      if (!m) return;
      push("Q" + ({ 一: 1, 二: 2, 三: 3 })[m[1]], m[2], until(i, /^####\s|^###\s/), 3);
    });
    const sub = (re) => {
      const s = A.findIndex((l) => re.test(l));
      if (s < 0) return "";
      let e2 = A.length;
      for (let k = s + 1; k < A.length; k++) if (/^###\s/.test(A[k])) { e2 = k; break; }
      return A.slice(s, e2).join("\n");
    };
    const parseAsk = (text, prefix, star) => {
      const B = text.split("\n");
      let n = 0;
      B.forEach((l, i) => {
        const m = l.match(/^\*\*Q\d+「(.+?)」\*\*\s*$/);
        if (!m) return;
        n++;
        let j = i + 1;
        while (j < B.length && !/^\*\*Q\d+「/.test(B[j])) j++;
        push(prefix + n, m[1], B.slice(i + 1, j).join("\n"), star);
      });
    };
    parseAsk(sub(/^###\s*1\.2\s/), "硕", 2);
    parseAsk(sub(/^###\s*1\.3\s/), "本", 2);
    const iOral = A.findIndex((l) => /^####\s*口述版/.test(l));
    // 标题直接取那一行（不要写死公司名与时长——每个人写的不一样）
    if (iOral >= 0) push("讲1", A[iOral].replace(/^####\s*/, ""), until(iOral, /^####\s|^###\s|^##\s/), 1);
  }
  // 不写死题数：抓不到任何题才报（标题结构可能变了）
  if (!generalQuestions.length) gaps.push("面试.md §一 一道题都没抓到 → 标题结构可能变了（要 `#### 问题一：…` 与 `### 1.2 / 1.3`＋`**Q1「…」**`）");

  // ── §四 逐家速查（AUTO 表）：| # | 公司 | 岗位 | 投递日 | 城市 | 对口度 | 状态 | ──
  const s4 = sliceSection(t, "## 四、逐家速查");
  let speedHit = 0;
  for (const { cells } of tableRows(s4, { minCols: 7, filter: (c) => /^\d+$/.test(c[0]) && !!c[1] })) {
    const [no, name, roles, date, city, fitRaw, status] = cells;
    const rec = observe(name, {
      speedref: { no: +no, roles, date, city, fitRaw, status },
    }, "面试.md#四、逐家速查");
    if (rec) speedHit++;
  }
  if (!speedHit) gaps.push("面试.md §四 逐家速查表一行都没匹配上（表头需为 `| # | 公司 | 岗位 | 投递日 | 城市 | 对口度 | 状态 |`）");

  // ── §五 5.1 口碑逐家清单（#### 公司（N 条） + 笔记表） ──
  const s5 = sliceSection(t, "## 五、公司口碑汇总");
  const sub51 = grabSection(s5, /5\.1/);
  let repHit = 0;
  if (sub51) {
    const B = sub51.body.split("\n");
    const idx = [];
    B.forEach((l, i) => { if (/^#{4,6}\s/.test(l)) idx.push(i); });
    for (let k = 0; k < idx.length; k++) {
      const head = clean(B[idx[k]].replace(/^#{4,6}\s*/, ""));
      const m = head.match(/^(.+?)\s*[（(](\d+)\s*条[）)]/);
      if (!m) continue;
      const name = clean(m[1]), count = +m[2];
      const body = B.slice(idx[k], idx[k + 1] ?? B.length).join("\n");
      const notes = tableRows(body, { minCols: 5, filter: (c) => /^\d+$/.test(c[0]) })
        .map(({ cells }) => ({
          i: +cells[0], title: cells[1], author: cells[2], time: cells[3], likes: cells[4],
          link: (cells[5] ?? "").match(/https?:\/\/\S+/)?.[0] ?? "",
        }));
      if (observe(name, { reputation: { count, notes } }, "面试.md#五、公司口碑汇总")) repHit++;
    }
  }
  if (!repHit) gaps.push("面试.md §5.1 一家口碑都没匹配上");

  // ── §五 5.2 按主题归纳：| 主题 | 涉及公司 | 说明 | ──
  const sub52 = grabSection(s5, /5\.2/);
  if (sub52) {
    for (const { cells } of tableRows(sub52.body, { minCols: 3, filter: (c) => c[0] && c[1] && !/^主题$/.test(c[0]) })) {
      themes.push({ theme: cells[0], companiesText: cells[1], note: cells[2] });
    }
  }

  // ── §六 面试速览（按公司 · 手写）→ 工作台「面试练习」里的作战卡片 ──
  //    结构：每个 `### 6.x 公司 ｜ 岗位` → { no, head, blocks:[{title, body}] }
  //    body 保留 markdown 原文，由 app.html 的 mdLite() 渲染（不在这里转 HTML）。
  const s6 = sliceSection(t, "## 六、面试速览（按公司 · 面试前速看）");
  if (s6) {
    for (const ch of s6.split(/\n(?=###\s)/)) {
      const h6 = ch.match(/^###\s*([0-9]+\.[0-9]+)\s*(.+)$/m);
      if (!h6) continue;
      const rest = ch.slice(ch.indexOf(h6[0]) + h6[0].length).replace(/^\s+|\s+$/g, "");
      const blocks = [];
      for (const p of rest.split(/\n(?=\*\*)/)) {
        const bm = p.match(/^\*\*(.+?)\*\*/);
        if (bm) blocks.push({ title: clean(bm[1]), body: p.slice(bm[0].length).replace(/^\s+|\s+$/g, "") });
        else if (p.trim()) blocks.push({ title: "", body: p.trim() });
      }
      interviewCards.push({ no: h6[1], head: clean(h6[2]), blocks });
    }
    if (!interviewCards.length) gaps.push("面试.md §六 一节都没解析出来");
  }
}

// ───────────────────────── ③ 合并 + 自检 ─────────────────────────

/** 把 §5.2 主题挂到公司上（涉及公司名靠同样的匹配逻辑） */
let themeLinks = 0;
for (const th of themes) {
  for (const tok of th.companiesText.split(/[、,，/／]/).map((s) => clean(s)).filter(Boolean)) {
    const loose = looseNorm(tok);
    if (!loose) continue;
    for (const rec of canon) {
      const rl = looseNorm(rec.name) || looseNorm(rec.nameRaw);
      if (rl && (rl.includes(loose) || loose.includes(rl))) {
        if (!rec.themes.some((x) => x.theme === th.theme)) rec.themes.push({ theme: th.theme, note: th.note, token: tok });
        themeLinks++;
        break;
      }
    }
  }
}

const list = canon.slice().sort((a, b) => (a.no ?? 999) - (b.no ?? 999));

/**
 * 缺口回填：§四 详情里只有 107 块写了投递日、88 块写了城市、67 块写了对口度，
 * 而「面试.md §四 逐家速查」（126 行 · 由 refresh-面试-md.js 从同一份台账生成）三列都齐。
 * 回填写 `filledFrom`，界面据此显示「（速查表补）」——**不把二手值伪装成台账原文**。
 */
for (const rec of list) {
  const s = rec.speedref;
  if (!s) continue;
  const from = [];
  if (!rec.applyDate && s.date) { const nd = normDate(s.date); if (nd) { rec.applyDate = nd; if (!isFullDate(s.date)) rec.applyDateInferred = true; from.push("投递日"); } }
  if (!rec.city && s.city) { rec.city = s.city; from.push("城市"); }
  if (!rec.fit && s.fitRaw) { rec.fit = (s.fitRaw.match(/★/g) ?? []).length; rec.fitRaw = s.fitRaw; from.push("对口度"); }
  if (!rec.roles && s.roles) { rec.roles = s.roles; from.push("岗位"); }
  if (from.length) { rec.filledFrom = from; filled++; }
}

const coverage = {
  total: list.length,
  withDetail: list.filter((c) => c.detailHead).length,
  withStage: list.filter((c) => c.stage).length,
  withStageHard: list.filter((c) => c.stage && c.stageHard).length,
  withLine: list.filter((c) => c.line).length,
  withLineMissing: list.filter((c) => !c.line).map((c) => `#${c.no} ${c.name}`),
  withReputation: list.filter((c) => c.reputation).length,
  withThemes: list.filter((c) => c.themes.length).length,
  withDetailText: list.filter((c) => c.detail).length,
  withFit: list.filter((c) => c.fit > 0).length,
  scheduled: list.filter((c) => c.dispatch === "scheduled").length,
  stageUnparsed: unparsedStages.length,
  byStage: Object.fromEntries(Object.entries(STAGES).map(([k, v]) => [k, list.filter((c) => c.stage === k).length])),
  noStage: list.filter((c) => !c.stage).map((c) => `#${c.no} ${c.name}`),
};

const cache = {
  _meta: {
    scraper: "scrape.mjs",
    version: SCRAPER_VERSION,
    generatedAt: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    generatedAtMs: Date.now(),
        scope: "只抓「已投递的公司.md」的已投公司（§一 总览 = 权威名单）+「面试.md」的题与口碑",
    stages: STAGES,
    sources,
    ledger,
    coverage,
    matching: { ...matchLog, themeLinks, aliasTable: Object.keys(ALIAS).length, inheritedStage: inherited, filledFromSpeedref: filled },
    unmatched: unmatched.slice(0, 60),
    unmatchedCount: unmatched.length,
    statsNotes,
    gaps,
  },
  ledger,
  companies: list,
  dropped,
  statsTables,
  generalQuestions,
  interviewCards,
  themes,
};

fs.writeFileSync(path.join(HERE, "cache.json"), JSON.stringify(cache, null, 1), "utf8");

if (!QUIET) {
  console.log("=== 抓取完成（只读 · 未改动任何台账）===");
  for (const s of sources) console.log(`  · ${s.file}  ${(s.bytes / 1024).toFixed(0)} KiB / ${s.lines} 行 / sha1:${s.sha1}  ← ${s.role}`);
  console.log(`  已投公司 ${coverage.total} 家（抬头声明 ${ledger?.appliedTotal ?? "?"} 家 = 已发出 ${ledger?.sent ?? "?"} + 排期 ${ledger?.scheduled ?? "?"}）`);
  console.log(`  覆盖：详情块 ${coverage.withDetail} ｜ 详情正文 ${coverage.withDetailText} ｜ 阶段 ${coverage.withStage}（硬证据 ${coverage.withStageHard}）｜ 行业线 ${coverage.withLine} ｜ 对口度 ${coverage.withFit} ｜ 口碑 ${coverage.withReputation} ｜ 主题 ${coverage.withThemes}`);
  console.log("  阶段：" + Object.entries(STAGES).map(([k, v]) => `${v.label}=${coverage.byStage[k]}`).join("  "));
  console.log(`  匹配：精确 ${matchLog.exact} / 宽松 ${matchLog.loose} / 包含 ${matchLog.contain} / 相似 ${matchLog.similar} / 别名 ${matchLog.alias} / 匹配不上 ${matchLog.none}`);
  console.log(`  面试题 ${generalQuestions.length} 道 ｜ 面试作战卡片 ${interviewCards.length} 张 ｜ 口碑主题 ${themes.length} 组（挂到公司 ${themeLinks} 处）｜ 已放弃（不计入）${dropped.length} 家`);
  if (coverage.noStage.length) console.log(`  无阶段记录 ${coverage.noStage.length} 家：${coverage.noStage.join("、")}`);
  if (unmatched.length) console.log(`  ⚠️ 匹配不上的补充观察 ${unmatched.length} 条（未新建公司）：` + unmatched.slice(0, 8).map((u) => `${u.name}(${u.source.split("#")[0]})`).join("、") + (unmatched.length > 8 ? " …" : ""));
  if (gaps.length) { console.log("  ⚠️ 缺口："); for (const g of gaps) console.log("    · " + g); }
  else console.log("  ✅ 无解析缺口");
  console.log("  → cache.json");
}
