#!/usr/bin/env node
'use strict';
/*
 * cli.js —— 无头模拟命令行入口
 * ---------------------------------------------------------------------------
 * 示例：
 *   node cli.js --games 200 --red rush --blue ai:medium
 *   node cli.js -n 100 --red turtle --blue ai:medium --assert blue:0.6:100
 *   node cli.js --list
 *   node cli.js --trace --red rush --blue ai:medium
 *   node cli.js -n 500 --workers 8 --json out.json --map scorch
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker } = require('worker_threads');
const { fork } = require('child_process');

const { loadEngine, resolveSource } = require('./engine');
const { runMatch, summarize, nowMs } = require('./sim');

/* ------------------------------------------------------------------ *
 *  参数解析
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const o = { _: [] };
  const put = (k, v) => {
    if (o[k] === undefined) o[k] = v;
    else if (Array.isArray(o[k])) o[k].push(v);
    else o[k] = [o[k], v];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) put(a.slice(2, eq), a.slice(eq + 1));
      // 注意：下一个参数只要以 '-' 开头就视为标志，否则 --quiet 会把 -w 吃掉
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) put(a.slice(2), argv[++i]);
      else put(a.slice(2), true);
    } else if (a === '-n') put('games', argv[++i]);
    else if (a === '-w') put('workers', argv[++i]);
    else o._.push(a);
  }
  return o;
}

const HELP = `
战场沙盘 · 无头高速模拟

用法
  node cli.js [选项]

基本选项
  -n, --games <N>        对局数（默认 100）
      --red <策略>       红方策略（默认 ai:medium）
      --blue <策略>      蓝方策略（默认 rush）
      --map <地图>       地图：gen | scorch | f01..f06（默认 gen）
      --budget <分>      双方预算（默认 3000）
      --seed <S>         起始种子，第 i 局用 S+i（默认 1）
      --max-rounds <R>   单局回合上限（默认 300）
  -w, --workers <W>      并行线程数（默认 auto = min(核数-2, 16)）
      --chunk <N>        每个线程单次领取的局数（默认自动 ≈ 局数/(线程×8)）
      --src <文件>       指定游戏 HTML 源文件

输出与校验
      --json <文件>      把逐局明细写成 JSON
      --detail           明细中包含编成与地图分布
      --assert <规则>    目标校验，形如 side:min[:maxTurns]，可重复
                         例：--assert blue:0.8   --assert blue:0.6:100
      --no-auto-check    关闭按双方策略自动推断的胜率校验
      --keep-exposure    保留「单位暴露」统计（会慢一些）
      --no-vision-cache  关闭视野缓存（默认开启：同回合记忆化，约 3.2× 提速，
                         已由 selfcheck 第 [4] 关证明与逐次重算完全等价）
      --trace            只跑 1 局并逐回合打印态势
      --quiet            不打印进度条
      --list             列出所有可用策略
  -h, --help             显示本帮助

内置策略
  ai:easy | ai:medium | ai:hard    游戏内置 AI 三档难度
  rush                              速推流：全军直扑敌基地
  turtle                            龟缩流：守家远程倾泻，条件满足才出门
  hold                              纯守家（永不主动出门）
  random                            随机基线
`;

/* ------------------------------------------------------------------ *
 *  --list
 * ------------------------------------------------------------------ */
function cmdList() {
  const { listPolicies } = require('./policies');
  console.log('\n可用策略：');
  for (const p of listPolicies()) console.log('  · ' + p);
  console.log('\n提示：也可以在代码中传入自定义策略对象 { name, deploy, act }。\n');
}

/* ------------------------------------------------------------------ *
 *  --trace：单局态势追踪
 * ------------------------------------------------------------------ */
function cmdTrace(opt) {
  const api = loadEngine({ src: opt.src, seed: 0, quiet: true, keepExposure: true });
  const cfg = {
    red: opt.red || 'rush',
    blue: opt.blue || 'ai:medium',
    map: opt.map || 'gen',
    budget: Number(opt.budget || 3000),
    maxRounds: Number(opt['max-rounds'] || 300),
    seed: Number(opt.seed || 1),
  };
  console.log(`\n=== 单局追踪 · ${cfg.red} (红) vs ${cfg.blue} (蓝) · ${cfg.map} · 预算 ${cfg.budget} · 种子 ${cfg.seed} ===\n`);
  console.log('回合 | 红方(兵力/价值) | 蓝方(兵力/价值) | 红方单位 | 蓝方单位');
  console.log('-'.repeat(78));

  const r = runMatch(api, Object.assign(cfg, {
    onRound(a, round) {
      if (!(round <= 12 || round % 5 === 0)) return;
      const s0 = a.strength(0), s1 = a.strength(1);
      const n0 = a.aliveOf(0).length, n1 = a.aliveOf(1).length;
      console.log(
        String(round).padStart(4) + ' | ' +
        `${String(s0.men).padStart(4)}/${String(s0.value).padStart(5)} | ` +
        `${String(s1.men).padStart(4)}/${String(s1.value).padStart(5)} | ` +
        String(n0).padStart(8) + ' | ' + String(n1).padStart(8)
      );
    },
  }));

  const label = (s) => (s === 0 ? '红方' : '蓝方');
  console.log('-' .repeat(78));
  console.log(`结果：${r.winner < 0 ? '未决（超时）' : label(r.winner) + ' 胜'} · ${r.reason} · ${r.turns} 回合 · ${Math.round(r.ms)}ms`);
  console.log(`部署花费：红 ${r.deploySpent[0]} / 蓝 ${r.deploySpent[1]}`);
  console.log(`残存：红 ${r.survivors[0].men} 人(${r.survivors[0].value}) | 蓝 ${r.survivors[1].men} 人(${r.survivors[1].value})\n`);
}

/* ------------------------------------------------------------------ *
 *  并行执行（常驻 worker 池 · pull 调度）
 * ---------------------------------------------------------------------------
 *  为什么不用「静态分片」：单局耗时差异极大（速推 30 回合 vs 龟缩打满 300 回合），
 *  固定切蛋糕会让先跑完的线程空转。改成 pull 模式后，负载自动向空闲线程倾斜。
 * ------------------------------------------------------------------ */
function resolveWorkers(opt, games) {
  const cpus = os.cpus().length;
  const raw = opt.workers;
  let w;
  if (raw === undefined || raw === true || raw === 0 || raw === 'auto' || raw === '0') {
    // 默认：留 2 个逻辑核给系统与主线程，上限 16（内存与调度收益的平衡点）
    w = Math.max(1, Math.min(cpus - 2, 16));
  } else {
    w = Math.max(1, Number(raw) || 1);
  }
  return Math.max(1, Math.min(w, games));
}

function runPool(opt, cfgBase, games) {
  const workers = resolveWorkers(opt, games);
  const keepExposure = !!opt['keep-exposure'];
  const visionCache = !opt['no-vision-cache'];
  const baseSeed = cfgBase.seed;
  const allSeeds = Array.from({ length: games }, (_, i) => baseSeed + i);
  const mode = opt.mode === 'process' ? 'process' : 'thread';

  if (workers === 1) {
    const api = loadEngine({ src: opt.src, seed: 0, quiet: true, keepExposure, visionCache });
    const results = [];
    const t0 = nowMs();
    for (const seed of allSeeds) results.push(runMatch(api, Object.assign({}, cfgBase, { seed })));
    return Promise.resolve({ results, workers, wallMs: nowMs() - t0, perWorker: [games], mode: 'single' });
  }

  // 每批种子数：太少 → 消息往返开销大；太多 → 长尾不均。取 ~8 批/线程
  const chunk = Math.max(1, Math.min(16, Number(opt.chunk) || Math.floor(games / (workers * 8)) || 1));

  return new Promise((resolve) => {
    const results = [];
    const perWorker = new Array(workers).fill(0);
    let next = 0;
    let completed = 0;
    let failed = 0;
    let finished = 0;
    const t0 = nowMs();

    const takeChunk = () => {
      if (next >= allSeeds.length) return null;
      const s = allSeeds.slice(next, next + chunk);
      next += s.length;
      return s;
    };

    const onBatch = (workerIndex, msg) => {
      for (const r of msg.results) { if (r.error) failed++; else results.push(r); }
      perWorker[workerIndex] += msg.seeds.length;
      completed += msg.seeds.length;
      if (!opt.quiet) process.stdout.write(`\r  进度 ${completed}/${games} 局 …`);
      const s = takeChunk();
      if (s) workerSend(workerIndex, s);
      else { workerClose(workerIndex); finished++; checkDone(); }
    };

    const checkDone = () => {
      if (finished < workers) return;
      if (!opt.quiet) process.stdout.write('\n');
      resolve({ results, workers, failed, wallMs: nowMs() - t0, perWorker, chunk, mode });
    };

    let workerSend, workerClose;
    const workerData = { src: opt.src, cfg: cfgBase, detail: !!opt.detail, keepExposure, visionCache };

    if (mode === 'process') {
      const procs = [];
      const payload = JSON.stringify({ src: opt.src, cfg: cfgBase, detail: !!opt.detail, keepExposure, visionCache });
      workerSend = (i, seeds) => { try { procs[i].stdin.write(JSON.stringify({ seeds }) + '\n'); } catch (e) { /* 忽略 */ } };
      workerClose = (i) => { try { procs[i].stdin.write(JSON.stringify({ done: true }) + '\n'); } catch (e) { /* 忽略 */ } };
      for (let i = 0; i < workers; i++) {
        const child = fork(path.join(__dirname, 'proc-worker.js'), [payload], { stdio: ['pipe', 'pipe', 'inherit', 'ipc'] });
        procs.push(child);
        let buf = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d) => {
          buf += d;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
            if (!line.trim()) continue;
            let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
            if (msg.ready) { const s = takeChunk(); if (s) workerSend(i, s); else { workerClose(i); finished++; checkDone(); } continue; }
            if (msg.results) onBatch(i, msg);
          }
        });
        child.on('exit', () => { /* 正常退出不计数（已在上层 close 时计） */ });
        child.on('error', (e) => { process.stderr.write('\n[proc] 异常: ' + e.message + '\n'); failed += chunk; finished++; checkDone(); });
      }
      return;
    }

    const threads = [];
    workerSend = (i, seeds) => { try { threads[i].postMessage({ seeds }); } catch (e) { /* 忽略 */ } };
    workerClose = (i) => { try { threads[i].postMessage({ done: true }); } catch (e) { /* 忽略 */ } };
    for (let i = 0; i < workers; i++) {
      const w = new Worker(path.join(__dirname, 'worker.js'), { workerData });
      threads.push(w);
      w.on('message', (msg) => {
        if (msg && msg.ready) { const s = takeChunk(); if (s) workerSend(i, s); else { workerClose(i); finished++; checkDone(); } return; }
        if (msg && msg.results) onBatch(i, msg);
      });
      w.on('error', (e) => { process.stderr.write('\n[worker] 异常: ' + e.message + '\n'); failed += chunk; finished++; checkDone(); });
    }
  });
}

/* ------------------------------------------------------------------ *
 *  主流程
 * ------------------------------------------------------------------ */
async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || opt.h) { console.log(HELP); return; }
  if (opt.list || opt._[0] === 'list') { cmdList(); return; }
  if (opt.trace) { cmdTrace(opt); return; }

  const games = Number(opt.games || 100);
  const cfgBase = {
    red: opt.red || 'ai:medium',
    blue: opt.blue || 'rush',
    map: opt.map || 'gen',
    budget: Number(opt.budget || 3000),
    maxRounds: Number(opt['max-rounds'] || 300),
    seed: Number(opt.seed || 1),
  };

  const src = resolveSource(opt.src);
  const t0 = nowMs();

  if (!opt.quiet) {
    console.log('\n战场沙盘 · 无头高速模拟');
    console.log('─'.repeat(64));
    console.log('  源文件  ' + src);
    console.log(`  对局    red=${cfgBase.red}  vs  blue=${cfgBase.blue}`);
    console.log(`  地图    ${cfgBase.map}    预算 ${cfgBase.budget}    回合上限 ${cfgBase.maxRounds}`);
    console.log(`  规模    ${games} 局    种子 ${cfgBase.seed}..${cfgBase.seed + games - 1}`);
  }

  const { results, workers, failed = 0, wallMs, perWorker, chunk } = await runPool(opt, cfgBase, games);
  const elapsed = nowMs() - t0;

  /* ---- 目标校验规则 ---- */
  const checks = [];
  const pushCheck = (raw) => {
    const parts = String(raw).split(':');
    const side = parts[0] === 'red' || parts[0] === '0' ? 'red' : 'blue';
    checks.push({ side, min: parts[1] === undefined ? undefined : Number(parts[1]), maxTurns: parts[2] === undefined ? undefined : Number(parts[2]) });
  };
  if (opt.assert) [].concat(opt.assert).forEach(pushCheck);
  if (!checks.length && !opt['no-auto-check']) {
    const b = cfgBase.blue, r = cfgBase.red;
    if (/^ai:/.test(b) && r === 'rush') checks.push({ side: 'blue', min: 0.8, label: '中等AI 对 速推流 胜率 ≥80%' });
    if (/^ai:/.test(b) && (r === 'turtle' || r === 'hold')) checks.push({ side: 'blue', min: 0.6, maxTurns: 100, label: '中等AI 对 龟缩流 胜率 ≥60% 且平均 <100 回合' });
  }
  if (checks.length) {
    checks.forEach((c) => {
      if (!c.label) c.label = `${c.side === 'red' ? '红方' : '蓝方'}胜率` + (c.min !== undefined ? ` ≥${(c.min * 100).toFixed(0)}%` : '') + (c.maxTurns !== undefined ? ` 且平均 <${c.maxTurns} 回合` : '');
    });
  }

  const agg = summarize(results, { checks, config: Object.assign({ games, workers }, cfgBase) });

  /* ---- 打印汇总 ---- */
  const pct = (x) => (x * 100).toFixed(1) + '%';
  console.log('\n' + '═'.repeat(64));
  console.log('  结果');
  console.log('─'.repeat(64));
  console.log(`  蓝方 ${cfgBase.blue.padEnd(12)} 胜 ${String(agg.wins.blue).padStart(5)}   ${pct(agg.winRate.blue).padStart(7)}`);
  console.log(`  红方 ${cfgBase.red.padEnd(12)} 胜 ${String(agg.wins.red).padStart(5)}   ${pct(agg.winRate.red).padStart(7)}`);
  if (agg.wins.undecided) {
    console.log(`  未决${' '.repeat(10)}   胜 ${String(agg.wins.undecided).padStart(5)}   ${pct(agg.winRate.undecided).padStart(7)}`);
  }
  console.log('─'.repeat(64));
  console.log(`  回合    平均 ${agg.turns.avg.toFixed(1)}   中位 ${agg.turns.p50}   P90 ${agg.turns.p90}   最短 ${agg.turns.min}   最长 ${agg.turns.max}`);
  console.log('  原因    ' + Object.entries(agg.reasons).map(([k, v]) => `${k} ${v}`).join(' · '));
  const wallSec = elapsed / 1000;
  const throughput = wallSec > 0 ? games / wallSec : 0;
  console.log(`  性能    ${agg.perf.msPerGame.toFixed(1)} ms/局·单核 · ${throughput.toFixed(1)} 局/秒·墙钟 · ${workers} 线程 · 总耗时 ${wallSec.toFixed(2)}s`);
  if (perWorker && perWorker.length > 1) {
    const mn = Math.min.apply(null, perWorker), mx = Math.max.apply(null, perWorker);
    console.log(`  负载    ${workers} 线程 · 每线程 ${mn}~${mx} 局 · 批 ${chunk} 局/次 · 失衡 ${mx - mn} 局`);
  }
  if (failed) console.log(`  ⚠ 失败    ${failed} 局（详见 --json 输出）`);

  if (agg.checks) {
    console.log('─'.repeat(64));
    console.log('  目标校验');
    for (const c of agg.checks) {
      const mark = c.pass ? '✅ 通过' : '❌ 未达';
      console.log(`  ${mark}  ${c.label}    实际 ${pct(c.rate)}${c.maxTurns !== undefined ? `，平均 ${agg.turns.avg.toFixed(1)} 回合` : ''}`);
    }
  }
  console.log('═'.repeat(64) + '\n');

  /* ---- JSON 输出 ---- */
  if (opt.json) {
    const payload = { config: agg.config, summary: agg, results };
    fs.writeFileSync(opt.json, JSON.stringify(payload, null, 2), 'utf8');
    console.log('逐局明细已写入 ' + path.resolve(opt.json) + '\n');
  }

  // 有校验未过 → 退出码 1（方便 CI）
  if (agg.checks && agg.checks.some((c) => !c.pass)) process.exitCode = 1;
}

main().catch((e) => { console.error('运行失败：', e); process.exit(2); });
