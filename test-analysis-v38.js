const fs=require("fs"), vm=require("vm"), path=require("path");
const html=fs.readFileSync(path.join(__dirname,"battlefield-v3.html"),"utf8");
let code=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nnewGame\(\);\s*$/,"\n");
code+=`
globalThis.__T={
  get corps(){return corps}, get current(){return current}, set current(v){current=v},
  get turnNo(){return turnNo}, get gameOver(){return gameOver}, get winner(){return winner},
  get phase(){return phase}, set phase(v){phase=v},
  get deploySide(){return deploySide}, set deploySide(v){deploySide=v},
  get deployCfg(){return deployCfg}, set deployCfg(v){deployCfg=v},
  get aiDiff(){return aiDiff}, set aiDiff(v){aiDiff=v},
  get acted(){return acted},
  get battleStats(){return battleStats},
  BASES:BASES, UNITS,
  fn:{ newGame, spawnFromConfig, aiDeployConfig, aiAct, endTurn, compareBattleOutcomes, baseThreatLevel, enemyKnowledgeChain, updateExposure, recordBattle }
};`;
function stubEl(){return{innerHTML:"",textContent:"",className:"",value:"0",style:{},dataset:{},classList:{add(){},remove(){},contains(){return false},toggle(){}},addEventListener(){},appendChild(){},closest(){return null}};}
const cache={};
const documentStub={getElementById:id=>(cache[id]||(cache[id]=stubEl())),querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>stubEl(),addEventListener:()=>{}};
const ctx={document:documentStub,console,alert:()=>{},Math,JSON,Set,Map,Array,Object,String,Number,parseInt,isNaN,Infinity,setTimeout:()=>0,clearTimeout:()=>{},globalThis:null};
ctx.globalThis=ctx;vm.createContext(ctx);vm.runInContext(code,ctx);
const T=ctx.__T,F=T.fn;
let pass=0,fail=0;
function ok(cond,msg){ if(cond){pass++;} else {fail++; console.log("  ✗ "+msg);} }

/* ===== 战果记录 ===== */
F.newGame(); T.phase="play";
T.aiDiff="hard"; T.deploySide=0; let cfg=F.aiDeployConfig(); F.spawnFromConfig(0,cfg);
T.aiDiff="easy"; T.deploySide=1; cfg=F.aiDeployConfig(); F.spawnFromConfig(1,cfg);
for(let i=0;i<6;i++){ T.aiDiff=T.current===0?"hard":"easy"; F.aiAct(T.current); if(T.gameOver)break; F.endTurn(); }
ok(Array.isArray(T.battleStats),"battleStats 是数组");
ok(T.battleStats.length>0,"前6回合产生了交战记录（实际 "+T.battleStats.length+"）");
const bad=T.battleStats.find(b=>!b.side===undefined||!b.zone||!b.kind||b.round===undefined);
ok(!bad,"每条记录含 side/kind/zone/round 字段");
const zones=new Set(T.battleStats.map(b=>b.zone));
ok([...zones].every(z=>["深入敌境","本方腹地","中场拉锯"].includes(z)),"区域分类合法: "+[...zones].join("/"));

/* ===== 战果比较 ===== */
const an=F.compareBattleOutcomes(0);
ok(an&&an.side===0&&Array.isArray(an.list),"compareBattleOutcomes 返回结构");
ok(typeof an.advice==="string"&&an.advice.length>0,"advice 非空: "+an.advice);
ok(an.total===T.battleStats.filter(b=>b.side===0).length,"total 与记录数一致");
if(an.list.length){
  const z=an.list[0];
  ok(z.winRate>=0&&z.winRate<=100,"winRate 在 0~100");
  ok(z.exchange===null||z.exchange>=0,"exchange 非负");
}

/* ===== 大本营威胁度 ===== */
F.newGame(); T.phase="play";
T.aiDiff="hard"; T.deploySide=0; cfg=F.aiDeployConfig(); F.spawnFromConfig(0,cfg);
T.aiDiff="easy"; T.deploySide=1; cfg=F.aiDeployConfig(); F.spawnFromConfig(1,cfg);
const th0=F.baseThreatLevel(0);
ok(th0&&typeof th0.score==="number"&&th0.score>=0,"威胁度分数非负: "+th0.score);
ok(["安全","警戒","告急","危急"].includes(th0.level),"威胁等级合法: "+th0.level);
ok(th0.score<15,"开局大本营安全（score="+th0.score+"）");
/* 敌军大部队传送到红方大本营旁 → 威胁飙升 */
const red=T.corps.find(p=>p.side===1&&!T.UNITS[p.type].air&&p.type!=="scout");
const [br0,bc0]=T.BASES[0];
red.r=br0+1; red.c=bc0;
const th1=F.baseThreatLevel(0);
ok(th1.score>th0.score,"敌军逼近后威胁分上升: "+th0.score+"→"+th1.score);
ok(th1.level!=="安全","敌军兵临城下时不再安全: "+th1.level);
ok(th1.topThreats.length>0,"输出主要威胁来源");
/* 敌方站在红方大本营 → 占领进度威胁 */
red.r=br0; red.c=bc0;
T.fn.endTurn&&0;
const th2=F.baseThreatLevel(0);
ok(th2.occupyProgress===0,"无 endTurn 推进时占领进度为 0");

/* ===== 敌情推测链 ===== */
F.newGame(); T.phase="play";
T.aiDiff="hard"; T.deploySide=0; cfg=F.aiDeployConfig(); F.spawnFromConfig(0,cfg);
T.aiDiff="easy"; T.deploySide=1; cfg=F.aiDeployConfig(); F.spawnFromConfig(1,cfg);
let kc=F.enemyKnowledgeChain(0);
ok(kc&&kc.chain&&kc.chain.length>=4,"推测链输出多级链条");
ok(kc.knownPct===0,"开局双方未接触，掌握度为 0%（实际 "+kc.knownPct+"%）");
ok(kc.unknown>0,"开局存在从未被发现的兵团");
/* 把红方一个单位传送到蓝方单位旁并推进回合 → 暴露 */
const redU=T.corps.find(p=>p.side===0);
const blueU=T.corps.find(p=>p.side===1&&!T.UNITS[p.type].air);
redU.r=blueU.r; redU.c=blueU.c+1;
F.updateExposure();
kc=F.enemyKnowledgeChain(0);
ok(kc.knownPct>0||kc.known>0,"进入敌方视野后掌握度上升（knownPct="+kc.knownPct+" known="+kc.known+"）");
ok(kc.chain.some(s=>s.includes("掌握度")),"推测链包含掌握度结论");
const chainStr=kc.chain.join("\n");
ok(chainStr.includes("暴露事件")&&chainStr.includes("情报时效"),"推测链包含暴露事件与情报时效环节");

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail?1:0);
