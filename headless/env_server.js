'use strict';
/*
 * env_server.js —— RL 环境常驻服务（NDJSON over stdio）
 * ---------------------------------------------------------------------------
 * 供 Python 训练层（model.py / ppo.py / train.py）通过子进程调用本仓库的
 * env.js 环境契约。一行一个 JSON（请求 → 一行 JSON 响应），stdio 纯文本。
 *
 * 启动：  node env_server.js [--src ../battlefield-vX.Y.Z.html]
 * 协议：
 *   {cmd:'ping'}                                → {ok:true, ...环境静态信息}
 *   {cmd:'reset', side?, seed?, opponent?,      → {obs, mask, meta}
 *      budget?, maxRounds?, map?}
 *   {cmd:'step', action:{unit,type,target}}     → {obs, mask, reward, done, info}
 *   {cmd:'targets', unit, type}                 → {targets:[idx,...]}   按需取稠密目标掩码
 *   {cmd:'legal', unit}                         → {types:[...], targets:{type:[...]}}
 *   {cmd:'close'}                               → 进程退出
 *
 * ── 外部对手（League Play 历史快照需要）────────────────────────────────────
 *   规则 AI 由 Node 侧 policies.js 驱动；但「历史快照」是 PyTorch 权重，
 *   Node 不认识。因此提供一套「轮到对手时问 Python 要动作」的协议：
 *
 *   reset 传 opponent:'external'  → 进入外部对手模式。此时 env.js 用
 *     'ai:wait'（一个「只标记待命」的空策略）占位，真正的对手动作全部由
 *     Python 通过 {cmd:'opp'} 系列命令注入：
 *       {cmd:'opp-obs'}                  → {pending, mask, obs} 对手当前该动谁
 *       {cmd:'opp-step', action:{...}}   → 执行一个对手动作，返回 {pending, done, ...}
 *     对手回合结束后，环境自动推进 endTurn，回到 agent 视角。
 *
 * obs  = Float32Array(N*N*12) 的普通数组（4800 个数，行优先 [r][c][ch]）。
 * mask = { unit:[64], type:[64][4] }（0/1 数组）；稠密 target 掩码 10 万布尔
 *        太大，默认不下发，Python 端用 {cmd:'targets'} 按需取当前选择下的列表。
 *        外部对手模式下，{cmd:'opp-targets'} 取对手视角的合法格。
 *
 * 奖励塑形（默认开启，可用 {cmd:'reset', shape:false} 关闭拿纯 ±1）：
 *   reward = w_kill * Δ(己方当量 − 敌方当量)/1000  +  终局 ±1
 *   —— 歼敌当量差按步累计只在「整回合推进」（本方行动完触发对手回合）时结算，
 *      与游戏内 strength 口径一致。
 */

const { createEnv, ACTION_TYPES, MAX_UNITS, FEATURE_CHANNELS } = require('./env');

/* ---------- 参数 ---------- */
let SRC = null;   // null → engine.js 的 DEFAULT_SRC 自动选最新版
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--src') SRC = argv[++i];
}

const W_KILL = 2.0;        // 每千当量差的奖励系数
let env = null;
let shaped = true;
let externalOpp = false;   // 外部对手模式（League 快照）
let lastDiff = 0;          // 上一结算点 (己方当量 − 敌方当量)

/* ---------- 序列化 ---------- */
function obsOf() {
  if (!env) return null;
  return Array.from(env.encode(env.agentSide));
}
function maskOf() {
  const m = env.masks();               // 稀疏（不带稠密 targets）
  return { unit: Array.from(m.unit), type: m.type.map((t) => Array.from(t)) };
}
function metaOf(extra) {
  const st = env.state();
  return Object.assign({
    N: env.api.get('N'), C: FEATURE_CHANNELS,
    maxUnits: MAX_UNITS, actionTypes: ACTION_TYPES,
    agentSide: env.agentSide, pending: env.pending().length,
  }, st, extra || {});
}
function response(id, body) { return Object.assign({ id }, body); }

/* ---------- 奖励塑形 ---------- *
 * 注意：api.strength(side) 返回 {value, men}（当量 / 兵力），不是标量。
 * 之前直接相减得到 NaN，JSON 序列化成 null —— 已修正为取 .value。
 * 这里用「当量 + 兵力/20」的混合口径：当量刻画装备价值，men/20 让
 * 「把 300 步兵磨成 30 步兵」这类纯人力损耗也进入梯度（20 men ≈ 1 当量）。
 */
function strengthScalar(side) {
  const s = env.api.strength(side);
  return (s && s.value || 0) + ((s && s.men || 0) / 20);
}
function strengthDiff() {
  return strengthScalar(env.agentSide) - strengthScalar(env.foeSide);
}

/* ---------- 外部对手辅助 ---------- *
 * 复用 env.js 导出的 legalActionsFor（它就是环境层与 BC 采集共用的合法集真源），
 * 因此「对手视角的掩码」与「agent 视角的掩码」口径完全一致，只是 side 不同。
 */
function oppSide() { return env.foeSide; }

function oppPendingUnits() {
  const acted = env.api.get('acted');
  return env.api.get('corps').filter(
    (p) => p.alive && p.side === oppSide() && !acted.has(p.id)
  );
}

function oppLegal(unitIdx) {
  const { legalActionsFor } = require('./env');
  return legalActionsFor(env.api, oppSide(), unitIdx, env.api.fn.computeVision(oppSide()));
}

function oppLegalTargets(unitIdx, type) {
  const la = oppLegal(unitIdx);
  if (!la) return [];
  if (type === 2 || type === 3) return [];
  return (la.targets[type] || []).slice();
}

function oppObs() {
  const list = oppPendingUnits();
  if (!list.length) return null;
  const { MAX_UNITS, ACTION_TYPES } = require('./env');
  const unit = new Uint8Array(MAX_UNITS);
  const type = [];
  for (let i = 0; i < MAX_UNITS; i++) {
    const t = new Uint8Array(ACTION_TYPES.length);
    if (i < list.length) {
      const la = oppLegal(i);
      if (la) for (const k of la.types) t[k] = 1;
      unit[i] = 1;
    }
    type.push(Array.from(t));
  }
  return {
    side: oppSide(),
    obs: Array.from(env.encode(oppSide())),
    mask: { unit: Array.from(unit), type },
    pending: list.length,
    units: list.map((p) => ({ id: p.id, type: p.type, r: p.r, c: p.c, troops: p.troops })),
  };
}

/** 执行一个对手动作；返回 {pendingOpp, info} */
function applyOppAction(act) {
  const { legalActionsFor } = require('./env');
  const api = env.api;
  const side = oppSide();
  const list = oppPendingUnits();
  const p = list[act.unit | 0];
  if (!p) return { pendingOpp: oppObs(), info: { applied: { ok: false, why: 'no-such-unit' } } };

  const acted = api.get('acted');
  const N = api.get('N');
  const type = act.type | 0;
  const R = Math.floor((act.target | 0) / N), C = (act.target | 0) % N;

  if (type === 3) { acted.add(p.id); }
  else if (type === 2) { if (api.get('UNITS')[p.type].canRest) api.fn.doRest(p); acted.add(p.id); }
  else if (type === 1) {
    if (p.type === 'katyusha') api.fn.performKatyusha(p, R, C);
    else if (p.type === 'bomber') api.fn.performBomb(p, R, C);
    else api.fn.performStrike(p, R, C);
    acted.add(p.id);
  } else {
    const vis = api.fn.computeVision(side);
    const u = api.get('UNITS')[p.type];
    const steps = Math.max(u.move, u.charge || 0);
    const mt = api.fn.computeMoveTargets(p, steps, vis);
    const k = api.fn.key(R, C);
    const path = mt.empties.get(k) || (mt.corpsCells.get(k) || {}).path;
    if (path) api.fn.executeMove(p, path);
    acted.add(p.id);
  }

  // 对手还有单位没动 → 继续问 Python；否则推进 endTurn 回到 agent 视角
  const rest = oppPendingUnits();
  if (rest.length) return { pendingOpp: oppObs(), info: { applied: { ok: true } } };

  if (!api.get('gameOver')) api.fn.endTurn();
  return { pendingOpp: null, info: { applied: { ok: true }, turn: api.get('turnNo'), gameOver: api.get('gameOver'), winner: api.get('winner') } };
}

/* ---------- 主循环 ---------- */
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try { req = JSON.parse(line); } catch (e) {
    process.stdout.write(JSON.stringify({ error: 'bad-json', detail: String(e && e.message) }) + '\n');
    return;
  }
  const id = req.id;
  let out;
  try { out = handle(req); }
  catch (e) { out = { error: 'handler', detail: String(e && e.stack || e) }; }
  if (out) process.stdout.write(JSON.stringify(response(id, out)) + '\n');
  if (req.cmd === 'close') process.exit(0);
});

function handle(req) {
  switch (req.cmd) {
    case 'ping': {
      const probe = createEnv({ src: SRC });
      const N = probe.api.get('N');
      const info = { N, C: FEATURE_CHANNELS, maxUnits: MAX_UNITS, actionTypes: ACTION_TYPES };
      return { ok: true, src: SRC, info };
    }
    case 'reset': {
      externalOpp = req.opponent === 'external';
      env = createEnv({
        src: SRC, side: req.side === undefined ? 0 : req.side,
        externalOpponent: externalOpp,
      });
      shaped = req.shape === undefined ? true : !!req.shape;
      lastDiff = 0;
      const obs = env.reset({
        seed: req.seed,
        // 外部对手模式：不驱动任何内置策略，对手动作全部由 Python 注入
        opponent: externalOpp ? 'ai:medium' : req.opponent,
        budget: req.budget, maxRounds: req.maxRounds, map: req.map, deploy: req.deploy,
      });
      lastDiff = strengthDiff();
      return {
        obs: obsOf(), mask: maskOf(),
        meta: metaOf({ shaped, externalOpp }),
        pendingOpp: externalOpp ? oppObs() : null,
      };
    }
    case 'step': {
      if (!env) return { error: 'not-reset' };
      const act = req.action || {};
      const before = strengthDiff();
      const r = env.step({ unit: act.unit | 0, type: act.type | 0, target: (act.target | 0) });
      const after = strengthDiff();
      let reward = r.reward;                                  // 终局 ±1
      if (shaped && !r.done) {
        reward += W_KILL * ((after - before) / 1000);         // 歼敌当量差（回合结算点才非零）
      }
      const res = {
        obs: obsOf(), mask: maskOf(), reward, done: r.done,
        info: r.info, meta: metaOf({ shaped }),
      };
      // 外部对手模式：env 把回合停在「轮到对手」，通知 Python 接管
      if (externalOpp && r.info && r.info.awaitingOpponent) res.pendingOpp = oppObs();
      return res;
    }
    /* ---------- 外部对手（League 快照）---------- */
    case 'opp-obs': {
      if (!env) return { error: 'not-reset' };
      return { pendingOpp: oppObs() };
    }
    case 'opp-step': {
      if (!env) return { error: 'not-reset' };
      const act = req.action || {};
      const r = applyOppAction(act);
      if (!r.pendingOpp) {
        // 对手动完 → 收尾回合，返回 agent 视角的标准 step 结果
        const before = lastDiff;
        const fin = env.resumeOpponentTurn();
        lastDiff = strengthDiff();
        let reward = fin.reward;
        if (shaped && !fin.done) reward += W_KILL * ((lastDiff - before) / 1000);
        return {
          pendingOpp: null, done: fin.done, reward,
          obs: Array.from(obsOf()), mask: maskOf(),
          info: fin.info, meta: metaOf({ shaped }),
        };
      }
      return { pendingOpp: r.pendingOpp, info: r.info, meta: metaOf({ shaped }) };
    }
    case 'opp-targets': {
      if (!env) return { error: 'not-reset' };
      return { targets: oppLegalTargets(req.unit | 0, req.type | 0) };
    }
    case 'opp-legal': {
      if (!env) return { error: 'not-reset' };
      return oppLegal(req.unit | 0);
    }
    case 'targets': {
      if (!env) return { error: 'not-reset' };
      return { targets: env.legalTargets(req.unit | 0, req.type | 0) };
    }
    case 'legal': {
      if (!env) return { error: 'not-reset' };
      const la = env.legalActions(req.unit | 0);
      if (!la) return { types: [], targets: {} };
      const targets = {};
      for (const k of Object.keys(la.targets)) targets[k] = la.targets[k];
      return { types: la.types, targets };
    }
    case 'state': {
      if (!env) return { error: 'not-reset' };
      return { state: env.state(), meta: metaOf({}) };
    }
    case 'close':
      return null;   // 主循环里退出
    default:
      return { error: 'unknown-cmd', cmd: req.cmd };
  }
}
