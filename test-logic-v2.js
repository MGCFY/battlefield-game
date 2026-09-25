/* 战场沙盘 v2 · 规则断言测试
   直接从 battlefield-v2.html 抽取真实脚本，在 Node 里用最小 DOM 桩运行，
   对视野/昼夜/损耗/打击/地堡/烟幕/导弹等规则做断言。 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "battlefield-v2.html"), "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error("未找到脚本"); process.exit(1); }
let code = m[1].replace(/\nnewGame\(\);\s*$/, "\n");

/* ---- 把内部状态与函数暴露给测试 ---- */
code += `
globalThis.__T = {
  get terrain(){return terrain}, set terrain(v){terrain=v},
  get bridge(){return bridge}, set bridge(v){bridge=v},
  get fort(){return fort}, set fort(v){fort=v},
  get bunker(){return bunker}, set bunker(v){bunker=v},
  get bunkerDead(){return bunkerDead}, set bunkerDead(v){bunkerDead=v},
  get flare(){return flare}, set flare(v){flare=v},
  get smokeLeft(){return smokeLeft}, set smokeLeft(v){smokeLeft=v},
  get smokeId(){return smokeId}, set smokeId(v){smokeId=v},
  get corps(){return corps}, set corps(v){corps=v},
  get current(){return current}, set current(v){current=v},
  get turnNo(){return turnNo}, set turnNo(v){turnNo=v},
  get phase(){return phase}, set phase(v){phase=v},
  get gameOver(){return gameOver}, set gameOver(v){gameOver=v},
  get winner(){return winner}, set winner(v){winner=v},
  get pendingMissiles(){return pendingMissiles}, set pendingMissiles(v){pendingMissiles=v},
  get memoryFog(){return memoryFog}, set memoryFog(v){memoryFog=v},
  get smokeSeq(){return smokeSeq}, set smokeSeq(v){smokeSeq=v},
  get deployCfg(){return deployCfg}, set deployCfg(v){deployCfg=v},
  get deployedCount(){return corps.length},
  get logEntries(){return logEntries},
  get acted(){return acted},
  get mode(){return mode}, set mode(v){mode=v},
  get modeData(){return modeData}, set modeData(v){modeData=v},
  UNITS, BASES, N, MELEE, RECOMMEND, DEPLOY_TYPES, BUDGET,
  fn: { newGame, renderDeploy, confirmDeploy, startPlay, render, endTurn,
        genMap, stationable, airStationable, computeVision, visionRange, unitVisibleTo,
        structVisibleAt, enemySizeClass, smokePatchAt, inFlare, patchHasUnit, patchCells,
        meleeLoss, attrition, resolveMelee, strikeBase, strikeRange, canStrike, strikeCell,
        katyushaStrike, computeMoveTargets, executeMove, checkWin, isDay, dayNo,
        deploySpent, spawnFromConfig, resolveMissiles, hasGround, markSeen, grid, key, cheb,
        log, boardStrike, showStrikeModal }
};
`;

/* ---- 最小 DOM 桩 ---- */
function stubEl() {
  return {
    innerHTML: "", textContent: "", className: "", value: "0",
    style: {}, dataset: {}, scrollTop: 0, scrollHeight: 0, checked: true,
    classList: { add(){}, remove(){}, contains(){ return false; } },
    appendChild(){}, addEventListener(){}, closest(){ return null; }
  };
}
const elCache = {};
const documentStub = {
  getElementById: id => (elCache[id] || (elCache[id] = stubEl())),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => stubEl(),
  addEventListener: () => {}
};
const ctx = { document: documentStub, console, alert: () => {}, Math, JSON, Set, Map,
              Array, Object, String, Number, parseInt, isNaN, Infinity, globalThis: null };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx);
const T = ctx.__T, F = T.fn, N = T.N, UNITS = T.UNITS, BASES = T.BASES;

/* ---- 断言 ---- */
let pass = 0, fail = 0;
const fails = [];
function ok(cond, label) { if (cond) pass++; else { fail++; fails.push(label); } }
function eq(a, b, label) { ok(a === b, `${label} (期望 ${b}，实际 ${a})`); }
function near(a, b, tol, label) { ok(Math.abs(a - b) <= tol, `${label} (期望≈${b}，实际 ${a})`); }
const grid = v => Array.from({ length: N }, () => Array(N).fill(v));

function resetMap(fill) {
  T.terrain = grid(fill || "plain");
  T.bridge = grid(false); T.fort = grid(false);
  T.bunker = grid(0); T.bunkerDead = grid(false);
  T.flare = grid(0); T.smokeLeft = grid(0); T.smokeId = grid(0);
  T.corps = []; T.nextId = 1; T.current = 0; T.turnNo = 1; T.phase = "play";
  T.gameOver = false; T.winner = 0; T.pendingMissiles = []; T.smokeSeq = 1;
}
let _id = 1;
function mk(side, type, troops, r, c, extra) {
  const u = UNITS[type];
  const p = Object.assign({
    id: 1000 + (_id++), side, type, troops, r, c, resting: false, fatigue: 0,
    alive: true, acc: 0, dur: u.dur || 0,
    flare: u.throwable ? 1 : 0, smoke: u.throwable ? 1 : 0,
    missile: u.missile ? 1 : 0, ammo: false
  }, extra || {});
  T.corps.push(p); return p;
}
function vis(side) { return F.computeVision(side); }

/* ============ 1. 地图生成 ============ */
{
  let genOk = 0, riverOk = 0, bridgeOk = 0, baseOk = 0, terrOk = 0, stationOk = 0;
  for (let t = 0; t < 40; t++) {
    F.genMap();
    const terr = T.terrain, br = T.bridge;
    const cnt = { plain: 0, highland: 0, river: 0, forbidden: 0 };
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) cnt[terr[r][c]]++;
    if (cnt.plain + cnt.highland + cnt.river + cnt.forbidden === 400) terrOk++;
    // 河流会在 1:2:7 的地基上开凿，故三类地形数量围绕 40/80/280 上下浮动
    if (cnt.forbidden >= 28 && cnt.forbidden <= 40 &&
        cnt.highland >= 66 && cnt.highland <= 82 &&
        cnt.plain >= 236 && cnt.plain <= 292 &&
        cnt.river >= 12 && cnt.river <= 40) genOk++;
    // 河流连通（四方向）
    const river = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (terr[r][c] === "river") river.push([r, c]);
    const seenR = new Set([river[0].join(",")]);
    const q = [river[0]];
    while (q.length) {
      const [r, c] = q.shift();
      for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= N || nc < 0 || nc >= N) continue;
        const k = nr + "," + nc;
        if (seenR.has(k) || terr[nr][nc] !== "river") continue;
        seenR.add(k); q.push([nr, nc]);
      }
    }
    if (seenR.size === river.length) riverOk++;
    let bc = 0, allOnRiver = true;
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (br[r][c]) { bc++; if (terr[r][c] !== "river") allOnRiver = false; }
    if (bc === 3 && allOnRiver) bridgeOk++;
    let bok = true;
    for (const [r, c] of BASES) if (terr[r][c] !== "highland") bok = false;
    if (bok) baseOk++;
    let sok = true;
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      if (terr[r][c] === "forbidden" && F.stationable(r, c)) sok = false;
      if (terr[r][c] === "river" && !br[r][c] && F.stationable(r, c)) sok = false;
    }
    if (sok) stationOk++;
  }
  eq(terrOk, 40, "地图：400 格地形数量守恒");
  eq(genOk, 40, "地图：1:2:7 比例正确（禁地:高地:平地）");
  eq(riverOk, 40, "地图：河流四方向连通成一条");
  eq(bridgeOk, 40, "地图：恰好 3 座桥且都在河上");
  eq(baseOk, 40, "地图：两座大本营均为高地");
  eq(stationOk, 40, "地图：禁地与无桥河面不可驻扎");
}

/* ============ 2. 昼夜 ============ */
{
  for (const [t, day, dn] of [[1,true,1],[10,true,1],[11,false,1],[20,false,1],[21,true,2],[40,false,2],[41,true,3]]) {
    T.turnNo = t;
    eq(F.isDay(), day, `昼夜：第 ${t} 回合为${day ? "白天" : "夜晚"}`);
    eq(F.dayNo(), dn, `昼夜：第 ${t} 回合是第 ${dn} 天`);
  }
}

/* ============ 3. 视野范围 ============ */
{
  resetMap();
  const expect = {
    inf: [2, 1], cav: [3, 2], lightArt: [3, 2], scout: [6, 4],
    heavyArt: [3, 2], tank: [4, 3], katyusha: [4, 3], recon: [3, 2], bomber: [3, 2]
  };
  for (const t in expect) {
    T.turnNo = 1; const p = mk(0, t, 10, 10, 10);
    eq(F.visionRange(p), expect[t][0], `视野：白天 ${UNITS[t].name}=${expect[t][0]} 格`);
    T.turnNo = 11;
    eq(F.visionRange(p), expect[t][1], `视野：夜晚 ${UNITS[t].name}=${expect[t][1]} 格`);
    T.corps = [];
  }
  T.turnNo = 1;
}

/* ============ 4. 迷雾可见性 ============ */
{
  resetMap(); T.turnNo = 1;
  const own = mk(0, "inf", 100, 10, 10);        // 视野2
  const foeIn = mk(1, "inf", 100, 12, 12);      // 距离2 → 可见
  const foeOut = mk(1, "inf", 100, 15, 15);     // 距离5 → 不可见
  const foeAir = mk(1, "recon", 1, 11, 11);     // 距离1，但空中 → 永不可见
  const v = vis(0);
  ok(F.unitVisibleTo(own, 0, v), "迷雾：己方兵团始终可见");
  ok(F.unitVisibleTo(foeIn, 0, v), "迷雾：视野内敌方地面兵团可见");
  ok(!F.unitVisibleTo(foeOut, 0, v), "迷雾：视野外敌方兵团不可见");
  ok(!F.unitVisibleTo(foeAir, 0, v), "迷雾：敌方空中单位永不可见");
  const vB = vis(1);
  ok(F.unitVisibleTo(foeOut, 1, vB), "迷雾：兵团对本方始终可见");
  const redFar = mk(0, "inf", 100, 19, 0);
  ok(!F.unitVisibleTo(redFar, 1, vis(1)), "迷雾：视角相互独立（红远处单位对蓝方不可见）");
  // 视野是"全方共享"的：侦察兵可为后排炮兵提供目标
  resetMap(); T.turnNo = 1;
  const scout = mk(0, "scout", 1, 10, 10);      // 视野6
  const farFoe = mk(1, "inf", 100, 10, 15);     // 距离5
  ok(F.unitVisibleTo(farFoe, 0, vis(0)), "迷雾：侦察兵为全方提供远处视野（协同打击）");
  const art = mk(0, "lightArt", 10, 10, 11);
  ok(F.strikeRange(art) >= 4, "迷雾：轻炮射程 4 格，配合侦察兵视野可用");
}

/* ============ 5. 兵团规模分级 ============ */
{
  resetMap();
  const a = mk(1, "inf", 49, 5, 5);    eq(F.enemySizeClass([a]), "小", "规模：49分 → 小");
  a.troops = 50;                        eq(F.enemySizeClass([a]), "中", "规模：50分 → 中");
  a.troops = 199;                       eq(F.enemySizeClass([a]), "中", "规模：199分 → 中");
  a.troops = 200;                       eq(F.enemySizeClass([a]), "大", "规模：200分 → 大");
  const s = mk(1, "scout", 100, 6, 6);  eq(F.enemySizeClass([s]), "小", "规模：侦察兵永远算小（500分仍为小）");
  const tk = mk(1, "tank", 4, 7, 7);    eq(F.enemySizeClass([tk]), "大", "规模：坦克4辆=200分 → 大");
  const i2 = mk(1, "inf", 30, 8, 8), c2 = mk(1, "cav", 10, 8, 8);
  eq(F.enemySizeClass([i2, c2]), "中", "规模：同格多兵团积分求和 (30+40=70) → 中");
}

/* ============ 6. 近战损耗 ============ */
{
  resetMap();
  const inf = mk(0, "inf", 400, 5, 5), cav = mk(1, "cav", 50, 5, 5);
  eq(F.meleeLoss(inf, cav, false), 1, "近战：步兵对骑兵每回合损耗 1");
  eq(F.meleeLoss(cav, inf, true), 3, "近战：骑兵对步兵每回合损耗 3（1:3）");
  const tk = mk(1, "tank", 10, 5, 5);
  eq(F.meleeLoss(cav, tk, false), 1, "近战：骑兵对坦克损耗 1");
  eq(F.meleeLoss(tk, cav, true), 10, "近战：坦克对骑兵损耗 10（1:10）");
  eq(F.meleeLoss(inf, tk, false), 1, "近战：步兵对坦克损耗 1");
  eq(F.meleeLoss(tk, inf, true), 20, "近战：坦克对步兵损耗 20（1:20）");
  const inf2 = mk(0, "inf", 400, 6, 6), inf3 = mk(1, "inf", 400, 6, 6);
  eq(F.meleeLoss(inf2, inf3, false), 1, "近战：同兵种 1:1");
  inf2.resting = true;
  near(F.meleeLoss(inf2, cav, false), 0.5, 1e-9, "近战：休整减半");
  inf2.resting = false;
  T.terrain[6][6] = "highland";
  near(F.meleeLoss(inf2, cav, false), 0.5, 1e-9, "近战：高地驻扎减半");
  T.terrain[6][6] = "plain";
  T.fort[6][6] = true;
  near(F.meleeLoss(inf2, cav, true), 0.5, 1e-9, "近战：工事上的被进攻方减半");
  eq(F.meleeLoss(inf2, cav, false), 1, "近战：工事只保护被进攻方（主动进攻者不享受）");
  T.fort[6][6] = false;
  const art = mk(0, "lightArt", 20, 7, 7);
  eq(F.meleeLoss(art, inf2, false), 20, "近战：炮兵遭遇步兵 → 被全歼");
  eq(F.meleeLoss(inf2, art, true), 0, "近战：步兵打炮兵不掉兵");
  const sc = mk(0, "scout", 30, 8, 8), cv2 = mk(1, "cav", 20, 8, 8);
  eq(F.meleeLoss(sc, cv2, false), 30, "近战：侦察兵遭遇骑兵 → 被全歼");
  const tk2 = mk(1, "tank", 30, 9, 9, { dur: 1 });
  near(F.meleeLoss(tk2, inf, true), 20 / 3, 1e-9, "近战：剩1耐久坦克损耗 ×1/3");
  tk2.dur = 2; near(F.meleeLoss(tk2, inf, true), 40 / 3, 1e-9, "近战：剩2耐久坦克损耗 ×2/3");
  // 实际结算
  resetMap();
  const A = mk(0, "inf", 400, 5, 5), B = mk(1, "cav", 50, 5, 5);
  const seg = { rounds: [] };
  F.attrition(A, B, seg);
  ok(!B.alive && A.alive, "近战：步兵400 全歼 骑兵50");
  eq(A.troops, 400 - 17, "近战：骑兵50 抵抗 17 轮，步兵实损 17");
  ok(seg.rounds.length === 17, "近战：逐轮消耗过程被完整记录");
  // 休整让防守方损耗减半（同兵力对拼，休整方胜且仅损一半）
  resetMap();
  const A2 = mk(0, "inf", 400, 5, 5), B2 = mk(1, "inf", 400, 5, 5, { resting: true });
  const seg2 = { rounds: [] };
  F.attrition(A2, B2, seg2);
  ok(B2.alive && !A2.alive, "近战：同兵力对拼中休整方获胜");
  near(B2.troops, 200, 1, "近战：休整减损生效（400轮仅损200）");
  // 高地同样减损
  resetMap();
  T.terrain[5][5] = "highland";
  const A3 = mk(0, "inf", 400, 6, 6), B3 = mk(1, "inf", 400, 5, 5);
  const segHi = { rounds: [] };
  F.attrition(A3, B3, segHi);
  ok(B3.alive && !A3.alive, "近战：高地驻扎方对拼获胜（减损一半）");
  // 步 vs 坦克：坦克一回合被清空
  resetMap();
  const infA = mk(0, "inf", 400, 5, 5), tkb = mk(1, "tank", 10, 5, 5);
  const seg3 = { rounds: [] };
  F.attrition(infA, tkb, seg3);
  ok(!tkb.alive && infA.troops === 399, "近战：10辆坦克对400步兵，首轮即被全歼（1:20）");
}

/* ============ 7. 远程打击参数 ============ */
{
  resetMap();
  const la = mk(0, "lightArt", 10, 10, 10);
  eq(F.strikeBase(la), 3, "打击：轻炮未休整每门 3 人");
  la.resting = true; eq(F.strikeBase(la), 5, "打击：轻炮休整每门 5 人");
  eq(F.strikeRange(la), 5, "打击：轻炮休整射程 5");
  la.resting = false; eq(F.strikeRange(la), 4, "打击：轻炮未休整射程 4");
  T.terrain[10][10] = "highland";
  eq(F.strikeRange(la), 5, "打击：高地增幅 +1 格");
  T.terrain[10][10] = "plain";

  const ha = mk(0, "heavyArt", 5, 10, 10);
  eq(F.strikeBase(ha), 8, "打击：重炮每门 8 人");
  eq(F.strikeRange(ha), 8, "打击：重炮射程 8");
  eq(F.canStrike(ha), false, "打击：重炮未休整不能打击");
  ha.resting = true; eq(F.canStrike(ha), true, "打击：重炮休整后可打击");
  T.terrain[10][10] = "highland"; eq(F.strikeRange(ha), 9, "打击：重炮高地射程 9");
  T.terrain[10][10] = "plain";

  const tk = mk(0, "tank", 10, 10, 10);
  eq(F.strikeBase(tk), 20, "打击：坦克每辆 20 人");
  eq(F.strikeRange(tk), 3, "打击：坦克未休整射程 3");
  tk.resting = true; eq(F.strikeRange(tk), 4, "打击：坦克休整射程 4");
  tk.resting = false;

  const ka = mk(0, "katyusha", 2, 10, 10);
  eq(F.strikeBase(ka), 30, "打击：喀秋莎每辆 30 人（100%威力）");
  eq(F.strikeRange(ka), 4, "打击：喀秋莎选点射程 4");
  eq(F.canStrike(ka), false, "打击：喀秋莎未装填不能打击");
  ka.ammo = true; eq(F.canStrike(ka), true, "打击：喀秋莎装填后可打击");
  T.terrain[10][10] = "highland"; eq(F.strikeRange(ka), 5, "打击：喀秋莎高地射程 5");
}

/* ============ 8. 打击结算与减伤 ============ */
{
  resetMap();
  const sh = mk(0, "lightArt", 10, 5, 5);
  const t1 = mk(1, "inf", 200, 6, 6);
  F.strikeCell(sh, 6, 6, 30);
  eq(t1.troops, 170, "打击：满威力直接扣 30");

  resetMap();
  T.terrain[6][6] = "highland";
  const sh2 = mk(0, "lightArt", 10, 5, 5);
  const t2 = mk(1, "inf", 200, 6, 6, { resting: true });
  F.strikeCell(sh2, 6, 6, 30);
  eq(t2.troops, 200 - 8, "打击：休整(×0.5) + 高地(×0.5) → 30×0.25=7.5≈8");

  resetMap();
  T.terrain[6][6] = "highland";
  const sh3 = mk(0, "lightArt", 10, 5, 5);
  const t3 = mk(1, "inf", 200, 6, 6, { resting: true });
  T.bunker[6][6] = 3;
  F.strikeCell(sh3, 6, 6, 30);
  eq(t3.troops, 200 - 4, "打击：休整+高地+地堡 三重减半 → 30×0.125≈4");
  eq(T.bunker[6][6], 2, "地堡：受击一次耐久 3→2");
  F.strikeCell(sh3, 6, 6, 30); F.strikeCell(sh3, 6, 6, 30);
  eq(T.bunker[6][6], 0, "地堡：第三次打击后耐久归零");
  ok(T.bunkerDead[6][6], "地堡：失效后该格永久不可再修筑");

  resetMap();
  const sh4 = mk(0, "tank", 5, 5, 5);
  const t4 = mk(1, "inf", 100, 6, 6);
  T.fort[6][6] = true;
  F.strikeCell(sh4, 6, 6, 100);
  ok(!T.fort[6][6], "打击：摧毁目标格防御工事");

  resetMap();
  const sh5 = mk(0, "heavyArt", 5, 5, 5, { resting: true });
  const tkv = mk(1, "tank", 5, 6, 6);
  F.strikeCell(sh5, 6, 6, 40);
  eq(tkv.dur, 2, "耐久：被炮兵打击后 3→2");
  F.strikeCell(sh5, 6, 6, 40); F.strikeCell(sh5, 6, 6, 40);
  ok(!tkv.alive, "耐久：归零即毁灭");

  resetMap();
  const sh6 = mk(0, "heavyArt", 5, 5, 5, { resting: true });
  const air = mk(1, "recon", 1, 6, 6);
  F.strikeCell(sh6, 6, 6, 40);
  ok(air.alive && air.troops === 1, "打击：空中单位不会被打击");

  resetMap();
  const sh7 = mk(0, "heavyArt", 5, 5, 5, { resting: true });
  const real = mk(1, "lightArt", 20, 6, 6);
  F.strikeCell(sh7, 6, 6, 40);
  ok(!real.alive, "打击：敌对炮兵可被歼灭");
}

/* ============ 9. 喀秋莎面杀伤 ============ */
{
  resetMap();
  const ka = mk(0, "katyusha", 2, 5, 5);   // 总威力 2×30 = 60
  const center = mk(1, "inf", 500, 6, 6);
  const ring = [];
  for (const [r, c] of [[6,7],[7,7],[7,6],[7,5],[6,5],[5,5],[5,6],[5,7]]) ring.push(mk(1, "inf", 500, r, c));
  F.katyushaStrike(ka, 6, 6);
  const dmgCenter = 500 - center.troops;
  const dmgRing = ring.reduce((s, p) => s + (500 - p.troops), 0);
  near(dmgCenter, 30, 1e-9, "喀秋莎：中心承受 50% 威力 (60×0.5=30)");
  ok(dmgRing > 0 && dmgRing <= 34, "喀秋莎：其余 50% 威力在周围 8 格随机结算");
  near(dmgCenter + dmgRing, 60, 5, "喀秋莎：总威力守恒（含四舍五入误差）");
}

/* ============ 10. 视野决定可否打击 ============ */
{
  resetMap(); T.turnNo = 1;
  const art = mk(0, "lightArt", 20, 10, 10);   // 射程4，自身视野3
  const v = vis(0);
  ok(v.has("10,12"), "视野：3 格内在视野内");
  ok(!v.has("10,15"), "视野：4 格外不在视野内（即使射程够也无法打击）");
  const scout = mk(0, "scout", 1, 10, 10);     // 视野6 拉动全方视野
  const v2 = vis(0);
  ok(v2.has("10,15"), "视野：侦察兵把全方视野拉到 6 格（炮兵可打 4 格目标）");
}

/* ============ 11. 烟幕与照明弹 ============ */
{
  // A. 烟幕内单位可互相看见
  resetMap(); T.turnNo = 1;
  const inSmoke = mk(0, "scout", 1, 10, 10);
  const foe = mk(1, "inf", 100, 11, 11);
  const id = 77;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    T.smokeLeft[10 + dr][10 + dc] = 5; T.smokeId[10 + dr][10 + dc] = id;
  }
  eq(F.smokePatchAt(10, 10), id, "烟幕：投掷点处于烟幕区");
  ok(F.patchHasUnit(id, 0), "烟幕：识别出区内己方单位");
  eq(F.visionRange(inSmoke), 1, "烟幕：区内非空中单位视野降为 1 格");
  ok(F.unitVisibleTo(foe, 0, vis(0)), "烟幕：区内单位可见同烟幕内的敌人");
  eq(F.patchCells(id).length, 9, "烟幕：形成 3×3 区域");

  // B. 区外单位无法窥视烟幕内敌人
  resetMap(); T.turnNo = 1;
  const observer = mk(0, "scout", 1, 10, 15);   // 视野6，距离4，本应看得见
  const hidden = mk(1, "inf", 100, 11, 11);
  const id2 = 88;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    T.smokeLeft[11 + dr][11 + dc] = 5; T.smokeId[11 + dr][11 + dc] = id2;
  }
  ok(!F.unitVisibleTo(hidden, 0, vis(0)), "烟幕：区外单位无法窥视烟幕内敌人");
  T.smokeLeft[11][11] = 0; T.smokeId[11][11] = 0;
  ok(F.unitVisibleTo(hidden, 0, vis(0)), "烟幕：烟幕散去后恢复可见");

  // C. 照明弹
  resetMap(); T.turnNo = 1;
  const hidden2 = mk(1, "inf", 100, 1, 1);
  ok(!F.unitVisibleTo(hidden2, 0, vis(0)), "照明弹：未照明时远处敌人不可见");
  T.flare[1][1] = 5;
  ok(F.inFlare(1, 1), "照明弹：标记照明区");
  ok(F.unitVisibleTo(hidden2, 0, vis(0)), "照明弹：照明区内兵团全图可见");
}

/* ============ 12. 移动规则 ============ */
{
  resetMap();
  const inf = mk(0, "inf", 100, 10, 10);
  let mt = F.computeMoveTargets(inf, 1, vis(0));
  ok(mt.empties.has("11,10") && mt.empties.has("10,11"), "移动：步兵走 1 格");
  ok(!mt.empties.has("12,10"), "移动：步兵不能走 2 格");
  const cav = mk(0, "cav", 50, 10, 12);
  mt = F.computeMoveTargets(cav, 3, vis(0));
  ok(mt.empties.has("10,15"), "移动：骑兵最多 3 格");
  const sc = mk(0, "scout", 5, 10, 14);
  mt = F.computeMoveTargets(sc, 2, vis(0));
  ok(!mt.empties.has("10,17"), "移动：侦察兵常规 2 格");
  mt = F.computeMoveTargets(sc, 3, vis(0));
  ok(mt.empties.has("10,17"), "移动：侦察兵可选 3 格（代价下回合不能动）");
  T.terrain[11][16] = "forbidden";
  const tk = mk(0, "tank", 5, 10, 14);
  mt = F.computeMoveTargets(tk, 2, vis(0));
  ok(!mt.empties.has("11,16"), "移动：地面载具不可进入禁地");
  const pl = mk(0, "recon", 1, 10, 14);
  mt = F.computeMoveTargets(pl, 2, vis(0));
  ok(mt.empties.has("10,16") || mt.empties.has("11,16"), "移动：空中单位可飞越禁地");
  resetMap();
  T.terrain[10][11] = "river";
  const inf2 = mk(0, "inf", 100, 10, 10);
  mt = F.computeMoveTargets(inf2, 2, vis(0));
  ok(!mt.empties.has("10,11"), "移动：无桥河面不可进入");
  T.bridge[10][11] = true;
  mt = F.computeMoveTargets(inf2, 2, vis(0));
  ok(mt.empties.has("10,11"), "移动：有桥可通过");
  // 敌方不可见时不会被列为攻击目标（走进去才会触发遭遇）
  resetMap();
  const own = mk(0, "inf", 100, 2, 2);
  const farFoe = mk(1, "inf", 100, 18, 18);
  mt = F.computeMoveTargets(own, 1, vis(0));
  ok(!mt.corpsCells.has("18,18"), "移动：视野外敌军不显示为攻击目标");
}

/* ============ 13. 遭遇与近战执行 ============ */
{
  resetMap();
  const inf = mk(0, "inf", 400, 10, 10);
  const foe = mk(1, "cav", 30, 10, 11, { resting: true });
  const rep = F.executeMove(inf, [[10, 11]]);
  ok(rep.fought, "交锋：移入敌军格触发交战");
  ok(!foe.alive, "交锋：骑兵30 被步兵400 全歼");

  resetMap();
  const r2 = mk(0, "inf", 100, 10, 10, { resting: true });
  F.executeMove(r2, [[10, 11]]);
  ok(!r2.resting, "规则：移动未交战则解除休整");

  resetMap();
  const r3 = mk(0, "inf", 400, 10, 10, { resting: true });
  mk(1, "cav", 10, 10, 11);
  F.executeMove(r3, [[10, 11]]);
  ok(r3.resting, "规则：交战后保持休整（后续继续减损）");

  resetMap();
  const art = mk(0, "lightArt", 20, 10, 10);
  const e2 = mk(1, "inf", 100, 10, 11);
  F.executeMove(art, [[10, 11]]);
  ok(!art.alive, "规则：炮兵遭遇步兵 → 被全歼");
}

/* ============ 14. 轰炸机导弹 ============ */
{
  resetMap();
  const a = mk(1, "inf", 300, 6, 6), b = mk(1, "cav", 20, 6, 6);
  T.pendingMissiles = [{ r: 6, c: 6, side: 0 }];
  F.resolveMissiles();
  ok(!a.alive && !b.alive, "导弹：无防空地堡 → 该格所有单位全歼");

  resetMap();
  const c1 = mk(1, "inf", 300, 6, 6);
  T.bunker[6][6] = 3;
  T.pendingMissiles = [{ r: 6, c: 6, side: 0 }];
  F.resolveMissiles();
  ok(c1.alive && c1.troops === 150, "导弹：有防空地堡 → 损耗减半");
  eq(T.bunker[6][6], 2, "导弹：命中地堡后耐久 3→2");

  resetMap();
  const air = mk(1, "bomber", 1, 6, 6);
  T.pendingMissiles = [{ r: 6, c: 6, side: 0 }];
  F.resolveMissiles();
  ok(air.alive, "导弹：空中单位不受导弹影响");
}

/* ============ 15. 大本营 / 胜负 ============ */
{
  resetMap();
  mk(0, "inf", 10, BASES[1][0], BASES[1][1]);
  F.checkWin();
  ok(T.gameOver && T.winner === 0, "胜负：地面兵团占领对方大本营即获胜");

  resetMap();
  mk(0, "recon", 1, BASES[1][0], BASES[1][1]);
  mk(0, "inf", 10, 0, 0); mk(1, "inf", 10, 1, 1);
  F.checkWin();
  ok(!T.gameOver, "胜负：空中单位不能占领大本营");

  resetMap();
  mk(0, "recon", 1, 5, 5); mk(1, "inf", 10, 6, 6);
  F.checkWin();
  ok(T.gameOver && T.winner === 1, "胜负：一方再无地面兵团即判负");
  eq(F.hasGround(0), false, "胜负：正确识别「无地面兵团」");
}

/* ============ 16. 积分部署 ============ */
{
  const cfg = {}; for (const t of T.DEPLOY_TYPES) cfg[t] = 0;
  eq(F.deploySpent(cfg), 0, "部署：空配置 0 分");
  Object.assign(cfg, T.RECOMMEND);
  eq(F.deploySpent(cfg), 990, "部署：推荐配置 = 990 分");
  ok(F.deploySpent(cfg) <= T.BUDGET, "部署：推荐配置不超过 1000 分");
  const price = { inf:1, cav:4, lightArt:5, scout:5, heavyArt:10, tank:50, katyusha:50, recon:100, bomber:200 };
  for (const t in price) eq(UNITS[t].cost, price[t], `部署：${UNITS[t].name} 单价 ${price[t]} 分`);
  resetMap(); T.corps = [];
  F.spawnFromConfig(0, { inf:100, cav:8, lightArt:4, scout:2, heavyArt:2, tank:1, katyusha:1, recon:1, bomber:1 });
  eq(T.corps.length, 9, "部署：每种兵生成 1 支兵团");
  const b = T.corps.find(p => p.type === "inf");
  eq(b.r, BASES[0][0], "部署：兵力部署在大本营行");
  eq(b.c, BASES[0][1], "部署：兵力部署在大本营列");
  eq(b.troops, 100, "部署：兵力数量与积分兑换一致");
  const bomber = T.corps.find(p => p.type === "bomber");
  eq(bomber.missile, 1, "部署：轰炸机自带 1 发导弹");
  eq(bomber.flare, 1, "部署：空中载具自带 1 发照明弹");
  const tank = T.corps.find(p => p.type === "tank");
  eq(tank.dur, 3, "部署：载具 3 点耐久");
}

/* ============ 17. 投掷 / 回营补给 / 回合推进 ============ */
{
  resetMap();
  const scout = mk(0, "scout", 5, 10, 10);
  scout.flare--;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) T.flare[12 + dr][12 + dc] = 5;
  let cnt = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (T.flare[r][c] > 0) cnt++;
  eq(cnt, 9, "投掷：照明弹形成 3×3 区域");
  eq(T.flare[12][12], 5, "投掷：持续 5 回合");

  resetMap();
  const pl = mk(0, "bomber", 1, 3, 3, { flare: 0, smoke: 0, missile: 0 });
  F.executeMove(pl, [[BASES[0][0], BASES[0][1]]]);
  eq(pl.flare, 1, "补给：轰炸机回大本营补充照明弹");
  eq(pl.smoke, 1, "补给：轰炸机回大本营补充烟雾弹");
  eq(pl.missile, 1, "补给：轰炸机回大本营补充导弹");

  resetMap();
  const rc = mk(0, "recon", 1, 3, 3, { flare: 0, smoke: 0 });
  F.executeMove(rc, [[3, 4]]);
  eq(rc.flare, 0, "补给：未回大本营不补给");
}

/* ============ 18. 真实 UI 流程冒烟：部署 → 开局 → 推进回合 ============ */
{
  F.newGame();
  eq(T.phase, "deploy", "流程：新开局进入部署阶段");
  T.deployCfg = Object.assign({}, T.RECOMMEND);
  F.confirmDeploy();
  eq(T.phase, "handoff", "流程：红方确认后交棒给蓝方");
  ok(T.corps.filter(p => p.side === 0).length >= 3, "流程：红方生成了多支兵团");
  T.deployCfg = Object.assign({}, T.RECOMMEND);
  F.confirmDeploy();
  eq(T.phase, "play", "流程：双方部署完成后进入对战");
  ok(T.corps.filter(p => p.side === 1).length >= 3, "流程：蓝方兵团已生成");
  eq(T.turnNo, 1, "流程：从第 1 回合开始");
  eq(F.isDay(), true, "流程：开局为白天");
  let renderOk = true;
  try { F.render(); } catch (e) { renderOk = false; }
  ok(renderOk, "流程：界面渲染无异常");
  let okTurn = true;
  try { for (let i = 0; i < 21; i++) F.endTurn(); } catch (e) { okTurn = false; }
  ok(okTurn, "流程：连续推进 21 回合无异常");
  eq(T.turnNo, 11, "流程：回合数正确推进到第 11 回合");
  eq(F.isDay(), false, "流程：第 11 回合进入夜晚（每 10 回合转换）");
  ok(T.corps.every(p => p.alive), "流程：无战斗时双方兵力无损失");
}

/* ============ 11b. 休整情报仅限视野内 ============ */
{
  resetMap(); T.turnNo = 1;
  const obs = mk(0, "inf", 100, 2, 2);                          // 视野2
  const farRest = mk(1, "inf", 100, 18, 18, { resting: true }); // 视野外且休整
  ok(!F.unitVisibleTo(farRest, 0, vis(0)), "休整情报：视野外的休整敌军完全不可见");
  const nearRest = mk(1, "inf", 100, 3, 3, { resting: true });  // 视野内且休整
  ok(F.unitVisibleTo(nearRest, 0, vis(0)), "休整情报：视野内的休整敌军可见（含休整状态）");
  ok(obs.alive, "休整情报：己方单位不受影响");
}

/* ============ 12. 日志分方可见 ============ */
{
  resetMap(); T.logEntries.length = 0;
  F.log("红方移动", "red");
  F.log("蓝方移动", "blue");
  F.log("公开情报", "sys", null);
  F.log("当前方提示", "warn");                     // current=0
  const es = T.logEntries;
  eq(es[0].side, 0, "日志：红方条目仅红方可见");
  eq(es[1].side, 1, "日志：蓝方条目仅蓝方可见");
  eq(es[2].side, null, "日志：公开情报双方可见");
  eq(es[3].side, 0, "日志：无色条目归属当前行动方");
  const visibleTo = (side) => es.filter(e => e.side == null || e.side === side).length;
  eq(visibleTo(0), 3, "日志：红方视角看到 3 条（自己 2 + 公开 1）");
  eq(visibleTo(1), 2, "日志：蓝方视角看到 2 条（自己 1 + 公开 1）");
}

/* ============ 13. 远程打击报告脱敏 ============ */
{
  resetMap(); T.logEntries.length = 0;
  const art = mk(0, "lightArt", 10, 10, 10);       // 视野3，射程4
  const inf = mk(1, "inf", 200, 11, 11);
  T.mode = "strike";
  T.modeData = { id: art.id, cells: new Set([F.key(11, 11)]) };
  F.boardStrike(11, 11);
  const strike = T.logEntries.find(e => e.msg.includes("🎯"));
  ok(strike && strike.msg.includes("消灭"), `打击战报：显示消灭人数 → "${strike ? strike.msg.slice(0, 70) : "未找到"}"`);
  ok(!strike.msg.includes("步兵"), "打击战报：不泄露敌方兵种");
  ok(!strike.msg.includes("剩 "), "打击战报：不泄露敌方剩余兵力");
  ok(strike.msg.includes("敌方规模"), "打击战报：显示敌方规模变化");
  ok(inf.troops === 170, `打击结算：步兵实际损失 30（剩 ${inf.troops}）`);
  ok(inf.alive, "打击结算：目标仍存活");
}

/* ---- 结果 ---- */
console.log(`\n================ 测试结果 ================`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { console.log("\n失败明细："); fails.forEach(f => console.log("  ✗ " + f)); process.exit(1); }
else console.log("全部通过 ✓");
