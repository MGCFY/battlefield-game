'use strict';
/*
 * probe-branch.js —— 分支指纹探针：逐单位记录一回合内「到底做了什么」
 * ---------------------------------------------------------------------------
 * 做法：在 vm 沙盒里把动作原语换成"记录后再放行"的包装（与渲染 no-op 同一机制），
 *       从而在不改动游戏逻辑的前提下看清 AI 每回合的实际决策分支。
 *
 * 用法：
 *   node probe-branch.js --seed 1 --from 55 --to 75 --side 0
 */

const { loadEngine } = require('./engine');
const { prepare, runMatch } = require('./sim');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('-')) ? true : v;
}

const seed = Number(arg('seed', 1));
const from = Number(arg('from', 50));
const to = Number(arg('to', 80));
const focus = Number(arg('side', 0));
const maxRounds = Number(arg('max-rounds', 200));

const api = loadEngine({ seed, src: arg('src', null) || undefined });
const sb = api.sandbox;
const H = api.H;

/* ---------- 记录器 ---------- */
let curTurn = 0;
const events = new Map();       // unitId -> [string]
function log(id, what) {
  if (!events.has(id)) events.set(id, []);
  events.get(id).push(what);
}

/* 包装动作原语。注意：必须在游戏内部调用点之前替换沙盒全局，机制同渲染 no-op。 */
function wrap(name, make) {
  if (typeof sb[name] !== 'function') { console.log('!! 未找到', name); return; }
  const orig = sb[name];
  sb[name] = make(orig);
}

wrap('executeMove', (fn) => function (p) { log(p.id, 'move→(' + arguments[1][arguments[1].length - 1].r + ',' + arguments[1][arguments[1].length - 1].c + ')'); return fn.apply(this, arguments); });
wrap('performStrike', (fn) => function (p, r, c) { log(p.id, 'strike(' + r + ',' + c + ')'); return fn.apply(this, arguments); });
wrap('performKatyusha', (fn) => function (p, r, c) { log(p.id, 'katyusha(' + r + ',' + c + ')'); return fn.apply(this, arguments); });
wrap('performBomb', (fn) => function (p, r, c) { log(p.id, 'bomb(' + r + ',' + c + ')'); return fn.apply(this, arguments); });
wrap('doRest', (fn) => function (p) { log(p.id, 'rest'); return fn.apply(this, arguments); });
wrap('resolveBattle', (fn) => function (units, r, c) { for (const q of units) log(q.id, 'melee(' + r + ',' + c + ')'); return fn.apply(this, arguments); });
wrap('performGroupCharge', (fn) => function (side, r, c, ids) {
  log(ids[0], 'GROUPCHARGE×' + ids.length + '→(' + r + ',' + c + ')');
  return fn.apply(this, arguments);
});
wrap('aiStepToward', (fn) => function (p) {
  const ret = fn.apply(this, arguments);
  log(p.id, 'stepTowards' + (ret ? '' : '✗(不可达→空转)'));
  return ret;
});

/* ---------- 跑 ---------- */
const res = runMatch(api, {
  red: 'ai:medium', blue: 'turtle', budget: 3000, map: 'gen', seed, maxRounds,
  onRound(a, round) {
    curTurn = a.get('turnNo');
    if (curTurn < from || curTurn > to) { events.clear(); return; }
    const U = a.get('UNITS');
    const alive = a.get('corps').filter((p) => p.alive && p.side === focus);
    console.log(`\n── 第 ${curTurn} 回合  side${focus} 单位 ${alive.length} 个  兵力 ${Math.round(a.strength(focus).value)}` +
      `  doc=${a.get('aiDoctrine')[focus]} ph=${a.get('aiTurtlePhase')[focus]} tur=${a.get('aiThreatProfile')[focus].turtle}`);
    for (const p of alive) {
      const ev = events.get(p.id) || ['(无动作/空转)'];
      const u = U[p.type];
      console.log(`   ${String(p.type).padEnd(9)}@(${String(p.r).padStart(2)},${String(p.c).padStart(2)})` +
        ` 兵${String(p.troops).padStart(4)} rest${p.resting ? 1 : 0} fat${p.fatigue || 0}` +
        ` rng${u.range || '-'}  →  ${ev.join(' , ')}`);
    }
    const foe = a.get('corps').filter((p) => p.alive && p.side !== focus);
    console.log('   敌军: ' + foe.map((p) => `${p.type}@(${p.r},${p.c})/${p.troops}`).join(' '));
    events.clear();
  },
});
console.log(`\n结果: ${res.winnerName || '未决'} / ${res.reason} / ${res.turns} 回合`);
