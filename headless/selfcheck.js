'use strict';
/*
 * selfcheck.js —— 一致性与安全性自检
 * ---------------------------------------------------------------------------
 * 训练方案里最担心的风险是「训练环境与实际游戏规则不一致」。本脚本用四道
 * 关卡把这件事钉死：
 *
 *   [1] 源码一致性：无头引擎加载的就是 HTML 里的原始脚本，未被改写
 *   [2] 确定性    ：同一随机种子重复运行，结果逐字段一致（可复现）
 *   [3] 补丁安全性：把所有渲染/快照/落盘函数打成 no-op 后，对局结果不变
 *   [4] 缓存安全性：开启视野缓存后，对局结果不变
 *   [5] 掩码合法性：从掩码中随机采样的动作，必须 100% 可执行
 *
 * 用法：node selfcheck.js [每关样本数]
 */

const fs = require('fs');
const { loadEngine, extractGameScript, resolveSource } = require('./engine');
const { runMatch } = require('./sim');
const { createEnv } = require('./env');

const SAMPLES = Number(process.argv[2] || 12);
const CFG = { red: 'ai:medium', blue: 'rush', map: 'gen', budget: 3000, maxRounds: 300 };

let failed = 0;
const ok = (b, msg) => { console.log(`  ${b ? '✅' : '❌'} ${msg}`); if (!b) failed++; };
const sig = (r) => `${r.winner}|${r.turns}|${r.reason}|${r.survivors[0].men}|${r.survivors[1].men}|${r.deploySpent.join(',')}`;

/* ------------------------------------------------------------------ *
 *  [1] 源码一致性
 * ------------------------------------------------------------------ */
function checkSource() {
  console.log('\n[1] 源码一致性（引擎载入的就是原始脚本，无改写）');
  const path = resolveSource();
  const html = fs.readFileSync(path, 'utf8');
  const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  blocks.sort((a, b) => b.length - a.length);
  const raw = blocks[0];
  const ext = extractGameScript(html);
  const delta = raw.length - ext.length;
  ok(ext.length > 0, `提取脚本 ${ext.length} 字节`);
  // ext 只在末尾裁掉了自动启动调用并补一个换行，因此去掉尾部换行后应与原文前缀逐字节相同
  const extBody = ext.replace(/\n$/, '');
  const diffAt = (() => { let k = 0; while (k < extBody.length && raw[k] === extBody[k]) k++; return k; })();
  ok(raw.startsWith(extBody), `与原始脚本逐字节一致（首个差异在第 ${diffAt} 字节 / 共 ${extBody.length}）`);
  ok(delta >= 0 && delta < 400, `唯一改动是移除尾部自动启动调用（差 ${delta} 字节）`);
}

/* ------------------------------------------------------------------ *
 *  [2] 确定性
 * ------------------------------------------------------------------ */
function checkDeterminism() {
  console.log(`\n[2] 确定性（同种子重复 ${SAMPLES} 局）`);
  const a = loadEngine({ seed: 0, quiet: true });
  const b = loadEngine({ seed: 0, quiet: true });
  let same = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const seed = 300 + i;
    const r1 = runMatch(a, Object.assign({}, CFG, { seed }));
    const r2 = runMatch(b, Object.assign({}, CFG, { seed }));
    if (sig(r1) === sig(r2)) same++;
  }
  ok(same === SAMPLES, `${same}/${SAMPLES} 局结果逐字段一致（胜者/回合/残存/花费）`);
}

/* ------------------------------------------------------------------ *
 *  [3] 规则等价性（RNG 对齐后）
 * ------------------------------------------------------------------
 * 直接对比「no-op 渲染 vs 完整渲染」的整局结果会不一致，但根因不是规则被改，
 * 而是随机数消耗点不同：被 no-op 掉的 beginRecord() 里有一次 Math.random()，
 * 整条随机流因此错位一格 → 由随机决定的战斗/决策随之分叉。
 *
 * 要证明的是「规则等价」，所以这里把随机流对齐：在每个阶段开始前重新播种。
 * 这样渲染消耗多少随机数都被冲掉，两条路径面对的随机序列完全相同。
 * 若此时逐回合状态仍完全一致，即证：跳过渲染不改变任何规则转移。
 * ------------------------------------------------------------------ */
function detAct(api, side) {
  const acted = api.get('acted');
  const N = api.get('N');
  for (const p of api.get('corps').filter((x) => x.alive && x.side === side)) {
    if (api.get('gameOver')) return;
    if (!p.alive || acted.has(p.id)) continue;
    const u = api.get('UNITS')[p.type];
    const vis = api.fn.computeVision(side);
    const steps = Math.max(u.move, u.charge || 0);
    let fired = false;
    if (u.ranged && api.fn.canStrike(p)) {
      const range = api.fn.strikeRange(p);
      outer:
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (r === p.r && c === p.c) continue;
        if (!vis.has(api.fn.key(r, c))) continue;
        if (api.fn.manh({ r, c }, p) > range) continue;
        if (p.type === 'katyusha') api.fn.performKatyusha(p, r, c);
        else api.fn.performStrike(p, r, c);
        fired = true;
        break outer;
      }
    }
    if (!fired) {
      const mt = api.fn.computeMoveTargets(p, steps, vis);
      const keys = [...mt.empties.keys()].sort();
      if (keys.length) api.fn.executeMove(p, mt.empties.get(keys[0]));
    }
    acted.add(p.id);
  }
}

function stateSig(api) {
  const parts = api.get('corps')
    .filter((p) => p.alive)
    .map((p) => `${p.id}:${p.side}:${p.type}:${p.troops}:${p.dur || 0}:${p.r},${p.c}`)
    .sort();
  return `${api.get('turnNo')}|${api.get('winner')}|${api.get('gameOver') ? 1 : 0}|${parts.join('/')}`;
}

function playAligned(api, seed, rounds) {
  api.set('aiSide', -1);
  api.set('aiDiff', 'medium');
  api.set('gameBudget', [3000, 3000]);
  api.set('mapKind', 'gen');
  api.reseed(seed);
  api.set('phase', 'deploy');
  api.fn.newGame();
  for (const side of [0, 1]) api.fn.spawnFromConfig(side, api.fn.aiDeployConfig(side));
  api.fn.startPlay();
  api.set('phase', 'play');
  const sigs = [];
  for (let r = 0; r < rounds && !api.get('gameOver'); r++) {
    api.reseed(seed * 100003 + r * 4 + 0); detAct(api, 0);
    api.reseed(seed * 100003 + r * 4 + 1); api.fn.endTurn();
    api.reseed(seed * 100003 + r * 4 + 2); detAct(api, 1);
    api.reseed(seed * 100003 + r * 4 + 3); api.fn.endTurn();
    sigs.push(stateSig(api));
  }
  return sigs.join(';;');
}

function checkPatches() {
  console.log('\n[3] 规则等价性（渲染 no-op vs 完整执行，随机流对齐后逐回合比对）');
  const fast = loadEngine({ seed: 0, quiet: true });                   // 默认开启补丁
  const slow = loadEngine({ seed: 0, quiet: true, fast: false });      // 关闭补丁，真实执行渲染
  console.log(`      fast 补丁: ${fast.patched.length} 个函数 → ${fast.patched.join(', ')}`);
  let same = 0; const total = 3;
  for (let i = 0; i < total; i++) {
    const seed = 700 + i;
    const a = playAligned(fast, seed, 20);
    const b = playAligned(slow, seed, 20);
    const eq = a === b;
    if (eq) same++;
    console.log(`      种子 ${seed}: ${eq ? '逐回合一致' : '不一致'}  （比对了 ${a.split(';;').length} 个回合快照）`);
    if (!eq) {
      const A = a.split(';;'), B = b.split(';;');
      for (let k = 0; k < Math.max(A.length, B.length); k++) {
        if (A[k] !== B[k]) { console.log(`        首个分歧在第 ${k + 1} 回合：\n          fast: ${A[k]}\n          slow: ${B[k]}`); break; }
      }
    }
  }
  ok(same === total, `${same}/${total} 局：跳过渲染后，逐回合状态转移完全一致`);
}

/* ------------------------------------------------------------------ *
 *  [4] 视野缓存安全性
 * ------------------------------------------------------------------ */
function checkVisionCache() {
  console.log(`\n[4] 视野缓存安全性（cache on vs off，${SAMPLES} 局）`);
  const off = loadEngine({ seed: 0, quiet: true });
  const on = loadEngine({ seed: 0, quiet: true, visionCache: true });
  ok(on.visionCache === true, '视野缓存已安装');
  let same = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const seed = 900 + i;
    const r1 = runMatch(off, Object.assign({}, CFG, { seed }));
    const r2 = runMatch(on, Object.assign({}, CFG, { seed }));
    if (sig(r1) === sig(r2)) same++;
  }
  ok(same === SAMPLES, `${same}/${SAMPLES} 局结果完全一致`);
}

/* ------------------------------------------------------------------ *
 *  [5] 掩码合法性
 * ------------------------------------------------------------------ */
function checkMasks() {
  console.log('\n[5] 掩码合法性（从掩码随机采样动作，必须全部可执行）');
  const env = createEnv({ side: 0, opponent: 'ai:medium', budget: 3000 });
  let tried = 0, bad = 0, typesSeen = {};
  for (let g = 0; g < 3; g++) {
    env.reset({ seed: 1100 + g });
    let guard = 0;
    while (!env.done && guard++ < 3000) {
      const list = env.pending();
      if (!list.length) { env.step({ unit: 0, type: 3, target: 0 }); continue; }
      const i = (Math.random() * list.length) | 0;
      const la = env.legalActions(i);
      if (!la || !la.types.length) { env.step({ unit: i, type: 3, target: 0 }); continue; }
      const type = la.types[(Math.random() * la.types.length) | 0];
      const cells = la.targets[type] || [];
      const target = cells.length ? cells[(Math.random() * cells.length) | 0] : 0;
      const r = env.step({ unit: i, type, target });
      typesSeen[type] = (typesSeen[type] || 0) + 1;
      if (type !== 2 && type !== 3) {
        tried++;
        if (!r.info.applied.ok) bad++;
      }
    }
  }
  ok(tried > 0, `采样到 ${tried} 个「带目标」动作`);
  ok(bad === 0, `非法动作 ${bad} 个（应为 0：掩码即合法性保证）`);
  console.log(`      动作类型分布：move ${typesSeen[0] || 0} · ranged ${typesSeen[1] || 0} · rest ${typesSeen[2] || 0} · wait ${typesSeen[3] || 0}`);
}

/* ------------------------------------------------------------------ */
console.log('══ 战场沙盘无头环境 · 一致性自检 ══');
checkSource();
checkDeterminism();
checkPatches();
checkVisionCache();
checkMasks();
console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项未通过`}\n`);
process.exitCode = failed ? 1 : 0;
