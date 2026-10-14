'use strict';
/*
 * proc-worker.js —— 进程级并行执行器（NDJSON 协议）
 * ---------------------------------------------------------------------------
 * 与 worker.js（线程）功能相同，但跑在独立进程里：
 *   · 各自独立的 V8 堆与 GC，避免多线程共享堆带来的 GC 争用；
 *   · 对 CPU 密集的 JS 负载，通常比 worker_threads 有更好的扩展性。
 *
 * 协议（stdin / stdout 各一行一个 JSON）
 *   父 → 子：{"seeds":[1,2,3]}         派发一批
 *   父 → 子：{"done":true}             收工退出
 *   子 → 父：{"ready":true}            就绪
 *   子 → 父：{"seeds":[...],"results":[...]}  本批结果
 */

const { loadEngine } = require('./engine');
const { runMatch } = require('./sim');

function boot(payload) {
  const api = loadEngine({
    src: payload.src, seed: 0, quiet: true,
    keepExposure: !!payload.keepExposure, visionCache: !!payload.visionCache,
  });
  const detail = !!payload.detail;
  const cfg = payload.cfg;

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.done) { process.exit(0); }
      const seeds = msg.seeds || [];
      const results = [];
      for (const seed of seeds) {
        try {
          const r = runMatch(api, Object.assign({}, cfg, { seed }));
          if (!detail) { delete r.census; delete r.mapInfo; }
          results.push(r);
        } catch (e) {
          results.push({ seed, error: String((e && e.stack) || e) });
        }
      }
      process.stdout.write(JSON.stringify({ seeds, results }) + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stdout.write(JSON.stringify({ ready: true }) + '\n');
}

try {
  boot(JSON.parse(process.argv[2]));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String((e && e.stack) || e) }) + '\n');
  process.exit(1);
}
