/*
 * probe-uimark.js —— 「规模标记」端到端 UI 验证
 * ---------------------------------------------------------------------------
 * 与 probe-sizemark.js 的区别：那个直接测纯函数，这个**跑真实的渲染函数**——
 *   loadEngine({ fast:false }) → 渲染不被打 no-op → 手工摆一个战局 → 调 renderPanel()/renderHoverCard()
 *   → 从 DOM 桩里读回 innerHTML，检查玩家真正会看到的文字与样式类。
 *
 * 战局（20×20，红方视角 viewMode="auto"、current=0）：
 *   (10,10) 己方侦察兵          ← 提供 6 格视野，敌方空中单位才可见
 *   (12,10) 敌方侦察机 recon×1  ← 期望「空」（v3.9.15 会错报「大」）
 *   (14,10) 敌方轰炸机 bomber×1 ← 期望「空」（v3.9.15 会错报「大」）
 *   (10,12) 敌方步兵 ×300       ← 期望「大」（对照）
 *   (10,14) 敌方侦察兵 scout×1  ← 期望「小」（对照，地面规则不变）
 *   (14,14) 敌方步兵 ×30 + 侦察机 ← 期望「小」（30 人，不被空中单位抬高）
 *
 * 用法：node probe-uimark.js [--src ../battlefield-v3.9.16.html]
 */
const { loadEngine } = require('./engine');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const LAYOUT = [
  { side: 1, type: 'recon', troops: 1, r: 12, c: 10, want: '空' },
  { side: 1, type: 'bomber', troops: 1, r: 14, c: 10, want: '空' },
  { side: 1, type: 'inf', troops: 300, r: 10, c: 12, want: '大' },
  { side: 1, type: 'scout', troops: 1, r: 10, c: 14, want: '小' },
  { side: 1, type: 'inf', troops: 30, r: 12, c: 13, want: '小' },
];

function build(src) {
  const api = loadEngine({ fast: false, seed: 7, src });   // fast:false → 渲染是原生实现
  api.set('aiSide', -1);
  api.set('gameBudget', [3000, 3000]);
  api.fn.newGame();

  const H = api.H;
  H.corps.length = 0;
  H.corps.push({ id: 1, side: 0, type: 'scout', troops: 1, r: 10, c: 10, alive: true, resting: false,
                 fatigue: 0, moved: false, lockAtk: false, lockDef: false, dur: 0, flare: 1, smoke: 1, bombs: 0, ammo: false });
  let id = 2;
  for (const e of LAYOUT) {
    H.corps.push({ id: id++, side: e.side, type: e.type, troops: e.troops, r: e.r, c: e.c, alive: true,
                   resting: false, fatigue: 0, moved: false, lockAtk: false, lockDef: false, dur: 0,
                   flare: 2, smoke: 2, bombs: e.type === 'bomber' ? 3 : 0, ammo: false });
  }
  // 同格叠加：30 步兵 + 侦察机
  H.corps.push({ id: id++, side: 1, type: 'recon', troops: 1, r: 12, c: 13, alive: true, resting: false,
                 fatigue: 0, moved: false, lockAtk: false, lockDef: false, dur: 0, flare: 3, smoke: 3, bombs: 0, ammo: false });

  api.set('phase', 'play');
  api.set('current', 0);
  api.set('turnNo', 1);
  api.set('viewMode', 'auto');
  return api;
}

function readDoc(api, id) {
  return api.sandbox.document.getElementById(id).innerHTML || '';
}

function classOf(html, r, c) {
  // 从「规模 <b>X</b> @ (r+1,c+1)」行里抓标记文字
  const re = new RegExp('规模 <b>([^<]*)</b>[^@]*@ \\(' + (r + 1) + ',' + (c + 1) + '\\)');
  const m = html.match(re);
  return m ? m[1] : null;
}

function run(label, src) {
  const api = build(src);
  const S = api.sandbox;
  const out = { label, src: api.src, panel: null, board: null, hover: {}, err: null };

  try {
    S.renderPanel();
    out.panel = readDoc(api, 'enemyList');
    S.renderBoard();                                   // 棋盘格上的规模 chip
    out.board = readDoc(api, 'board');
    for (const e of LAYOUT) {
      api.set('hoverCell', { r: e.r, c: e.c });
      S.renderHoverCard();
      out.hover[e.type + '@' + e.r + ',' + e.c] = readDoc(api, 'hoverInfo');
    }
    api.set('hoverCell', { r: 12, c: 13 });
    S.renderHoverCard();
    out.hover['stack@13,13'] = readDoc(api, 'hoverInfo');
  } catch (e) {
    out.err = e && e.message;
  }
  return out;
}

function main() {
  const newSrc = arg('src', null) || '../battlefield-v3.9.16.html';
  const oldSrc = newSrc.replace('v3.9.16', 'v3.9.15');

  const A = run('v3.9.15 (旧)', oldSrc);
  const B = run('v3.9.16 (新)', newSrc);

  for (const R of [A, B]) {
    console.log('─'.repeat(96));
    console.log(R.label, '·', R.src);
    if (R.err) { console.log('  !! 渲染异常:', R.err); continue; }
    console.log('  [侧栏「敌方兵团」卡片 enemyList]');
    for (const e of LAYOUT) {
      const got = classOf(R.panel, e.r, e.c);
      const flag = got === e.want ? '✅' : '❌';
      console.log(`    ${flag} (${e.r + 1},${e.c + 1}) ${e.type}×${e.troops}  实际=${got}  期望=${e.want}`);
    }
    const st = classOf(R.panel, 12, 13);
    console.log(`    ${st === '小' ? '✅' : '❌'} (14,14) inf×30+recon  实际=${st}  期望=小`);
    console.log('  [悬停卡片 hoverInfo（(13,11) 侦察机格）]');
    const h = R.hover['recon@12,10'] || '';
    const line = (h.match(/规模[^<]*<b>[^<]*<\/b>[^<]*(<span[^>]*>[^<]*<\/span>)?/) || ['(未匹配)'])[0];
    console.log('    ' + line.replace(/\s+/g, ' '));
    console.log('  [棋盘网格 chip（renderBoard）]');
    const chips = [...(R.board || '').matchAll(/enemy-chip[^"]*"[^>]*>([^<]+)</g)].map(m => m[1] + '[' + m[0].split('"')[1] + ']');
    console.log('    本局可见敌方 chip: ' + (chips.join('  ') || '(无)'));
    console.log('  enemyList 片段:');
    console.log('    ' + R.panel.replace(/\s+/g, ' ').slice(0, 260) + ' …');
  }

  // ---- 断言 ----
  console.log('');
  console.log('══════════ 断言 ══════════');
  const checks = [];
  if (!B.err) {
    checks.push(['新：侧栏 侦察机格 → 空', classOf(B.panel, 12, 10) === '空']);
    checks.push(['新：侧栏 轰炸机格 → 空', classOf(B.panel, 14, 10) === '空']);
    checks.push(['新：侧栏 300 步兵 → 大（不变）', classOf(B.panel, 10, 12) === '大']);
    checks.push(['新：侧栏 侦察兵 → 小（不变）', classOf(B.panel, 10, 14) === '小']);
    checks.push(['新：侧栏 30 步兵+侦察机 → 小', classOf(B.panel, 12, 13) === '小']);
    checks.push(['新：棋盘 chip 使用 sz-empty 且文字为「空」', /enemy-chip[^"]*sz-empty"[^>]*>空</.test(B.board || '')]);
    checks.push(['新：棋盘 chip 恰好 2 个「空」（侦察机格 + 轰炸机格）', ((B.board || '').match(/sz-empty"[^>]*>空</g) || []).length === 2]);
    checks.push(['新：悬停卡片注明「仅空中单位」', /（仅空中单位）/.test(B.hover['recon@12,10'] || '')]);
    checks.push(['新：悬停卡片规模为 空', /规模 <b>空<\/b>/.test(B.hover['recon@12,10'] || '')]);
  } else checks.push(['新：渲染无异常', false]);
  if (!A.err) {
    checks.push(['旧：侦察机格确实错报为「大」（复现 bug）', classOf(A.panel, 12, 10) === '大']);
    checks.push(['旧：轰炸机格确实错报为「大」（复现 bug）', classOf(A.panel, 14, 10) === '大']);
    checks.push(['旧：棋盘 chip 无 sz-empty 样式', !/sz-empty/.test(A.board || '')]);
  }
  let fail = 0;
  for (const [n, ok] of checks) { console.log((ok ? '  ✅ ' : '  ❌ ') + n); if (!ok) fail++; }
  console.log(`\n  通过 ${checks.length - fail} / ${checks.length}`);
  process.exit(fail ? 1 : 0);
}

main();
