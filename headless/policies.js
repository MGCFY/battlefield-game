'use strict';
/*
 * policies.js —— 可插拔策略库
 * ---------------------------------------------------------------------------
 * 一个「策略」对象形如：
 *   {
 *     name: 'rush',                       // 显示名
 *     deploy(api, side) -> cfg            // 返回采购配置 { inf: 300, cav: 40, ... }
 *     setup?(api, side)                   // 部署完成后可选回调（如 AI 伪装部署）
 *     act(api, side, ctx)                 // 本回合行动（ctx.round / ctx.turn / ...）
 *   }
 *
 * 约定：
 *   - 策略只通过 api.fn.* 操作游戏，不直接触碰沙盒内部变量；
 *   - 所有随机数必须走 api.fn.randInt（沙盒内 RNG），否则无法复现；
 *   - act() 只需遍历「尚未行动」的己方单位，行动后标记 acted.add(p.id)。
 */

/* ------------------------------------------------------------------ *
 *  通用工具
 * ------------------------------------------------------------------ */
const UNITS_OF = (api) => api.get('UNITS');
const UU = (api, p) => UNITS_OF(api)[p.type];

function visibleFoes(api, side, vis) {
  const UNITS = UNITS_OF(api);
  return api.get('corps').filter(
    (p) => p.alive && p.side !== side && !UNITS[p.type].air && api.fn.unitVisibleTo(p, side, vis)
  );
}

/** 目标威胁估值：用于挑选优先打击对象 */
function valueOf(api, f) {
  const u = UU(api, f);
  let v = u.cost * f.troops * 0.5 + f.troops * 0.3;
  if (f.type === 'katyusha') v += 260;
  if (f.type === 'heavyArt') v += 170;
  if (f.type === 'lightArt') v += 80;
  if (f.type === 'tank') v += 60;
  return v;
}

/** 远程单位开火（返回是否已消耗本回合行动） */
function tryRangedFire(api, p, vis) {
  const u = UU(api, p);
  if (!u.ranged) return false;
  if (p.type === 'bomber') {
    if (!(p.bombs > 0) || !api.fn.canStrike(p)) return false;
    const t = api.fn.aiPickTarget(p, vis, api.fn.strikeRange(p));
    if (!t) return false;
    api.fn.performBomb(p, t.r, t.c);
    return true;
  }
  if (!api.fn.canStrike(p)) return false;
  const t = api.fn.aiPickTarget(p, vis, api.fn.strikeRange(p));
  if (!t) return false;
  if (p.type === 'katyusha') api.fn.performKatyusha(p, t.r, t.c);
  else api.fn.performStrike(p, t.r, t.c);
  return true;
}

/** 尝试向目标格发起近战（可达则执行），成功返回 true */
function tryMelee(api, p, vis, steps, targets) {
  for (const t of targets) {
    const mt = api.fn.computeMoveTargets(p, steps, vis);
    const cell = mt.corpsCells && mt.corpsCells.get(t.r + ',' + t.c);
    if (cell) { api.fn.executeMove(p, cell.path); return true; }
  }
  return false;
}

/** 按参考配置 + 预算等比缩放采购方案 */
function scaleConfig(api, ref, budget) {
  const UNITS = UNITS_OF(api);
  const TYPES = api.get('DEPLOY_TYPES');
  const spend = (cfg) => Object.keys(cfg).reduce((s, t) => s + (cfg[t] || 0) * UNITS[t].cost, 0);
  const refSpend = spend(ref) || 1;
  const k = budget / refSpend;
  const out = {};
  for (const t of TYPES) out[t] = 0;
  for (const t of Object.keys(ref)) out[t] = Math.max(ref[t] > 0 ? 1 : 0, Math.round(ref[t] * k));
  // 超预算则按重要度从后往前砍
  let guard = 0;
  while (spend(out) > budget && guard++ < 20000) {
    const cut = ['bomber', 'recon', 'katyusha', 'tank', 'scout', 'heavyArt', 'lightArt', 'cav', 'inf'];
    let done = false;
    for (const t of cut) if (out[t] > (t === 'inf' ? 1 : 0)) { out[t]--; done = true; break; }
    if (!done) break;
  }
  // 用剩余的积分补步兵
  guard = 0;
  while (spend(out) + UNITS.inf.cost <= budget && guard++ < 20000) out.inf++;
  return out;
}

/* ------------------------------------------------------------------ *
 *  1) 游戏内置 AI：ai:easy / ai:medium / ai:hard
 * ------------------------------------------------------------------ */
function aiPolicy(diff) {
  return {
    name: 'ai:' + diff,
    deploy(api, side) {
      api.set('aiDiff', diff);
      return api.fn.aiDeployConfig(side);
    },
    setup(api, side) {
      // 中/高难度 AI 会做「伪装部署」（分散初始站位，避免编成泄露）
      if (diff !== 'easy' && typeof api.fn.aiDisguiseDeploy === 'function') {
        api.set('aiDiff', diff);
        api.fn.aiDisguiseDeploy(side);
      }
    },
    act(api, side) {
      api.set('aiDiff', diff);
      api.fn.aiAct(side);
    },
  };
}

/* ------------------------------------------------------------------ *
 *  2) rush：速推流 —— 所有单位直奔敌基地，沿途能吃谁吃谁
 * ------------------------------------------------------------------ */
function rushPolicy(opts) {
  opts = opts || {};
  const ref = opts.config || { inf: 600, cav: 150, tank: 6, lightArt: 8 };
  return {
    name: 'rush',
    deploy(api, side) {
      return scaleConfig(api, ref, api.get('gameBudget')[side]);
    },
    act(api, side) {
      const acted = api.get('acted');
      const vis = api.fn.computeVision(side);
      const foes = visibleFoes(api, side, vis);
      const mine = api.get('corps').filter((p) => p.alive && p.side === side);
      const [ebr, ebc] = api.get('BASES')[1 - side];
      for (const p of mine) {
        if (api.get('gameOver')) return;
        if (!p.alive || acted.has(p.id)) continue;
        const u = UU(api, p);
        const steps = Math.max(u.move, u.charge || 0);
        if (u.ranged) {
          if (tryRangedFire(api, p, vis)) { acted.add(p.id); continue; }
          api.fn.aiStepToward(p, vis, [{ r: ebr, c: ebc }]);
          acted.add(p.id); continue;
        }
        const reach = foes
          .filter((f) => api.fn.manh(p, f) <= steps)
          .sort((a, b) => valueOf(api, b) - valueOf(api, a));
        if (tryMelee(api, p, vis, steps, reach)) { acted.add(p.id); continue; }
        api.fn.aiStepToward(p, vis, [{ r: ebr, c: ebc }]);
        acted.add(p.id);
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 *  3) turtle：龟缩流 —— 守在自家大本营，远程倾泻，近战只在敌军进圈时反击
 * ------------------------------------------------------------------ */
function turtlePolicy(opts) {
  opts = opts || {};
  const ref = opts.config || { inf: 700, heavyArt: 26, lightArt: 12, cav: 20, bomber: 1, recon: 1, scout: 2 };
  const sortieTurn = opts.sortieTurn || 34;   // 第 N 回合后且敌空军被清空才考虑出门
  return {
    name: 'turtle',
    deploy(api, side) {
      return scaleConfig(api, ref, api.get('gameBudget')[side]);
    },
    act(api, side, ctx) {
      const acted = api.get('acted');
      const corps = api.get('corps');
      const vis = api.fn.computeVision(side);
      const foes = visibleFoes(api, side, vis);
      const mine = corps.filter((p) => p.alive && p.side === side);
      const [mbr, mbc] = api.get('BASES')[side];
      const [ebr, ebc] = api.get('BASES')[1 - side];
      const roundNo = (ctx && ctx.round) || 0;

      const foeGround = corps.filter((p) => p.alive && p.side !== side && !UU(api, p).air)
        .reduce((s, p) => s + p.troops, 0);
      const foeAir = corps.filter((p) => p.alive && p.side !== side && UU(api, p).air).length;
      const goOut = foeAir === 0 && (roundNo > sortieTurn || foeGround <= 220);

      for (const p of mine) {
        if (api.get('gameOver')) return;
        if (!p.alive || acted.has(p.id)) continue;
        const u = UU(api, p);
        const steps = Math.max(u.move, u.charge || 0);
        const dHome = api.fn.manh(p, { r: mbr, c: mbc });

        if (p.type === 'bomber') {
          if (p.bombs > 0) {
            if (tryRangedFire(api, p, vis)) { acted.add(p.id); continue; }
            if (foes.length && api.fn.aiStepToward(p, vis, foes.slice(0, 4).map((f) => ({ r: f.r, c: f.c })))) {
              acted.add(p.id); continue;
            }
          }
          api.fn.aiStepToward(p, vis, [{ r: mbr, c: mbc }]);
          acted.add(p.id); continue;
        }
        if (p.type === 'recon') {
          if (dHome > 3) api.fn.aiStepToward(p, vis, [{ r: mbr, c: mbc }]);
          else if (foes.length) api.fn.aiStepToward(p, vis, [{ r: foes[0].r, c: foes[0].c }]);
          acted.add(p.id); continue;
        }
        if (p.type === 'scout') {
          if (foes.length) api.fn.aiStepToward(p, vis, foes.slice(0, 3).map((f) => ({ r: f.r, c: f.c })));
          acted.add(p.id); continue;
        }
        if (u.ranged) {
          if (tryRangedFire(api, p, vis)) { acted.add(p.id); continue; }
          if (u.canRest && !p.resting) { api.fn.doRest(p); acted.add(p.id); continue; }
          if (dHome > 5) api.fn.aiStepToward(p, vis, [{ r: mbr, c: mbc }]);
          acted.add(p.id); continue;
        }

        const reach = foes
          .filter((f) => api.fn.manh(p, f) <= steps)
          .sort((a, b) => valueOf(api, b) - valueOf(api, a));

        if (!goOut) {
          if (tryMelee(api, p, vis, steps, reach)) { acted.add(p.id); continue; }
          if (dHome > 4) api.fn.aiStepToward(p, vis, [{ r: mbr, c: mbc }]);
          acted.add(p.id); continue;
        }
        if (tryMelee(api, p, vis, steps, reach)) { acted.add(p.id); continue; }
        api.fn.aiStepToward(p, vis, [{ r: ebr, c: ebc }]);
        acted.add(p.id);
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 *  4) hold：守家流 —— 类似 turtle 但永不主动出门，纯粹消耗
 * ------------------------------------------------------------------ */
function holdPolicy(opts) {
  const base = turtlePolicy(Object.assign({ sortieTurn: 1e9 }, opts || {}));
  return Object.assign({}, base, { name: 'hold' });
}

/* ------------------------------------------------------------------ *
 *  5) random：随机基线 —— 用于压测与对照
 * ------------------------------------------------------------------ */
function randomPolicy(opts) {
  opts = opts || {};
  const ref = opts.config || { inf: 400, cav: 60, lightArt: 20, heavyArt: 10, tank: 6, scout: 2, katyusha: 1 };
  return {
    name: 'random',
    deploy(api, side) {
      return scaleConfig(api, ref, api.get('gameBudget')[side]);
    },
    act(api, side) {
      const acted = api.get('acted');
      const vis = api.fn.computeVision(side);
      const mine = api.get('corps').filter((p) => p.alive && p.side === side);
      const rnd = api.fn.randInt;
      for (const p of mine) {
        if (api.get('gameOver')) return;
        if (!p.alive || acted.has(p.id)) continue;
        const u = UU(api, p);
        const steps = Math.max(u.move, u.charge || 0);
        if (u.ranged && rnd(0, 99) < 55) {
          if (tryRangedFire(api, p, vis)) { acted.add(p.id); continue; }
        }
        if (u.canRest && rnd(0, 99) < 12) { api.fn.doRest(p); acted.add(p.id); continue; }
        const mt = api.fn.computeMoveTargets(p, steps, vis);
        const opts2 = [...mt.empties.keys()].map(api.fn.unkey)
          .concat([...mt.corpsCells.keys()].map(api.fn.unkey));
        if (!opts2.length) { acted.add(p.id); continue; }
        const pick = opts2[rnd(0, opts2.length - 1)];
        const k = api.fn.key(pick.r, pick.c);
        const path = mt.empties.has(k) ? mt.empties.get(k) : (mt.corpsCells.get(k) || {}).path;
        if (path) api.fn.executeMove(p, path);
        acted.add(p.id);
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 *  注册表
 * ------------------------------------------------------------------ */
const REGISTRY = {
  'ai:easy': () => aiPolicy('easy'),
  'ai:medium': () => aiPolicy('medium'),
  'ai:hard': () => aiPolicy('hard'),
  rush: () => rushPolicy(),
  turtle: () => turtlePolicy(),
  hold: () => holdPolicy(),
  random: () => randomPolicy(),
};

/** 把字符串或对象解析成策略对象 */
function resolvePolicy(spec) {
  if (!spec) throw new Error('策略不能为空');
  if (typeof spec === 'object' && typeof spec.act === 'function') return spec;
  const key = String(spec);
  if (!REGISTRY[key]) {
    throw new Error(`未知策略「${key}」，可用：${Object.keys(REGISTRY).join(' | ')}`);
  }
  return REGISTRY[key]();
}

module.exports = {
  resolvePolicy,
  REGISTRY,
  aiPolicy, rushPolicy, turtlePolicy, holdPolicy, randomPolicy,
  scaleConfig, visibleFoes, valueOf, tryRangedFire, tryMelee,
  listPolicies: () => Object.keys(REGISTRY),
};
