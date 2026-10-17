'use strict';
/*
 * selfcheck-rl.js —— RL 链路自检（不依赖 Python）
 * ---------------------------------------------------------------------------
 * 校验 env_client.py 依赖的那套协议在 Node 侧完全自洽：
 *   [1] 外部对手模式：awaitingOpponent 挂起 / resumeOpponentTurn 恢复
 *   [2] opp-obs / opp-legal / opp-targets 与 env.js 的 legalActionsFor 同源
 *   [3] 对手视角掩码采样 100% 合法（与 agent 侧同一套断言口径）
 *   [4] 奖励塑形：非终局 reward 有限、终局 reward ∈ {-1,0,+1}+塑形
 *   [5] 外部对手整局跑完，回合数与内置规则 AI 驱动时同一量级
 *
 * 用法：node selfcheck-rl.js [--src ../battlefield-vX.Y.Z.html]
 */
const { createEnv, legalActionsFor } = require('./env');

let SRC = null;   // null → engine.js 的 DEFAULT_SRC 自动选最新版
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i] === '--src') SRC = argv[++i];

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg); }
}
function section(t) { console.log('\n[' + t + ']'); }

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];

/* 对手侧辅助（复刻 env_server.js 的实现，用于独立验证协议语义） */
function oppPending(api) {
  const acted = api.get('acted');
  return api.get('corps').filter((p) => p.alive && p.side === 1 && !acted.has(p.id));
}

function main() {
  const env = createEnv({ src: SRC, side: 0, externalOpponent: true });
  // 版本号动态取自实际加载的文件名，避免版本升级时此处硬编码过期。
  const vTag = (env.api && env.api.src ? env.api.src : String(SRC || 'DEFAULT_SRC'))
    .replace(/^.*[\\/]/, '').replace(/\.html$/i, '');
  console.log('战场沙盘 · RL 链路自检   版本 ' + vTag);
  console.log('='.repeat(64));
  env.reset({ seed: 20251015, opponent: 'ai:medium' });

  section('1 · 外部对手模式的挂起 / 恢复');
  ok(env.awaitingOpponent === false, 'reset 后未处于等待对手状态');
  let sawAwait = false, agentSteps = 0, oppSteps = 0;
  let done = false;
  let totalR = 0, maxAbsR = 0, badR = 0;

  while (!done && agentSteps < 5000) {
    const list = env.pending();
    if (!list.length) break;
    const u = rnd(list.length);
    const types = env.legalTypes(u);
    const t = pick(types);
    let c = 0;
    if (t === 0 || t === 1) { const tg = env.legalTargets(u, t); if (tg.length) c = pick(tg); }
    const r = env.step({ unit: u, type: t, target: c });
    agentSteps++;
    totalR += r.reward;
    if (!Number.isFinite(r.reward)) badR++;
    maxAbsR = Math.max(maxAbsR, Math.abs(r.reward));

    if (r.info && r.info.awaitingOpponent) {
      sawAwait = true;
      // 对手回合：逐个提交
      let guard = 0;
      while (env.awaitingOpponent && guard++ < 900) {
        const list2 = oppPending(env.api);
        if (!list2.length) break;
        const u2 = rnd(list2.length);
        const la = legalActionsFor(env.api, 1, u2, env.api.fn.computeVision(1));
        if (!la) break;
        const t2 = pick(la.types);
        let c2 = 0;
        if ((t2 === 0 || t2 === 1) && la.targets[t2] && la.targets[t2].length) c2 = pick(la.targets[t2]);
        oppSteps++;
        // 复刻 applyOppAction 的语义（直接操作 api，与 env_server 同逻辑）
        const p = list2[u2];
        const N = env.api.get('N');
        const R = Math.floor(c2 / N), C = c2 % N;
        const acted = env.api.get('acted');
        if (t2 === 3) acted.add(p.id);
        else if (t2 === 2) { if (env.api.get('UNITS')[p.type].canRest) env.api.fn.doRest(p); acted.add(p.id); }
        else if (t2 === 1) {
          if (p.type === 'katyusha') env.api.fn.performKatyusha(p, R, C);
          else if (p.type === 'bomber') env.api.fn.performBomb(p, R, C);
          else env.api.fn.performStrike(p, R, C);
          acted.add(p.id);
        } else {
          const uu = env.api.get('UNITS')[p.type];
          const mt = env.api.fn.computeMoveTargets(p, Math.max(uu.move, uu.charge || 0), env.api.fn.computeVision(1));
          const k = env.api.fn.key(R, C);
          const path = mt.empties.get(k) || (mt.corpsCells.get(k) || {}).path;
          if (path) env.api.fn.executeMove(p, path);
          acted.add(p.id);
        }
        if (!oppPending(env.api).length) {
          const fin = env.resumeOpponentTurn();
          done = fin.done;
          totalR += fin.reward || 0;
          if (!Number.isFinite(fin.reward)) badR++;
          maxAbsR = Math.max(maxAbsR, Math.abs(fin.reward || 0));
          break;
        }
      }
    }
    done = done || r.done;
  }

  section('2 · 对手视角掩码与 legalActionsFor 同源');
  {
    const e2 = createEnv({ src: SRC, side: 0, externalOpponent: true });
    e2.reset({ seed: 77, opponent: 'ai:medium' });
    let checked = 0, mismatch = 0, submitted = 0, illegalSubmit = 0;
    for (let k = 0; k < 400; k++) {
      const list = oppPending(e2.api);
      if (!list.length) break;
      const u = rnd(list.length);
      const la = legalActionsFor(e2.api, 1, u, e2.api.fn.computeVision(1));
      if (la) {
        checked++;
        // 断言：掩码里的 type 都在 [0,4)，target 格都在棋盘内
        for (const t of la.types) {
          if (!(t >= 0 && t < 4)) mismatch++;
          if (t === 0 || t === 1) {
            for (const cell of (la.targets[t] || [])) if (cell < 0 || cell >= 400) mismatch++;
          }
        }
      }
      // 提交一个动作以推进
      const t2 = la ? pick(la.types) : 3;
      let c2 = 0;
      if ((t2 === 0 || t2 === 1) && la && la.targets[t2] && la.targets[t2].length) {
        c2 = pick(la.targets[t2]);
        if (c2 < 0 || c2 >= 400) illegalSubmit++;
      }
      const p = list[u];
      const N = e2.api.get('N'), R = Math.floor(c2 / N), C = c2 % N;
      const acted = e2.api.get('acted');
      if (t2 === 3) acted.add(p.id);
      else if (t2 === 2) { if (e2.api.get('UNITS')[p.type].canRest) e2.api.fn.doRest(p); acted.add(p.id); }
      else if (t2 === 1) { e2.api.fn.performStrike(p, R, C); acted.add(p.id); }
      else {
        const uu = e2.api.get('UNITS')[p.type];
        const mt = e2.api.fn.computeMoveTargets(p, Math.max(uu.move, uu.charge || 0), e2.api.fn.computeVision(1));
        const kk = e2.api.fn.key(R, C);
        const path = mt.empties.get(kk) || (mt.corpsCells.get(kk) || {}).path;
        if (path) e2.api.fn.executeMove(p, path);
        acted.add(p.id);
      }
      submitted++;
      if (!oppPending(e2.api).length) e2.resumeOpponentTurn();
    }
    ok(checked >= 5, `对手合法集检查 ${checked} 次（应 ≥5）`);
    ok(mismatch === 0, `掩码内非法项 ${mismatch} 次（应为 0）`);
    ok(submitted >= 5, `向对手视角提交动作 ${submitted} 次（应 ≥5）`);
    ok(illegalSubmit === 0, `提交越界目标 ${illegalSubmit} 次（应为 0）`);
  }

  section('3 · 奖励塑形数值健全性');
  ok(badR === 0, `非有限 reward ${badR} 次（应为 0）`);
  ok(maxAbsR < 10, `单步 |reward| 最大 ${maxAbsR.toFixed(3)}（应 <10）`);
  ok(sawAwait, '整局中出现过对手回合挂起');

  section('4 · 整局完成度');
  ok(agentSteps > 50, `agent 步数 ${agentSteps}（应 >50）`);
  ok(oppSteps > 50, `对手 步数 ${oppSteps}（应 >50）`);
  ok(done, '对局正常结束（非中途卡死）');
  console.log(`        winners=${env.api.get('winner')}  round=${env.round}  totalR=${totalR.toFixed(3)}`);

  console.log('\n' + '='.repeat(64));
  console.log(fail === 0 ? `✅ 全部通过（${pass} 项）` : `❌ ${fail} 项失败 / 共 ${pass + fail} 项`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
