/*
 * probe-sizemark.js —— 「规模标记」特性回归探针
 * ---------------------------------------------------------------------------
 * 验证 v3.9.16 的情报标记改动：敌方空中单位（侦察机 cost200 / 轰炸机 cost500）不再计入
 * enemySizeClass 的规模折算；该格若除空中单位外没有地面兵团，标记为「空」。
 *
 * v3.9.15 之所以会把「只有一架侦察机」的格子报成「大」：规模 = Σ(cost × troops)，
 * 侦察机 200×1 恰好触到 ≥200 的「大」阈值，轰炸机 500×1 更是直接爆表。
 *
 * 用法：node probe-sizemark.js [--src ../battlefield-v3.9.16.html]
 */
const { loadEngine } = require('./engine');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const SRC = arg('src', null);

function mk(type, troops) { return { alive: true, side: 1, type, troops, r: 5, c: 5, id: 99 }; }

const CASES = [
  ['（空数组·实际调用不会出现）', []],
  ['1 架侦察机 recon×1', [mk('recon', 1)]],
  ['1 架轰炸机 bomber×1', [mk('bomber', 1)]],
  ['2 架轰炸机 bomber×2', [mk('bomber', 2)]],
  ['1 支侦察兵 scout×1', [mk('scout', 1)]],
  ['侦察机 + 侦察兵', [mk('recon', 1), mk('scout', 1)]],
  ['步兵 30 人', [mk('inf', 30)]],
  ['步兵 120 人', [mk('inf', 120)]],
  ['步兵 250 人', [mk('inf', 250)]],
  ['坦克 5 辆', [mk('tank', 5)]],
  ['步兵 250 + 侦察机', [mk('inf', 250), mk('recon', 1)]],
  ['步兵 30 + 轰炸机', [mk('inf', 30), mk('bomber', 1)]],
];

function run(label, src) {
  const api = loadEngine(src ? { seed: 1, src } : { seed: 1 });
  const esc = api.fn.enemySizeClass;
  const out = CASES.map(([name, stack]) => [name, esc(stack)]);
  return { label, src: api.src, out };
}

function main() {
  const oldSrc = SRC ? SRC.replace('v3.9.16', 'v3.9.15') : '../battlefield-v3.9.15.html';
  const newSrc = SRC || '../battlefield-v3.9.16.html';

  const A = run('v3.9.15 (旧)', oldSrc);
  const B = run('v3.9.16 (新)', newSrc);

  console.log('源文件 A:', A.src);
  console.log('源文件 B:', B.src);
  console.log('');
  const w = 26;
  console.log('输入'.padEnd(w) + '│ ' + 'v3.9.15'.padEnd(10) + '│ ' + 'v3.9.16'.padEnd(10) + '│ 变化');
  console.log('─'.repeat(w + 1) + '┼' + '─'.repeat(12) + '┼' + '─'.repeat(12) + '┼' + '─'.repeat(12));

  let changed = 0, ok = 0, fail = 0;
  for (let i = 0; i < CASES.length; i++) {
    const a = A.out[i][1], b = B.out[i][1];
    const diff = a !== b ? `** ${a} → ${b}` : '   —';
    if (a !== b) changed++;
    // 只有「含空中单位」的用例才允许变化；「空数组」用例是定义域边界，另行标注
    if (a !== b && i !== 0 && !CASES[i][1].some(p => isAir(p))) {
      fail++; console.log(`  !! 用例「${CASES[i][0]}」不含空中单位，不应变化`);
    }
    if (a !== b && i === 0) console.log('  ·  「空数组」是定义域边界（真实调用点均保证非空），新旧行为不同属预期');
    console.log(CASES[i][0].padEnd(w) + '│ ' + a.padEnd(9) + '│ ' + b.padEnd(9) + '│ ' + diff);
  }
  console.log('');
  console.log(`变化用例: ${changed} / ${CASES.length}`);

  // 关键断言（v3.9.16 必须满足）
  const checks = [
    ['空数组 → 空（边界，兜底不崩）', B.out[0][1] === '空'],
    ['仅侦察机 → 空（旧版为「大」）', B.out[1][1] === '空' && A.out[1][1] === '大'],
    ['仅轰炸机 → 空（旧版为「大」）', B.out[2][1] === '空' && A.out[2][1] === '大'],
    ['仅侦察兵 → 小（地面规则不变）', B.out[4][1] === '小' && A.out[4][1] === '小'],
    ['侦察机+侦察兵 → 小（地面只剩侦察兵）', B.out[5][1] === '小'],
    ['步兵 120 → 中（不变）', B.out[7][1] === '中' && A.out[7][1] === '中'],
    ['步兵 250 → 大（不变）', B.out[8][1] === '大' && A.out[8][1] === '大'],
    ['步兵250+侦察机 → 大（只算地面）', B.out[10][1] === '大' && A.out[10][1] === '大'],
    ['步兵30+轰炸机 → 小（不被轰炸机抬高）', B.out[11][1] === '小' && A.out[11][1] === '大'],
  ];
  console.log('');
  for (const [name, okv] of checks) {
    console.log((okv ? '  ✅ ' : '  ❌ ') + name);
    if (okv) ok++; else fail++;
  }
  console.log('');
  console.log(`断言: ${ok} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

function isAir(p) { return ['recon', 'bomber'].includes(p.type) || p.type === 'air'; }

main();
