'use strict';
/*
 * probe-turtle.js —— 单局逐步探针：中等 AI 打龟缩流「卡在哪一步」
 * ---------------------------------------------------------------------------
 * 用法：
 *   node probe-turtle.js --seed 1 --max-rounds 200
 *   node probe-turtle.js --seed 1 --every 5 --max-rounds 200 --side ai:medium
 *
 * 输出每 K 回合一行，字段：
 *   T      turnNo
 *   doc    AI 当前 doctrine（hunt/capture/defend/hold）
 *   ph     aiTurtlePhase（0=未识别 1=炮兵压制 2=突击 3=孤注一掷）
 *   tur    aiThreatProfile.turtle（迟滞计数）
 *   A地面  攻方（默认 ai:medium）地面兵力当量
 *   A炮    攻方炮兵门数（lightArt+heavyArt）
 *   A坦/喀 攻方坦克 / 喀秋莎门数
 *   dBase  攻方地面部队距敌大本营的最近曼哈顿距离
 *   in9    攻方落在敌重炮射程覆盖圈（≤9）内的地面单位数
 *   D地面  守方（默认 turtle）地面兵力当量
 *   D炮    守方炮兵门数
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
const maxRounds = Number(arg('max-rounds', 200));
const every = Number(arg('every', 4));
const redSpec = String(arg('side', 'ai:medium'));
const blueSpec = String(arg('foe', 'turtle'));
const budget = Number(arg('budget', 3000));

const api = loadEngine({ seed, src: arg('src', null) || undefined });
const H = () => api.get('aiDiag');

function groundPow(side) {
  const UNITS = api.get('UNITS');
  let v = 0;
  for (const p of api.get('corps')) {
    if (!p.alive || p.side !== side || UNITS[p.type].air) continue;
    v += p.troops * UNITS[p.type].cost;
  }
  return v;
}
function countOf(side, types) {
  let n = 0, men = 0;
  for (const p of api.get('corps')) {
    if (!p.alive || p.side !== side || !types.includes(p.type)) continue;
    n++; men += p.troops || 0;
  }
  return { n, men };
}
function census(side) {
  const out = {};
  for (const p of api.get('corps')) {
    if (!p.alive || p.side !== side) continue;
    out[p.type] = (out[p.type] || 0) + 1;
  }
  return out;
}

const cfg = { red: redSpec, blue: blueSpec, budget, map: 'gen', seed, maxRounds };
const t0 = Date.now();
let prev = { 0: null, 1: null };

console.log('─'.repeat(110));
console.log('   T doc        ph tur   A地面  A炮 坦/喀 dBase in9   D地面  D炮    损失(攻/守)');
console.log('─'.repeat(110));

const res = runMatch(api, Object.assign({}, cfg, {
  onRound(a, round) {
    if (round % every !== 0) return;
    const [er, ec] = a.get('BASES')[1];
    const [br, bc] = a.get('BASES')[0];
    let dMin = 99, in9 = 0;
    for (const p of a.get('corps')) {
      if (!p.alive || p.side !== 0 || a.get('UNITS')[p.type].air) continue;
      const d = Math.abs(p.r - er) + Math.abs(p.c - ec);
      if (d < dMin) dMin = d;
      if (d <= 9) in9++;
    }
    const d = a.get('aiDiag') || {};
    const g0 = Math.round(groundPow(0)), g1 = Math.round(groundPow(1));
    const art0 = countOf(0, ['lightArt', 'heavyArt']).n, art1 = countOf(1, ['lightArt', 'heavyArt']).n;
    const dmg0 = prev[0] === null ? 0 : prev[0] - g0;
    const dmg1 = prev[1] === null ? 0 : prev[1] - g1;
    prev[0] = g0; prev[1] = g1;
    console.log(
      [
        String(a.get('turnNo')).padStart(4),
        String(a.get('aiDoctrine')[0]).padEnd(8),
        String(a.get('aiTurtlePhase') ? a.get('aiTurtlePhase')[0] : '-').padStart(2),
        String(d.prof ? d.prof.turtle : '-').padStart(3),
        String(g0).padStart(6),
        String(art0).padStart(3),
        String(countOf(0, ['tank']).n + '/' + countOf(0, ['katyusha']).n).padStart(4),
        String(dMin === 99 ? '-' : dMin).padStart(5),
        String(in9).padStart(4),
        String(g1).padStart(6),
        String(art1).padStart(4),
        (' 损失 ' + dmg0 + '/' + dmg1).padStart(12),
        d.turtleStance ? ' [TURTLE]' : '',
      ].join(' ')
    );
  },
}));

console.log('─'.repeat(110));
console.log(`结果: 胜者=${res.winnerName || '未决'} 原因=${res.reason} 回合=${res.turns} 轮=${res.rounds} 耗时=${res.ms | 0}ms`);
console.log('初始兵力:', JSON.stringify(res.initial), '残存:', JSON.stringify({ 0: res.survivors[0], 1: res.survivors[1] }));
console.log('攻方编成:', JSON.stringify(census(0)));
console.log('守方编成:', JSON.stringify(census(1)));
console.log('大本营:', JSON.stringify(api.get('BASES')), ' aiGuardId:', JSON.stringify(api.get('aiGuardId')));
console.log('存活单位:');
for (const p of api.get('corps')) {
  if (!p.alive) continue;
  const U = api.get('UNITS')[p.type];
  console.log(`  side${p.side} ${p.type.padEnd(9)} @(${String(p.r).padStart(2)},${String(p.c).padStart(2)})` +
    ` 兵=${String(p.troops).padStart(4)} resting=${p.resting ? 1 : 0}` +
    ` fatigue=${p.fatigue || 0} dur=${p.dur === undefined ? '-' : p.dur}` +
    (U.air ? ' [air]' : '') + (api.get('aiGuardId')[p.side] === p.id ? ' ★卫兵' : ''));
}
console.log('末次 doctrine 诊断:', JSON.stringify(H() ? {
  doc: H().doc, why: api.get('aiWhy'), turtleRatio: +H().turtleRatio.toFixed(3),
  enNearMyBaseCount: H().enNearMyBaseCount, myCentDist: +H().myCentDist.toFixed(1),
  enCombat: Math.round(H().enCombat), my: Math.round(H().my),
} : null));
