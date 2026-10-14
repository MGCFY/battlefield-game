'use strict';
/*
 * collect-worker.js —— 行为克隆采集的并行分片执行器
 * 由 collect.js 以 worker_threads 启动；每个 worker 自带独立 vm 沙盒与独立分片目录。
 */

const { parentPort, workerData } = require('worker_threads');
const { loadEngine } = require('./engine');
const { collectLocal } = require('./collect');

function main() {
  const d = workerData;
  const api = loadEngine({ src: d.src, seed: 0, quiet: true, visionCache: !!d.visionCache });
  const r = collectLocal(api, d.cfg, {
    games: d.games,
    gameOffset: d.gameOffset,
    shardDir: d.shardDir,
    obs: !!d.obs,
    obsDtype: d.obsDtype,
    record: d.record,
  });
  parentPort.postMessage(r);
}

try {
  main();
} catch (e) {
  parentPort.postMessage({ error: String((e && e.stack) || e) });
}
