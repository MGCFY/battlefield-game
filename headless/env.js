'use strict';
/*
 * env.js —— 强化学习环境层（Gym 风格契约）
 * ---------------------------------------------------------------------------
 * 对应训练方案中的「因子化动作头 + 动作掩码」：
 *
 *   动作 = { unit, type, target }
 *     unit   : 己方「尚未行动」单位在待行动列表中的下标（0 .. K-1）
 *     type   : 0=机动/近战   1=远程打击   2=休整   3=待命（放弃该单位）
 *     target : 目标格下标 r*N+c（type 0/1 时有效）
 *
 *   三个头各自维度：  K / 4 / N²
 *   若用扁平动作空间则是 K×4×N²（20×20 下 ≈ 16 万），
 *   因子化后每步只需 3 个离散选择，且合法性由掩码强制保证。
 *
 * 掩码：
 *   masks() 返回 { unit:[K], type:[4], target:[N*N] } 的布尔/0-1 数组，
 *   其中 type/target 掩码是「针对当前 unit 选项」的条件掩码：
 *   - 若想拿全局条件掩码，用 legalTypes(unitIdx) / legalTargets(unitIdx, type)。
 *
 * 观测：
 *   observe(side) 返回结构化对象；encode(side) 返回 Float32Array 特征图
 *   [H, W, C]（默认 12 通道），可直接喂给 CNN。
 *
 * 对手：默认由规则策略驱动（league 里的规则 AI 档位），也可传入任意 policy。
 */

const { loadEngine } = require('./engine');
const { resolvePolicy } = require('./policies');
const { prepare } = require('./sim');

const ACTION_TYPES = ['move', 'ranged', 'rest', 'wait'];
const MAX_UNITS = 64;             // 单位头维度上限（单方单位数远小于此）
const FEATURE_CHANNELS = 12;      // 特征图通道数（见 encodeObs）
const TERRAIN_ORDER = ['plain', 'highland', 'river', 'forbidden', 'city', 'jungle', 'desert', 'snow'];

/* ------------------------------------------------------------------ *
 *  内部工具
 * ------------------------------------------------------------------ */
function unactedUnits(api, side) {
  const acted = api.get('acted');
  return api.get('corps').filter((p) => p.alive && p.side === side && !acted.has(p.id));
}

function stepsOf(api, p) {
  const u = api.get('UNITS')[p.type];
  return Math.max(u.move, u.charge || 0);
}

/** 单位是否具备「打击」动作（远程火力 或 轰炸机投弹） */
function canRangedAction(api, p) {
  const u = api.get('UNITS')[p.type];
  if (p.type === 'bomber') return (p.bombs || 0) > 0;
  return !!u.ranged && !!api.fn.canStrike(p);
}

/**
 * 单位可打击的格集合。
 * 与游戏 UI 的 strikeCells(cp) 完全对齐：射程内（含高地修正）全图可打，
 * 不受视野限制（视野只影响观测，不影响开火合法性）。
 * 轰炸机另走曼哈顿菱形口径 bombRange。
 */
function strikeCells(api, p, vis) {
  const out = [];
  if (!canRangedAction(api, p)) return out;
  const u = api.get('UNITS')[p.type];
  const N = api.get('N');
  const isBomb = p.type === 'bomber';
  const bombR = u.bombRange || 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (r === p.r && c === p.c) continue;
    const d = Math.abs(r - p.r) + Math.abs(c - p.c);
    const lim = isBomb ? bombR : api.fn.strikeRangeTo(p, r, c);
    if (d <= lim) out.push(r * N + c);
  }
  return out;
}

/** 单位可移动到的格集合（含可发起近战的敌方格） */
function moveCells(api, p, vis) {
  const N = api.get('N');
  const mt = api.fn.computeMoveTargets(p, stepsOf(api, p), vis);
  const out = new Set();
  for (const k of mt.empties.keys()) { const q = api.fn.unkey(k); out.add(q.r * N + q.c); }
  for (const k of mt.corpsCells.keys()) { const q = api.fn.unkey(k); out.add(q.r * N + q.c); }
  return out;
}

/* ------------------------------------------------------------------ *
 *  共享契约：合法动作计算 + 特征编码
 * ---------------------------------------------------------------------------
 *  这两个函数是「环境层」与「行为克隆采集」共用的唯一真源：
 *  - env.legalActions(unitIdx)          → legalActionsFor(api, agentSide, unitIdx, vis)
 *  - 采集器在教师动作发生前，用同一函数算出掩码，从而保证
 *    「训练用的掩码」与「教师决策时看到的合法集」完全一致。
 * ------------------------------------------------------------------ */

/**
 * 某方第 unitIdx 个待行动单位的全部合法动作。
 * @returns {{types:number[], targets:Object}|null} types 升序；targets[type] = 格下标数组
 */
function legalActionsFor(api, side, unitIdx, vis) {
  const list = unactedUnits(api, side);
  const p = list[unitIdx];
  if (!p) return null;
  const u = api.get('UNITS')[p.type];
  const N = api.get('N');
  if (vis === undefined) vis = api.fn.computeVision(side);
  const res = { types: [], targets: {} };

  if (u.air) {
    const mt = api.fn.computeMoveTargets(p, stepsOf(api, p), vis);
    const list2 = [];
    for (const k of mt.empties.keys()) { const q = api.fn.unkey(k); list2.push(q.r * N + q.c); }
    if (list2.length) { res.types.push(0); res.targets[0] = list2; }
  } else {
    const moveList = [...moveCells(api, p, vis)];
    if (moveList.length) { res.types.push(0); res.targets[0] = moveList; }
  }
  if (canRangedAction(api, p)) { res.types.push(1); res.targets[1] = strikeCells(api, p, vis); }
  if (u.canRest) res.types.push(2);
  res.types.push(3);   // 待命永远合法，作为兜底
  return res;
}

/**
 * 特征图编码（默认 12 通道，[C, N, N] 行优先展平为一维 N*N*C）。
 * 通道：0..7 地形 one-hot | 8 桥 | 9 地雷 | 10 未探明 | 11 单位分布(己+, 敌−)
 */
function encodeObs(api, side, vis) {
  const N = api.get('N');
  const C = FEATURE_CHANNELS;
  const out = new Float32Array(N * N * C);
  const t = api.get('terrain');
  if (vis === undefined) vis = api.fn.computeVision(side);
  const visSet = new Set(vis);
  const key = api.fn.key;
  const bridge = api.get('bridge'), mine = api.get('mine');

  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const base = (r * N + c) * C;
    const ti = TERRAIN_ORDER.indexOf(t[r][c]);
    if (ti >= 0) out[base + ti] = 1;                    // 0..7 地形 one-hot
    if (bridge[r][c]) out[base + 8] = 1;                 // 8 桥
    if (mine[r][c]) out[base + 9] = 1;                   // 9 地雷
    if (!visSet.has(key(r, c))) out[base + 10] = 1;      // 10 未探明
  }
  // 11 通道：单位分布（己方 +，敌方 −，按兵力当量缩放；视野外敌不写）
  for (const p of api.get('corps')) {
    if (!p.alive) continue;
    const own = p.side === side;
    if (!own && !visSet.has(key(p.r, p.c))) continue;
    const u = api.get('UNITS')[p.type];
    const eq = u.cls === 'hf' ? (p.dur || 0) * 20 : p.troops;
    out[(p.r * N + p.c) * C + 11] += (own ? 1 : -1) * Math.min(1, eq / 100);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  环境工厂
 * ------------------------------------------------------------------ */
function createEnv(opts) {
  opts = opts || {};
  const api = opts.api || loadEngine({ src: opts.src, seed: 0, quiet: true, keepExposure: !!opts.keepExposure, visionCache: !!opts.visionCache });

  const agentSide = opts.side === undefined ? 0 : opts.side;
  const foeSide = 1 - agentSide;

  let opponent = null;
  let cfg = null;
  let done = false;
  let round = 0;
  let lastObsSide = null;

  /* ---------- 视野缓存 ----------
   * computeVision 的成本是 O(己方单位数 × N²)，而一次决策里往往要反复调用
   * （掩码 / 合法目标 / 观测各一次）。棋盘只有在「动作结算」后才会变化，
   * 因此用一个代际计数器 gen 做失效：执行动作后 gen++，缓存自动作废。
   * 注意：这只缓存 env 自己发起的调用，不改变游戏内部的计算，零语义风险。 */
  let gen = 0;
  let visKey = null, visVal = null, visGen = -1;
  function visionOf(side) {
    if (visKey === side && visGen === gen && visVal) return visVal;
    const v = api.fn.computeVision(side);
    visKey = side; visVal = v; visGen = gen;
    return v;
  }

  /* ---------- reset ---------- */
  function reset(o) {
    o = o || {};
    cfg = {
      map: o.map || opts.map || 'gen',
      budget: o.budget === undefined ? (opts.budget === undefined ? 3000 : opts.budget) : o.budget,
      maxRounds: o.maxRounds === undefined ? (opts.maxRounds === undefined ? 300 : opts.maxRounds) : o.maxRounds,
      seed: o.seed === undefined ? 1 : o.seed,
      opponent: o.opponent || opts.opponent || 'ai:medium',
    };
    // 双方部署：agent 侧默认用均衡配置（可由外部通过 deploy 覆盖）
    const agentDeploy = o.deploy || opts.deploy || null;
    const { prepare } = require('./sim');
    const info = prepare(api, {
      map: cfg.map, budget: cfg.budget, seed: cfg.seed,
      red: agentSide === 0 ? 'ai:medium' : cfg.opponent,
      blue: agentSide === 1 ? 'ai:medium' : cfg.opponent,
    });
    // 若调用方给了显式部署配置，重建 agent 侧部队
    if (agentDeploy) {
      api.set('corps', api.get('corps').filter((p) => p.side !== agentSide));
      api.fn.spawnFromConfig(agentSide, agentDeploy);
    }
    opponent = resolvePolicy(cfg.opponent);
    done = false;
    round = 0;

    // 若开局轮到对手先动，先让对手走完一手
    if (api.get('current') !== agentSide && !api.get('gameOver')) {
      opponent.act(api, foeSide, { round: 0, turn: api.get('turnNo'), api });
      if (!api.get('gameOver')) api.fn.endTurn();
    }
    return observe(agentSide);
  }

  /* ---------- 观测 ---------- */
  function observe(side) {
    const N = api.get('N');
    const vis = visionOf(side);
    const acted = api.get('acted');
    const units = api.aliveOf(side).map((p) => ({
      id: p.id, type: p.type, r: p.r, c: p.c, troops: p.troops, dur: p.dur || 0,
      resting: !!p.resting, fatigue: p.fatigue || 0, acted: acted.has(p.id),
      visible: true,
    }));
    const foes = api.get('corps')
      .filter((p) => p.alive && p.side !== side)
      .map((p) => {
        // 只有进入视野的敌军才暴露坐标（信息不完全，与游戏一致）
        const seen = api.fn.unitVisibleTo(p, side, vis);
        const o = { id: p.id, type: p.type, troops: p.troops, dur: p.dur || 0, visible: seen };
        if (seen) { o.r = p.r; o.c = p.c; }
        return o;
      });
    lastObsSide = side;
    return {
      side, N, turn: api.get('turnNo'), round,
      current: api.get('current'),
      terrain: api.get('terrain'),
      bridge: api.get('bridge'),
      mine: api.get('mine'),
      bases: api.get('BASES'),
      units, foes,
      vision: [...vis],
      strength: { mine: api.strength(side), foe: api.strength(1 - side) },
      done, gameOver: api.get('gameOver'), winner: api.get('winner'),
    };
  }

  /* ---------- 特征编码（默认 12 通道） ---------- */
  function encode(side) { return encodeObs(api, side, visionOf(side)); }

  /* ---------- 动作空间 ---------- */
  function actionSpace() {
    const N = api.get('N');
    return { unit: MAX_UNITS, type: ACTION_TYPES.length, target: N * N, types: ACTION_TYPES.slice() };
  }

  /** 当前待行动单位（稳定顺序，供 unit 头索引） */
  function pending() { return unactedUnits(api, agentSide); }

  /* 每个单位在当前代际下的合法动作（types + targets），带代际缓存 */
  let laGen = -1;
  const laCache = new Map();

  /**
   * 一次性算出某单位的全部合法动作（types 与各 type 的 target 列表）。
   * legalTypes / legalTargets / masks 都基于它，保证同一单位只做一次
   * computeMoveTargets + computeVision。
   */
  function legalActions(unitIdx) {
    if (laGen !== gen) { laCache.clear(); laGen = gen; }
    if (laCache.has(unitIdx)) return laCache.get(unitIdx);
    const res = legalActionsFor(api, agentSide, unitIdx, visionOf(agentSide));
    laCache.set(unitIdx, res);
    return res;
  }

  /** 某单位下合法的动作类型 */
  function legalTypes(unitIdx) {
    const la = legalActions(unitIdx);
    return la ? la.types.slice() : [];
  }

  /** 某单位 + 某类型的合法目标格 */
  function legalTargets(unitIdx, type) {
    const la = legalActions(unitIdx);
    if (!la) return [];
    if (type === 2 || type === 3) return [];
    return (la.targets[type] || []).slice();
  }

  /**
   * 掩码（供策略网络直接使用）
   * unit   : [MAX_UNITS] 哪些下标有待行动单位
   * type   : [MAX_UNITS][4] 每个单位下的合法动作类型（条件掩码）
   * target : [MAX_UNITS][4][N*N] 若展开会是 64×4×400 = 10 万布尔，
   *          默认按需生成；需要稠密张量时传 { dense: true }
   */
  function masks(o) {
    o = o || {};
    const list = pending();
    const N = api.get('N');
    const total = N * N;
    const unit = new Uint8Array(MAX_UNITS);
    const type = [];
    for (let i = 0; i < MAX_UNITS; i++) {
      const t = new Uint8Array(ACTION_TYPES.length);
      if (i < list.length) {
        const la = legalActions(i);
        if (la) for (const k of la.types) t[k] = 1;
        unit[i] = 1;
      }
      type.push(t);
    }
    if (!o.dense) return { unit, type, targets: null };
    const target = [];
    for (let i = 0; i < MAX_UNITS; i++) {
      const perType = [];
      for (let k = 0; k < ACTION_TYPES.length; k++) {
        const arr = new Uint8Array(total);
        if (i < list.length && type[i][k]) {
          const la = legalActions(i);
          if (la && la.targets[k]) for (const idx of la.targets[k]) arr[idx] = 1;
        }
        perType.push(arr);
      }
      target.push(perType);
    }
    return { unit, type, targets: target };
  }

  /* ---------- step ---------- */
  function doApplyAction(act) {
    const list = pending();
    const p = list[act.unit];
    if (!p) return { ok: false, why: 'no-such-unit' };
    const acted = api.get('acted');
    const N = api.get('N');
    const type = act.type | 0;

    if (type === 3) { acted.add(p.id); return { ok: true }; }               // 待命
    if (type === 2) { if (api.get('UNITS')[p.type].canRest) api.fn.doRest(p); acted.add(p.id); return { ok: true }; }
    if (type === 1) {
      const r = Math.floor(act.target / N), c = act.target % N;
      if (p.type === 'katyusha') api.fn.performKatyusha(p, r, c);
      else if (p.type === 'bomber') api.fn.performBomb(p, r, c);
      else api.fn.performStrike(p, r, c);
      acted.add(p.id);
      return { ok: true };
    }
    // type 0：机动 / 近战
    const r = Math.floor(act.target / N), c = act.target % N;
    const vis = visionOf(agentSide);
    const mt = api.fn.computeMoveTargets(p, stepsOf(api, p), vis);
    const k = api.fn.key(r, c);
    const path = mt.empties.get(k) || (mt.corpsCells.get(k) || {}).path;
    if (!path) { acted.add(p.id); return { ok: false, why: 'unreachable' }; }
    api.fn.executeMove(p, path);
    acted.add(p.id);
    return { ok: true };
  }

  /* 动作结算后棋盘可能已变化 → 作废视野 / 合法动作缓存 */
  function applyAction(act) {
    const r = doApplyAction(act);
    gen++;
    return r;
  }

  function rewardOf() {
    if (!done) return 0;
    const w = api.get('winner');
    if (w === agentSide) return 1;
    if (w === 1 - agentSide) return -1;
    return 0;
  }

  function step(act) {
    if (done) return { obs: observe(agentSide), reward: 0, done: true, info: { reason: 'already-done' } };
    const res = applyAction(act);

    // 本方全部行动完 → 推进回合（对手行动 + endTurn）
    if (pending().length === 0 && !api.get('gameOver')) {
      api.fn.endTurn();
      if (!api.get('gameOver')) {
        opponent.act(api, foeSide, { round, turn: api.get('turnNo'), api });
        if (!api.get('gameOver')) api.fn.endTurn();
      }
      round++;
    }

    const over = api.get('gameOver') || round >= cfg.maxRounds;
    done = over;
    const info = {
      applied: res,
      turn: api.get('turnNo'),
      round,
      reason: api.get('gameOver')
        ? (api.fn.hasGround(0) && api.fn.hasGround(1) ? 'capture' : 'elimination')
        : (over ? 'timeout' : null),
      winner: api.get('winner'),
      strength: { mine: api.strength(agentSide), foe: api.strength(1 - agentSide) },
    };
    return { obs: observe(agentSide), reward: rewardOf(), done, info };
  }

  return {
    api, agentSide, foeSide,
    reset, step, observe, encode, masks, actionSpace,
    legalActions, legalTypes, legalTargets, pending,
    get done() { return done; },
    get round() { return round; },
    get config() { return cfg; },
    state() {
      return {
        done, round, turn: api.get('turnNo'), current: api.get('current'),
        winner: api.get('winner'), gameOver: api.get('gameOver'),
        strength: { 0: api.strength(0), 1: api.strength(1) },
      };
    },
  };
}

module.exports = {
  createEnv, ACTION_TYPES, MAX_UNITS, FEATURE_CHANNELS, TERRAIN_ORDER,
  unactedUnits, stepsOf, moveCells, strikeCells, canRangedAction,
  legalActionsFor, encodeObs,
};
