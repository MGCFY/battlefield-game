'use strict';
/*
 * collect.js —— 行为克隆（Behavior Cloning）数据采集
 * ---------------------------------------------------------------------------
 * 目标：把「规则 AI 的对局」变成神经网络可训练的三元组 (obs, mask, action)。
 *
 * 做法（关键设计）
 *   不重写教师策略，而是在沙盒里给「动作原语」打钩子：
 *      executeMove / performStrike / performKatyusha / performBomb /
 *      doRest / performGroupCharge / resolveBattle / aiActOne
 *   教师（游戏内置 AI）照常决策与执行，我们在它动手之前把
 *   「当时的观测 + 当时的合法动作掩码 + 它的实际选择」抓下来。
 *
 *   为什么这样最稳：
 *     1. 教师就是真教师 —— 没有任何「把 AI 重写一遍」带来的行为漂移；
 *     2. 掩码用 env.js 的 legalActionsFor（环境层与采集层唯一真源），
 *        训练时的掩码 == 教师决策时看到的合法集；
 *     3. 观测在动作发生「之前」编码，是教师真正看到的那一帧；
 *     4. 钩子只读取状态，不写状态、不消耗随机数 → 采集不改变对局。
 *
 *   已知不可表示的情形都会被记为 valid=0 或直接跳过并计数，
 *   便于用 valid 率判断这批数据能不能直接喂给 BC。
 *
 * 输出（--out <dir>）
 *   obs.npy           uint8 [D, 12, N, N]      量化观测（--obs none 时不生成）
 *   meta.npy          int32 [D, 9]             game, round, turn, side, unitIdx,
 *                                              unitType, type, target, valid
 *   legal_types.npy   uint8 [D, 4]             各动作类型的合法位
 *   legal_count.npy   int32 [D]                该决策的合法 (type,target) 项数
 *   legal_items.npy   int32 [K, 2]             合法项流：(type, target)
 *   legal_ptr.npy     int32 [D+1]              CSR 行指针（由 count 推出）
 *   meta.json                                  配置 / 特征规格 / 统计
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');

const { loadEngine, resolveSource } = require('./engine');
const { prepare, nowMs } = require('./sim');
const { unactedUnits, legalActionsFor, encodeObs, FEATURE_CHANNELS, ACTION_TYPES } = require('./env');
const { resolvePolicy } = require('./policies');
const npy = require('./npy');

const META_FIELDS = ['game', 'round', 'turn', 'side', 'unitIdx', 'unitType', 'type', 'target', 'valid'];
const N_ACT = ACTION_TYPES.length;

/* ------------------------------------------------------------------ *
 *  教师动作捕获器
 * ------------------------------------------------------------------ */
function createRecorder(api, opts) {
  opts = opts || {};
  const wantObs = opts.obs !== false;
  const P = api.sandbox;
  const orig = {};
  const wrapped = [];
  let installed = false;
  let state = null;                       // 当前正在记录的回合
  const stats = {
    decisions: 0, valid: 0, invalid: 0, skipped: 0, unattributed: 0,
    byType: [0, 0, 0, 0], turns: 0, killsOrNoAction: 0, exotic: 0,
  };

  function snapshot(side, p) {
    const list = unactedUnits(api, side);
    const idx = list.indexOf(p);
    if (idx < 0) return null;
    const vis = api.fn.computeVision(side);
    const la = legalActionsFor(api, side, idx, vis);
    if (!la) return null;
    const obs = wantObs ? encodeObs(api, side, vis) : null;
    return { idx, la, obs };
  }

  function emit(side, snap, type, target, unitType, round, turn) {
    const t = type | 0;
    let valid = false;
    if (t === 3) valid = true;
    else if (t === 2) valid = snap.la.types.indexOf(2) >= 0;
    else valid = snap.la.types.indexOf(t) >= 0 && (snap.la.targets[t] || []).indexOf(target) >= 0;
    const rec = {
      round, turn, side, unitIdx: snap.idx, unitType, type: t,
      target: t <= 1 ? target : -1, obs: snap.obs,
      types: snap.la.types, targets: snap.la.targets, valid,
    };
    state.samples.push(rec);
    stats.decisions++;
    stats.byType[t]++;
    if (valid) stats.valid++; else stats.invalid++;
    return rec;
  }

  /** 抓一个原语动作（调用方保证在原始动作「之前」调用） */
  function capture(p, type, targetCell) {
    if (!state || !p || p.side !== state.side) return false;
    if (state.seen.has(p.id)) return false;
    const snap = snapshot(state.side, p);
    if (!snap) { stats.unattributed++; return false; }
    state.seen.add(p.id);
    emit(state.side, snap, type, targetCell, p.type, state.round, api.get('turnNo'));
    return true;
  }

  function destIndex(path, N) {
    if (!path || !path.length) return -1;
    const last = path[path.length - 1];
    return last[0] * N + last[1];
  }

  function hook(name, makeWrapper) {
    if (typeof P[name] !== 'function') return;
    orig[name] = P[name];
    P[name] = makeWrapper(orig[name]);
    wrapped.push(name);
  }

  function install() {
    if (installed) return wrapped.slice();
    const N = () => api.get('N');
    hook('executeMove', (fn) => function (cp, pathNav) { capture(cp, 0, destIndex(pathNav, N())); return fn.apply(this, arguments); });
    hook('performStrike', (fn) => function (p, r, c) { capture(p, 1, r * N() + c); return fn.apply(this, arguments); });
    hook('performKatyusha', (fn) => function (p, r, c) { capture(p, 1, r * N() + c); return fn.apply(this, arguments); });
    hook('performBomb', (fn) => function (p, r, c) { capture(p, 1, r * N() + c); return fn.apply(this, arguments); });
    hook('doRest', (fn) => function (p) { capture(p, 2, -1); return fn.apply(this, arguments); });
    hook('performGroupCharge', (fn) => function (side, r, c, ids) {
      // 集团冲锋：一次调用多个单位同格突进 → 逐单位记成 type0 指向该格
      if (state && state.side === side && Array.isArray(ids)) {
        const tgt = r * N() + c;
        for (const id of ids) {
          const q = api.get('corps').find((x) => x.id === id);
          if (q) capture(q, 0, tgt);
        }
      }
      return fn.apply(this, arguments);
    });
    hook('resolveBattle', (fn) => function (units, r, c) {
      // 原地近战（大本营混战 / 交战锁定）：等价于「移动到本格发起攻击」
      if (state && Array.isArray(units) && units.length) {
        const tgt = r * N() + c;
        for (const q of units) if (q && q.side === state.side) capture(q, 0, tgt);
      }
      return fn.apply(this, arguments);
    });
    hook('aiActOne', (fn) => function (p, vis) {
      if (!state || !p || p.side !== state.side || state.seen.has(p.id)) return fn.apply(this, arguments);
      const pre = snapshot(state.side, p);            // 决策前那一帧
      const wasResting = !!p.resting;
      const supBefore = { flare: p.flare || 0, smoke: p.smoke || 0, bombs: p.bombs || 0 };
      const before = state.samples.length;
      const out = fn.apply(this, arguments);
      if (state.samples.length === before && pre && p.alive && !state.seen.has(p.id)) {
        // 没有触发任何已挂钩的原语 → 三种可能
        const exotic = (p.flare || 0) < supBefore.flare || (p.smoke || 0) < supBefore.smoke
          || (p.bombs || 0) < supBefore.bombs;
        if (exotic) {
          // 投掷照明弹 / 烟幕等本动作空间未覆盖的行为：跳过而非错误标注
          state.seen.add(p.id);
          stats.exotic++;
        } else {
          let type = 3;
          if (!wasResting && p.resting && pre.la.types.indexOf(2) >= 0) type = 2;
          state.seen.add(p.id);
          emit(state.side, pre, type, -1, p.type, state.round, api.get('turnNo'));
        }
      } else if (state.samples.length === before) {
        stats.killsOrNoAction++;
      }
      return out;
    });
    installed = true;
    return wrapped.slice();
  }

  return {
    install,
    get hooked() { return wrapped.slice(); },
    stats,
    arm(side, round) { state = { side, round, samples: [], seen: new Set() }; stats.turns++; },
    disarm() { const s = state ? state.samples : []; state = null; return s; },
  };
}

/* ------------------------------------------------------------------ *
 *  一局采集
 * ------------------------------------------------------------------ */
function shouldRecord(spec, mode) {
  if (mode === 'none') return false;
  if (mode === 'both') return true;
  if (mode === 'ai') return /^ai:/.test(String(spec));
  return false;
}

function runCollectGame(api, cfg, recorder, opts) {
  const mode = opts.record || 'ai';
  const ctx = prepare(api, cfg);
  const rec = { 0: shouldRecord(ctx.red.name, mode), 1: shouldRecord(ctx.blue.name, mode) };
  const maxRounds = cfg.maxRounds === undefined ? 300 : cfg.maxRounds;
  const onTurn = opts.onTurn || null;

  let round = 0;
  while (!api.get('gameOver') && round < maxRounds) {
    for (const side of [0, 1]) {
      const pol = side === 0 ? ctx.red : ctx.blue;
      if (rec[side]) recorder.arm(side, round);
      pol.act(api, side, { round, turn: api.get('turnNo'), api });
      if (rec[side]) {
        const samples = recorder.disarm();
        if (onTurn) onTurn(side, round, samples, api);
      }
      if (api.get('gameOver')) break;
      api.fn.endTurn();
    }
    round++;
  }

  const g0 = api.fn.hasGround(0), g1 = api.fn.hasGround(1);
  return {
    seed: cfg.seed, map: ctx.map, red: ctx.red.name, blue: ctx.blue.name,
    winner: api.get('gameOver') ? api.get('winner') : -1,
    reason: !api.get('gameOver') ? (round >= maxRounds ? 'timeout' : 'stalled')
      : ((!g0 || !g1) ? 'elimination' : 'capture'),
    turns: api.get('turnNo'), rounds: round,
    recordedSides: [rec[0] ? ctx.red.name : null, rec[1] ? ctx.blue.name : null],
  };
}

/* ------------------------------------------------------------------ *
 *  分片写入器（流式，避免把数据集全塞进内存）
 * ------------------------------------------------------------------ */
class ShardWriter {
  constructor(dir, opts) {
    opts = opts || {};
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.wantObs = opts.obs !== false;
    this.dtype = opts.obsDtype === 'f32' ? 'f32' : 'u8';
    this.C = FEATURE_CHANNELS;
    this.obsBytes = this.dtype === 'f32' ? 4 : 1;
    this.f = {
      obs: fs.openSync(path.join(dir, 'obs.raw'), 'w'),
      meta: fs.openSync(path.join(dir, 'meta.raw'), 'w'),
      types: fs.openSync(path.join(dir, 'legal_types.raw'), 'w'),
      count: fs.openSync(path.join(dir, 'legal_count.raw'), 'w'),
      items: fs.openSync(path.join(dir, 'legal_items.raw'), 'w'),
    };
    this.count = 0;
    this.byType = [0, 0, 0, 0];
    this.invalid = 0;
    this.games = [];
    this.N = null;
    this.unitTypes = null;
  }

  add(sample, gameId) {
    const N = sample.obs ? Math.round(Math.sqrt(sample.obs.length / this.C)) : 0;
    if (sample.obs) {
      if (this.N === null) this.N = N;
      else if (this.N !== N) throw new Error('棋盘尺寸不一致：' + this.N + ' vs ' + N);
    }
    const meta = Buffer.alloc(META_FIELDS.length * 4);
    const mt = sample.unitTypeIdx === undefined ? -1 : sample.unitTypeIdx;
    const vals = [gameId, sample.round, sample.turn, sample.side, sample.unitIdx, mt, sample.type, sample.target, sample.valid ? 1 : 0];
    for (let i = 0; i < vals.length; i++) meta.writeInt32LE(vals[i] | 0, i * 4);
    fs.writeSync(this.f.meta, meta);
    this.count++;
    this.byType[sample.type]++;
    if (!sample.valid) this.invalid++;

    const types = Buffer.alloc(4);
    for (const t of sample.types) if (t >= 0 && t < 4) types[t] = 1;
    fs.writeSync(this.f.types, types);

    const items = [];
    for (const t of sample.types) {
      if (t === 2 || t === 3) continue;
      for (const cell of (sample.targets[t] || [])) items.push([t, cell]);
    }
    const cnt = Buffer.alloc(4); cnt.writeInt32LE(items.length, 0);
    fs.writeSync(this.f.count, cnt);
    if (items.length) {
      const buf = Buffer.alloc(items.length * 8);
      items.forEach(([t, cell], i) => { buf.writeInt32LE(t, i * 8); buf.writeInt32LE(cell, i * 8 + 4); });
      fs.writeSync(this.f.items, buf);
    }

    if (this.wantObs && sample.obs) {
      // 注意：env.encodeObs 的展平顺序是「格优先、通道在后」（index = cell*C + ch），
      // 而训练侧要的是 [C, N, N]（通道优先）。这里必须重排一次，
      // 否则 numpy 会按 [D,C,N,N] 解释一段 [D,N,N,C] 的字节 —— 数据会被静默打乱。
      const src = sample.obs;
      const n2 = src.length / this.C;
      const buf = Buffer.alloc(this.dtype === 'f32' ? src.length * 4 : src.length);
      if (this.dtype === 'f32') {
        for (let ch = 0; ch < this.C; ch++) {
          for (let cell = 0; cell < n2; cell++) {
            buf.writeFloatLE(src[cell * this.C + ch], (ch * n2 + cell) * 4);
          }
        }
      } else {
        for (let ch = 0; ch < this.C; ch++) {
          const isUnitCh = ch === 11;
          for (let cell = 0; cell < n2; cell++) {
            const v = src[cell * this.C + ch];
            // 通道语义：0..10 为 0/1；通道 11 为 [-1,1]
            // 量化用 ×127（而非 ×127.5）→ 0 恰好编码为 127，解码回来精确为 0
            const vv = isUnitCh ? (v > 1 ? 1 : v < -1 ? -1 : v) : v;   // 单位通道夹到 [-1,1]
            const q = isUnitCh ? Math.round((vv + 1) * 127) : Math.round(vv * 255);
            buf[ch * n2 + cell] = q < 0 ? 0 : q > 255 ? 255 : q;
          }
        }
      }
      fs.writeSync(this.f.obs, buf);
    }
  }

  setUnitTypes(list) { this._unitTypes = list; if (!this.unitTypes) this.unitTypes = list; }

  close() {
    for (const k of Object.keys(this.f)) fs.closeSync(this.f[k]);
    return { dir: this.dir, samples: this.count, invalid: this.invalid, N: this.N };
  }
}

/* ------------------------------------------------------------------ *
 *  合并分片 → .npy
 * ------------------------------------------------------------------ */
function mergeShards(outDir, shardDirs, opts) {
  const wantObs = opts.obs !== false;
  const isF32 = opts.obsDtype === 'f32';
  const dtype = isF32 ? 'f4' : 'u1';          // 注意：npy 里 uint8 写作 u1
  const C = FEATURE_CHANNELS;
  const N = opts.N;
  const part = (name) => shardDirs.map((d) => path.join(d, name)).filter((p) => fs.existsSync(p));
  const out = { files: [], samples: 0 };

  if (wantObs) {
    const r = npy.writeNpyFromParts(path.join(outDir, 'obs.npy'), dtype, [C, N, N], part('obs.raw'));
    out.files.push(r); out.samples = r.shape[0];
  }
  const rm = npy.writeNpyFromParts(path.join(outDir, 'meta.npy'), 'i4', [META_FIELDS.length], part('meta.raw'));
  out.files.push(rm);
  out.samples = rm.shape[0];
  out.files.push(npy.writeNpyFromParts(path.join(outDir, 'legal_types.npy'), 'u1', [N_ACT], part('legal_types.raw')));
  const rc = npy.writeNpyFromParts(path.join(outDir, 'legal_count.npy'), 'i4', [], part('legal_count.raw'));
  out.files.push(rc);
  out.files.push(npy.writeNpyFromParts(path.join(outDir, 'legal_items.npy'), 'i4', [2], part('legal_items.raw')));

  // CSR 行指针
  const counts = new Int32Array(rc.shape[0]);
  {
    let off = 0;
    for (const f of part('legal_count.raw')) {
      const b = fs.readFileSync(f);
      const arr = new Int32Array(b.buffer, b.byteOffset, b.length / 4);
      counts.set(arr, off); off += arr.length;
    }
  }
  const ptr = new Int32Array(counts.length + 1);
  for (let i = 0; i < counts.length; i++) ptr[i + 1] = ptr[i] + counts[i];
  out.files.push(npy.writeNpy(path.join(outDir, 'legal_ptr.npy'), 'i4', [ptr.length], ptr));
  out.legalItems = ptr[ptr.length - 1];
  return out;
}

/* ------------------------------------------------------------------ *
 *  单线程批量采集（worker 内部也用这个）
 * ------------------------------------------------------------------ */
function collectLocal(api, cfg, opts) {
  const recorder = createRecorder(api, opts);
  recorder.install();
  const shardDir = opts.shardDir;
  const gameOffset = opts.gameOffset === undefined ? 0 : opts.gameOffset;
  const baseSeed = cfg.seed === undefined ? 1 : cfg.seed;
  const writer = new ShardWriter(shardDir, opts);
  writer.setUnitTypes(api.get('DEPLOY_TYPES').slice());
  const unitTypes = api.get('DEPLOY_TYPES');
  const games = [];
  const t0 = nowMs();

  for (let i = 0; i < opts.games; i++) {
    const gid = gameOffset + i;
    const c = Object.assign({}, cfg, { seed: baseSeed + i });
    const info = runCollectGame(api, c, recorder, Object.assign({}, opts, {
      onTurn: (side, round, samples) => {
        for (const s of samples) {
          s.unitTypeIdx = unitTypes.indexOf(s.unitType);
          writer.add(s, gid);
        }
      },
    }));
    info.gameId = gid;
    info.samples = writer.count;
    games.push(info);
  }
  const closed = writer.close();
  if (closed.N === null) closed.N = api.get('N');
  return {
    shardDir, samples: closed.samples, invalid: closed.invalid, N: closed.N,
    games, byType: writer.byType, stats: recorder.stats,
    ms: nowMs() - t0, unitTypes: unitTypes.slice(), hooked: recorder.hooked,
  };
}

/* ------------------------------------------------------------------ *
 *  并行采集
 * ------------------------------------------------------------------ */
function collectParallel(opt, cfg, games) {
  const cpus = os.cpus().length;
  const workers = Math.max(1, Math.min(
    opt.workers === undefined || opt.workers === 0 || opt.workers === 'auto' ? cpus : Number(opt.workers),
    games
  ));
  const outDir = path.resolve(opt.out);
  fs.mkdirSync(outDir, { recursive: true });

  if (workers === 1) {
    const api = loadEngine({ src: opt.src, seed: 0, quiet: true, visionCache: opt['no-vision-cache'] ? false : true });
    const r = collectLocal(api, cfg, {
      games, gameOffset: 0, shardDir: path.join(outDir, '_shard_0'),
      obs: opt.obs !== 'none', obsDtype: opt['obs-dtype'] || 'u8', record: opt.record || 'ai',
    });
    return Promise.resolve({ shards: [r], workers });
  }

  // 动态分配：每片 games/workers 局，先到先得（最后一个分片承担余数）
  const per = Math.ceil(games / workers);
  const jobs = [];
  for (let s = 0; s < workers && s * per < games; s++) {
    const n = Math.min(per, games - s * per);
    jobs.push({ shardIndex: s, games: n, gameOffset: s * per });
  }

  return new Promise((resolve) => {
    const shards = [];
    let finished = 0;
    jobs.forEach((job) => {
      const w = new Worker(path.join(__dirname, 'collect-worker.js'), {
        workerData: {
          src: opt.src, cfg, games: job.games, gameOffset: job.gameOffset,
          shardDir: path.join(outDir, `_shard_${job.shardIndex}`),
          obs: opt.obs !== 'none', obsDtype: opt['obs-dtype'] || 'u8',
          record: opt.record || 'ai', visionCache: !opt['no-vision-cache'],
        },
      });
      w.on('message', (m) => {
        if (m && m.error) process.stderr.write('\n[shard ' + job.shardIndex + '] 失败: ' + m.error + '\n');
        else shards.push(m);
        finished++;
        if (!opt.quiet) process.stdout.write(`\r  采集进度 ${finished}/${jobs.length} 片 …`);
        if (finished === jobs.length) { if (!opt.quiet) process.stdout.write('\n'); resolve({ shards, workers }); }
      });
      w.on('error', (e) => {
        process.stderr.write('\n[shard] worker 异常: ' + e.message + '\n');
        finished++;
        if (finished === jobs.length) resolve({ shards, workers });
      });
    });
  });
}

/* ------------------------------------------------------------------ *
 *  汇总打印
 * ------------------------------------------------------------------ */
function report(outDir, shards, merged, opts, elapsedMs) {
  const samples = shards.reduce((s, x) => s + (x.samples || 0), 0);
  const invalid = shards.reduce((s, x) => s + (x.invalid || 0), 0);
  const games = shards.reduce((s, x) => s + (x.games ? x.games.length : 0), 0);
  const byType = [0, 0, 0, 0];
  for (const s of shards) for (let i = 0; i < 4; i++) byType[i] += (s.byType ? s.byType[i] : 0);
  const st = { decisions: 0, valid: 0, skipped: 0, unattributed: 0, killsOrNoAction: 0, turns: 0, exotic: 0 };
  for (const s of shards) {
    const c = s.stats || {};
    for (const k of Object.keys(st)) st[k] += (c[k] || 0);
  }
  const N = shards.map((s) => s.N).find((x) => x) || 0;
  const pct = (a, b) => (b ? (a / b * 100).toFixed(2) + '%' : '-');
  console.log('\n' + '═'.repeat(64));
  console.log('  行为克隆数据集');
  console.log('─'.repeat(64));
  console.log(`  对局      ${games} 局    决策样本 ${samples}`);
  console.log(`  平均      ${(samples / Math.max(1, games)).toFixed(1)} 决策/局`);
  console.log(`  合法率    ${pct(samples - invalid, samples)}   （${samples - invalid}/${samples}，非法 ${invalid}）`);
  console.log(`  动作分布  机动 ${byType[0]} · 远程 ${byType[1]} · 休整 ${byType[2]} · 待命 ${byType[3]}`);
  console.log(`  教师回合  ${st.turns}    未能归属 ${st.unattributed}    无动作/阵亡 ${st.killsOrNoAction}    未覆盖动作 ${st.exotic}`);
  console.log('─'.repeat(64));
  const bytes = merged.files.reduce((s, f) => s + f.bytes, 0) + 64 * merged.files.length;
  console.log(`  棋盘      ${N}×${N}    特征 ${FEATURE_CHANNELS} 通道`);
  console.log(`  数据量    ${(bytes / 1048576).toFixed(1)} MB   合法项 ${merged.legalItems}`);
  console.log(`  耗时      ${(elapsedMs / 1000).toFixed(2)}s    ${(samples / (elapsedMs / 1000)).toFixed(0)} 决策/秒`);
  console.log(`  输出      ${outDir}`);
  console.log('═'.repeat(64) + '\n');
  return { games, samples, invalid, byType, N, bytes, stats: st };
}

/* ------------------------------------------------------------------ *
 *  CLI
 * ------------------------------------------------------------------ */
const HELP = `
战场沙盘 · 行为克隆数据采集

用法
  node collect.js -n 100 --red ai:hard --blue ai:medium --out data/bc_hard

选项
  -n, --games <N>        对局数（默认 50）
      --red <策略>       红方策略（默认 ai:hard）
      --blue <策略>      蓝方策略（默认 ai:medium）
      --record <模式>    记录哪一方：ai(默认) | both | none
      --map <地图>       地图：gen | ...（默认 gen）
      --budget <分>      双方预算（默认 3000）
      --seed <S>         起始种子（默认 1）
      --max-rounds <R>   单局回合上限（默认 300）
      --obs <模式>       u8(默认) | f32 | none  —— none 只采动作/掩码，体积极小
      --obs-dtype <d>    u8(默认) | f32
      --out <目录>       输出目录（必填）
  -w, --workers <W>      并行线程数（默认全部核心）
      --no-vision-cache  关闭视野缓存（默认开启，selfcheck 已验证等价）
      --src <文件>       指定游戏 HTML
      --quiet            不打印进度
  -h, --help             显示帮助
`;

function parseArgs(argv) {
  const o = { _: [] };
  const put = (k, v) => { if (o[k] === undefined) o[k] = v; else if (Array.isArray(o[k])) o[k].push(v); else o[k] = [o[k], v]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) put(a.slice(2, eq), a.slice(eq + 1));
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) put(a.slice(2), argv[++i]);
      else put(a.slice(2), true);
    } else if (a === '-n') put('games', argv[++i]);
    else if (a === '-w') put('workers', argv[++i]);
    else o._.push(a);
  }
  return o;
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || opt.h) { console.log(HELP); return; }
  if (opt.list) { console.log('可用策略见 headless/policies.js REGISTRY'); return; }
  if (!opt.out) { console.error('缺少 --out <目录>（数据集体积可能很大，必须显式指定输出目录）\n' + HELP); process.exit(2); }

  const games = Number(opt.games || 50);
  const cfg = {
    red: opt.red || 'ai:hard',
    blue: opt.blue || 'ai:medium',
    map: opt.map || 'gen',
    budget: Number(opt.budget || 3000),
    maxRounds: Number(opt['max-rounds'] || 300),
    seed: Number(opt.seed || 1),
  };

  if (!opt.quiet) {
    console.log('\n战场沙盘 · 行为克隆采集');
    console.log('─'.repeat(64));
    console.log('  源文件  ' + resolveSource(opt.src));
    console.log(`  对局    red=${cfg.red}  vs  blue=${cfg.blue}   record=${opt.record || 'ai'}`);
    console.log(`  地图    ${cfg.map}   预算 ${cfg.budget}   回合上限 ${cfg.maxRounds}`);
    console.log(`  规模    ${games} 局   种子 ${cfg.seed}..${cfg.seed + games - 1}   obs=${opt.obs || 'u8'}`);
  }

  const t0 = nowMs();
  const { shards, workers } = await collectParallel(opt, cfg, games);
  if (!shards.length) { console.error('没有采集到任何数据'); process.exit(1); }

  const outDir = path.resolve(opt.out);
  const N = shards.map((s) => s.N).find((x) => x) || 20;
  const merged = mergeShards(outDir, shards.map((s) => s.shardDir), {
    obs: opt.obs !== 'none', obsDtype: opt['obs-dtype'] || 'u8', N,
  });
  const elapsed = nowMs() - t0;
  const summary = report(outDir, shards, merged, opt, elapsed);

  // 合并完成后清掉中间分片（--keep-shards 可保留以便排查）
  if (!opt['keep-shards']) {
    for (const s of shards) { try { fs.rmSync(s.shardDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }
  }

  const spec = {
    createdAt: new Date().toISOString(),
    source: resolveSource(opt.src),
    workers,
    config: cfg,
    record: opt.record || 'ai',
    board: { N, channels: FEATURE_CHANNELS },
    featureSpec: {
      layout: '[D, C, N, N]  (C=通道, N=边长)',
      channels: {
        '0-7': '地形 one-hot: plain, highland, river, forbidden, city, jungle, desert, snow',
        8: '桥面',
        9: '地雷',
        10: '未探明（迷雾）',
        11: '单位分布：己方 +，敌方 −，按兵力当量/100 缩放；视野外敌方不写',
      },
      dtypeNote: opt['obs-dtype'] === 'f32'
        ? 'float32 原始值'
        : 'uint8 量化：通道 0-10 = value*255（0/255 无损）；通道 11 = (value+1)*127 → 解码 value=u/127-1（0 精确还原）',
    },
    actionSpace: {
      unit: '待行动单位下标（0..K-1）',
      type: ACTION_TYPES,
      target: 'r*N+c；type=2/3 时无意义（记 -1）',
    },
    unitTypes: (shards.find((s) => s.unitTypes) || {}).unitTypes || null,
    files: {
      'obs.npy': `[D, ${FEATURE_CHANNELS}, ${N}, ${N}] ${opt['obs-dtype'] === 'f32' ? 'f4' : 'u1'}`,
      'meta.npy': `[D, ${META_FIELDS.length}] i4 列: ${META_FIELDS.join(', ')}`,
      'legal_types.npy': `[D, ${N_ACT}] u1 各动作类型是否合法`,
      'legal_count.npy': '[D] i4 该决策合法 (type,target) 项数',
      'legal_items.npy': '[K, 2] i4 合法项流 (type, target)',
      'legal_ptr.npy': '[D+1] i4 CSR 行指针',
    },
    stats: summary,
    games: shards.flatMap((s) => s.games || []),
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(spec, null, 2), 'utf8');
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(spec, null, 2), 'utf8');
  console.log('  规格文件  ' + path.join(outDir, 'meta.json'));
  console.log('  提示      用 headless/load_bc.py 可直接读进 numpy / torch\n');
}

module.exports = {
  createRecorder, runCollectGame, collectLocal, collectParallel, mergeShards,
  ShardWriter, META_FIELDS, report,
};

if (require.main === module) main().catch((e) => { console.error('采集失败：', e); process.exit(2); });
