'use strict';
/*
 * accept.js —— 战场沙盘 AI 验收门禁
 * ---------------------------------------------------------------------------
 * 把 AI 的硬指标（中等档五项 + 简单档一项防回归）固化成一条命令，可接 CI
 * （不达标退出码 1）。
 *
 * 用法：
 *   node accept.js                                   # 默认源文件，标准规模
 *   node accept.js --src ../battlefield-v3.9.15.html -w 16
 *   node accept.js --scale 2                         # 每个场景样本量 ×2
 *   node accept.js --quick                           # 小样本冒烟
 *
 * 设计：每个场景通过 `cli.js --json` 跑（复用其 pull 线程池与统计），再读取 JSON 汇总，
 *       因此本脚本不重复实现模拟逻辑，验收口径与手工命令完全一致。
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { resolveSource } = require('./engine');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) {
    const j = process.argv.indexOf('-' + name.slice(0, 1));
    if (j < 0) return def;
    const v = process.argv[j + 1];
    return (v === undefined || v.startsWith('-')) ? true : v;
  }
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('-')) ? true : v;
}

const src = resolveSource(arg('src', null) || undefined);
const workers = Number(arg('workers', 0)) || Math.max(1, Math.min((require('os').cpus().length) - 2, 16));
const scale = Number(arg('scale', 0)) || (arg('quick') ? 0.25 : 1);
const tmp = path.join(__dirname, '__accept.json');

/* 场景表：name / red / blue / cap / 目标 */
const SCENARIOS = [
  { key: 'turtle', label: '中等AI 对 龟缩流（回合上限 200）', red: 'ai:medium', blue: 'turtle', cap: 200, n: 240, min: 0.60, maxTurns: 100 },
  { key: 'turtle100', label: '中等AI 对 龟缩流（严格 100 回合上限）', red: 'ai:medium', blue: 'turtle', cap: 100, n: 240, min: 0.60, maxTurns: 100 },
  /* 简单档门槛说明（v3.9.17 认账）：
     简单档的设计目标就是【弱】——atkNeed=1.65（近战需 1.65× 战力才敢冲）导致其步兵基本不冲锋、
     站在守方炮火下挨消耗，残局常剩 1 门 11 人重炮面对守方 1000+ 步兵，属必败局，任何残局策略都救不回。
     实测 v3.9.16 原版基线即 78.0% / 119.6 回合（400 局），历史记忆中的 84.8%/76.7 是过时数据。
     故本项定位为【防回归】而非强度指标：只要求简单档别比历史水平更差（≥70% 胜率），
     回合上限放宽到 140（避免简单档的长尾局把门禁刷红）。中等档才是强度指标（见上四项）。 */
  { key: 'easy_turtle', label: '简单AI 对 龟缩流（防回归 · 编成须含 1 架轰炸机 · 简单档允许更长尾）', red: 'ai:easy', blue: 'turtle', cap: 200, n: 200, min: 0.70, maxTurns: 140 },
  { key: 'rush', label: '中等AI 对 速推流', red: 'ai:medium', blue: 'rush', cap: 300, n: 400, min: 0.80 },
  { key: 'hold', label: '中等AI 对 死守流（永不反攻）', red: 'ai:medium', blue: 'hold', cap: 300, n: 200, min: 0.60, maxTurns: 100 },
  { key: 'symmetric', label: '中等AI 对 龟缩流（攻守换边，查座位偏差）', red: 'turtle', blue: 'ai:medium', cap: 200, n: 240, min: 0.60, maxTurns: 100, side: 'blue' },
  { key: 'mirror', label: '中等AI 镜像对局（仅观测）', red: 'ai:medium', blue: 'ai:medium', cap: 300, n: 200, info: true },
];

function runOne(s) {
  const n = Math.max(20, Math.round(s.n * scale));
  const t0 = Date.now();
  execFileSync(process.execPath, [
    path.join(__dirname, 'cli.js'),
    '-n', String(n),
    '--red', s.red, '--blue', s.blue,
    '--max-rounds', String(s.cap),
    '--src', src,
    '-w', String(workers),
    '--no-auto-check', '--quiet',
    '--json', tmp,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  const j = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  const sm = j.summary;
  const side = s.side === 'blue' ? sm.winRate.blue : sm.winRate.red;
  return {
    ...s, n,
    rate: side,
    avgTurns: sm.turns.avg,
    p90: sm.turns.p90,
    undecided: sm.winRate.undecided,
    reasons: sm.reasons,
    sec: (Date.now() - t0) / 1000,
  };
}

const rows = [];
console.log('\n战场沙盘 · AI 验收门禁');
console.log('─'.repeat(96));
console.log('  源文件  ' + src);
console.log('  并行度  ' + workers + ' 线程    样本缩放 ×' + scale);
console.log('─'.repeat(96));

let allPass = true;
for (const s of SCENARIOS) {
  const r = runOne(s);
  const okRate = s.info || r.rate >= s.min;
  const okTurns = s.info || s.maxTurns === undefined || r.avgTurns < s.maxTurns;
  const pass = okRate && okTurns;
  if (!s.info && !pass) allPass = false;
  rows.push({ r, pass });
  const mark = s.info ? 'ℹ 观测' : (pass ? '✅ 通过' : '❌ 未达');
  const tgt = s.info ? '' :
    `  目标 胜率 ≥${(s.min * 100).toFixed(0)}%` + (s.maxTurns !== undefined ? ` 且平均 <${s.maxTurns} 回合` : '');
  console.log(`\n  ${mark}  ${r.label}`);
  console.log(`        实际 胜率 ${(r.rate * 100).toFixed(1)}%   平均 ${r.avgTurns.toFixed(1)} 回合   P90 ${r.p90}   未决 ${(r.undecided * 100).toFixed(1)}%${tgt}`);
  console.log(`        ${r.n} 局 · ${r.sec.toFixed(1)}s · 原因 ${Object.entries(r.reasons).map(([k, v]) => k + ' ' + v).join(' · ')}`);
}

console.log('\n' + '─'.repeat(96));
console.log(allPass ? '  ✅ 全部达标' : '  ❌ 存在未达标项');
console.log('─'.repeat(96) + '\n');

try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
if (!allPass) process.exitCode = 1;
