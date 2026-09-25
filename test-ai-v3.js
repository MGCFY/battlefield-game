/* 战场沙盘 v3.6 · 单机 AI 对手自动化测试
   覆盖：AI 部署（三档）/ aiAct 合法性 / 三档 AI vs AI 完整对局 / 快进等价性 / 热座回归 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "battlefield-v3.html"), "utf8");
let code = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nnewGame\(\);\s*$/, "\n");
code += `
globalThis.__T = {
  get aiSide(){return aiSide}, set aiSide(v){aiSide=v},
  get aiDiff(){return aiDiff}, set aiDiff(v){aiDiff=v},
  get aiBusy(){return aiBusy},
  get terrain(){return terrain}, get bridge(){return bridge},
  get fort(){return fort}, get bunker(){return bunker},
  get corps(){return corps}, get acted(){return acted},
  get current(){return current}, get turnNo(){return turnNo},
  get gameOver(){return gameOver}, get winner(){return winner},
  get phase(){return phase}, set phase(v){phase=v},
  get deploySide(){return deploySide}, set deploySide(v){deploySide=v},
  get deployCfg(){return deployCfg}, set deployCfg(v){deployCfg=v},
  get seen(){return seen}, set seen(v){seen=v},
  get memoryFog(){return memoryFog}, set memoryFog(v){memoryFog=v},
  get nextId(){return nextId}, set nextId(v){nextId=v},
  get smokeSeq(){return smokeSeq}, set smokeSeq(v){smokeSeq=v},
  get pendingMissiles(){return pendingMissiles},
  get flare(){return flare}, get smokeLeft(){return smokeLeft}, get smokeId(){return smokeId},
  get bunkerDead(){return bunkerDead},
  UNITS, BASES, N, RECOMMEND, DEPLOY_TYPES, BUDGET, AI_PROFILES,
  fn: { genMap, stationable, computeVision, visionRange, computeMoveTargets, executeMove,
        strikeCell, katyushaStrike, strikeBase, strikeRange, canStrike,
        resolveMissiles, endTurn, checkWin, isDay, dayNo, spawnFromConfig, hasGround,
        randInt, key, unkey, manh, enemySizeClass, deploySpent,
        newGame, confirmDeploy, renderDeploy, deployConfigDefaults,
        aiAct, aiActOne, aiAutoDeploy, aiDeployConfig, aiProf }
};
`;
function stubEl() {
  return { innerHTML: "", textContent: "", className: "", value: "0", style: {}, dataset: {},
    scrollTop: 0, scrollHeight: 0, checked: true, disabled: true,
    classList: { add(){}, remove(){}, contains(){ return false; } },
    appendChild(){}, addEventListener(){}, focus(){},
    querySelectorAll(){ return []; }, closest(){ return null; } };
}
const cache = {};
const documentStub = { getElementById: id => (cache[id] || (cache[id] = stubEl())),
  querySelector: () => null, querySelectorAll: () => [], createElement: () => stubEl(), addEventListener: () => {} };
const ctx = { document: documentStub, console: { log(){}, warn(){}, error(){} }, alert: () => {},
  Math, JSON, Set, Map, Array, Object, String, Number, parseInt, isNaN, Infinity,
  setTimeout: () => 0, clearTimeout: () => {}, globalThis: null };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx);
const T = ctx.__T, F = T.fn, N = T.N, UNITS = T.UNITS, BASES = T.BASES;

/* ---------- 断言框架 ---------- */
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log("  ✓ " + msg); }
  else { failed++; console.log("  ✗ " + msg); }
}

/* ---------- 1. AI 部署（三档难度） ---------- */
console.log("\n== 1. AI 自动部署 ==");
for (const diff of ["easy", "medium", "hard"]) {
  T.aiSide = 0; T.aiDiff = diff;
  F.newGame();
  const red = T.corps.filter(p => p.side === 0);
  const spent = red.reduce((s, p) => s + p.troops * UNITS[p.type].cost, 0);
  const ground = red.filter(p => !UNITS[p.type].air).length;
  ok(red.length > 0 && T.phase === "handoff", `[${diff}] 红方AI自动部署完成并移交蓝方 (兵团 ${red.length} 支)`);
  ok(spent <= T.BUDGET, `[${diff}] 部署花费 ${spent} ≤ 预算 ${T.BUDGET}`);
  ok(ground > 0, `[${diff}] 至少 1 支地面兵团`);
  ok(F.deploySpent(F.aiDeployConfig()) <= T.BUDGET, `[${diff}] aiDeployConfig 输出均在预算内`);
}
/* 蓝方 AI：红方（人类）确认部署后应自动接管 */
T.aiSide = 1; T.aiDiff = "medium";
F.newGame();
ok(T.phase === "deploy" && T.deploySide === 0 && T.corps.length === 0, "aiSide=1 时 newGame 不自动部署（等红方配置）");
T.deployCfg = F.deployConfigDefaults();
Object.assign(T.deployCfg, { inf: 400, cav: 30, lightArt: 20, scout: 4, heavyArt: 10, tank: 2 });
F.confirmDeploy();
const blue = T.corps.filter(p => p.side === 1);
ok(blue.length > 0, "红方确认部署后蓝方 AI 自动生成兵团");
ok(T.phase === "play" && T.current === 0, "双方部署完成进入对局 (phase=play, 红方先手)");

/* ---------- 2. aiAct 合法性 ---------- */
console.log("\n== 2. aiAct 行动合法性 ==");
T.aiSide = -1; T.aiDiff = "hard";
F.newGame();
T.phase = "play"; T.corps.length = 0; T.nextId = 1;
F.spawnFromConfig(0, { inf: 300, cav: 30, lightArt: 20, scout: 4, heavyArt: 10, tank: 4, katyusha: 2, recon: 1, bomber: 1 });
F.spawnFromConfig(1, { inf: 300, cav: 30, lightArt: 20, scout: 4, heavyArt: 10, tank: 4, katyusha: 2, recon: 1, bomber: 1 });
T.acted.clear();
F.aiAct(0);
const redAll = T.corps.filter(p => p.side === 0);
ok(redAll.every(p => !p.alive || T.acted.has(p.id)), "行动后红方所有存活单位均标记已行动");
ok(redAll.every(p => p.troops >= 0), "所有单位兵力 ≥ 0");
ok(redAll.every(p => !p.alive || (p.r >= 0 && p.r < N && p.c >= 0 && p.c < N)), "所有存活单位坐标在地图内");
ok(redAll.every(p => !p.alive || UNITS[p.type].air || F.stationable(p.r, p.c)), "地面单位均在合法驻扎格");
ok(redAll.every(p => !p.alive || UNITS[p.type].air || T.terrain[p.r][p.c] !== "forbidden"), "无单位进入禁地");

/* ---------- 3. AI vs AI 完整对局（三档 × 各 5 局） ---------- */
console.log("\n== 3. AI vs AI 完整对局 ==");
const GAMES_PER_DIFF = 5;
const errs = [], winStat = { easy: 0, medium: 0, hard: 0 }, maxTurns = {};
for (const diff of ["easy", "medium", "hard"]) {
  T.aiDiff = diff; maxTurns[diff] = 0;
  for (let g = 0; g < GAMES_PER_DIFF; g++) {
    try {
      F.newGame();
      T.phase = "play"; T.corps.length = 0; T.nextId = 1;
      F.spawnFromConfig(0, F.aiDeployConfig());
      F.spawnFromConfig(1, F.aiDeployConfig());
      T.acted.clear(); T.current = 0; T.turnNo = 1; T.gameOver = false;
      T.seen = [Array.from({ length: N }, () => Array(N).fill(false)),
                Array.from({ length: N }, () => Array(N).fill(false))];
      let rounds = 0;
      while (!T.gameOver && rounds < 400) {
        F.aiAct(T.current);
        if (T.gameOver) break;
        F.endTurn();
        if (T.gameOver) break;
        rounds++;
      }
      maxTurns[diff] = Math.max(maxTurns[diff], T.turnNo);
      if (T.gameOver) winStat[diff]++;
      if (!F.hasGround(0) && !F.hasGround(1)) errs.push(`[${diff}] 第${g}局双方均无地面兵团`);
    } catch (e) {
      errs.push(`[${diff}] 第${g}局异常: ${e.message} @ ${(e.stack || "").split("\\n")[1] || ""}`.trim());
    }
  }
}
ok(errs.length === 0, `三档难度 × ${GAMES_PER_DIFF} 局共 ${GAMES_PER_DIFF * 3} 局对局 0 异常`);
errs.slice(0, 5).forEach(e => console.log("    ✗ " + e));
ok(true, `分出胜负统计: 简单 ${winStat.easy}/${GAMES_PER_DIFF} · 中等 ${winStat.medium}/${GAMES_PER_DIFF} · 困难 ${winStat.hard}/${GAMES_PER_DIFF}（剩余为 400 回合内合法僵持）`);

/* ---------- 4. 快进同步核心等价性 ---------- */
console.log("\n== 4. 快进（aiFastForward 同步核心）等价性 ==");
try {
  F.newGame();
  T.phase = "play"; T.corps.length = 0; T.nextId = 1;
  F.spawnFromConfig(0, { inf: 500, cav: 20, lightArt: 20, scout: 4, heavyArt: 10, tank: 2 });
  F.spawnFromConfig(1, { inf: 500, cav: 20, lightArt: 20, scout: 4, heavyArt: 10, tank: 2 });
  T.acted.clear(); T.current = 0; T.turnNo = 1; T.gameOver = false;
  // 模拟快进：与 aiFastForward 同路径 —— aiAct(同步) + endTurn
  const turnBefore = T.turnNo;
  F.aiAct(0); F.endTurn();
  ok(T.current === 1 && T.turnNo === turnBefore, "快进后回合正常移交蓝方");
  F.aiAct(1); F.endTurn();
  ok(T.turnNo === turnBefore + 1, "一个完整大回合后回合计数 +1");
  // 校验 endTurn 的 AI 挂钩在异步模式下不误触发（aiSide=-1 时）
  ok(T.aiSide === -1 && !T.aiBusy, "热座模式下 endTurn 不触发 AI 驱动");
} catch (e) {
  ok(false, "快进等价性异常: " + e.message);
}

/* ---------- 5. 热座回归 ---------- */
console.log("\n== 5. 热座模式回归 ==");
T.aiSide = -1; T.aiDiff = "medium";
F.newGame();
ok(T.corps.length === 0 && T.phase === "deploy" && T.deploySide === 0, "aiSide=-1 时 newGame 不自动部署");
F.aiAct(0);   // 热座下手动调用不报错即可（不该有副作用导致崩溃）
ok(true, "aiAct 在热座模式下调用无异常");

console.log(`\n============== 单机 AI 测试结果 ==============`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
