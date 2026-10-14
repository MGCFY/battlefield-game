'use strict';
/*
 * bench.js —— 性能基准
 * ---------------------------------------------------------------------------
 * 报告三个口径：
 *   1) 局/秒   ：完整对局吞吐（含部署、地图生成、全部决策）
 *   2) step/秒 ：环境交互吞吐（一个 step = 一次「选单位→选目标→选动作」决策）
 *   3) 单局耗时分布
 * 用法：node bench.js [局数] [策略A] [策略B]
 */

const { loadEngine } = require('./engine');
const { runMatch } = require('./sim');
const { createEnv } = require('./env');

const N = Number(process.argv[2] || 40);
const RED = process.argv[3] || 'ai:medium';
const BLUE = process.argv[4] || 'rush';
const USE_CACHE = process.argv.includes('--cache');
const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;

function benchMatches() {
  const api = loadEngine({ seed: 0, quiet: true, visionCache: USE_CACHE });
  const cfg = { red: RED, blue: BLUE, map: 'gen', budget: 3000, maxRounds: 300 };
  const times = [];
  const t0 = nowMs();
  for (let i = 0; i < N; i++) {
    const r = runMatch(api, Object.assign({}, cfg, { seed: 1000 + i }));
    times.push({ ms: r.ms, turns: r.turns, winner: r.winner });
  }
  const total = nowMs() - t0;
  times.sort((a, b) => a.ms - b.ms);
  const avgTurns = times.reduce((s, t) => s + t.turns, 0) / times.length;
  return {
    label: `完整对局  ${RED} vs ${BLUE}`,
    games: N, totalMs: total,
    gps: N / (total / 1000),
    msPerGame: total / N,
    p50: times[Math.floor(times.length / 2)].ms,
    p90: times[Math.floor(times.length * 0.9)].ms,
    max: times[times.length - 1].ms,
    avgTurns,
  };
}

function benchSteps() {
  const env = createEnv({ side: 0, opponent: 'ai:medium', budget: 3000, visionCache: USE_CACHE });
  let steps = 0, games = 0;
  const t0 = nowMs();
  const budgetMs = 6000;                       // 采样窗口：6 秒
  while (nowMs() - t0 < budgetMs) {
    env.reset({ seed: 5000 + games });
    let guard = 0;
    while (!env.done && guard++ < 20000) {
      const list = env.pending();
      if (!list.length) { env.step({ unit: 0, type: 3, target: 0 }); steps++; continue; }
      const la = env.legalActions(0);
      if (!la) { env.step({ unit: 0, type: 3, target: 0 }); steps++; continue; }
      const type = la.types.includes(0) ? 0 : la.types[0];
      const cells = la.targets[type] || [];
      env.step({ unit: 0, type, target: cells.length ? cells[(Math.random() * cells.length) | 0] : 0 });
      steps++;
    }
    games++;
  }
  const total = nowMs() - t0;
  return { label: '环境交互  随机策略', steps, games, totalMs: total, sps: steps / (total / 1000), gps: games / (total / 1000), msPerStep: total / steps };
}

function fmt(r) { return r; }

console.log('\n══ 性能基准 ══\n');
const m = benchMatches();
console.log(`[${m.label}]`);
console.log(`  ${m.games} 局 / ${(m.totalMs / 1000).toFixed(2)}s`);
console.log(`  吞吐        ${m.gps.toFixed(1)} 局/秒（单核）`);
console.log(`  单局耗时    avg ${m.msPerGame.toFixed(0)}ms  p50 ${m.p50}ms  p90 ${m.p90}ms  max ${m.max}ms`);
console.log(`  平均回合    ${m.avgTurns.toFixed(1)} 回合/局`);

const s = benchSteps();
console.log(`\n[${s.label}]`);
console.log(`  ${s.steps} 步 / ${s.games} 局 / ${(s.totalMs / 1000).toFixed(2)}s`);
console.log(`  吞吐        ${s.sps.toFixed(0)} step/秒 · ${s.gps.toFixed(1)} 局/秒（单核）`);
console.log(`  单步耗时    ${s.msPerStep.toFixed(2)} ms/step`);

console.log('\n[换算]');
const cpus = require('os').cpus().length;
const TH = Math.max(1, Math.min(cpus - 2, 16));       // 与 cli.js resolveWorkers 的默认一致
const TH2 = 8;
console.log(`  实测线程缩放（本机参考，见 README「性能实测」）：1→${(m.gps).toFixed(1)}  8→${(m.gps * 6.0).toFixed(0)}  16→${(m.gps * 7.3).toFixed(0)} 局/秒`);
console.log(`  默认 ${TH} 线程并行 → 约 ${(m.gps * 7.3).toFixed(0)} 局/秒 · ${(s.sps * 7.3).toFixed(0)} step/秒`);
console.log(`  1 亿步交互 → 单核 ${(1e8 / s.sps / 3600).toFixed(1)}h · ${TH2} 线程 ${(1e8 / s.sps / 6.0 / 3600).toFixed(1)}h · ${TH} 线程 ${(1e8 / s.sps / 7.3 / 3600).toFixed(1)}h`);
console.log('');
