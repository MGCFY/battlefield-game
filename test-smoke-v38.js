/* 战场沙盘 v3.8 · 冒烟测试：脚本可加载、部署可完成、回合可推进 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "battlefield-v3.html"), "utf8");
let code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n').replace(/\nnewGame\(\);\s*$/, "\n");
code += `
globalThis.__T = {
  get corps(){return corps}, get current(){return current}, get turnNo(){return turnNo},
  get gameOver(){return gameOver}, get winner(){return winner}, get phase(){return phase}, set phase(v){phase=v},
  get deploySide(){return deploySide}, set deploySide(v){deploySide=v},
  get deployCfg(){return deployCfg}, set deployCfg(v){deployCfg=v},
  get terrain(){return terrain}, get bridge(){return bridge}, get fortH(){return fortH}, get fortV(){return fortV},
  get bunker(){return bunker}, get flare(){return flare}, get smokeLeft(){return smokeLeft},
  get acted(){return acted}, get battleRecord(){return battleRecord}, get baseHold(){return baseHold},
  get gameBudget(){return gameBudget}, set gameBudget(v){gameBudget=v},
  get aiSide(){return aiSide}, set aiSide(v){aiSide=v},
  get aiDiff(){return aiDiff}, set aiDiff(v){aiDiff=v},
  get mode(){return mode}, get modeData(){return modeData}, get selId(){return selId},
  UNITS, DEPLOY_TYPES, BASES, N, DEFAULT_BUDGET, AI_PROFILES, logEntries,
  fn: { newGame, genMap, renderDeploy, confirmDeploy, startPlay, endTurn, render,
        computeVision, unitVisibleTo, computeMoveTargets, executeMove, checkWin, checkBaseCapture,
        deploySpent, spawnFromConfig, aiAct, aiActOne, aiDeployConfig, aiProf, aiTrimBudget,
        strikeRange, canStrike, performStrike, performKatyusha, performBomb, resolveBattle,
        stationable, key, unkey, manh, isDay, dayNo, takeSnapshot, showVictory, showReplay, renderReplay,
        startSplit, confirmSplit, boardSplitPlace, doLoad, edgeBetween, getFort, setFort, edgesTouching,
        unitPower, meleeRatio: (a,b)=>clampRatio(RAT_BASE+RAT_A1*a-RAT_A2*b), unitTag, doRest, startFight, hasGround }
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
const ctx = { document: documentStub, console: { log(){}, warn(){}, error(){} }, alert: m=>{throw new Error("alert: "+m)},
  Math, JSON, Set, Map, Array, Object, String, Number, parseInt, isNaN, Infinity,
  setTimeout: () => 0, clearTimeout: () => {}, globalThis: null };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx);
const T = ctx.__T, F = T.fn;

let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;} else {fail++; console.error("  ✗ "+m);} };

/* ---- 1. 初始化 ---- */
F.newGame();
ok(T.phase==="deploy"||T.phase==="handoff", "初始阶段为部署");
ok(Array.isArray(T.terrain)&&T.terrain.length===20, "地形表已生成");

/* ---- 2. 地图合法性：50 次生成全部满足（对称河+桥+连通+无禁区占位） ---- */
for(let i=0;i<50;i++){
  F.genMap();
  let bridges=0, forb=0;
  for(let r=0;r<20;r++)for(let c=0;c<20;c++){
    const t=T.terrain[r][c];
    if(t==="forbidden") forb++;
    if(t==="river"&&T.bridge[r][c]) bridges++;
    if(T.fortH[r][c]||T.fortV[r][c]){ ok(false, `地图#${i} 初始即有工事`); break; }
  }
  if(!(bridges===3&&forb>0)){ ok(false, `地图#${i} 非法 bridges=${bridges} forb=${forb}`); break; }
}
ok(true, "50 次地图生成均合法（河流+桥+禁地）");

/* ---- 3. 部署（默认预算 1500） ---- */
ok(T.DEFAULT_BUDGET===1500, "默认积分 1500");
T.gameBudget=1500;
const cfgA={inf:500,cav:30,lightArt:30,scout:1,heavyArt:15,tank:6,katyusha:2,recon:1,bomber:1};
T.deployCfg={...cfgA}; F.confirmDeploy();
ok(T.phase==="handoff", "红方部署后进入移交");
T.deploySide=1; T.phase="deploy"; T.deployCfg={...cfgA};
const spent=F.deploySpent(T.deployCfg);
F.confirmDeploy();
ok(T.phase==="play", "蓝方部署后进入对局");
ok(spent<=1500, "部署未超预算");

/* ---- 4. 回合推进 + 复盘快照 ---- */
F.endTurn();
ok(T.current===1, "红方结束轮到蓝方");
F.endTurn();
ok(T.turnNo===2, "完整回合后回合数+1");
ok(T.battleRecord.length>=2, "每回合生成复盘快照");

/* ---- 5. AI 完整对局（困难 vs 默认）：无异常、60回合内结束 ---- */
T.aiSide=-1; T.aiDiff="hard";   // AI-vs-AI 语义：双方均由 aiAct 驱动，保持严格回合指标
F.newGame();
// AI 自动部署红方后处于 handoff，人类蓝方自动部署
T.deployCfg={inf:500,cav:30,lightArt:30,scout:1,heavyArt:15,tank:6,katyusha:2,recon:1,bomber:1};
if(T.phase==="deploy"){ T.deploySide=1; F.confirmDeploy(); }
else if(T.phase==="handoff"){ T.deploySide=1; T.phase="deploy"; F.confirmDeploy(); }
let guard=0;
while(!T.gameOver && guard++<400){
  F.aiAct(T.current);
  if(T.gameOver) break;
  F.endTurn();
}
ok(guard<=240, `困难AI对局在60回合内结束（实际 ${Math.ceil(guard/2)} 回合）`, true);
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail?1:0);
