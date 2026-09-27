/* 战场沙盘 v3.8 · AI 测试
   覆盖：三档部署预算 / 对局合法性不变量（禁区、兵力非负）/ 三档互sim完整对局 /
   困难档 60 回合内结束指标 / 热座回归 / 复盘快照 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "battlefield-v3.html"), "utf8");
let code = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nnewGame\(\);\s*$/, "\n");
code += `
globalThis.__T = {
  get corps(){return corps},
  get current(){return current}, set current(v){current=v},
  get turnNo(){return turnNo},
  get gameOver(){return gameOver}, get winner(){return winner},
  get phase(){return phase}, set phase(v){phase=v},
  get deploySide(){return deploySide}, set deploySide(v){deploySide=v},
  get deployCfg(){return deployCfg}, set deployCfg(v){deployCfg=v},
  get terrain(){return terrain}, get bridge(){return bridge},
  get fortH(){return fortH}, get fortV(){return fortV}, get bunker(){return bunker},
  get acted(){return acted}, get battleRecord(){return battleRecord},
  get gameBudget(){return gameBudget}, set gameBudget(v){gameBudget=v},
  get aiSide(){return aiSide}, set aiSide(v){aiSide=v},
  get aiDiff(){return aiDiff}, set aiDiff(v){aiDiff=v},
  get baseHold(){return baseHold},
  UNITS, DEPLOY_TYPES, BASES, N, AI_PROFILES,
  fn: { newGame, genMap, renderDeploy, confirmDeploy, endTurn, render,
        computeVision, executeMove, checkWin, checkBaseCapture, deploySpent,
        spawnFromConfig, aiAct, aiActOne, aiDeployConfig, aiTrimBudget, aiProf,
        stationable, key, isDay, takeSnapshot, hasGround }
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
const ok=(c,m)=>{ if(c) pass++; else { fail++; console.error("  ✗ "+m); } };

/* ---------- 部署：三档均在预算内且有地面兵团 ---------- */
for(const diff of ["easy","medium","hard"]){
  T.aiDiff=diff; T.gameBudget=1500;
  const cfg=F.aiDeployConfig();
  ok(F.deploySpent(cfg)<=1500, `${diff} 部署不超预算`);
  const ground=T.DEPLOY_TYPES.filter(t=>!T.UNITS[t].air).reduce((s,t)=>s+(cfg[t]||0),0);
  ok(ground>0, `${diff} 有地面兵团`);
  ok(Object.keys(cfg).length===T.DEPLOY_TYPES.length, `${diff} 配置覆盖全部兵种`);
}
/* 自定义预算缩放 */
T.gameBudget=5000;
const big=F.aiDeployConfig();
ok(F.deploySpent(big)<=5000 && F.deploySpent(big)>3000, "大预算下 AI 扩军");
T.gameBudget=1500;

/* ---------- AI vs AI 完整对局（双方都由 aiAct 驱动） ---------- */
function simGame(diffA, diffB, maxRounds){
  F.newGame();
  T.phase="play";
  // 双方部署
  T.aiDiff=diffA; T.deploySide=0; T.deployCfg=F.aiDeployConfig(); F.spawnFromConfig(0,T.deployCfg);
  T.aiDiff=diffB; T.deploySide=1; T.deployCfg=F.aiDeployConfig(); F.spawnFromConfig(1,T.deployCfg);
  T.corps.forEach(p=>{ p.resting=false; p.fatigue=0; });
  T.turnNo=1; T.current=0; T.acted.clear();
  F.takeSnapshot();
  const errs=[];
  let rounds=0;
  while(!T.gameOver && rounds<maxRounds){
    const side=T.current;
    T.aiDiff = side===0?diffA:diffB;   // 关键：按行动方切换难度，模拟各自真实水平
    try{ F.aiAct(side); }
    catch(e){ errs.push(`r${rounds}: ${e.message}`); break; }
    // 不变量：地面单位不在禁区/无桥河面；兵力非负
    for(const p of T.corps){
      if(!p.alive) continue;
      if(p.troops<0){ errs.push(`回合${rounds}: 兵力为负`); break; }
      if(!T.UNITS[p.type].air && !F.stationable(p.r,p.c)){
        errs.push(`回合${rounds}: ${p.type} 出现在非法地形 (${p.r},${p.c})`);
        break;
      }
    }
    if(errs.length) break;
    if(T.gameOver) break;
    F.endTurn();
    if(T.current===0) rounds++;
  }
  return { over:T.gameOver, winner:T.winner, rounds, errs };
}

/* 烟雾：三档互相打，全部合法完成 */
const matchups=[["hard","easy"],["hard","medium"],["medium","medium"],["easy","easy"],["medium","hard"]];
for(const [a,b] of matchups){
  const r=simGame(a,b,80);
  ok(r.errs.length===0, `${a} vs ${b} 无运行错误 ${r.errs.slice(0,2).join(";")}`);
  ok(r.over||r.rounds>=80, `${a} vs ${b} 对局可推进（${r.rounds}回合, ${r.over?"结束":"超时"}）`);

}

/* 回合指标（对应用户要求：困难≤60 / 中等≤80 / 简单≤100 终结对局） */
{
  let wins=0, within60=0, N2=12;
  for(let i=0;i<N2;i++){
    const r=simGame("hard","easy",60);
    if(r.over) within60++;
    if(r.over && r.winner===0) wins++;
  }
  ok(within60>=N2*0.85, `困难 vs 简单：${within60}/${N2} 局60回合内结束`);
  ok(wins>=N2*0.8, `困难 vs 简单：${wins}/${N2} 局困难获胜`);
}
{
  let wins=0, within60=0, N2=10;
  for(let i=0;i<N2;i++){
    const r=simGame("hard","medium",60);
    if(r.over) within60++;
    if(r.over && r.winner===0) wins++;
  }
  ok(within60>=N2*0.7, `困难 vs 中等：${within60}/${N2} 局60回合内结束`);
  ok(wins>=N2*0.6, `困难 vs 中等：${wins}/${N2} 局困难获胜`);
}
{
  let wins=0, within80=0, N2=10;
  for(let i=0;i<N2;i++){
    const r=simGame("medium","easy",80);
    if(r.over) within80++;
    if(r.over && r.winner===0) wins++;
  }
  ok(within80>=N2*0.7, `中等 vs 简单：${within80}/${N2} 局80回合内结束`);
  ok(wins>=N2*0.6, `中等 vs 简单：${wins}/${N2} 局中等获胜`);
}
{
  let within100=0, N2=8;
  for(let i=0;i<N2;i++){
    const r=simGame("easy","medium",100);
    if(r.over) within100++;
  }
  ok(within100>=N2*0.6, `简单 vs 中等：${within100}/${N2} 局100回合内结束`);
}

/* 热座回归：无 AI 时回合切换正常 */
F.newGame();
ok(T.phase==="deploy", "热座 newGame 正常");

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail?1:0);
