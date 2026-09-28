/* debug-charge.js — 验证集体冲锋：同时抵达 / 途中遇敌转独立冲锋 / 过境即停拦截 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "battlefield-v3.html"), "utf8");
let code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n').replace(/\nnewGame\(\);\s*$/, "\n");
code += `
globalThis.__T = {
  get corps(){return corps}, get current(){return current}, set current(v){current=v},
  get turnNo(){return turnNo}, get phase(){return phase}, set phase(v){phase=v},
  get fortH(){return fortH}, get fortV(){return fortV},
  get terrain(){return terrain}, get acted(){return acted},
  UNITS, BASES, N,
  fn: { newGame, computeVision, performGroupCharge, computeMoveTargets, chargeEligible, chargeReachable, key,
        setFort, edgeBetween, nextId:()=>nextId }
};
`;
function stubEl() {
  return { innerHTML: "", textContent: "", className: "", value: "0", style: {}, dataset: {},
    scrollTop: 0, scrollHeight: 0, checked: true, disabled: true,
    classList: { add(){}, remove(){}, contains(){ return false; }, toggle(){} },
    appendChild(){}, addEventListener(){}, focus(){},
    querySelectorAll(){ return []; }, closest(){ return null; } };
}
const cache = {};
const documentStub = { getElementById: id => (cache[id] || (cache[id] = stubEl())),
  querySelector: () => null, querySelectorAll: () => [], createElement: () => stubEl(), addEventListener: () => {} };
const ctx = { document: documentStub, console: { log(){}, warn(){}, error(){} }, alert: m=>{ throw new Error("alert:"+m); },
  Math, JSON, Set, Map, Array, Object, String, Number, parseInt, isNaN, Infinity,
  setTimeout: () => 0, clearTimeout: () => {}, globalThis: null };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx);
const T = ctx.__T, F = T.fn;

let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++; console.log("  ✓ "+m);} else {fail++; console.log("  ✗ "+m);} };

F.newGame();
T.phase = "play"; T.current = 0;
T.corps.length = 0;
T.acted.clear();

function mkUnit(type, side, r, c, extra) {
  const u = T.UNITS[type];
  const p = Object.assign({
    id: T.corps.length + 1, type, side, r, c, troops: 10, alive: true,
    fatigue: 0, resting: false, moved: false, lockAtk: false, lockDef: false,
    dur: u.dur || 0, flare: 0, smoke: 0, bombs: 0,
  }, extra || {});
  T.corps.push(p);
  return p;
}
// 人工地形：区域大部分设为禁地，只留两条走廊，保证路径唯一可预测
for (let r = 4; r <= 14; r++) for (let c = 4; c <= 15; c++) T.terrain[r][c] = "forbidden";
for (let r = 6; r <= 10; r++) T.terrain[r][10] = "plain";     // 纵向走廊（cavB 用）
for (let c = 5; c <= 13; c++) T.terrain[10][c] = "plain";     // 横向走廊（cavA/cavC 用）

console.log("--- 场景A：同时抵达 + 途中遇敌转独立冲锋 + 过境即停拦截 ---");
const enemyTarget = mkUnit("inf", 1, 10, 10);       // 目标格守军
const hiddenEnemy = mkUnit("inf", 1, 9, 10);        // cavB 路径上的隐藏敌军（距 cavB 3 > 视野2，迷雾中）
const cavA = mkUnit("cav", 0, 10, 7);               // 直线可达，无阻挡
const cavB = mkUnit("cav", 0, 6, 10);               // 路径必经 (9,10) 的隐藏敌军
const cavC = mkUnit("cav", 0, 10, 13);              // 跨工事且目标在停点之外 → 不该参战
F.setFort(F.edgeBetween(10, 12, 10, 11), true);

const vis = F.computeVision(0);
console.log("框选判定（chargeReachable）:");
for (const p of [cavA, cavB, cavC]) {
  const rc = F.chargeReachable(p, 10, 10, vis);
  console.log(`  ${p.type}@(${p.r},${p.c}): ${rc ? "可合法抵达" + (rc.crossed ? "（过工事）" : "") : "不可合法抵达"}`);
}
ok(F.chargeReachable(cavA, 10, 10, vis), "cavA 可合法抵达");
ok(F.chargeReachable(cavB, 10, 10, vis), "cavB 可合法抵达（敌军隐藏，BFS 未知）");
ok(!F.chargeReachable(cavC, 10, 10, vis), "cavC 过境即停够不到 → 框选即排除");

const res = F.performGroupCharge(0, 10, 10, [cavA.id, cavB.id, cavC.id]);
console.log("到场:", res.arrived.map(p=>`${p.type}@(${p.r},${p.c})`).join(" "));
console.log("途中转独立冲锋:", res.diverted.map(d=>`(${d.r+1},${d.c+1})`).join(" "));
console.log("掉队:", res.dropped);
console.log("移动日志:", res.movedLogs);

ok(res.arrived.length===1 && res.arrived[0]===cavA, "仅 cavA 抵达目标格");
ok(cavA.r===10 && cavA.c===10, "cavA 位于目标格 (10,10)");
ok(res.diverted.length===1 && res.diverted[0].r===9 && res.diverted[0].c===10, "cavB 途中遇敌 → 在 (9,10) 转独立冲锋");
ok(cavB.r===9 && cavB.c===10, "cavB 停在遭遇格 (9,10)");
ok(cavC.r===10 && cavC.c===13, "cavC 留在原地（未瞬移）");
ok(res.dropped.some(s=>s.includes("(11,14)")||s.includes("(10,14)")), "cavC 出现在掉队记录");
ok(res.seg && res.seg.atk0.length===1, "目标格战斗攻方=1（同时抵达者）");
ok(res.diverted[0].seg && res.diverted[0].seg.atk0.length===1 && res.diverted[0].seg.atk0[0].type==="cav", "遭遇战攻方=cavB");
ok(T.acted.has(cavA.id) && T.acted.has(cavB.id) && T.acted.has(cavC.id)===false, "到场/转进者已行动，掉队者未行动");

console.log("\n--- 场景B：过境即停边界（目标=工事后1格，应可抵达） ---");
const enemyB = mkUnit("inf", 1, 10, 11);
const cavD = mkUnit("cav", 0, 10, 13);
const resB = F.performGroupCharge(0, 10, 11, [cavD.id]);
ok(resB.arrived.length===1 && cavD.r===10 && cavD.c===11, "cavD 跨工事抵达工事后1格的目标");
ok(resB.dropped.length===0, "无掉队");

console.log("\n--- 场景C：多兵团同时抵达（合并为一次冲锋） ---");
const enemyC = mkUnit("inf", 1, 4, 4);
for (let r = 2; r <= 6; r++) for (let c = 2; c <= 6; c++) T.terrain[r][c] = "plain";
const e1 = mkUnit("cav", 0, 4, 1), e2 = mkUnit("cav", 0, 1, 4), e3 = mkUnit("cav", 0, 2, 2);
for (let r = 1; r <= 6; r++) for (let c = 1; c <= 6; c++) if (T.terrain[r][c]==="forbidden") T.terrain[r][c] = "plain";
const resC = F.performGroupCharge(0, 4, 4, [e1.id, e2.id, e3.id]);
ok(resC.arrived.length===3, "3 支兵团全部同时抵达");
ok(resC.arrived.every(p=>p.r===4&&p.c===4), "全部位于目标格");
ok(resC.seg && resC.seg.atk0.length===3, "合并为一次集体冲锋（攻方=3）");
ok(resC.diverted.length===0 && resC.dropped.length===0, "无遭遇战、无掉队");

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail?1:0);
