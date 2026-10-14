'use strict';
/*
 * diag-turtle-endgame.js —— 龟缩对局「终局画像」批量诊断
 * ---------------------------------------------------------------------------
 * 目的：把超时局的终局状态分类，回答「这些局为什么打不完、还有没有的救」。
 * 分类维度：
 *   - 攻方是否还有地面单位；是否还有炮兵；最近地面单位离敌大本营多远
 *   - 守方是否还有地面单位
 *   - 是否处于"双方都清空战场只剩炮兵/空军"的枯竭态
 *
 * 用法：node diag-turtle-endgame.js -n 40 --max-rounds 200
 */

const { loadEngine } = require('./engine');
const { runMatch } = require('./sim');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) {
    const j = process.argv.indexOf('-' + name[0]);
    if (j < 0) return def;
    const v = process.argv[j + 1];
    return (v === undefined || v.startsWith('-')) ? true : v;
  }
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('-')) ? true : v;
}

const n = Number(arg('games', 40));
const maxRounds = Number(arg('max-rounds', 200));
const budget = Number(arg('budget', 3000));
const src = arg('src', null);

const api = loadEngine({ seed: 1, src: src || undefined });
const U = api.get('UNITS');

function classify(a) {
  const BASES = a.get('BASES');
  const [gr, gc] = BASES[1];
  let atkGround = 0, atkArt = 0, atkAir = 0, atkMelee = 0, atkMeleeAtHome = 0;
  let dMin = 99, inRange = 0;
  for (const p of a.get('corps')) {
    if (!p.alive || p.side !== 0) continue;
    const u = U[p.type];
    if (u.air) { atkAir++; continue; }
    if (u.cls === 'art') { atkArt++; }
    atkGround++;
    if (['inf', 'cav', 'scout'].includes(p.type)) {
      atkMelee++;
      if (Math.abs(p.r - BASES[0][0]) + Math.abs(p.c - BASES[0][1]) <= 4) atkMeleeAtHome++;
    }
    const d = Math.abs(p.r - gr) + Math.abs(p.c - gc);
    if (d < dMin) dMin = d;
    if (u.cls === 'art' && d <= (u.range || 0)) inRange++;
  }
  let defGround = 0, defArt = 0;
  for (const p of a.get('corps')) {
    if (!p.alive || p.side !== 1) continue;
    if (U[p.type].air) continue;
    defGround++;
    if (U[p.type].cls === 'art') defArt++;
  }
  return { atkGround, atkArt, atkAir, atkMelee, atkMeleeAtHome, dMin: dMin === 99 ? -1 : dMin, inRange, defGround, defArt };
}

const t0 = Date.now();
const rows = [];
for (let i = 0; i < n; i++) {
  const r = runMatch(api, { red: 'ai:medium', blue: 'turtle', budget, map: 'gen', seed: 1000 + i, maxRounds });
  const end = classify(api);
  rows.push({ seed: 1000 + i, winner: r.winner, reason: r.reason, turns: r.turns, ...end });
}

const wins = rows.filter((x) => x.winner === 0).length;
const timeouts = rows.filter((x) => x.reason === 'timeout');
console.log(`\n对局 ${n} 局 · 攻方(medium) 胜 ${wins} (${(wins / n * 100).toFixed(1)}%) · 超时 ${timeouts.length} · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.log('\n【超时局终局画像】');
const buckets = {};
for (const x of timeouts) {
  let k;
  if (x.atkGround === 0) k = 'A. 攻方无地面单位（全灭/只剩空军）';
  else if (x.defGround === 0) k = 'B. 守方无地面单位（攻方竟未终结）';
  else if (x.atkMelee === 0) k = 'C. 攻方无近战（只剩炮兵）';
  else if (x.atkMeleeAtHome === x.atkMelee) k = 'D. 攻方近战全缩在自家基地';
  else if (x.dMin > 9) k = 'E. 攻方近战推进受阻（离敌基地 >9，炮兵射程外）';
  else k = 'F. 已贴脸但啃不动（≤9 格内僵持）';
  buckets[k] = (buckets[k] || 0) + 1;
}
for (const k of Object.keys(buckets).sort()) console.log(`  ${String(buckets[k]).padStart(3)}  ${k}`);

console.log('\n【超时局明细】 seed 回合 | 攻:地面/炮/空/近战(在家) dMin 射程内 | 守:地面/炮');
for (const x of timeouts.slice(0, 30)) {
  console.log(`  ${String(x.seed).padStart(5)} ${String(x.turns).padStart(4)} |` +
    ` ${String(x.atkGround).padStart(3)}/${String(x.atkArt).padStart(2)}/${String(x.atkAir).padStart(2)}/` +
    `${String(x.atkMelee).padStart(3)}(${String(x.atkMeleeAtHome).padStart(2)})` +
    ` ${String(x.dMin).padStart(3)} ${String(x.inRange).padStart(2)} |` +
    ` ${String(x.defGround).padStart(3)}/${String(x.defArt).padStart(2)}`);
}

console.log('\n【胜局回合数】', rows.filter((x) => x.winner === 0).map((x) => x.turns).join(' '));
