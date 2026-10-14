#!/usr/bin/env node
/**
 * 求职工作台 · 构建器（第二阶段）
 *
 * 把抓取缓存 `cache.json` 变成**双击即用**的自包含工作台。
 *
 *   node build.mjs              # cache.json → data.json + 工作台.html
 *   node build.mjs --scrape     # 先跑 scrape.mjs 重新抓取，再构建（台账改了就加这个）
 *
 * 产出
 *   data.json     注入用的视图数据（缓存 + 派生计数 / 对账 / 新鲜度）
 *   工作台.html   自包含单文件应用（数据已内嵌，无需服务器）
 *
 * 分工（与 scrape.mjs 的关系）
 *   scrape.mjs  = 「台账 → 结构化缓存」，慢、要读 400 KB markdown、是事实来源的那一步
 *   build.mjs   = 「缓存 → 界面」，快、只做派生与注入；**不重新读 markdown**
 *   → 所以改界面（app.html）只要跑 build.mjs；台账改了才需要 build.mjs --scrape
 *
 * 设计原则
 *   - 只读：不修改 求职/ 下任何文件
 *   - 人工状态（跟进日期 / 笔记 / 练习）存浏览器 localStorage，不进台账
 *   - **台账与界面不一致时，先把不一致喊出来**（对账 + 缓存新鲜度两道自检）
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "求职");
const ARGS = process.argv.slice(2);

// ── ① 可选：先重新抓取 ──
if (ARGS.includes("--scrape")) {
  console.log("→ 先跑 scrape.mjs（只读抓取台账）…");
  execFileSync(process.execPath, [path.join(HERE, "scrape.mjs")], { stdio: "inherit" });
}

const cachePath = path.join(HERE, "cache.json");
if (!fs.existsSync(cachePath)) {
  console.error("✗ 没有 cache.json —— 先跑一次：node scrape.mjs");
  process.exit(1);
}
const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));

// ── ② 缓存新鲜度：台账 sha1 有没有变 ──
const sha = (f) => {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) return null;
  return crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex").slice(0, 12);
};
const drift = (cache._meta.sources ?? [])
  .map((s) => ({ file: s.file, cached: s.sha1, now: sha(s.file) }))
  .filter((x) => x.now === null || x.now !== x.cached);
const staleness = drift.length
  ? { ok: false, text: `台账已改动（${drift.map((d) => d.file).join("、")}）→ 重跑：node build.mjs --scrape` }
  : { ok: true, text: "缓存与台账 sha1 一致" };

// ── ③ 派生 ──
const stages = cache._meta.stages;
const companies = cache.companies ?? [];
const byStage = Object.fromEntries(Object.keys(stages).map((k) => [k, companies.filter((c) => c.stage === k).length]));
const byLine = {};
for (const c of companies) {
  const k = c.line ?? "?";
  byLine[k] = byLine[k] ?? { letter: k, name: c.lineName || "未分组", n: 0 };
  byLine[k].n++;
}

const ledger = cache.ledger ?? {};
const sent = companies.filter((c) => c.dispatch === "sent").length;
const scheduled = companies.filter((c) => c.dispatch === "scheduled").length;

const reconcile = (() => {
  if (ledger.appliedTotal == null) return { ok: null, text: "台账抬头没有「已投递合计 N 家」→ 跳过对账" };
  const parts = [`解析 ${companies.length} 家`, `抬头 ${ledger.appliedTotal} 家`];
  let ok = companies.length === ledger.appliedTotal;
  if (ledger.sent != null && ledger.scheduled != null) {
    parts.push(`已发出 ${sent} + 排期 ${scheduled} = ${sent + scheduled}`);
    if (sent + scheduled !== ledger.appliedTotal) ok = false;
  }
  return { ok, text: `${ok ? "✅ 一致" : "⚠️ 不一致"}：${parts.join(" ｜ ")}` };
})();

const data = {
  generatedAt: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
  generatedAtMs: Date.now(),
  pipeline: {
    scrape: cache._meta.generatedAt,
    scraper: cache._meta.scraper,
    scope: cache._meta.scope,
    sources: cache._meta.sources,
    matching: cache._meta.matching,
    coverage: cache._meta.coverage,
    unmatched: cache._meta.unmatched ?? [],
    gaps: cache._meta.gaps ?? [],
  },
  staleness,
  ledger,
  stages,
  stageOrder: Object.keys(stages),
  counts: { total: companies.length, ...byStage, sent, scheduled },
  byLine: Object.values(byLine).sort((a, b) => a.letter.localeCompare(b.letter)),
  reconcile,
  companies,
  dropped: cache.dropped ?? [],
  statsTables: cache.statsTables ?? [],
  statsNotes: cache._meta.statsNotes ?? [],
  generalQuestions: cache.generalQuestions ?? [],
  interviewCards: cache.interviewCards ?? [],
  themes: cache.themes ?? [],
  exam: { available: false },   // 分享版不带这一块：页面也已摘掉对应栏目
};

fs.writeFileSync(path.join(HERE, "data.json"), JSON.stringify(data, null, 1), "utf8");

// ── ④ 注入模板 ──
let injected = false;
let heroInlinedKb = null;   // hero 底图是否内联（给最后的汇报用，作用域在 ④ 之外）
const tplPath = path.join(HERE, "app.html");
if (fs.existsSync(tplPath)) {
  const tpl = fs.readFileSync(tplPath, "utf8");
  if (!tpl.includes("/*__DATA__*/null")) console.warn("⚠️ app.html 里找不到 /*__DATA__*/null 占位符 —— 注入不会生效");
  // ── hero 底图内联 ──
  // assets/hero.jpg（压缩过的真照片）转成 data URI 写进 CSS，保持「双击即用、不联网、单文件」。
  // 图不在就写 none —— .hero 的渐变兜底照样能看，不会因为缺图就白屏。
  const heroPath = path.join(HERE, "assets", "hero.jpg");
  const heroUri = fs.existsSync(heroPath)
    ? 'url("data:image/jpeg;base64,' + fs.readFileSync(heroPath).toString("base64") + '")'
    : "none";
  if (!heroUri.startsWith("url(") && tpl.includes("/*__HERO_IMG__*/none")) {
    console.warn("ℹ️ 没有 assets/hero.jpg —— hero 用渐变兜底（想要真图：放一张 assets/hero.jpg 再重跑本脚本）");
  }
  const html = tpl
    .replace("/*__DATA__*/null", JSON.stringify(data))
    .replace("/*__HERO_IMG__*/none", heroUri);
  fs.writeFileSync(path.join(HERE, "工作台.html"), html, "utf8");
  injected = true;
  heroInlinedKb = heroUri.startsWith("url(") ? (fs.statSync(heroPath).size / 1024).toFixed(0) + " KB" : null;
}

// ── ⑤ 汇报 ──
const KB = (p) => (fs.statSync(path.join(HERE, p)).size / 1024).toFixed(0) + " KB";
console.log("=== 构建完成 ===");
console.log(`  公司 ${companies.length} 家（已发出 ${sent} + 邮箱排期 ${scheduled}）｜ 对账：${reconcile.text}`);
console.log("  阶段：" + Object.entries(stages).map(([k, v]) => `${v.label}=${byStage[k]}`).join("  "));
console.log("  行业线：" + Object.values(byLine).sort((a, b) => a.letter.localeCompare(b.letter)).map((g) => `${g.letter}${g.n}`).join(" "));
console.log(`  统计表 ${data.statsTables.length} 张 ｜ 面试题 ${data.generalQuestions.length} 道 ｜ 面试作战卡片 ${data.interviewCards.length} 张 ｜ 口碑主题 ${data.themes.length} 组 ｜ 已放弃（不计入）${data.dropped.length} 家`);
console.log(`  缓存新鲜度：${staleness.ok ? "✅" : "⚠️"} ${staleness.text}`);
if (cache._meta.gaps?.length) console.log("  ⚠️ 抓取缺口：" + cache._meta.gaps.join("；"));
if (cache._meta.unmatched?.length) console.log(`  ℹ️ 匹配不上的补充观察 ${cache._meta.unmatched.length} 条（未新建公司）`);
console.log(`  → data.json ｜ ${injected ? "工作台.html（" + KB("工作台.html") + "）" : "（app.html 不存在，未生成 HTML）"}`);
if (injected) console.log(`  hero 底图：${heroInlinedKb ? "已内联 assets/hero.jpg（" + heroInlinedKb + "）" : "无（渐变兜底）"}`);
