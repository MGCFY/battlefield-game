'use strict';
/*
 * selfcheck-collect.js —— 行为克隆采集的自检
 * ---------------------------------------------------------------------------
 * 五关：
 *   [1] 采集零扰动：装钩子 vs 不装钩子，同一批种子的对局结果必须逐字段一致
 *       （钩子只读状态、不消耗随机数；这是「教师行为 == 真实对局」的根本保证）
 *   [2] 观测布局：写出的 [D,C,N,N] 与内存中的编码逐元素一致（含通道重排 + 量化）
 *   [3] 掩码自洽：每条 valid 样本的动作都落在它自己的掩码里
 *   [4] 确定性：同种子两次采集，最终数据文件逐字节一致
 *   [5] 通道语义：0..7 地形 one-hot、8/9/10 二值、11 落在 [-1,1]
 */

const fs = require('fs');
const path = require('path');
const { loadEngine } = require('./engine');
const { runMatch } = require('./sim');
const { createRecorder, runCollectGame, collectLocal, mergeShards, ShardWriter } = require('./collect');
const { FEATURE_CHANNELS } = require('./env');
const npy = require('./npy');

const CFG = { red: 'ai:hard', blue: 'ai:medium', map: 'gen', budget: 3000, maxRounds: 80 };
const GAMES = Number(process.argv[2] || 6);
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

const i32 = (np) => {
  const u = new Uint8Array(np.data.buffer, np.data.byteOffset, np.data.byteLength);
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const out = new Int32Array(u.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt32(i * 4, true);
  return out;
};
const hashBuf = (b) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619); }
  return h >>> 0;
};

/* ================================================================== */
console.log('\n══ 战场沙盘 · 行为克隆采集自检 ══');

console.log(`\n[1] 采集零扰动（钩子 vs 无钩子，${GAMES} 局）`);
{
  const plain = loadEngine({ seed: 0, quiet: true, visionCache: true });
  const hooked = loadEngine({ seed: 0, quiet: true, visionCache: true });
  const rec = createRecorder(hooked, { obs: false });
  rec.install();
  let same = 0;
  const diffs = [];
  for (let i = 0; i < GAMES; i++) {
    const seed = 300 + i;
    const a = runMatch(plain, Object.assign({}, CFG, { seed }));
    const b = runCollectGame(hooked, Object.assign({}, CFG, { seed }), rec, { record: 'ai' });
    const sa = [a.winner, a.turns, a.reason, a.survivors[0].men, a.survivors[0].value, a.survivors[1].men, a.survivors[1].value].join('|');
    const sb = [b.winner, b.turns, b.reason,
      hooked.strength(0).men, hooked.strength(0).value,
      hooked.strength(1).men, hooked.strength(1).value].join('|');
    if (sa === sb) same++; else diffs.push(`种子 ${seed}: ${sa}  vs  ${sb}`);
  }
  ok(same === GAMES, `${same}/${GAMES} 局：钩子对胜负/回合/残存零影响`);
  for (const d of diffs.slice(0, 3)) console.log('      ' + d);
  console.log(`      钩子: ${rec.hooked.join(', ')}`);
}

/* ================================================================== */
console.log('\n[2][3][5] 数据文件：布局 / 掩码 / 通道语义');
const tmp = path.join(__dirname, '__bc_selfcheck');
{
  fs.rmSync(tmp, { recursive: true, force: true });
  const api = loadEngine({ seed: 0, quiet: true, visionCache: true });
  const N = 0; // 稍后取
  const shardDir = path.join(tmp, 's0');
  const rec = createRecorder(api, { obs: true });
  rec.install();
  const writer = new ShardWriter(shardDir, { obs: true, obsDtype: 'u8' });
  writer.setUnitTypes(api.get('DEPLOY_TYPES').slice());
  const unitTypes = api.get('DEPLOY_TYPES');
  const caught = [];               // 前若干条样本的内存快照，用于逐元素比对
  let emitted = 0;
  const games = Math.min(GAMES, 4);
  for (let i = 0; i < games; i++) {
    runCollectGame(api, Object.assign({}, CFG, { seed: 500 + i }), rec, {
      record: 'ai',
      onTurn: (side, round, samples) => {
        for (const s of samples) {
          s.unitTypeIdx = unitTypes.indexOf(s.unitType);
          if (caught.length < 8) caught.push({ idx: emitted, obs: s.obs, types: s.types, targets: s.targets, type: s.type, target: s.target, valid: s.valid });
          writer.add(s, i);
          emitted++;
        }
      },
    });
  }
  const Nn = api.get('N');
  writer.close();
  const merged = mergeShards(tmp, [shardDir], { obs: true, obsDtype: 'u8', N: Nn });
  const obsNp = npy.readNpy(path.join(tmp, 'obs.npy'));
  const obsBytes = new Uint8Array(obsNp.data.buffer, obsNp.data.byteOffset, obsNp.data.byteLength);
  const C = FEATURE_CHANNELS;
  const n2 = Nn * Nn;

  ok(merged.samples === emitted && obsNp.shape[0] === emitted,
    `样本数一致：写出 ${emitted} 条，npy 形状 [${obsNp.shape.join(', ')}]`);

  // [2] 布局与量化：按「通道优先」重建期望字节并逐元素比对
  let layoutOk = true;
  for (const c of caught) {
    const expected = Buffer.alloc(n2 * C);
    for (let ch = 0; ch < C; ch++) {
      for (let cell = 0; cell < n2; cell++) {
        const v = c.obs[cell * C + ch];
        const vv = ch === 11 ? Math.max(-1, Math.min(1, v)) : v;
        const q = ch === 11 ? Math.round((vv + 1) * 127) : Math.round(vv * 255);
        expected[ch * n2 + cell] = Math.max(0, Math.min(255, q));
      }
    }
    const got = obsBytes.subarray(c.idx * n2 * C, (c.idx + 1) * n2 * C);
    if (Buffer.compare(expected, Buffer.from(got)) !== 0) { layoutOk = false; break; }
  }
  ok(layoutOk, `通道优先布局 + 量化正确（逐元素比对 ${caught.length} 条样本）`);

  // [3] 掩码自洽（全量）
  const ltypes = new Uint8Array(npy.readNpy(path.join(tmp, 'legal_types.npy')).data.buffer,
    npy.readNpy(path.join(tmp, 'legal_types.npy')).data.byteOffset,
    npy.readNpy(path.join(tmp, 'legal_types.npy')).data.byteLength);
  const ptr = i32(npy.readNpy(path.join(tmp, 'legal_ptr.npy')));
  const meta = i32(npy.readNpy(path.join(tmp, 'meta.npy')));
  const items = i32(npy.readNpy(path.join(tmp, 'legal_items.npy')));
  let checked = 0, bad = 0;
  for (let d = 0; d < merged.samples; d++) {
    const valid = meta[d * 9 + 8], type = meta[d * 9 + 6], target = meta[d * 9 + 7];
    if (!valid) continue;
    checked++;
    if (type === 2 || type === 3) continue;
    let found = false;
    for (let k = ptr[d]; k < ptr[d + 1]; k++) {
      if (items[k * 2] === type && items[k * 2 + 1] === target) { found = true; break; }
    }
    if (!found) bad++;
  }
  ok(bad === 0, `掩码自洽：${checked} 条 valid 样本，动作不在掩码内 ${bad} 条`);

  // [5] 通道语义
  let semOk = true, terrainOk = true;
  for (let d = 0; d < Math.min(merged.samples, 200); d++) {
    for (let cell = 0; cell < n2; cell++) {
      const base = d * n2 * C + cell;
      let oneHot = 0;
      for (let ch = 0; ch < 8; ch++) { const v = obsBytes[base + ch * n2]; if (v !== 0 && v !== 255) semOk = false; if (v === 255) oneHot++; }
      for (let ch = 8; ch <= 10; ch++) { const v = obsBytes[base + ch * n2]; if (v !== 0 && v !== 255) semOk = false; }
      if (oneHot !== 1) terrainOk = false;
    }
  }
  ok(semOk, '通道 0..10 只取 {0, 255}（二值）');
  ok(terrainOk, '每格恰好一个地形通道为 1（0..7 one-hot）');
}

/* ================================================================== */
console.log('\n[4] 确定性（同种子两次采集逐字节一致）');
{
  const api = loadEngine({ seed: 0, quiet: true, visionCache: true });
  const runs = [];
  for (const tag of ['a', 'b']) {
    const dir = path.join(tmp, 'det_' + tag);
    fs.rmSync(dir, { recursive: true, force: true });
    collectLocal(api, Object.assign({}, CFG, { seed: 900 }), {
      games: 3, gameOffset: 0, shardDir: dir, obs: true, obsDtype: 'u8', record: 'ai',
    });
    runs.push({
      obs: hashBuf(fs.readFileSync(path.join(dir, 'obs.raw'))),
      meta: hashBuf(fs.readFileSync(path.join(dir, 'meta.raw'))),
      legal: hashBuf(fs.readFileSync(path.join(dir, 'legal_items.raw'))),
    });
  }
  ok(runs[0].obs === runs[1].obs && runs[0].meta === runs[1].meta && runs[0].legal === runs[1].legal,
    `两次采集指纹一致（obs ${runs[0].obs} / meta ${runs[0].meta} / legal ${runs[0].legal}）`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项未通过`) + `  （通过 ${pass}）\n`);
process.exitCode = fail === 0 ? 0 : 1;
