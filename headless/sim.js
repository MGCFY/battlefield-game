'use strict';
/*
 * sim.js —— 对局驱动 + 批量统计
 * ---------------------------------------------------------------------------
 * 职责：
 *   - prepare()  配置并开好一局（地图 / 预算 / 双方部署）
 *   - runMatch() 驱动一整局，返回结构化结果
 *   - runBatch() 复用同一个引擎实例跑 N 局，返回结果数组
 *   - summarize() 汇总胜率 / 回合分布 / 吞吐，并做目标校验
 *
 * 设计要点：
 *   1. 引擎实例只加载一次（约 10ms），每局用 newGame() 重置（约 2ms）；
 *   2. aiSide 固定为 -1：让 endTurn() 不会自动驱动内置 AI，改由本模块按
 *      双方各自策略显式调用，从而支持「AI vs 人形策略」等任意对局形态；
 *   3. 每局种子 = baseSeed + 局序号，保证同一种子序列可完整复现。
 */

const { resolvePolicy } = require('./policies');

const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;

/* ------------------------------------------------------------------ *
 *  准备一局：地图 + 预算 + 部署
 * ------------------------------------------------------------------ */
function prepare(api, cfg) {
  const map = cfg.map || 'gen';
  const budget = cfg.budget === undefined ? 3000 : cfg.budget;
  const seed = cfg.seed === undefined ? 1 : cfg.seed;

  // 关键：aiSide = -1 → endTurn() 内 `aiSide===current` 恒为 false，
  // 不会自动跑内置 AI；同时 aiAct() 里 `aiSide<0` 成立，AI 的集团冲锋等仍会生效。
  api.set('aiSide', -1);
  api.set('gameBudget', [budget, budget]);
  api.set('mapKind', map);
  api.reseed(seed);

  api.set('phase', 'deploy');
  api.set('deploySide', 0);
  api.fn.newGame();          // 生成地图 + 重置全部对局态
  // 新一局地形/单位全变，视野缓存必须作废（指纹里的地图 id 也能兜住，这里是双保险）
  if (typeof api.fn.__resetVisionCache === 'function') api.fn.__resetVisionCache();

  const red = resolvePolicy(cfg.red === undefined ? 'ai:medium' : cfg.red);
  const blue = resolvePolicy(cfg.blue === undefined ? 'rush' : cfg.blue);

  const spent = [];
  for (const [side, pol] of [[0, red], [1, blue]]) {
    api.set('aiDiff', pol.name.startsWith('ai:') ? pol.name.slice(3) : 'medium');
    const dep = pol.deploy(api, side) || {};
    api.fn.spawnFromConfig(side, dep);
    if (typeof pol.setup === 'function') pol.setup(api, side);
    spent.push(Object.keys(dep).reduce((s, t) => s + (dep[t] || 0) * api.get('UNITS')[t].cost, 0));
  }

  // 开战
  api.fn.startPlay();        // 内部会设置 current=0 / turnNo=1 / acted.clear()
  api.set('phase', 'play');

  return { red, blue, budget, map, seed, spent };
}

/* ------------------------------------------------------------------ *
 *  跑一整局
 * ------------------------------------------------------------------ */
function runMatch(api, cfg) {
  const maxRounds = cfg.maxRounds === undefined ? 300 : cfg.maxRounds;
  const onRound = cfg.onRound || null;

  const t0 = nowMs();
  const ctxInfo = prepare(api, cfg);

  const init = {
    0: api.strength(0),
    1: api.strength(1),
  };

  const marks = {
    rounds: 0, strikes: 0, melees: 0, reinforcements: 0,
    firstBloodRound: -1, minDistance: Infinity,
  };

  let round = 0;
  while (!api.get('gameOver') && round < maxRounds) {
    ctxInfo.red.act(api, 0, { round, turn: api.get('turnNo'), api, phase: 'red' });
    if (api.get('gameOver')) break;
    api.fn.endTurn();
    if (api.get('gameOver')) break;

    ctxInfo.blue.act(api, 1, { round, turn: api.get('turnNo'), api, phase: 'blue' });
    if (api.get('gameOver')) break;
    api.fn.endTurn();

    round++;
    if (onRound) onRound(api, round);
  }

  const over = api.get('gameOver');
  let winner = over ? api.get('winner') : -1;
  let reason;
  if (!over) reason = round >= maxRounds ? 'timeout' : 'stalled';
  else {
    const g0 = api.fn.hasGround(0), g1 = api.fn.hasGround(1);
    reason = (!g0 || !g1) ? 'elimination' : 'capture';
  }

  const t1 = nowMs();
  return {
    seed: ctxInfo.seed,
    map: ctxInfo.map,
    budget: ctxInfo.budget,
    red: ctxInfo.red.name,
    blue: ctxInfo.blue.name,
    winner,
    winnerName: winner === 0 ? ctxInfo.red.name : winner === 1 ? ctxInfo.blue.name : null,
    reason,
    turns: api.get('turnNo'),
    rounds: round,
    deploySpent: ctxInfo.spent,
    initial: init,
    survivors: { 0: api.strength(0), 1: api.strength(1) },
    census: { 0: api.census(0), 1: api.census(1) },
    mapInfo: api.mapInfo(),
    ms: t1 - t0,
  };
}

/* ------------------------------------------------------------------ *
 *  批量
 * ------------------------------------------------------------------ */
function runBatch(env, cfg, n, opts) {
  opts = opts || {};
  const api = env.api;
  const results = [];
  const baseSeed = cfg.seed === undefined ? 1 : cfg.seed;

  for (let i = 0; i < n; i++) {
    const c = Object.assign({}, cfg, { seed: baseSeed + i });
    if (opts.onRound) c.onRound = (a, r) => opts.onRound(i, a, r);
    if (opts.onGame) opts.onGame(i);
    results.push(runMatch(api, c));
  }
  return results;
}

/* ------------------------------------------------------------------ *
 *  汇总统计
 * ------------------------------------------------------------------ */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

function summarize(results, opts) {
  opts = opts || {};
  const n = results.length;
  const wins = [0, 0, 0];                     // 红 / 蓝 / 未决
  const reasons = {};
  const turnList = [];
  let totalMs = 0;
  for (const r of results) {
    if (r.winner === 0) wins[0]++; else if (r.winner === 1) wins[1]++; else wins[2]++;
    reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    turnList.push(r.turns);
    totalMs += r.ms;
  }
  turnList.sort((a, b) => a - b);

  const agg = {
    games: n,
    wins: { red: wins[0], blue: wins[1], undecided: wins[2] },
    winRate: { red: n ? wins[0] / n : 0, blue: n ? wins[1] / n : 0, undecided: n ? wins[2] / n : 0 },
    reasons,
    turns: {
      avg: turnList.length ? turnList.reduce((a, b) => a + b, 0) / turnList.length : 0,
      p50: percentile(turnList, 0.5),
      p90: percentile(turnList, 0.9),
      max: turnList.length ? turnList[turnList.length - 1] : 0,
      min: turnList.length ? turnList[0] : 0,
    },
    perf: {
      totalMs,
      msPerGame: n ? totalMs / n : 0,
      gamesPerSec: totalMs > 0 ? n / (totalMs / 1000) : 0,
    },
    config: opts.config || null,
  };

  if (opts.checks && opts.checks.length) {
    agg.checks = opts.checks.map((c) => {
      const rate = c.side === 'red' ? agg.winRate.red : agg.winRate.blue;
      const passRate = c.min === undefined || rate >= c.min;
      const passTurns = c.maxTurns === undefined || agg.turns.avg < c.maxTurns;
      return Object.assign({}, c, { rate, pass: passRate && passTurns, passRate, passTurns });
    });
  }
  return agg;
}

module.exports = { prepare, runMatch, runBatch, summarize, nowMs };
