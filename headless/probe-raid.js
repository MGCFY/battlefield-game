'use strict';
/*
 * probe-raid.js —— 骑兵绕后（role:"raid"）分支的**合成场景**验证
 * ---------------------------------------------------------------------------
 * 为什么需要它：v3.9.23 的绕后分支在「AI 对 AI」基准里贡献恒为 0 —— 当前 AI 惯于叠兵，
 * 炮兵与全军同格，判据「目标 3 格内敌步骑 < 突袭队×1.2」永远不满足。所以常规对局统计
 * 证明不了这段代码是活的，必须人工构造一个「后置炮阵 + 无护卫」的局面。
 *
 * 场景：红方困难档 vs 蓝方中等档，部署后把蓝方一门重炮单独挪到 (2,17)，其余蓝军压回 (16,16)，
 * 红骑推到 (6,17)（距炮 4 格）。若分支正常，本回合应出现 role=raid 的分队。
 *
 * 用法：
 *   node probe-raid.js              # 用 DEFAULT_SRC（最新版）
 *   node probe-raid.js --src ../battlefield-v3.9.23.html
 *
 * 注意：回合必须从 **T2** 起跑。T1 的 aiPlanSplits 已被 confirmDeploy 内部的 aiPlanTurn
 * 用 `side|turnNo` 打过戳，再调 aiAct 会整段跳过规划（roles 恒为空）。
 */
const { loadEngine } = require('./engine.js');

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  return process.argv[i + 1];
};

const api = loadEngine({ fast: true, seed: Number(arg('seed', 3)), src: arg('src', null) || undefined });
api.set('aiSide', -1);
api.set('gameBudget', [3000, 3000]);
api.fn.newGame();
const H = api.H;

const deploy = (side, diff) => {
  api.set('aiDiff', diff);
  H.deploySide = side;
  H.deployCfg = api.fn.aiDeployConfig(side);
  api.fn.confirmDeploy();
};
deploy(0, 'hard');
deploy(1, 'medium');
H.phase = 'play';
H.current = 0;
H.turnNo = 2;

const manh = api.fn.manh;
const foil = H.corps.find(p => p.alive && p.side === 1 && p.type === 'heavyArt');
if (!foil) { console.log('❌ 蓝方没有重炮，无法构造场景'); process.exit(1); }
foil.r = 2; foil.c = 17; foil.troops = 9;
for (const p of H.corps) if (p.alive && p.side === 1 && p !== foil) { p.r = 16; p.c = 16; }
const cav = H.corps.find(p => p.alive && p.side === 0 && p.type === 'cav');
if (!cav) { console.log('❌ 红方没有骑兵，无法构造场景'); process.exit(1); }
cav.r = 6; cav.c = 17; cav.troops = 70;

console.log(`源文件  ${api.src}`);
console.log(`场景    蓝重炮 @${foil.r},${foil.c}（无护卫） · 红骑×${cav.troops} @${cav.r},${cav.c} · 距离 ${manh(cav, foil)}`);

api.set('aiDiff', 'hard');
api.fn.aiAct(0);

const diag = H.aiDiag || {};
const roles = diag.roles || [];
const raid = roles.filter(x => String(x).endsWith(':raid'));
console.log(`角色分配 ${roles.length ? roles.join(' | ') : '（无）'} · 剩余分兵预算 ${diag.splitCap}`);
if (raid.length) {
  console.log(`✅ 绕后分支已触发：${raid.join(' ')} → 目标 (2,17)`);
  process.exit(0);
}
console.log('❌ 未触发（判据：目标距我方压线近战 ≥6 格 / 突袭队 ≤9 格 / 目标 3 格内敌步骑 < 突袭队×1.2）');
process.exit(1);
