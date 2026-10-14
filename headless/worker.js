'use strict';
/*
 * worker.js —— 常驻并行执行器（pull 模式）
 * ---------------------------------------------------------------------------
 * 与旧版「一次性跑完固定分片」不同，本 worker 是**常驻**的：
 *   主线程按需把下一批种子发过来，worker 跑完回传结果并等待下一批。
 * 这样长尾对局（例如龟缩流打到回合上限）不会让某个线程干等，
 * 负载自动向空闲线程倾斜 —— 这是把 24 核真正吃满的关键。
 */

const { parentPort, workerData } = require('worker_threads');
const { loadEngine } = require('./engine');
const { runMatch } = require('./sim');

const { src, cfg, keepExposure, visionCache, detail } = workerData;
const api = loadEngine({ src, seed: 0, quiet: true, keepExposure: !!keepExposure, visionCache: !!visionCache });

function runSeeds(seeds) {
  const out = [];
  for (const seed of seeds) {
    try {
      const r = runMatch(api, Object.assign({}, cfg, { seed }));
      if (!detail) { delete r.census; delete r.mapInfo; }
      out.push(r);
    } catch (e) {
      out.push({ seed, error: String((e && e.stack) || e) });
    }
  }
  return out;
}

parentPort.on('message', (msg) => {
  if (msg && msg.done) { parentPort.close(); return; }
  const t0 = Date.now();
  const results = runSeeds(msg.seeds);
  parentPort.postMessage({ seeds: msg.seeds, results, ms: Date.now() - t0 });
});

parentPort.postMessage({ ready: true });
