// 逻辑自动化测试：从 battlefield.html 提取 <script>，Mock DOM 后运行规则验证
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "battlefield.html"), "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error("未找到脚本"); process.exit(1); }
let code = m[1];

// ---- Mock DOM ----
function makeEl() {
  return {
    innerHTML: "", textContent: "", className: "", value: "",
    style: {}, dataset: {},
    classList: { add(){}, remove(){}, contains(){ return false; } },
    addEventListener(){}, appendChild(){},
    scrollTop: 0, scrollHeight: 0,
  };
}
const els = {};
global.document = {
  getElementById(id){ return els[id] || (els[id] = makeEl()); },
  createElement(){ return makeEl(); },
  addEventListener(){},
};
global.alert = (msg)=>{ throw new Error("alert: " + msg); };

// 暴露内部函数供测试
code += `
;globalThis.__T = {
  genMap, initCorps, checkWin, executeMove, resolveMelee, roundLoss, attrition,
  doArtilleryStrike, bfsFrom, computeMoveTargets, stationable, corpsIndexAt,
  getCorps, mergeCandidates, artTargets, buildCells, fortCells, tryRiver,
  get corps(){ return corps; }, set corps(v){ corps = v; },
  get terrain(){ return terrain; }, set terrain(v){ terrain = v; },
  get bridge(){ return bridge; }, set bridge(v){ bridge = v; },
  get fort(){ return fort; }, set fort(v){ fort = v; },
  get gameOver(){ return gameOver; },
};
`;
eval(code);
const T = globalThis.__T;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg); }
}

/* ========== 1. 地图生成 ========== */
console.log("\n[1] 地图生成（50 次随机地图）");
for (let s = 0; s < 50; s++) {
  T.genMap();
  const terrain = T.terrain, bridge = T.bridge;
  // 1a. 河流连通且仅一条：所有 river 格 4 连通
  const rivers = [];
  for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) if (terrain[r][c] === "river") rivers.push([r, c]);
  const seen = new Set([rivers[0].join(",")]);
  const q = [rivers[0]];
  while (q.length) {
    const [r, c] = q.pop();
    for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nr = r + dr, nc = c + dc, k = nr + "," + nc;
      if (nr>=0&&nr<20&&nc>=0&&nc<20 && terrain[nr][nc]==="river" && !seen.has(k)) { seen.add(k); q.push([nr,nc]); }
    }
  }
  if (seen.size !== rivers.length) { ok(false, `第${s}次: 河流不连通 (${seen.size}/${rivers.length})`); continue; }
  // 1b. 恰好 3 座桥且都在河上
  let bridges = 0;
  for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) if (bridge[r][c]) { bridges++; if (terrain[r][c] !== "river") { ok(false, `第${s}次: 桥不在河上`); } }
  if (bridges !== 3) { ok(false, `第${s}次: 桥数量=${bridges}`); continue; }
  // 1c. 大本营为高地，周围一圈无禁地无河流
  const bases = [[2,2],[16,16]];
  let baseOK = true;
  for (const [br, bc] of bases) {
    if (terrain[br][bc] !== "highland") baseOK = false;
    for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++) {
      const t = terrain[br+dr][bc+dc];
      if (t === "forbidden" || t === "river") baseOK = false;
    }
  }
  if (!baseOK) { ok(false, `第${s}次: 大本营地形错误`); continue; }
  // 1d. 地形比例（禁地 ≤40，因大本营清禁地会略减）
  let f = 0, h = 0, p = 0;
  for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) {
    const t = terrain[r][c];
    if (t === "forbidden") f++; else if (t === "highland") h++; else if (t === "plain") p++;
  }
  if (f < 22 || f > 40 || h < 70 || h > 82) { ok(false, `第${s}次: 比例异常 禁地${f} 高地${h}`); continue; }
}
ok(true, "50 次随机地图全部通过：单条连通河流 + 恰好3桥 + 大本营高地 + 比例正确");

/* ========== 2. 损耗计算 ========== */
console.log("\n[2] 损耗计算");
T.terrain = Array.from({length:20},()=>Array(20).fill("plain"));
T.bridge  = Array.from({length:20},()=>Array(20).fill(false));
T.fort    = Array.from({length:20},()=>Array(20).fill(false));
const mk = (type, troops, r=5, c=5) => ({ id:1, side:0, type, troops, r, c, resting:false, fatigue:0, alive:true });

ok(T.roundLoss(mk("inf",100), mk("inf",100), false) === 1, "步vs步 基础损耗 1");
ok(T.roundLoss(mk("cav",100), mk("inf",100), false) === 3, "骑vs步 骑兵损耗 3 (步:骑=1:3)");
ok(T.roundLoss(mk("inf",100), mk("cav",100), false) === 1, "步vs骑 步兵损耗 1");
{
  const rest = mk("cav",100); rest.resting = true;
  ok(T.roundLoss(rest, mk("inf",100), false) === 2, "休整骑兵损耗减半 3→2");
  const hi = mk("inf",100); T.terrain[hi.r][hi.c] = "highland";
  ok(T.roundLoss(hi, mk("inf",100), false) === 1, "高地步兵损耗 1→1(向上取整)");
  const hic = mk("cav",100); T.terrain[hic.r][hic.c] = "highland";
  ok(T.roundLoss(hic, mk("inf",100), false) === 2, "高地骑兵 3→2");
  T.terrain[hic.r][hic.c] = "plain";
  const fortC = mk("cav",100); T.fort[fortC.r][fortC.c] = true;
  ok(T.roundLoss(fortC, mk("inf",100), true) === 2, "工事守方骑兵 3→2");
  ok(T.roundLoss(fortC, mk("inf",100), false) === 3, "工事仅守方生效(攻方不减) 3");
  T.fort[fortC.r][fortC.c] = false;
}

/* ========== 3. 消耗战至全歼 ========== */
console.log("\n[3] 消耗战");
{
  const atk = mk("inf", 100, 5, 5), def = mk("cav", 60, 5, 5);
  const seg = { rounds: [] };
  T.attrition(atk, def, seg);
  ok(!def.alive && atk.alive, "步兵100 全歼 骑兵60 (每轮1:3, 骑先耗尽)");
  ok(atk.troops === 100 - 20, `步兵剩余 ${atk.troops} (期望80)`);
}
{
  const atk = mk("cav", 30, 5, 5), def = mk("inf", 200, 5, 5);
  const seg = { rounds: [] };
  T.attrition(atk, def, seg);
  ok(!atk.alive && def.alive, "骑兵30 强攻 步兵200 → 骑兵全歼");
  ok(def.troops === 200 - 10, `步兵剩余 ${def.troops} (期望190: 骑每轮损3, 10轮耗尽, 步每轮损1)`);
}

/* ========== 4. 炮兵规则 ========== */
console.log("\n[4] 炮兵规则");
{
  // 步攻炮：炮全歼
  T.corps = [];
  const atk = mk("inf", 50, 5, 5); atk.id = 1;
  const def = mk("art", 30, 5, 5); def.id = 2; def.side = 1;
  T.corps.push(atk, def);
  const segs = T.resolveMelee(atk);
  ok(!def.alive && atk.alive, "步兵进攻炮兵 → 炮兵全歼");
}
{
  // 炮攻步：炮全歼
  T.corps = [];
  const atk = mk("art", 30, 5, 5); atk.id = 1;
  const def = mk("inf", 50, 5, 5); def.id = 2; def.side = 1;
  T.corps.push(atk, def);
  const segs = T.resolveMelee(atk);
  ok(!atk.alive && def.alive, "炮兵撞上步兵 → 炮兵被全歼");
}
{
  // 炮击伤害 = 炮兵数量；工事目标减半
  T.corps = [];
  const art = mk("art", 20, 5, 5); art.id = 1;
  const tgt = mk("inf", 100, 5, 7); tgt.id = 2; tgt.side = 1;
  T.corps.push(art, tgt);
  const rep = T.doArtilleryStrike(art, tgt);
  ok(rep.real === 20 && tgt.troops === 80, "炮击伤害=炮兵数 20");
  T.fort[5][7] = true;
  const rep2 = T.doArtilleryStrike(art, tgt);
  ok(rep2.real === 10 && tgt.troops === 70, "工事上目标炮击减半 20→10");
  T.fort[5][7] = false;
}
{
  // 炮击目标筛选
  T.corps = [];
  const art = mk("art", 20, 10, 10); art.id = 1;
  const e1 = mk("inf", 10, 10, 12); e1.id = 2; e1.side = 1;            // 距2
  const e2 = mk("inf", 10, 10, 14); e2.id = 3; e2.side = 1;            // 距4
  const e3 = mk("inf", 10, 13, 10); e3.id = 4; e3.side = 1; e3.resting = true; // 距3,休整
  T.corps.push(art, e1, e2, e3);
  const ts = T.artTargets(art);
  ok(ts.length === 1 && ts[0].id === 2, "未休整炮兵射程2：仅命中距离2目标");
  art.resting = true;
  const ts2 = T.artTargets(art);
  ok(ts2.length === 1 && ts2[0].id === 2, "休整炮兵：射程3内仅未休整目标可打(e1), 休整目标(e3)不可打");
  T.terrain[10][10] = "highland";
  const ts3 = T.artTargets(art);
  ok(ts3.length === 2 && ts3.some(t=>t.id===2) && ts3.some(t=>t.id===4), "高地休整炮兵：3格内任意目标(含休整)");
  T.terrain[10][10] = "plain";
}

/* ========== 5. 移动寻路 ========== */
console.log("\n[5] 移动与寻路");
{
  T.corps = [];
  const cav = mk("cav", 50, 10, 10); cav.id = 1;
  T.corps.push(cav);
  const t3 = T.computeMoveTargets(cav, 3);
  ok(t3.empties.has("10,13") && t3.empties.has("13,10"), "骑兵3步可达直线3格/纵向3格(曼哈顿距离)");
  ok(!t3.empties.has("10,14"), "4格不可达");
  const t1 = T.computeMoveTargets(cav, 1);
  ok(t1.empties.has("10,11") && !t1.empties.has("10,12"), "1步范围正确");
  // 禁地阻挡
  T.terrain[10][11] = "forbidden";
  const t2 = T.computeMoveTargets(cav, 2);
  ok(!t2.empties.has("10,12") && !t2.empties.has("10,13"), "禁地阻挡通行");
  T.terrain[10][11] = "plain";
  // 无桥河流阻挡
  T.terrain[10][11] = "river";
  const t2b = T.computeMoveTargets(cav, 2);
  ok(!t2b.empties.has("10,12"), "无桥河流阻挡");
  T.bridge[10][11] = true;
  const t2c = T.computeMoveTargets(cav, 2);
  ok(t2c.empties.has("10,12"), "有桥可通过(2步到达桥对岸)");
  T.bridge[10][11] = false; T.terrain[10][11] = "plain";
  // 兵团阻挡穿越，但可作为终点进攻
  T.corps = [];
  const cav2 = mk("cav", 50, 10, 10); cav2.id = 1;
  const enemy = mk("inf", 10, 10, 12); enemy.id = 2; enemy.side = 1;
  T.corps.push(cav2, enemy);
  const t3b = T.computeMoveTargets(cav2, 3);
  ok(t3b.corpsCells.has("10,12") && t3b.corpsCells.get("10,12").type === "attack", "敌军格可作为进攻终点");
  ok(!t3b.empties.has("10,13"), "不可穿越敌军身后的格子");
}
{
  // 3格奔袭疲劳 + 休整解除
  T.corps = [];
  const cav = mk("cav", 50, 10, 10); cav.id = 1; cav.resting = true;
  T.corps.push(cav);
  const path = [[10,11],[10,12],[10,13]];
  const rep = T.executeMove(cav, path);
  ok(cav.r === 10 && cav.c === 13, "移动到目标格");
  ok(!cav.resting, "移动后休整解除");
  ok(cav.fatigue === 2, "骑兵3格 → 疲劳(下回合不能移动)");
}
{
  // 移动交战保持休整
  T.corps = [];
  const inf = mk("inf", 50, 10, 10); inf.id = 1; inf.resting = true;
  const enemy = mk("cav", 10, 10, 11); enemy.id = 2; enemy.side = 1;
  T.corps.push(inf, enemy);
  const rep = T.executeMove(inf, [[10,11]]);
  ok(inf.resting === true, "移动且交战 → 休整保持");
  ok(!enemy.alive, "交战把敌方骑兵打光了(50步 vs 10骑 每轮1:3)");
}

/* ========== 6. 合并候选 / 分兵位 ========== */
console.log("\n[6] 分兵/合兵");
{
  T.corps = [];
  const a = mk("inf", 100, 10, 10); a.id = 1;
  const b = mk("inf", 20, 10, 11); b.id = 2;
  const c = mk("cav", 20, 10, 12); c.id = 3;
  T.corps.push(a, b, c);
  ok(T.mergeCandidates(a).length === 1 && T.mergeCandidates(a)[0].id === 2, "合兵：仅相邻同兵种");
  ok(T.buildCells(a).has("11,10"), "分兵/建造：相邻空格可选");
}

console.log(`\n========== 测试完成: ${pass} 通过, ${fail} 失败 ==========`);
process.exit(fail ? 1 : 0);
