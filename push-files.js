/*
 * push-files.js —— 多文件推送脚本（Git Data API，单 commit 提交多文件）
 * ---------------------------------------------------------------------------
 * 用法：node push-files.js            （读 .api-token，推送下方 FILES 列表）
 *       改 FILES / MESSAGE 后重跑即可；重复推送同一文件是幂等的。
 *
 * 为什么不用 git push 或 api-push.js：
 *   - 本机 https_proxy (127.0.0.1:56008) 对 HTTPS 做 MITM，node 默认证书校验必失败
 *     → 本脚本关闭 rejectUnauthorized（只对本脚本生效；认证仍靠 Bearer token）
 *   - git push 协议被代理封锁，Contents / Git Data API 是唯一通道
 *   - 多文件走 Git Data API 只产生 **一个 commit**（Contents API 是一文件一 commit）
 */
'use strict';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = fs.readFileSync(path.join(__dirname, '.api-token'), 'utf8').trim();
const REPO = 'MGCFY/battlefield-game';
const BRANCH = 'main';

/* 本次推送清单（v3.9.20 → v3.9.23 + 依赖它们的 headless 侧文件）
   只列「仓库里没有或有改动」的文件，避免把历史 debug-*.js 草稿一起塞进仓库。 */
const FILES = [
  'battlefield-v3.9.20.html',
  'battlefield-v3.9.21.html',
  'battlefield-v3.9.22.html',
  'battlefield-v3.9.23.html',
  'push-files.js',
  'headless/README.md',
  'headless/RL-BASELINE.md',
  'headless/accept.js',
  'headless/engine.js',
  'headless/env.js',
  'headless/env_server.js',
  'headless/probe-raid.js',
  'headless/probe-sizemark.js',
  'headless/probe-uimark.js',
  'headless/selfcheck-rl.js',
  'headless/rl/bc_warmup.py',
  'headless/rl/env_client.py',
  'headless/rl/eval.py',
  'headless/rl/league.py',
  'headless/rl/model.py',
  'headless/rl/ppo.py',
  'headless/rl/train.py',
];

const MESSAGE = [
  'feat v3.9.20 → v3.9.23: 威胁感知层 / AI 前置规划 / 分兵运用，纯性能优化 2.86×，困难档强化（编成修复 + 重炮错峰 + 骑兵绕后）',
  '',
  'v3.9.20 / v3.9.21 · AI 结构层',
  '- 威胁感知层（aiThreatKnown / aiThreatProfile）+ AI 前置规划 aiPlanTurn：原先整套战略规划只写在 aiAct（唯一调用者是「快进」按钮），',
  '  正常动画路径 runAiTurn → aiNext 逐个 aiActOne 时 AI「无战略」；抽成 aiPlanTurn 后两条路径共用，用 side|turnNo 打戳防重复。',
  '- 分兵运用：aiUnitObj（garrison/bait/flank 角色）+ aiSplit（数据层，规则同 confirmSplit）+ aiSplitCap（每回合额度）。',
  '- 侦察兵意志（aiScoutCommit / aiScoutFocus）。',
  '',
  'v3.9.22 · 纯性能优化（AI 行为逐位不变）',
  '- bfsFrom：q.shift() → 定长 Int16Array 队列 + 读指针；阻塞格一次性预计算。',
  '- computeVision：全图 N² → 矩形窗口 ±(v+1)，isHigh 外提。',
  '- computeMoveTargets：多槽缓存（键含视野标记/回合/单位/全部存活单位位置/隧道内容签名/烟雾序号），命中率 55%。',
  '- aiStepToward：aiAimField 目标距离场按目标集合缓存 + 友军占位计数表。',
  '- medium 镜像 3348 → 1152 ms/局（2.86×），hard vs medium 5886 → 1810 ms（3.25×），accept 总墙钟 ~150s → 58s。',
  '  等价性：accept 前六项逐位相同 + 400 局逐局比对（差异落在批量跑 ~1% 非确定性噪声内）。',
  '',
  'v3.9.23 · 困难档强化（改动全在 aiDiff==="hard"）',
  '- 编成修复：hard quotas 的 heavyArt q(20,2)=40 / tank q(12,2)=24 / katyusha q(2,0)=4 / bomber q(1,0)=2 在 3000 预算下不可实现，',
  '  trimTo 把骑兵轻炮砍成 0、quotaOrder 又把重炮补到 40 门 → 总兵力 619（medium 1414）。改为 heavyArt q(8,1) / tank q(6,0) /',
  '  katyusha q(1,0) / bomber 1 / inf q(400) → 1027 人。',
  '- 重炮错峰：每方一次把最大重炮团 aiSplit(0.5)，新组 resting=!src.resting 反相。heavyArt.needRest=1 使单团两轮一发，',
  '  原本全场同相（第 1/3/5 回合零炮火）→ 错峰后每回合恰有半数开火。',
  '- 骑兵绕后：敌炮兵/坦克距我方压线近战 ≥6 格、突袭队 ≤9 格、目标 3 格内敌步骑 < 突袭队×1.2 才派 max(30,40%)。',
  '  实测对叠兵型 AI 不触发（炮兵永远在主股内），用 probe-raid.js 合成「后置炮阵」证明分支有效。',
  '- 分兵预算 hard 2 → 3；aiDiag 增加 splitCap / roles 可观测字段。',
  '',
  '验收',
  '- 困难档 vs 中等档双向 300 局：76.7% / 72.0%（合并 74.4%）→ 97.0% / 96.3%（合并 96.7%），中位回合 73 → 56。',
  '- 消融：关重炮错峰 −5.3pp、关编成修复 −8.0pp、关骑兵绕后 ±0、cap 3→2 ±0。',
  '- accept.js 七项与 v3.9.22 逐位相同（98.3/63.0、94.6/60.4、79.5/109.3、85.3/27.6、98.0/64.9、99.2/59.3、镜像 45.5/70.8）。',
  '- selfcheck.js 5 关 / selfcheck-collect.js 7 关 / selfcheck-rl.js 11 项 全绿。',
].join('\n');

function api(method, url, body, tries) {
  tries = tries || 3;
  const once = () => new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: 'api.github.com', path: url, method,
      rejectUnauthorized: false,
      headers: Object.assign(
        { Authorization: 'Bearer ' + TOKEN, 'User-Agent': 'push-script', Accept: 'application/vnd.github+json' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
      ),
      timeout: 90000,
    }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => { try { res({ s: r.statusCode, j: b ? JSON.parse(b) : {} }); } catch (e) { rej(new Error('bad json: ' + b.slice(0, 200))); } });
    });
    req.on('error', rej);
    req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
  return (async () => {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await once(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
    }
    throw last;
  })();
}

(async () => {
  console.log('待推送 ' + FILES.length + ' 个文件：');
  FILES.forEach((f) => console.log('   ' + f));

  const ref = await api('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
  if (ref.s !== 200) throw new Error('读取 ref 失败 ' + ref.s + ' ' + JSON.stringify(ref.j).slice(0, 200));
  const headSha = ref.j.object.sha;

  const cm = await api('GET', `/repos/${REPO}/git/commits/${headSha}`);
  if (cm.s !== 200) throw new Error('读取 commit 失败 ' + cm.s);
  const baseTree = cm.j.tree.sha;
  console.log('\n当前 HEAD ' + headSha.slice(0, 8) + ' · base tree ' + baseTree.slice(0, 8));

  console.log('\n上传 blob：');
  const tree = [];
  let total = 0;
  for (const f of FILES) {
    const buf = fs.readFileSync(path.join(__dirname, f));
    total += buf.length;
    const b = await api('POST', `/repos/${REPO}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' });
    if (b.s !== 201) throw new Error('blob 失败 ' + f + ' ' + b.s + ' ' + JSON.stringify(b.j).slice(0, 200));
    tree.push({ path: f, mode: '100644', type: 'blob', sha: b.j.sha });
    console.log('   ok ' + f.padEnd(38) + (buf.length / 1024).toFixed(1) + ' KB');
  }
  console.log('   合计 ' + (total / 1024).toFixed(1) + ' KB');

  const t = await api('POST', `/repos/${REPO}/git/trees`, { base_tree: baseTree, tree });
  if (t.s !== 201) throw new Error('建 tree 失败 ' + t.s + ' ' + JSON.stringify(t.j).slice(0, 300));
  console.log('\n新 tree ' + t.j.sha.slice(0, 8));

  const c = await api('POST', `/repos/${REPO}/git/commits`, { message: MESSAGE, tree: t.j.sha, parents: [headSha] });
  if (c.s !== 201) throw new Error('建 commit 失败 ' + c.s + ' ' + JSON.stringify(c.j).slice(0, 300));
  console.log('新 commit ' + c.j.sha);

  const u = await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: c.j.sha });
  if (u.s !== 200) throw new Error('更新 ref 失败 ' + u.s + ' ' + JSON.stringify(u.j).slice(0, 300));
  console.log('\n✅ 推送完成：' + BRANCH + ' → ' + c.j.sha.slice(0, 8) + '（' + FILES.length + ' 个文件）');
})().catch((e) => { console.error('\n❌ 失败：' + e.message); process.exit(1); });
