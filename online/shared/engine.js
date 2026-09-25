
"use strict";
/* ============================================================
   战场沙盘策略游戏 · 视野版（v2）
   在 v1 规则基础上新增：战争迷雾视野、昼夜、10兵种积分部署、
   防空地堡、照明弹/烟雾弹、轰炸机导弹、载具耐久、面杀伤等。
   ============================================================ */

const N = 20;
const BASES = [[2,2],[16,16]];               // 0起始：第3行第3列 / 第17行第17列
const SIDE_NAME = ["红方","蓝方"];
const DIRS4 = [[1,0],[-1,0],[0,1],[0,-1]];
const T_NAME = { plain:"平地", highland:"高地", river:"河流", forbidden:"禁地" };

/* ---------------- 兵种表 ----------------
   move:最大步数  vision:白天视野  melee:是否有近战能力  air:空中
   veh:载具(地/空)  ranged:可远程打击  canRest:可休整  dur:耐久(载具)
   throwable:带照明弹/烟雾弹  missile:带导弹  scout:侦察兵  area:面杀伤 */
const UNITS = {
  inf:      { ch:"步", name:"步兵",   cost:1,   move:1, vision:2, melee:1, air:0, veh:0, ranged:0, canRest:1 },
  cav:      { ch:"骑", name:"骑兵",   cost:4,   move:3, vision:3, melee:1, air:0, veh:0, ranged:0, canRest:1 },
  lightArt: { ch:"轻", name:"轻炮兵", cost:5,   move:1, vision:3, melee:0, air:0, veh:0, ranged:1, canRest:1 },
  scout:    { ch:"侦", name:"侦察兵", cost:5,   move:2, vision:6, melee:0, air:0, veh:0, ranged:0, canRest:1, scout:1, throwable:1 },
  heavyArt: { ch:"重", name:"重炮兵", cost:10,  move:1, vision:3, melee:0, air:0, veh:0, ranged:1, canRest:1, heavy:1 },
  tank:     { ch:"坦", name:"坦克",   cost:50,  move:2, vision:4, melee:1, air:0, veh:1, ranged:1, canRest:1, dur:3 },
  katyusha: { ch:"喀", name:"喀秋莎", cost:50,  move:2, vision:4, melee:1, air:0, veh:1, ranged:1, canRest:0, dur:3, area:1 },
  recon:    { ch:"机", name:"侦查机", cost:100, move:2, vision:3, melee:0, air:1, veh:1, ranged:0, canRest:0, throwable:1 },
  bomber:   { ch:"轰", name:"轰炸机", cost:200, move:2, vision:3, melee:0, air:1, veh:1, ranged:0, canRest:0, throwable:1, missile:1 },
};
const DEPLOY_TYPES = ["inf","cav","lightArt","scout","heavyArt","tank","katyusha","recon","bomber"];
const RECOMMEND = { inf:400, cav:30, lightArt:20, scout:4, heavyArt:10, tank:2, katyusha:1, recon:1, bomber:0 };
const BUDGET = 1000;

/* 近战损耗表：MELEE[己方兵种][敌方兵种] = 己方每回合基础损耗 */
const MELEE = {
  inf:      { inf:1,  cav:1,  tank:1,  katyusha:1  },
  cav:      { inf:3,  cav:1,  tank:1,  katyusha:1  },
  tank:     { inf:20, cav:10, tank:1,  katyusha:1  },
  katyusha: { inf:20, cav:10, tank:1,  katyusha:1  },
};

/* ---------------- 状态 ---------------- */
let terrain, bridge, fort, bunker, bunkerDead;
let flare, smokeLeft, smokeId;                 // 20x20
let corps = [], nextId = 1;
let current = 0, turnNo = 1;
let acted = new Set();
let selId = null;
let mode = "idle", modeData = {};
let gameOver = false, winner = 0, victoryShown = false;
let phase = "deploy";                           // deploy | handoff | play
let deploySide = 0, deployCfg = null;
let seen = [];                                  // seen[side][r][c]
let pendingMissiles = [];                       // {r,c,side}
let smokeSeq = 1;
let memoryFog = true;
  let viewMode = "auto";  // 视角：auto=跟随当前方 red=红方 blue=蓝方 god=上帝
  let cur={r:0,c:0};      // 键盘光标

/* ---------------- 工具 ---------------- */
const randInt = (a,b)=> a + Math.floor(Math.random()*(b-a+1));
const manh = (a,b)=> Math.abs(a.r-b.r) + Math.abs(a.c-b.c);   // 曼哈顿距离（菱形）
const key = (r,c)=> r+","+c;
const unkey = k => { const a=k.split(","); return {r:+a[0], c:+a[1]}; };
const inMap = (r,c)=> r>=0&&r<N&&c>=0&&c<N;
const isBase = (r,c)=> BASES.some(([br,bc])=>br===r&&bc===c);
const getCorps = id => corps.find(p=>p.id===id);
const U = p => UNITS[p.type];
const typeName = t => UNITS[t].name;
const isDay = ()=> Math.floor((turnNo-1)/10) % 2 === 0;
const dayNo = ()=> Math.floor((turnNo-1)/20) + 1;
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function grid(v){ return Array.from({length:N},()=>Array(N).fill(v)); }

/* ---------------- 地图生成（沿用 v1） ---------------- */
function stationable(r,c){
  if(!inMap(r,c)) return false;
  if(terrain[r][c]==="forbidden") return false;
  if(terrain[r][c]==="river" && !bridge[r][c]) return false;
  return true;
}
function airStationable(r,c){ return inMap(r,c); }
function tryRiver(){
  const vis=new Set(), path=[]; let c=randInt(3,16), r=0, guard=0;
  while(true){
    if(++guard>200000) return null;
    if(vis.has(key(r,c))) return null;
    vis.add(key(r,c)); path.push([r,c]);
    if(r===N-1) return path;
    const cand=[];
    if(r+1<N && !vis.has(key(r+1,c))){ cand.push([r+1,c]); cand.push([r+1,c]); cand.push([r+1,c]); }
    if(c-1>=0 && !vis.has(key(r,c-1))) cand.push([r,c-1]);
    if(c+1<N  && !vis.has(key(r,c+1))) cand.push([r,c+1]);
    if(!cand.length) return null;
    [r,c]=cand[randInt(0,cand.length-1)];
  }
}
function genMap(){
  for(let attempt=0; attempt<800; attempt++){
    const cells=[];
    for(let i=0;i<40;i++)  cells.push("forbidden");
    for(let i=0;i<80;i++)  cells.push("highland");
    for(let i=0;i<280;i++) cells.push("plain");
    shuffle(cells);
    terrain = Array.from({length:N},(_,r)=>Array.from({length:N},(_,c)=>cells[r*N+c]));
    bridge  = grid(false);
    fort    = grid(false);
    bunker  = grid(0);
    bunkerDead = grid(false);
    flare   = grid(0);
    smokeLeft = grid(0);
    smokeId = grid(0);

    const river = tryRiver();
    if(!river) continue;
    let ok=true;
    for(const [r,c] of river){
      for(const [br,bc] of BASES) if(Math.abs(r-br)+Math.abs(c-bc)<=1){ ok=false; break; }
      if(!ok) break;
    }
    if(!ok || river.length<12) continue;
    for(const [r,c] of river) terrain[r][c]="river";
    for(const [br,bc] of BASES){
      terrain[br][bc]="highland";
      for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
        const r=br+dr,c=bc+dc;
        if(inMap(r,c)&&terrain[r][c]==="forbidden") terrain[r][c]="plain";
      }
    }
    const L=river.length;
    // 桥位候选：河流必须在该格"直行"（上下游同为上下方向，不拐弯），
    // 且左右两岸都存在、必须是真实陆地（平地/高地），这样桥才能横向过河
    const cand=[];
    for(let i=1;i<L-1;i++){
      const [r,c]=river[i], [pr,pc]=river[i-1], [nr,nc]=river[i+1];
      if(pc!==c||nc!==c) continue;                       // 上下游必须同列 → 直行通过
      if(Math.abs(pr-r)!==1||Math.abs(nr-r)!==1) continue;
      if(c-1<0||c+1>=N) continue;                        // 两岸必须都在地图内
      const bankT=[terrain[r][c-1],terrain[r][c+1]];
      if(bankT.some(t=>t!=="plain"&&t!=="highland")) continue;  // 两岸禁地/河流 → 无法过河
      cand.push(i);
    }
    // 前/中/后三段各随机取一，间隔≥3，保证三桥分散
    let idxs=null;
    for(let t=0;t<300&&!idxs;t++){
      const z1=cand.filter(i=>i<L/3), z2=cand.filter(i=>i>=L/3&&i<2*L/3), z3=cand.filter(i=>i>=2*L/3);
      if(!z1.length||!z2.length||!z3.length) break;
      const p=[z1[randInt(0,z1.length-1)],z2[randInt(0,z2.length-1)],z3[randInt(0,z3.length-1)]].sort((a,b)=>a-b);
      if(p[1]-p[0]>=3 && p[2]-p[1]>=3) idxs=p;
    }
    if(!idxs) continue;                                  // 找不到3个合法桥位 → 重新生成河流
    for(const i of idxs) bridge[river[i][0]][river[i][1]]=true;
    return;
  }
  alert("地图生成失败，请重试");
}

/* ---------------- 视野系统 ---------------- */
const smokePatchAt = (r,c)=> (inMap(r,c)&&smokeLeft[r][c]>0) ? smokeId[r][c] : null;
const inFlare = (r,c)=> inMap(r,c) && flare[r][c]>0;
function patchCells(id){
  const out=[];
  for(let r=0;r<N;r++)for(let c=0;c<N;c++) if(smokeId[r][c]===id && smokeLeft[r][c]>0) out.push([r,c]);
  return out;
}
function patchHasUnit(id, side){
  for(const p of corps) if(p.alive && p.side===side && smokePatchAt(p.r,p.c)===id) return true;
  return false;
}
function visionRange(p){
  const u=U(p);
  let v = isDay() ? u.vision : (u.scout ? u.vision-2 : u.vision-1);
  if(!u.air && smokePatchAt(p.r,p.c)!=null) v = Math.min(v,1);   // 烟幕内视野降为1
  return Math.max(1, v);
}
function computeVision(side){
  const vis = new Set();
  for(const p of corps){
    if(!p.alive || p.side!==side) continue;
    const v = visionRange(p);
    for(let r=0;r<N;r++)for(let c=0;c<N;c++){
      if(Math.abs(r-p.r)+Math.abs(c-p.c)<=v) vis.add(key(r,c));
    }
  }
  // 烟幕内的己方单位可以看到整片烟幕
  const patches = new Set();
  for(const p of corps){
    if(!p.alive || p.side!==side) continue;
    const id = smokePatchAt(p.r,p.c);
    if(id!=null) patches.add(id);
  }
  for(const id of patches) for(const [r,c] of patchCells(id)) vis.add(key(r,c));
  // 照明区全图可见
  for(let r=0;r<N;r++)for(let c=0;c<N;c++) if(flare[r][c]>0) vis.add(key(r,c));
  return vis;
}
function markSeen(side, vis){
  for(const k of vis){ const [r,c]=k.split(",").map(Number); seen[side][r][c]=true; }
}
function unitVisibleTo(u, side, vis){
  if(!u.alive) return false;
  if(u.side===side) return true;
  if(U(u).air) return false;                       // 敌方空中单位永不可见
  if(inFlare(u.r,u.c)) return true;                // 照明区内全图可见
  const id = smokePatchAt(u.r,u.c);
  if(id!=null) return patchHasUnit(id, side);      // 烟幕内仅同烟幕单位可见
  return vis.has(key(u.r,u.c));
}
function structVisibleAt(r,c,side,vis){
  if(!fort[r][c] && !(bunker[r][c]>0)) return false;
  const id = smokePatchAt(r,c);
  if(id!=null && !patchHasUnit(id,side)) return false;
  return vis.has(key(r,c));
}
/* 敌方规模：只暴露大中小 */
function enemySizeClass(stack){
  const nonScout = stack.filter(p=>!U(p).scout);
  if(!nonScout.length) return "小";                 // 全是侦察兵 → 永远小
  let pts=0;
  for(const p of nonScout) pts += U(p).cost * p.troops;
  if(pts>=200) return "大";
  if(pts>=50) return "中";
  return "小";
}

/* ---------------- 部署 ---------------- */
function newGame(){
  genMap();
  corps=[]; nextId=1; acted.clear(); selId=null;
  current=0; turnNo=1; gameOver=false; victoryShown=false;
  mode="idle"; modeData={}; pendingMissiles=[];
  flare=grid(0); smokeLeft=grid(0); smokeId=grid(0); smokeSeq=1;
  seen=[grid(false), grid(false)];
  phase="deploy"; deploySide=0;
  viewMode="auto"; renderViewBtn(); cur={r:0,c:0};
  logEntries.length=0;
  document.getElementById("log").innerHTML="";
  render();          // 部署阶段先让双方看清地形（此时尚无迷雾）
  renderDeploy();
}
function deployConfigDefaults(){
  const o={}; for(const t of DEPLOY_TYPES) o[t]=0; return o;
}
function renderDeploy(){
  const wrap=document.getElementById("deployWrap");
  const card=document.getElementById("deployCard");
  wrap.classList.remove("hidden");
  if(phase==="handoff"){
    card.innerHTML=`<div class="handoff">
      <div class="icon">🤝</div>
      <h2>${SIDE_NAME[deploySide]}部署阶段</h2>
      <div class="deploy-sub">请将设备交给 <b>${SIDE_NAME[deploySide]}</b> 玩家，点击下方按钮开始配置兵力。</div>
      <button class="btn primary" data-action="deploy-start" style="margin-top:10px">开始部署</button>
    </div>`;
    return;
  }
  if(!deployCfg) deployCfg=deployConfigDefaults();
  let rows="";
  for(const t of DEPLOY_TYPES){
    const u=UNITS[t];
    rows+=`<div class="drow">
      <span class="mini ${u.air?"air":(deploySide===0?"red":"blue")}">${u.ch}</span>
      <span class="dname">${u.name}</span>
      <span class="dcost">${u.cost} 分/${t==="tank"||t==="katyusha"?"辆":(u.air?"架":"名")}</span>
      <input type="number" min="0" step="1" data-dt="${t}" value="${deployCfg[t]||0}">
      <span class="dtip">${unitTip(t)}</span>
    </div>`;
  }
  card.innerHTML=`<h2>部署阶段 · <span style="color:${deploySide===0?"#c62828":"#1565c0"}">${SIDE_NAME[deploySide]}</span></h2>
    <div class="deploy-sub">可支配 <b>${BUDGET}</b> 积分，自由采购兵团。所有兵团开局驻守己方大本营（第 ${BASES[deploySide][0]+1} 行第 ${BASES[deploySide][1]+1} 列）。<br>
    <b>必须至少采购 1 支地面兵团</b>（无地面兵团即判负）。</div>
    ${rows}
    <div class="deploy-foot">剩余积分 <b id="deployLeft">${BUDGET}</b> / ${BUDGET}</div>
    <div class="deploy-btns">
      <button class="btn" data-action="deploy-recommend">推荐配置</button>
      <button class="btn" data-action="deploy-clear">清空</button>
      <button class="btn primary" data-action="deploy-confirm">确定部署</button>
    </div>`;
  updateDeployLeft();
}
function unitTip(t){
  const u=UNITS[t];
  const extra=[];
  extra.push("移动"+u.move+"格");
  extra.push("视野"+u.vision);
  if(u.ranged) extra.push("可远程打击");
  if(u.dur) extra.push("耐久3");
  if(u.area) extra.push("3×3面杀伤");
  if(u.throwable) extra.push("带照明/烟幕");
  if(u.missile) extra.push("带导弹");
  if(u.scout) extra.push("视作小兵团");
  if(u.air) extra.push("空中·不可见");
  if(!u.canRest) extra.push("无休整");
  return extra.join(" · ");
}
function deploySpent(cfg){ let s=0; for(const t of DEPLOY_TYPES) s += (cfg[t]||0)*UNITS[t].cost; return s; }
function updateDeployLeft(){
  const el=document.getElementById("deployLeft");
  if(!el) return;
  const left=BUDGET-deploySpent(deployCfg);
  el.textContent=left;
  el.style.color = left<0 ? "#c62828" : "#1f6f43";
}
function readDeployInputs(){
  for(const t of DEPLOY_TYPES){
    const inp=document.querySelector(`input[data-dt="${t}"]`);
    if(inp){ let v=parseInt(inp.value,10); if(isNaN(v)||v<0) v=0; deployCfg[t]=v; }
  }
}
function confirmDeploy(){
  readDeployInputs();
  const left=BUDGET-deploySpent(deployCfg);
  if(left<0){ alert("积分超出预算！请减少采购。"); return; }
  let ground=0;
  for(const t of DEPLOY_TYPES) if(deployCfg[t]>0 && !UNITS[t].air) ground+=deployCfg[t];
  if(!ground){ alert("必须至少采购 1 支地面兵团。"); return; }
  spawnFromConfig(deploySide, deployCfg);
  log(`${SIDE_NAME[deploySide]} 部署完成，投入 ${deploySpent(deployCfg)} 积分。`, deploySide===0?"red":"blue");
  if(deploySide===0){ deploySide=1; deployCfg=null; phase="handoff"; renderDeploy(); }
  else { phase="play"; deployCfg=null; viewMode="auto"; renderViewBtn(); document.getElementById("deployWrap").classList.add("hidden"); startPlay(); }
}
function spawnFromConfig(side, cfg){
  const [br,bc]=BASES[side];
  for(const t of DEPLOY_TYPES){
    const n=cfg[t]||0;
    if(n<=0) continue;
    corps.push({ id:nextId++, side, type:t, troops:n, r:br, c:bc,
                 resting:false, fatigue:0, alive:true, acc:0,
                 dur: UNITS[t].dur||0,
                 flare: UNITS[t].throwable?1:0, smoke: UNITS[t].throwable?1:0,
                 missile: UNITS[t].missile?1:0, ammo:false });
  }
}
function startPlay(){
  current=0; turnNo=1; acted.clear(); selId=null;
  log("全员集结完毕，战斗开始！红方先行。", "sys", null);
  log("☀ 白天（第 1 天）· 视野范围正常。", "sys", null);
  render();
}

/* ---------------- 战斗：近战损耗 ---------------- */
function death(p){ p.troops=0; p.alive=false; p.acc=0; }
// 返回该单位本回合的"基础损耗"（可为小数：让"减半"在低损耗下也真实累积生效）
function meleeLoss(self, opp, isDefender){
  const u=U(self);
  if(!u.melee) return self.troops;              // 无近战能力 → 被全歼
  if(!U(opp).melee) return 0;                   // 对方无近战能力
  const tbl=MELEE[self.type]||{};
  let base = (tbl[opp.type]!=null) ? tbl[opp.type] : 1;
  let m=1;
  if(self.resting) m*=0.5;                       // 休整减半
  if(terrain[self.r][self.c]==="highland") m*=0.5;   // 高地减半
  if(isDefender && fort[self.r][self.c]) m*=0.5;     // 工事(被进攻方)减半
  if(u.dur) m *= self.dur/3;                          // 载具耐久 n/3
  return base*m;
}
// 逐轮消耗；小数部分保留累积，体现"四舍五入"与"减半"的持续效果
function attrition(A,B,seg){
  let guard=0;
  A.acc=0; B.acc=0;
  while(A.alive && B.alive){
    if(++guard>20000) break;
    const fa=meleeLoss(A,B,false), fb=meleeLoss(B,A,true);
    A.acc+=fa; B.acc+=fb;
    const la=Math.floor(A.acc), lb=Math.floor(B.acc);
    A.acc-=la; B.acc-=lb;
    A.troops-=la; B.troops-=lb;
    seg.rounds.push({la,lb,aLeft:Math.max(0,A.troops),bLeft:Math.max(0,B.troops)});
    if(A.troops<=0) death(A);
    if(B.troops<=0) death(B);
  }
}
function groundEnemyAt(r,c,side){
  for(const p of corps) if(p.alive && p.side!==side && p.r===r && p.c===c && !U(p).air) return p;
  return null;
}
function anyEnemyAt(r,c,side){
  for(const p of corps) if(p.alive && p.side!==side && p.r===r && p.c===c) return p;
  return null;
}
function resolveMelee(atk){
  const segs=[]; const r=atk.r, c=atk.c;
  while(atk.alive){
    const def=groundEnemyAt(r,c,atk.side);
    if(!def) break;
    const seg={ atk0:atk.troops, atkType:atk.type, atkId:atk.id,
                def, def0:def.troops, rounds:[], special:null, defDead:false, atkDead:false };
    attrition(atk,def,seg);
    seg.defDead=!def.alive; seg.atkDead=!atk.alive;
    segs.push(seg);
  }
  return segs;
}

/* ---------------- 战斗：远程打击 ---------------- */
function strikeBase(p){          // 每个单位击杀数
  if(p.type==="lightArt") return p.resting?5:3;
  if(p.type==="heavyArt") return 8;
  if(p.type==="tank")     return 20;
  if(p.type==="katyusha") return 30;
  return 0;
}
function strikeRange(p){
  const hi = (terrain[p.r][p.c]==="highland") ? 1 : 0;
  if(p.type==="lightArt") return (p.resting?5:4)+hi;
  if(p.type==="heavyArt") return 8+hi;
  if(p.type==="tank")     return (p.resting?4:3)+hi;
  if(p.type==="katyusha") return 4+hi;
  return 0;
}
function canStrike(p){
  const u=U(p);
  if(!u.ranged) return false;
  if(p.type==="heavyArt") return !!p.resting;      // 重炮仅休整可打
  if(p.type==="katyusha") return !!p.ammo;         // 需先装填弹药
  return true;
}
function strikeHint(p){
  if(p.type==="heavyArt" && !p.resting) return "重炮兵仅在休整状态下才能打击。";
  if(p.type==="katyusha" && !p.ammo) return "喀秋莎尚未装填弹药，需先执行「装填弹药」。";
  return "";
}
function isArtOrGroundVeh(p){
  return p.type==="lightArt" || p.type==="heavyArt" || p.type==="tank" || p.type==="katyusha";
}
// 对某格结算一次打击；power 为未打折的威力
function strikeCell(shooter, r, c, power, rep){
  rep = rep || { cells:[], fort:0, bunker:0, bunkerDead:0, hits:0 };
  // 摧毁防御工事
  if(fort[r][c]){ fort[r][c]=false; rep.fort++; }
  // 防空地堡
  let mult=1;
  if(bunker[r][c]>0){
    bunker[r][c]--; rep.bunker++;
    mult=0.5;
    if(bunker[r][c]===0){ bunkerDead[r][c]=true; rep.bunkerDead++; }
  }
  const targets = corps
    .filter(t=>t.alive && t.side!==shooter.side && t.r===r && t.c===c && !U(t).air)
    .sort((a,b)=>b.troops-a.troops);
  const cellRep={r,c,power,hits:[],none:false};
  if(!targets.length) cellRep.none=true;
  for(const t of targets){
    let m=mult;
    if(t.resting) m*=0.5;
    if(terrain[r][c]==="highland") m*=0.5;
    let dmg=Math.round(power*m);
    if(power>0 && dmg<1) dmg=1;
    const real=Math.min(dmg, t.troops);
    t.troops-=dmg;
    const hadDur=!!U(t).dur;
    const durBefore=t.dur;
    if(U(t).dur && isArtOrGroundVeh(shooter)) t.dur--;
    const vehLost = hadDur && t.dur<durBefore;      // 载具掉了一点耐久
    const vehDead = hadDur && t.dur<=0;             // 载具被击毁
    const dead = (t.troops<=0) || vehDead;
    if(dead) death(t);
    cellRep.hits.push({ t, dmg, real, dead, vehLost, vehDead });
  }
  rep.cells.push(cellRep);
  return rep;
}
function katyushaStrike(cp, cr, cc){
  const total=cp.troops*strikeBase(cp);
  const rep={ cells:[], fort:0, bunker:0, bunkerDead:0, area:true };
  strikeCell(cp, cr, cc, total*0.5, rep);
  const per=(total*0.5)/8;
  const nb=[];
  for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){ if(!dr&&!dc) continue; const r=cr+dr,c=cc+dc; if(inMap(r,c)) nb.push([r,c]); }
  const acc=new Map();
  for(let i=0;i<8;i++){ const [r,c]=nb[randInt(0,nb.length-1)]; const k=key(r,c); acc.set(k,(acc.get(k)||0)+per); }
  for(const [k,v] of acc){ const p2=unkey(k); strikeCell(cp,p2.r,p2.c,v,rep); }
  return rep;
}
// 大本营雷达：感知来袭炮兵/载具距被打击地的格数
function baseRadar(shooter, cells){
  if(!shooter) return false;
  const defSide=1-shooter.side;
  const [br,bc]=BASES[defSide];
  let hit=false, minD=Infinity;
  for(const [r,c] of cells){
    if(Math.abs(r-br)+Math.abs(c-bc)<=5){
      hit=true;
      minD=Math.min(minD, Math.abs(shooter.r-r)+Math.abs(shooter.c-c));
    }
  }
  if(hit){
    log(`📡 大本营雷达（${SIDE_NAME[defSide]}）：侦测到敌方远程火力打击，来袭火力距被打击地 ${minD} 格。`, "warn", defSide);
  }
  return hit;
}

/* ---------------- 移动 ---------------- */
function bfsFrom(cp, side, vis){
  const dist=grid(-1), prev=grid(null);
  const q=[[cp.r,cp.c]]; dist[cp.r][cp.c]=0;
  while(q.length){
    const [r,c]=q.shift();
    for(const [dr,dc] of DIRS4){
      const nr=r+dr,nc=c+dc;
      if(!inMap(nr,nc)||dist[nr][nc]!==-1||!stationable(nr,nc)) continue;
      if(blocksMove(nr,nc,side,vis)) continue;
      dist[nr][nc]=dist[r][c]+1; prev[nr][nc]=[r,c]; q.push([nr,nc]);
    }
  }
  return {dist,prev};
}
// 是否阻挡通行：己方单位总是可见并阻挡；敌方单位仅"可见"时阻挡（不可见则可能遭遇突袭）
function blocksMove(r,c,side,vis){
  for(const p of corps){
    if(!p.alive||p.r!==r||p.c!==c) continue;
    if(p.id===selId && false) continue;
    if(unitVisibleTo(p,side,vis)) return true;
  }
  return false;
}
function reconstruct(prev, tr, tc, sr, sc){
  const path=[]; let cur=[tr,tc];
  while(!(cur[0]===sr&&cur[1]===sc)){ path.push(cur); cur=prev[cur[0]][cur[1]]; if(!cur) return null; }
  return path.reverse();
}
function computeMoveTargets(cp, steps, vis){
  const u=U(cp);
  if(u.air){
    // 空中：自由飞行，任意方向 2 格内
    const empties=new Map(), corpsCells=new Map();
    for(let dr=-steps;dr<=steps;dr++)for(let dc=-steps;dc<=steps;dc++){
      if(!dr&&!dc) continue;
      if(Math.abs(dr)+Math.abs(dc)>steps) continue;   // 曼哈顿距离（菱形）
      const r=cp.r+dr, c=cp.c+dc;
      if(!airStationable(r,c)) continue;
      empties.set(key(r,c), [[r,c]]);
    }
    return {empties, corpsCells};
  }
  const {dist,prev}=bfsFrom(cp, cp.side, vis);
  const empties=new Map(), corpsCells=new Map();
  for(let r=0;r<N;r++)for(let c=0;c<N;c++){
    if(dist[r][c]>=1 && dist[r][c]<=steps && !blockedByUnit(r,c,cp.side,vis))
      empties.set(key(r,c), reconstruct(prev,r,c,cp.r,cp.c));
  }
  for(const p of corps){
    if(!p.alive) continue;
    const isOwn = p.side===cp.side;
    if(!isOwn){
      if(U(p).air) continue;                       // 空中单位不可见、不可攻击
      if(!unitVisibleTo(p, cp.side, vis)) continue; // 不可见敌军不列为目标（走入才会触发遭遇战）
      if(cp.type==="scout") continue;               // 侦察兵无法进攻
    }
    const k=key(p.r,p.c);
    if(corpsCells.has(k)){
      corpsCells.get(k).ids.push(p.id);
      if(!isOwn) corpsCells.get(k).type="attack";
      continue;
    }
    let best=null;
    for(const [dr,dc] of DIRS4){
      const nr=p.r+dr,nc=p.c+dc;
      if(inMap(nr,nc)&&dist[nr][nc]>=0&&dist[nr][nc]+1<=steps){
        if(!best||dist[nr][nc]+1<best.length){
          const base=reconstruct(prev,nr,nc,cp.r,cp.c);
          if(base) best=base.concat([[p.r,p.c]]);
        }
      }
    }
    if(best) corpsCells.set(k,{ids:[p.id], path:best, type: isOwn?"ally":"attack"});
  }
  return {empties, corpsCells};
}
function blockedByUnit(r,c,side,vis){
  for(const p of corps){
    if(!p.alive||p.r!==r||p.c!==c) continue;
    if(p.side===side) return true;                  // 己方单位阻挡
    if(unitVisibleTo(p,side,vis)) return true;      // 可见敌军阻挡
  }
  return false;
}
function executeMove(cp, path){
  const rep={ from:[cp.r,cp.c], segs:[], steps:0, fought:false, died:false };
  const u=U(cp);
  for(const [r,c] of path){
    rep.steps++;
    cp.r=r; cp.c=c;
    if(!u.air && groundEnemyAt(r,c,cp.side)){
      rep.fought=true;
      rep.segs=resolveMelee(cp);
      break;
    }
  }
  if(!rep.fought) cp.resting=false;                    // 移动未交战 → 休整解除
  if(cp.type==="scout" && rep.steps>=3) cp.fatigue=2;  // 侦察兵奔袭3格 → 下回合不能移动
  if(!cp.alive) rep.died=true;
  // 空中载具降落自家大本营 → 补充弹药
  if(cp.alive && u.air && isBase(cp.r,cp.c) && BASES[cp.side][0]===cp.r && BASES[cp.side][1]===cp.c){
    const before={flare:cp.flare, smoke:cp.smoke, missile:cp.missile};
    if(u.throwable){ cp.flare=1; cp.smoke=1; }
    if(u.missile && cp.missile<=0) cp.missile=1;
    if((u.throwable && (before.flare<1||before.smoke<1)) || (u.missile && before.missile<1))
      log(`${SIDE_NAME[cp.side]} ${typeName(cp.type)}#${cp.id} 返回大本营完成补给。`, cp.side===0?"red":"blue");
  }
  checkWin();
  return rep;
}

/* ---------------- 胜负 ---------------- */
function hasGround(side){ return corps.some(p=>p.alive && p.side===side && !U(p).air); }
function checkWin(){
  if(gameOver) return;
  for(const p of corps){
    if(!p.alive || U(p).air) continue;               // 需地面兵团占领
    const [er,ec]=BASES[1-p.side];
    if(p.r===er && p.c===ec){ gameOver=true; winner=p.side; return; }
  }
  const g0=hasGround(0), g1=hasGround(1);
  if(!g0 || !g1){ gameOver=true; winner = g0?0:1; }
}

/* ---------------- 日志（分方可见：热座下只显示当前行动方的战报） ---------------- */
const logEntries=[];
function log(msg, cls, side){
  cls = cls || "sys";
  // 可见方：显式指定（null=公开）> 按颜色（红/蓝方的自身行动）> 默认当前行动方
  const sd = side!==undefined ? side : (cls==="red"?0 : cls==="blue"?1 : current);
  logEntries.push({msg, cls, side:sd});
  if(logEntries.length>400) logEntries.splice(0, logEntries.length-400);
  renderLog();
}
function renderLog(){
  const el=document.getElementById("log");
  if(!el) return;
  const rows=logEntries.filter(e=>e.side==null||e.side===current);
  el.innerHTML=rows.map(e=>`<div class="entry ${e.cls}">${e.msg}</div>`).join("");
  el.scrollTop=el.scrollHeight;
}
const posStr = p => `(${p.r+1},${p.c+1})`;
const corpsLabel = p => `${SIDE_NAME[p.side]}${typeName(p.type)}#${p.id}`;

/* ---------------- 指令 ---------------- */
function cancelMode(){ mode="idle"; modeData={}; render(); }
function currentVis(){ return computeVision(current); }
function startMove(cp){
  if(cp.fatigue>0 && cp.type==="scout"){ log("⚠ 该侦察兵上回合奔袭3格，本回合不能移动。"); return; }
  const u=U(cp);
  beginMoveMode(cp, u.move);
}
function beginMoveMode(cp, steps){
  const vis=currentVis();
  mode="move"; modeData={ id:cp.id, steps, vis, ...computeMoveTargets(cp, steps, vis) };
  render();
}
function boardMove(r,c){
  const cp=getCorps(modeData.id); if(!cp) return cancelMode();
  const k=key(r,c);
  let path=null;
  if(modeData.empties && modeData.empties.has(k)) path=modeData.empties.get(k);
  else if(modeData.corpsCells && modeData.corpsCells.has(k)) path=modeData.corpsCells.get(k).path;
  if(!path) return;
  if(cp.type==="scout" && path.length>=3 && (!modeData.raidOk || modeData.raidCell!==k)){
    modeData.raidOk=true; modeData.raidCell=k;
    log("⚠ 侦察兵奔袭3格：下个回合将无法移动。请再点一次目标 / 再按 Enter 确认。", cp.side===0?"red":"blue");
    render(); return;
  }
  const from=[cp.r,cp.c];
  const rep=executeMove(cp,path);
  acted.add(cp.id); mode="idle"; modeData={};
  log(`${corpsLabel(cp)} 从(${from[0]+1},${from[1]+1})移动到 ${posStr(cp)}`, cp.side===0?"red":"blue");
  if(rep.segs.length) showBattleModal(rep.segs);
  afterCommand();
}
function startSplit(cp){
  if(cp.troops<6){ log("⚠ 兵力不足：新军团需≥5且原军团至少保留1。"); return; }
  mode="split-amount"; modeData={ id:cp.id }; render();
  setTimeout(()=>{ const el=document.getElementById("splitNum"); if(el) el.focus(); },0);
}
function confirmSplit(){
  const cp=getCorps(modeData.id); if(!cp) return cancelMode();
  const v=parseInt(document.getElementById("splitNum").value,10);
  if(!(v>=5 && v<=cp.troops-1)){ alert(`请输入 5 ~ ${cp.troops-1} 之间的整数`); return; }
  const vis=currentVis(), u=U(cp), spots=[];
  for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
    if(!dr&&!dc) continue;
    const nr=cp.r+dr, nc=cp.c+dc;
    const ok = u.air ? airStationable(nr,nc) : stationable(nr,nc);
    if(ok && !blockedByUnit(nr,nc,cp.side,vis)) spots.push([nr,nc]);
  }
  if(!spots.length){ log("⚠ 周围没有可放置新军团的空格。"); return; }
  mode="split-place"; modeData={ id:cp.id, n:v, spots:new Set(spots.map(([r,c])=>key(r,c))) };
  render();
}
function boardSplitPlace(r,c){
  const cp=getCorps(modeData.id); if(!cp) return cancelMode();
  if(!modeData.spots.has(key(r,c))) return;
  const u=U(cp);
  const nc={ id:nextId++, side:cp.side, type:cp.type, troops:modeData.n, r, c,
             resting:false, fatigue:0, alive:true, acc:0, dur:u.dur||0,
             flare:0, smoke:0, missile:0, ammo:false };
  corps.push(nc); cp.troops-=modeData.n;
  log(`${corpsLabel(cp)} 分兵 → 新建 ${typeName(nc.type)}#${nc.id}(x${nc.troops}) 于 (${r+1},${c+1})`,
      cp.side===0?"red":"blue");
  acted.add(cp.id); mode="idle"; modeData={}; afterCommand();
}
function mergeCandidates(cp){
  return corps.filter(o=>o.alive&&o.side===cp.side&&o.type===cp.type&&o.id!==cp.id&&manh(o,cp)<=1);
}
function startMerge(cp){
  const c=mergeCandidates(cp);
  if(!c.length){ log("⚠ 周围（含同格）没有同兵种友军。"); return; }
  mode="merge"; modeData={ id:cp.id, cands:c.map(o=>o.id) }; render();
}
function doMerge(idx){
  const cp=getCorps(modeData.id); if(!cp) return cancelMode();
  const t=getCorps(modeData.cands[idx]); if(!t||!t.alive) return cancelMode();
  const a=cp.troops, b=t.troops;
  t.troops=a+b;
  if(U(t).dur) t.dur=Math.max(t.dur, cp.dur);       // 合并取较高耐久
  log(`${corpsLabel(cp)}(x${a}) 并入 #${t.id}(x${b})，合并后 ${t.troops}`, cp.side===0?"red":"blue");
  death(cp); acted.add(cp.id); selId=t.id; mode="idle"; modeData={};
  afterCommand();
}
function doRest(cp){
  if(!U(cp).canRest){ log(`⚠ ${typeName(cp.type)}没有休整状态。`); return; }
  cp.resting=!cp.resting;
  log(`${corpsLabel(cp)} ${cp.resting?"进入":"解除"}休整状态`, cp.side===0?"red":"blue");
  acted.add(cp.id); mode="idle"; modeData={}; afterCommand();
}
// 打击目标：射程内按曼哈顿距离（菱形）计算，允许盲打（无需视野）
function strikeCells(cp){
  const range=strikeRange(cp), out=new Set();
  for(let r=0;r<N;r++)for(let c=0;c<N;c++){
    if(r===cp.r && c===cp.c) continue;
    if(manh({r,c},cp)<=range) out.add(key(r,c));
  }
  return out;
}
function startStrike(cp){
  if(!canStrike(cp)){ log("⚠ "+strikeHint(cp)); return; }
  const cells=strikeCells(cp);
  if(!cells.size){ log("⚠ 射程内没有可打击的格子。"); return; }
  mode="strike"; modeData={ id:cp.id, cells }; render();
}
// 某格在 side 视野内可见的敌方地面兵团
function visibleFoesAt(side, r, c, vis){
  return corps.filter(p=>p.alive && p.side!==side && p.r===r && p.c===c && !U(p).air && unitVisibleTo(p,side,vis));
}
function boardStrike(r,c){
  const cp=getCorps(modeData.id); if(!cp) return cancelMode();
  if(!modeData.cells.has(key(r,c))) return;
  const vis=currentVis();
  // 打击范围：定点=1格，喀秋莎=以落点为中心的3×3
  const hitCells=[];
  for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
    const rr=r+dr, cc=c+dc;
    if(!inMap(rr,cc)) continue;
    if(cp.type!=="katyusha" && (dr||dc)) continue;
    hitCells.push([rr,cc]);
  }
  // 打击前记录可见敌军的规模档位（用于展示"规模是否变化"）
  const before=new Map();
  for(const [rr,cc] of hitCells){
    const f=visibleFoesAt(cp.side,rr,cc,vis);
    if(f.length) before.set(key(rr,cc), enemySizeClass(f));
  }
  let rep;
  if(cp.type==="katyusha") rep=katyushaStrike(cp,r,c);
  else rep=strikeCell(cp,r,c, cp.troops*strikeBase(cp));
  if(cp.type==="katyusha") cp.ammo=false;           // 装填消耗
  // 战果汇总（脱敏：只报消灭人数 / 载具损耗 / 规模变化，不报兵种与剩余兵力）
  let total=0, vehLost=0, vehDead=0;
  const lines=[], sizeChanges=[];
  for(const cell of rep.cells){
    const k=key(cell.r,cell.c);
    const beforeSize=before.get(k);
    const foesAfter=visibleFoesAt(cp.side,cell.r,cell.c,vis);
    const afterSize=foesAfter.length?enemySizeClass(foesAfter):null;
    const kills=cell.hits.reduce((s,h)=>s+h.real,0);
    total+=kills;
    vehLost+=cell.hits.filter(h=>h.vehLost).length;
    vehDead+=cell.hits.filter(h=>h.vehDead).length;
    if(beforeSize && afterSize!==beforeSize)
      sizeChanges.push(`(${cell.r+1},${cell.c+1}) ${beforeSize}→${afterSize||"已歼灭"}`);
    if(!beforeSize && !cell.hits.length) continue;   // 无目标、无情报 → 不显示该格
    let s=`(${cell.r+1},${cell.c+1})：`;
    if(cell.hits.length) s+=`消灭 ${kills} 人`;
    else s+=`未取得战果`;
    if(vehLost) s+=`，载具受损${vehDead?"并被击毁":""}`;
    if(beforeSize) s+=` · 敌方规模 ${beforeSize} → ${afterSize||"已歼灭"}`;
    lines.push(s);
  }
  log(`🎯 ${corpsLabel(cp)} 打击 (${r+1},${c+1})${rep.area?"[3×3面杀伤]":""}：消灭 ${total} 人`
      + (vehLost?`，载具受损${vehLost}次${vehDead?"（击毁"+vehDead+"辆）":""}`:"")
      + (sizeChanges.length?`，敌方规模 ${sizeChanges.join("、")}`:"")
      + (rep.fort?`，摧毁防御工事${rep.fort}座`:"")
      + (rep.bunker?`，命中防空地堡${rep.bunker}次${rep.bunkerDead?"（已失效）":""}`:"")
      + (!total&&!rep.fort&&!rep.bunker?"，未取得战果":"") , cp.side===0?"red":"blue");
  baseRadar(cp, rep.cells.map(x=>[x.r,x.c]));
  showStrikeModal(cp,rep,lines,total,vehLost,vehDead);
  checkWin();
  acted.add(cp.id); mode="idle"; modeData={};
  afterCommand();
}
function buildCells(cp){
  const out=new Set();
  for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
    if(!dr&&!dc) continue;
    const r=cp.r+dr,c=cp.c+dc;
    if(stationable(r,c) && !fort[r][c]) out.add(key(r,c));
  }
  return out;
}
function fortCells(cp){
  const out=new Set();
  for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
    if(!dr&&!dc) continue;
    const r=cp.r+dr,c=cp.c+dc;
    if(inMap(r,c) && fort[r][c]) out.add(key(r,c));
  }
  return out;
}
function startBuild(cp){
  if(!cp.resting){ log("⚠ 步兵必须休整才能修筑工事。"); return; }
  const s=buildCells(cp);
  if(!s.size){ log("⚠ 周围没有可修筑工事的格子。"); return; }
  mode="build"; modeData={ id:cp.id, cells:s }; render();
}
function startDestroy(cp){
  if(!cp.resting){ log("⚠ 步兵必须休整才能摧毁工事。"); return; }
  const s=fortCells(cp);
  if(!s.size){ log("⚠ 周围没有防御工事。"); return; }
  mode="destroy"; modeData={ id:cp.id, cells:s }; render();
}
function startDemolish(cp){
  const s=fortCells(cp);
  if(!s.size){ log("⚠ 周围没有可拆毁的防御工事。"); return; }
  mode="demolish"; modeData={ id:cp.id, cells:s }; render();
}
function startBunker(cp){
  if(!cp.resting){ log("⚠ 步兵必须休整才能修筑防空地堡。"); return; }
  if(bunker[cp.r][cp.c]>0){ log("⚠ 本格已有防空地堡。"); return; }
  if(bunkerDead[cp.r][cp.c]){ log("⚠ 本格防空地堡已被摧毁，无法再次修筑。"); return; }
  mode="bunker"; modeData={ id:cp.id }; render();
}
function boardBunker(r,c){
  const cp=getCorps(modeData.id); if(!cp) return cancelMode();
  if(cp.r!==r || cp.c!==c) return;                  // 只能在自身格修筑
  bunker[cp.r][cp.c]=3;
  log(`${corpsLabel(cp)} 在 ${posStr(cp)} 修筑防空地堡（3点耐久）`, cp.side===0?"red":"blue");
  acted.add(cp.id); mode="idle"; modeData={}; afterCommand();
}
function boardFortOp(r,c){
  const cp=getCorps(modeData.id); if(!cp) return cancelMode();
  if(!modeData.cells.has(key(r,c))) return;
  const isBuild = (mode==="build");
  fort[r][c]=isBuild;
  log(`${corpsLabel(cp)} ${isBuild?"修筑":"摧毁"}了 (${r+1},${c+1}) ${isBuild?"防御工事":"的防御工事"}`,
      cp.side===0?"red":"blue");
  acted.add(cp.id); mode="idle"; modeData={}; afterCommand();
}
function throwCells(cp){
  const vis=currentVis(), out=new Set();
  for(const k of vis){ const p=unkey(k); if(manh(p,cp)<=visionRange(cp)) out.add(k); }
  return out;
}
function startThrow(cp, kind){
  const u=U(cp);
  if(!u.throwable){ return; }
  if(kind==="flare" && cp.flare<=0){ log("⚠ 照明弹已用尽（需飞回大本营补给）。"); return; }
  if(kind==="smoke" && cp.smoke<=0){ log("⚠ 烟雾弹已用尽（需飞回大本营补给）。"); return; }
  const cells=throwCells(cp);
  if(!cells.size){ log("⚠ 视野范围内没有可投掷的格子。"); return; }
  mode=kind; modeData={ id:cp.id, cells }; render();
}
function boardThrow(r,c){
  const cp=getCorps(modeData.id); if(!cp) return cancelMode();
  if(!modeData.cells.has(key(r,c))) return;
  const kind=mode;
  if(kind==="flare"){
    cp.flare--;
    for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
      const rr=r+dr,cc=c+dc; if(inMap(rr,cc)) flare[rr][cc]=5;
    }
    log(`${corpsLabel(cp)} 投掷照明弹 → (${r+1},${c+1})，3×3 照明区持续5回合（区内兵团全图可见）`, cp.side===0?"red":"blue");
  } else {
    cp.smoke--;
    const id=smokeSeq++;
    for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
      const rr=r+dr,cc=c+dc; if(inMap(rr,cc)){ smokeLeft[rr][cc]=5; smokeId[rr][cc]=id; }
    }
    log(`${corpsLabel(cp)} 投掷烟雾弹 → (${r+1},${c+1})，3×3 烟幕持续5回合（区外无法窥视）`, cp.side===0?"red":"blue");
  }
  acted.add(cp.id); mode="idle"; modeData={}; afterCommand();
}
function startMissile(cp){
  if(cp.type!=="bomber"){ return; }
  if(cp.missile<=0){ log("⚠ 轰炸机没有导弹（飞回大本营可补充）。"); return; }
  const out=new Set();
  for(let r=0;r<N;r++)for(let c=0;c<N;c++){
    if(manh({r,c},cp)<=visionRange(cp)) out.add(key(r,c));
  }
  if(!out.size){ log("⚠ 射程内没有可打击的格子。"); return; }
  mode="missile"; modeData={ id:cp.id, cells:out }; render();
}
function boardMissile(r,c){
  const cp=getCorps(modeData.id); if(!cp) return cancelMode();
  if(!modeData.cells.has(key(r,c))) return;
  cp.missile--;
  pendingMissiles.push({ r, c, side:cp.side, shooterId:cp.id });
  log(`🚀 ${corpsLabel(cp)} 向 (${r+1},${c+1}) 发射导弹，将于下一回合命中！`, cp.side===0?"red":"blue");
  acted.add(cp.id); mode="idle"; modeData={}; afterCommand();
}
function resolveMissiles(){
  if(!pendingMissiles.length) return;
  const list=pendingMissiles.slice(); pendingMissiles=[];
  for(const ms of list){
    const {r,c,side}=ms;
    let mult=1, bunkerHit=false, bunkerKilled=false;
    if(fort[r][c]) fort[r][c]=false;
    if(bunker[r][c]>0){
      bunker[r][c]--; bunkerHit=true; mult=0.5;
      if(bunker[r][c]===0){ bunkerDead[r][c]=true; bunkerKilled=true; }
    }
    const targets=corps.filter(t=>t.alive && t.r===r && t.c===c && !U(t).air);
    if(!targets.length){
      log(`🚀 导弹命中 (${r+1},${c+1})，该格已空无一人。`, "warn", side);
      continue;
    }
    if(mult===1){
      for(const t of targets) death(t);
      log(`💥 导弹命中 (${r+1},${c+1})，该格 ${targets.length} 支兵团被<b>全歼</b>！`, "warn", side);
    } else {
      for(const t of targets){ t.troops=Math.max(0, t.troops-Math.round(t.troops*0.5)); if(t.troops<=0) death(t); }
      log(`💥 导弹命中 (${r+1},${c+1})，防空地堡拦截，敌方损耗减半${bunkerKilled?"，地堡已失效":""}。`, "warn", side);
    }
    baseRadar(getCorps(ms.shooterId), [[r,c]]);
    if(bunkerHit && !bunkerKilled) log(`🛡 防空地堡承受打击，剩余耐久 ${bunker[r][c]}/3。`, "warn", 1-side);
  }
  checkWin();
}
function afterCommand(){ render(); if(gameOver && !victoryShown) showVictory(); }

/* ---------------- 回合 / 昼夜 ---------------- */
function endTurn(){
  if(gameOver || phase!=="play") return;
  cancelMode();
  for(const p of corps) if(p.alive && p.side===current && p.fatigue>0) p.fatigue--;
  checkWin();
  if(gameOver){ render(); if(!victoryShown) showVictory(); return; }
  log(`—— ${SIDE_NAME[current]} 回合结束 ——`);
  current = 1-current;
  if(current===0){
    const wasDay=isDay();
    turnNo++;
    onNewRound(wasDay);
    if(gameOver){ render(); if(!victoryShown) showVictory(); return; }
  }
  acted.clear(); selId=null; mode="idle"; modeData={};
  log(`轮到 ${SIDE_NAME[current]} 行动（第 ${turnNo} 回合）`);
  render();
}
function onNewRound(wasDay){
  resolveMissiles();
  // 照明弹/烟幕计时
  for(let r=0;r<N;r++)for(let c=0;c<N;c++){
    if(flare[r][c]>0) flare[r][c]--;
    if(smokeLeft[r][c]>0) smokeLeft[r][c]--;
  }
  if(isDay()!==wasDay){
    log(`⏱ 时间转换 → ${isDay()?"☀ 白天":"🌙 夜晚"}（第 ${dayNo()} 天）`, "sys", null);
    log(isDay()?"白天视野恢复。":"夜晚：除侦察兵(-2格外)所有兵团视野 -1 格。", "sys", null);
  }
}

/* ---------------- 弹窗 ---------------- */
function closeModal(){ document.getElementById("modalWrap").classList.add("hidden"); }
function modalShow(html){ document.getElementById("modalCard").innerHTML=html; document.getElementById("modalWrap").classList.remove("hidden"); }
function segHTML(seg){
  const a=`${SIDE_NAME[seg.def.side===0?1:0]}${typeName(seg.atkType)}#${seg.atkId}`;
  let html=`<div class="battle-seg"><div class="vs">⚔ ${a}(${seg.atk0})　vs　${corpsLabel(seg.def)}(${seg.def0}${seg.def.resting?" · 休整":""}${U(seg.def).dur?` · 耐久${seg.def.dur}`:""})</div>`;
  if(seg.special) html+=`<div class="rounds">${seg.special}</div>`;
  else html+=`<div class="rounds">`+seg.rounds.slice(0,40).map((rd,i)=>
      `第${i+1}轮：攻损 ${rd.la} → 剩 ${rd.aLeft} ｜ 守损 ${rd.lb} → 剩 ${rd.bLeft}`).join("<br>")
      + (seg.rounds.length>40?`<br>… 共 ${seg.rounds.length} 轮`:``)+`</div>`;
  const parts=[];
  if(seg.defDead) parts.push(`${typeName(seg.def.type)} 被全歼`);
  if(seg.atkDead) parts.push(`攻方被全歼`);
  if(!parts.length) parts.push("交战结束");
  html+=`<div class="result">结果：${parts.join("；")}</div></div>`;
  return html;
}
function showBattleModal(segs){
  let html=`<h2>⚔ 交战报告</h2>`;
  for(const s of segs) html+=segHTML(s);
  html+=`<div style="text-align:center;margin-top:6px"><button class="btn primary" data-action="close-modal">确定</button></div>`;
  modalShow(html);
}
function showStrikeModal(cp,rep,lines,total,vehLost,vehDead){
  let html=`<h2>🎯 打击报告</h2>
    <div class="battle-seg"><div class="vs">${corpsLabel(cp)} · ${rep.area?"3×3 面杀伤":"定点打击"}</div>
    <div class="rounds">${lines.length?lines.join("<br>"):"（打击范围内无目标）"}</div>`;
  if(rep.fort) html+=`<div class="rounds">摧毁防御工事 ${rep.fort} 座</div>`;
  if(rep.bunker) html+=`<div class="rounds">命中防空地堡 ${rep.bunker} 次${rep.bunkerDead?"（已失效）":""}</div>`;
  html+=`<div class="result">合计消灭 ${total} 人${vehLost?` · 载具受损 ${vehLost} 次${vehDead?`（击毁 ${vehDead} 辆）`:""}`:""}</div></div>
    <div class="tip-note">※ 战果仅显示消灭人数、载具耐久损耗与敌方规模变化，具体兵种与剩余兵力不可侦察。</div>
    <div style="text-align:center"><button class="btn primary" data-action="close-modal">确定</button></div>`;
  modalShow(html);
}
function showVictory(){
  victoryShown=true;
  modalShow(`<div class="victory ${winner===0?"red":"blue"}">
    <div style="font-size:40px">🏆</div>
    <div class="big">${SIDE_NAME[winner]} 获胜！</div>
    <div style="color:#607d8b;font-size:13px">共经历 ${turnNo} 个回合（第 ${dayNo()} 天）</div>
    <button class="btn primary" style="margin-top:14px" data-action="new-game">再来一局</button>
  </div>`);
}

/* ---------------- 渲染 ---------------- */
function renderBoard(){
  const godView = viewMode==="god";
  const effSide = viewMode==="auto" ? current : (godView ? -1 : (viewMode==="red" ? 0 : 1));
  const noFog = (phase!=="play") || godView;
  const visR = phase==="play" ? computeVision(0) : null;
  const visB = phase==="play" ? computeVision(1) : null;
  const vis = noFog ? null : (effSide===0 ? visR : visB);
  if(!noFog){ markSeen(0, visR); markSeen(1, visB); }
  const misSet=new Map();
  for(const m of pendingMissiles){
    // 发射方始终可见自己的导弹落点；防守方仅当落点处于大本营雷达范围(5格)才可见
    const [br,bc]=BASES[1-m.side];
    if(current===m.side || Math.abs(m.r-br)+Math.abs(m.c-bc)<=5)
      misSet.set(key(m.r,m.c), m.side);
  }
  let html="";
  html+=`<div class="lbl"></div>`;
  for(let c=0;c<N;c++) html+=`<div class="lbl">${c+1}</div>`;
  for(let r=0;r<N;r++){
    html+=`<div class="lbl">${r+1}</div>`;
    for(let c=0;c<N;c++){
      const k=key(r,c);
      const v = noFog || vis.has(k);
      const ev = seen[current][r][c];
      const dim = !v && memoryFog && ev;
      let cls="cell";
      if(v || dim) cls += " t-"+terrain[r][c] + (bridge[r][c]?" bridge":"");
      if(dim) cls += " fog-mem";
      if(!v && !dim) cls += " fog-unknown";
      // 高亮
      if(mode==="move"||mode==="move-choose"){
        if(modeData.empties && modeData.empties.has(k)) cls+=" hl-move";
        else if(modeData.corpsCells && modeData.corpsCells.has(k))
          cls+= modeData.corpsCells.get(k).type==="attack" ? " hl-attack" : " hl-ally";
      }
      if(mode==="build" && modeData.cells && modeData.cells.has(k)) cls+=" hl-build";
      if((mode==="destroy"||mode==="demolish") && modeData.cells && modeData.cells.has(k)) cls+=" hl-fort";
      if(mode==="split-place" && modeData.spots && modeData.spots.has(k)) cls+=" hl-build";
      if(mode==="strike" && modeData.cells && modeData.cells.has(k)) cls+=" hl-strike";
      if((mode==="flare"||mode==="smoke"||mode==="missile") && modeData.cells && modeData.cells.has(k)) cls+=" hl-throw";
      if(godView && visR.has(k) && visB.has(k)) cls+=" god-rb";
      else if(godView && visR.has(k)) cls+=" god-r";
      else if(godView && visB.has(k)) cls+=" god-b";
      if(mode==="bunker" && modeData.id!=null){ const sp=getCorps(modeData.id); if(sp&&sp.r===r&&sp.c===c) cls+=" hl-build"; }
      const sp0 = selId!=null ? getCorps(selId) : null;
      if(mode==="idle" && sp0 && sp0.alive){
        const vv=visionRange(sp0);
        if(Math.abs(sp0.r-r)+Math.abs(sp0.c-c)<=vv) cls+=" hl-vision";
      }
      if(sp0 && sp0.alive && sp0.r===r && sp0.c===c) cls+=" selected";
      if(phase==="play" && r===cur.r && c===cur.c) cls+=" cursor";

      let title=`(${r+1},${c+1})`;
      if(v) title+=" "+T_NAME[terrain[r][c]]+(bridge[r][c]?" · 桥":"");
      else title+=" 未探明";
      if(v && fort[r][c]) title+=" · 有防御工事";
      if(v && bunker[r][c]>0) title+=` · 防空地堡(耐久${bunker[r][c]}/3)`;
      if(v && bunkerDead[r][c] && bunker[r][c]<=0) title+=" · 地堡废墟(不可再建)";

      let inner="";
      // 效果层
      if(inFlare(r,c)) inner+=`<span class="fx fx-flare"></span>`;
      if(smokeLeft[r][c]>0) inner+=`<span class="fx fx-smoke"></span>`;
      // 大本营
      if(isBase(r,c)) inner+=`<span class="base-tag">营</span>`;
      if(v && fort[r][c]) inner+=`<span class="fort-tag">#</span>`;
      if(v && bunker[r][c]>0) inner+=`<span class="bunk-tag">堡</span>`;

      // 单位
      const stack = corps.filter(p=>p.alive && p.r===r && p.c===c);
      const own = stack.filter(p=>p.side===current || godView);
      const foes = stack.filter(p=>!godView && p.side!==current && unitVisibleTo(p,current,vis||new Set()));
      if(own.length){
        let show=own[0];
        if(sp0 && sp0.alive && sp0.side===current && sp0.r===r && sp0.c===c && own.includes(sp0)) show=sp0;
        const st=[];
        if(show.resting) st.push("休整中");
        if(show.fatigue>0) st.push("下回合不能移动");
        if(U(show).air) st.push("空中单位");
        if(U(show).dur) st.push("耐久"+show.dur+"/3");
        if(show.type==="katyusha") st.push(show.ammo?"已装填":"未装填");
        if(U(show).throwable) st.push(`照明${show.flare}/烟雾${show.smoke}`);
        if(U(show).missile) st.push(`导弹${show.missile}`);
        title+=` · ${godView ? SIDE_NAME[show.side] : "我方"} ${typeName(show.type)}#${show.id} x${show.troops}${st.length?" · "+st.join("/"):""}`;
        if(own.length>1) title+=`（本格共 ${own.length} 支我方兵团）`;
        inner+=`<span class="corps ${show.side===0?"red":"blue"}${U(show).air?" air":""}${acted.has(show.id)?" acted":""}">${U(show).ch}</span>`;
        if(own.length>1) inner+=`<span class="stack">×${own.length}</span>`;
        if(show.resting) inner+=`<span class="dot rest"></span>`;
        if(show.fatigue>0) inner+=`<span class="dot fat"></span>`;
        if(U(show).dur) inner+=`<span class="dot dur">${show.dur}</span>`;
      } else if(foes.length){
        const size=enemySizeClass(foes);
        const anyRest=foes.some(p=>p.resting);
        title+=` · 敌方兵团（规模：${size}）${anyRest?" · 正在休整":""}`;
        inner+=`<span class="enemy-chip ${foes[0].side===0?"red":"blue"} ${size==="大"?"sz-l":size==="中"?"sz-m":"sz-s"}">${size}</span>`;
        if(foes.length>1) inner+=`<span class="stack">×${foes.length}</span>`;
        if(anyRest) inner+=`<span class="dot rest"></span>`;
      }
      // 遭遇战预警：无近战能力单位走入有近战能力的敌军格 → 将被全歼
      if(v && (mode==="move"||mode==="move-choose") && modeData.corpsCells && modeData.corpsCells.has(k)){
        const mc=modeData.corpsCells.get(k);
        const mover=getCorps(modeData.id);
        if(mover && mc.type==="attack" && !U(mover).melee){
          cls+=" hl-attack";
          title+=" ⚠ 突入即被全歼（"+typeName(mover.type)+"无近战能力）";
        }
      }
      // 导弹预警
      if(misSet.has(k)) inner+=`<span class="missile-mark">⊕</span>`;
      html+=`<div class="${cls}" data-cell="${r},${c}" title="${title}">${inner}</div>`;
    }
  }
  document.getElementById("board").innerHTML=html;
}
function renderPanel(){
  const chip=document.getElementById("turnChip");
  chip.textContent=SIDE_NAME[current]+"行动";
  chip.className="turn-chip "+(current===0?"red":"blue");
  const aliveOwn=corps.filter(p=>p.alive&&p.side===current).length;
  document.getElementById("turnRound").textContent=`第 ${turnNo} 回合 · 第 ${dayNo()} 天 · 已行动 ${acted.size}/${aliveOwn}`;
  const dc=document.getElementById("dayChip");
  dc.textContent = isDay() ? "☀ 白天" : "🌙 夜晚";
  dc.className = "day-chip "+(isDay()?"day":"night");

  // 空中威胁预警
  const thCard=document.getElementById("threatCard");
  const th=document.getElementById("threatText");
  let threat=false;
  for(const e of corps){
    if(!e.alive||e.side===current||!U(e).air) continue;
    for(const p of corps){
      if(!p.alive||p.side!==current) continue;
      if(manh(e,p)<=3){ threat=true; break; }
    }
    if(threat) break;
  }
  if(threat){
    thCard.style.display="block";
    th.textContent="⚠ 空中威胁：侦测到敌方空中单位活动（距我方某兵团 ≤3 格），但无法定位与攻击。";
  } else thCard.style.display="none";

  // 选中信息
  const info=document.getElementById("selInfo"), cmdArea=document.getElementById("cmdArea");
  const cp = selId!=null ? getCorps(selId) : null;
  if(!cp||!cp.alive){
    info.textContent="点击棋盘上的己方军团进行指挥。";
    cmdArea.innerHTML="";
  } else {
    const u=U(cp);
    const own = cp.side===current;
    const canCmd = own && !acted.has(cp.id) && !gameOver && mode==="idle";
    const st=[];
    if(cp.resting) st.push(`<span class="badge rest">休整中</span>`);
    if(cp.fatigue>0) st.push(`<span class="badge fat">下回合不能移动</span>`);
    if(u.air) st.push(`<span class="badge air">空中</span>`);
    if(u.dur) st.push(`<span class="badge dur">耐久 ${cp.dur}/3</span>`);
    if(acted.has(cp.id)) st.push(`<span class="badge done">已行动</span>`);
    const extra=[];
    extra.push(`视野 ${visionRange(cp)} 格`);
    if(u.ranged) extra.push(`打击射程 ${strikeRange(cp)} 格`);
    if(cp.type==="katyusha") extra.push(cp.ammo?"弹药已装填":"未装填");
    if(u.throwable) extra.push(`照明弹 ${cp.flare} / 烟雾弹 ${cp.smoke}`);
    if(u.missile) extra.push(`导弹 ${cp.missile}`);
    info.innerHTML=`<b style="color:var(--${cp.side===0?"red":"blue"})">${corpsLabel(cp)}</b>
      兵力 <b>${cp.troops}</b> @ ${posStr(cp)} ${st.join(" ")}<br>
      <span style="color:#607d8b;font-size:12px">${extra.join(" · ")}</span>`;
    if(!canCmd){
      cmdArea.innerHTML=`<span style="color:#90a4ae;font-size:12px">${
        gameOver?"游戏已结束": !own?"对方兵团（仅可查看规模）": acted.has(cp.id)?"该军团本回合已行动。":"请先结束当前操作"}</span>`;
    } else {
      let cmdN=0;
      const btn=(label,action,dis,tip)=>{ cmdN++; return `<button class="btn small" data-action="${action}" ${dis?"disabled":""} title="${tip||""}">${cmdN}. ${label}</button>`; };
      let html="";
      html+=btn("移动","cmd-move", cp.fatigue>0&&cp.type==="scout", cp.type==="scout"?"侦察兵1~2格，可奔袭3格（下回合不能移动）":`最多 ${u.move} 格`);
      html+=btn("分兵","cmd-split", cp.troops<6, "新军团不少于5");
      html+=btn("合兵","cmd-merge", mergeCandidates(cp).length===0, "与相邻同兵种友军合并");
      if(u.canRest) html+=btn(cp.resting?"解除休整":"休整","cmd-rest", false, "受击损耗减半");
      if(u.ranged){
        let dis=!canStrike(cp), tip=strikeHint(cp)||`射程 ${strikeRange(cp)} 格`;
        if(cp.type==="katyusha") tip="装填后才可打击（3×3面杀伤）";
        html+=btn("打击","cmd-strike", dis, tip);
      }
      if(cp.type==="katyusha") html+=btn("装填弹药","cmd-load", false, "花一回合装填，之后可随时打击");
      if(cp.type==="inf"){
        html+=btn("修筑工事","cmd-build", !cp.resting||buildCells(cp).size===0, "需休整，相邻格");
        html+=btn("摧毁工事","cmd-destroy", !cp.resting||fortCells(cp).size===0, "需休整，相邻格");
        const canB = cp.resting && bunker[cp.r][cp.c]<=0 && !bunkerDead[cp.r][cp.c];
        html+=btn("修筑防空地堡","cmd-bunker", !canB, "需休整，在自身格");
      }
      if(cp.type==="cav") html+=btn("拆毁工事","cmd-demolish", fortCells(cp).size===0, "拆毁相邻工事");
      if(u.throwable){
        html+=btn("照明弹","cmd-flare", cp.flare<=0, "3×3照明区，持续5回合");
        html+=btn("烟雾弹","cmd-smoke", cp.smoke<=0, "3×3烟幕，持续5回合");
      }
      if(u.missile) html+=btn("发射导弹","cmd-missile", cp.missile<=0, "下一回合命中；无地堡则全歼");
      cmdArea.innerHTML=html;
    }
  }

  // 模式框
  const modeCard=document.getElementById("modeCard"), mb=document.getElementById("modeBox");
  if(mode==="idle"){ modeCard.style.display="none"; }
  else{
    modeCard.style.display="block";
    let html=`<button class="btn small" data-action="cancel-mode" style="float:right">取消 (Esc)</button>`;
    if(mode==="move") html+=`<div>移动模式：<b>WASD 选落点，Enter 确认</b>（或点击 <b>黄色</b>空格 / <b style="color:#00bcd4">青色</b>己方格）。步数上限 ${modeData.steps}。<br>
      <span style="color:#b03a2e">若走入不可见敌军的格子，将立即触发遭遇战；侦察兵奔袭3格需二次确认。</span></div>`;
    else if(mode==="split-amount"){ const c=getCorps(modeData.id);
      html+=`<div>分出兵力（5 ~ ${c?c.troops-1:0}）：<input type="number" id="splitNum" min="5" value="5">
        <button class="btn small primary" data-action="split-confirm">确定</button></div>`; }
    else if(mode==="split-place") html+=`<div>点击棋盘上<b>绿色高亮</b>相邻空格放置新军团（${modeData.n}）；或 <b>WASD 选位 + Enter</b>。</div>`;
    else if(mode==="merge") html+=`<div>选择合并目标：</div><div class="targets">`+
      modeData.cands.map((id,i)=>{const o=getCorps(id);
        return `<button class="btn small" data-action="merge-${i}">#${o.id} ${typeName(o.type)} x${o.troops} @ ${posStr(o)}</button>`;}).join("")+`</div>`;
    else if(mode==="strike"){
      const cp2=getCorps(modeData.id);
      html+=`<div>打击模式：<b>WASD 选目标，Enter 确认</b>（或点击<b style="color:#d500f9">紫色高亮</b>格子，射程 ${cp2?strikeRange(cp2):0} 格 · 可盲打）。${cp2&&cp2.type==="katyusha"?"将以该格为中心发动 3×3 面杀伤。":""}<br>
        <span style="color:#607d8b">该格防御工事会被摧毁；防空地堡与休整/高地均使损耗减半。</span></div>`;
    }
    else if(mode==="build") html+=`<div>修筑工事：点击<b>绿色高亮</b>相邻格；或 <b>WASD + Enter</b>。</div>`;
    else if(mode==="destroy") html+=`<div>摧毁工事：点击<b>橙色高亮</b>相邻工事格；或 <b>WASD + Enter</b>。</div>`;
    else if(mode==="demolish") html+=`<div>骑兵拆毁工事：点击<b>橙色高亮</b>相邻工事格；或 <b>WASD + Enter</b>。</div>`;
    else if(mode==="bunker") html+=`<div>修筑防空地堡：<b>Enter</b> 或点击自身所在格。地堡可减半炮兵/载具打击伤害，承受 3 次打击后永久失效。</div>`;
    else if(mode==="flare") html+=`<div>投掷照明弹：点击<b>青色高亮</b>视野内格子，或 <b>WASD + Enter</b>，形成 3×3 照明区（持续5回合，区内兵团全图可见）。</div>`;
    else if(mode==="smoke") html+=`<div>投掷烟雾弹：点击<b>青色高亮</b>视野内格子，或 <b>WASD + Enter</b>，形成 3×3 烟幕（持续5回合，区外不可窥视）。</div>`;
    else if(mode==="missile") html+=`<div>发射导弹：点击<b>青色高亮</b>格子，或 <b>WASD + Enter</b>（射程内 · 可盲打）。导弹将于下一回合命中，该格若无防空地堡则所有单位被全歼。<br>
      <span style="color:#b03a2e">注意：导弹敌我不分，该格上的己方单位同样会被消灭。</span></div>`;
    mb.innerHTML=html;
  }

  // 己方军团列表
  const list=document.getElementById("corpsList");
  let lhtml="";
  const mine=corps.filter(p=>p.alive&&p.side===current);
  if(!mine.length) lhtml+=`<div style="font-size:12px;color:#90a4ae;padding:2px 8px">（已无兵团）</div>`;
  for(const p of mine){
    const u=U(p);
    const badges=[];
    if(p.resting) badges.push(`<span class="badge rest">休整</span>`);
    if(p.fatigue>0) badges.push(`<span class="badge fat">疲劳</span>`);
    if(u.air) badges.push(`<span class="badge air">空中</span>`);
    if(u.dur) badges.push(`<span class="badge dur">耐${p.dur}</span>`);
    if(acted.has(p.id)) badges.push(`<span class="badge done">已行动</span>`);
    const sel=selId===p.id?" sel":"";
    const dim=acted.has(p.id)?" dim":"";
    lhtml+=`<div class="corps-row${sel}${dim}" data-action="select" data-id="${p.id}">
      <span class="mini ${u.air?"air":(p.side===0?"red":"blue")}">${u.ch}</span>
      <span>#${p.id} ${typeName(p.type)} <b>x${p.troops}</b> @ ${posStr(p)}</span>
      <span style="margin-left:auto">${badges.join("")}</span></div>`;
  }
  list.innerHTML=lhtml;

  // 已发现的敌方兵团
  const vis=computeVision(current);
  const eCard=document.getElementById("enemyCard"), eList=document.getElementById("enemyList");
  const groups=new Map();
  for(const p of corps){
    if(!p.alive||p.side===current) continue;
    if(!unitVisibleTo(p,current,vis)) continue;
    const k=key(p.r,p.c);
    if(!groups.has(k)) groups.set(k,[]);
    groups.get(k).push(p);
  }
  if(!groups.size){ eCard.style.display="none"; }
  else{
    eCard.style.display="block";
    let e="";
    for(const [k,arr] of groups){
      const {r,c}=unkey(k);
      const size=enemySizeClass(arr);
      e+=`<div class="corps-row" style="cursor:default">
        <span class="mini red">${SIDE_NAME[arr[0].side][0]}</span>
        <span>规模 <b>${size}</b> @ (${r+1},${c+1})</span>
        <span style="margin-left:auto">${arr.some(p=>p.resting)?'<span class="badge rest">休整</span>':''}${arr.length>1?`×${arr.length}`:""}</span></div>`;
    }
    eList.innerHTML=e;
  }
}
function render(){ renderBoard(); renderPanel(); }

/* ---------------- 事件 ---------------- */
document.addEventListener("click", e=>{
  const btn=e.target.closest("[data-action]");
  if(!btn) return;
  const act=btn.dataset.action;
  if(act==="deploy-start"){ phase="deploy"; renderDeploy(); return; }
  if(act==="deploy-recommend"){ readDeployInputs(); deployCfg=Object.assign(deployConfigDefaults(), RECOMMEND); renderDeploy(); return; }
  if(act==="deploy-clear"){ deployCfg=deployConfigDefaults(); renderDeploy(); return; }
  if(act==="deploy-confirm"){ confirmDeploy(); return; }
  if(act==="new-game"){ newGame(); return; }
  if(act==="close-modal"){ closeModal(); if(gameOver&&!victoryShown) showVictory(); return; }
  if(act==="view-toggle"){ cycleViewMode(); return; }
  if(phase!=="play") return;
  const cp = selId!=null ? getCorps(selId) : null;
  if(act==="select"){ if(viewLocked()) return; const p=getCorps(+btn.dataset.id); if(p&&p.alive){ selId=p.id; if(mode!=="idle") cancelMode(); render(); } return; }
  if(act==="end-turn") return endTurn();
  if(act==="cancel-mode") return cancelMode();
  if(gameOver) return;
  if(act==="cmd-move"&&cp) return startMove(cp);
  if(act==="cmd-split"&&cp) return startSplit(cp);
  if(act==="split-confirm") return confirmSplit();
  if(act==="cmd-merge"&&cp) return startMerge(cp);
  if(act.startsWith("merge-")) return doMerge(+act.slice(6));
  if(act==="cmd-rest"&&cp) return doRest(cp);
  if(act==="cmd-strike"&&cp) return startStrike(cp);
  if(act==="cmd-load"&&cp){ cp.ammo=true; log(`${corpsLabel(cp)} 完成弹药装填，可随时发动打击。`, cp.side===0?"red":"blue");
    acted.add(cp.id); mode="idle"; modeData={}; return afterCommand(); }
  if(act==="cmd-build"&&cp) return startBuild(cp);
  if(act==="cmd-destroy"&&cp) return startDestroy(cp);
  if(act==="cmd-bunker"&&cp) return startBunker(cp);
  if(act==="cmd-demolish"&&cp) return startDemolish(cp);
  if(act==="cmd-flare"&&cp) return startThrow(cp,"flare");
  if(act==="cmd-smoke"&&cp) return startThrow(cp,"smoke");
  if(act==="cmd-missile"&&cp) return startMissile(cp);
});
document.getElementById("board").addEventListener("click", e=>{
  const cell=e.target.closest("[data-cell]");
  if(!cell || phase!=="play" || gameOver || viewLocked()) return;
  const [r,c]=cell.dataset.cell.split(",").map(Number);
  if(mode==="move") return boardMove(r,c);
  if(mode==="split-place") return boardSplitPlace(r,c);
  if(mode==="build"||mode==="destroy"||mode==="demolish") return boardFortOp(r,c);
  if(mode==="bunker") return boardBunker(r,c);
  if(mode==="strike") return boardStrike(r,c);
  if(mode==="flare"||mode==="smoke") return boardThrow(r,c);
  if(mode==="missile") return boardMissile(r,c);
  // idle：选择己方兵团
  const stack=corps.filter(p=>p.alive && p.r===r && p.c===c && p.side===current);
  if(stack.length){
    let pick=stack.find(p=>p.id===selId) || stack.find(p=>!acted.has(p.id)) || stack[0];
    selId=pick.id; cur={r,c}; render();        // 键盘光标跟随鼠标选中位置
  } else if(corps.some(p=>p.alive&&p.r===r&&p.c===c)){
    // 点到敌方（或不可见格）→ 清空选择
    selId=null; render();
  }
});
document.addEventListener("keydown", e=>{
  if(e.altKey||e.ctrlKey||e.metaKey) return;
  const k=e.key;
  if(k==="Escape"){ if(mode!=="idle") cancelMode(); else if(selId!=null){ selId=null; render(); } return; }
  if(k==="Enter" && mode==="split-amount"){ confirmSplit(); return; }
  if(e.target && e.target.matches && e.target.matches("input,textarea,select")) return;
  if(phase!=="play" || gameOver || viewLocked()) return;
  const dir={w:[-1,0],s:[1,0],a:[0,-1],d:[0,1],ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]};
  if(dir[k]){
    cur={r:Math.max(0,Math.min(N-1,cur.r+dir[k][0])), c:Math.max(0,Math.min(N-1,cur.c+dir[k][1]))};
    render(); return;
  }
  if(k==="Enter"){
    if(e.repeat) return;
    if(mode==="idle"){
      const stack=corps.filter(p=>p.alive && p.r===cur.r && p.c===cur.c && p.side===current);
      if(stack.length){
        const idx=stack.findIndex(p=>p.id===selId);
        const pick= idx>=0 ? stack[(idx+1)%stack.length] : (stack.find(p=>!acted.has(p.id)) || stack[0]);
        selId=pick.id; cur={r:pick.r,c:pick.c}; render();
      }
      return;
    }
    if(mode==="move") return boardMove(cur.r,cur.c);
    const tbl={ strike:boardStrike, "split-place":boardSplitPlace, build:boardFortOp, destroy:boardFortOp,
                demolish:boardFortOp, bunker:boardBunker, flare:boardThrow, smoke:boardThrow, missile:boardMissile };
    if(tbl[mode]) return tbl[mode](cur.r,cur.c);
    return;
  }
  const n=+k;
  if(n>=1 && n<=9 && !e.repeat){
    if(mode==="idle" && selId!=null){
      const btns=[...document.querySelectorAll("#cmdArea [data-action^='cmd-']")];
      const b=btns[n-1];
      if(b&&!b.disabled){
        const cp=getCorps(selId);
        b.click();
        if(cp) cur={r:cp.r,c:cp.c};
        render();
      }
    }
  }
});
document.getElementById("memFog").addEventListener("change", e=>{
  memoryFog=e.target.checked; render();
});
document.addEventListener("input", e=>{
  if(e.target && e.target.dataset && e.target.dataset.dt){ readDeployInputs(); updateDeployLeft(); }
});

/* ---------------- 上帝视角 ---------------- */
function viewLocked(){
  if(phase!=="play") return false;
  if(viewMode==="god") return true;
  if(viewMode==="auto") return false;
  return viewMode !== (current===0 ? "red" : "blue");
}
function renderViewBtn(){
  const b=document.getElementById("viewBtn");
  if(b){
    const map={auto:"自动",red:"红方",blue:"蓝方",god:"上帝"};
    b.textContent="👁 "+map[viewMode]+"视角";
  }
}
function cycleViewMode(){
  const order=["auto","red","blue","god"];
  viewMode=order[(order.indexOf(viewMode)+1)%order.length];
  if(viewLocked()){ selId=null; mode="idle"; modeData={}; }
  renderViewBtn(); render();
}

/* ---------------- 启动 ---------------- */

/* ============================================================
   Node 适配钩子：服务端/测试通过 __ENGINE_EXPORT__ 获取状态访问器。
   浏览器端不定义该函数，本段为空操作；引擎本体保持与 v3 逐字一致。
   由 build-engine.js 生成，请勿手改引擎部分。
   ============================================================ */
if (typeof __ENGINE_EXPORT__ === "function") {
  __ENGINE_EXPORT__({
    get terrain(){return terrain}, set terrain(v){terrain=v},
    get bridge(){return bridge}, set bridge(v){bridge=v},
    get fort(){return fort}, set fort(v){fort=v},
    get bunker(){return bunker}, set bunker(v){bunker=v},
    get bunkerDead(){return bunkerDead}, set bunkerDead(v){bunkerDead=v},
    get flare(){return flare}, set flare(v){flare=v},
    get smokeLeft(){return smokeLeft}, set smokeLeft(v){smokeLeft=v},
    get smokeId(){return smokeId}, set smokeId(v){smokeId=v},
    get corps(){return corps}, set corps(v){corps=v},
    get nextId(){return nextId}, set nextId(v){nextId=v},
    get current(){return current}, set current(v){current=v},
    get turnNo(){return turnNo}, set turnNo(v){turnNo=v},
    get acted(){return acted}, set acted(v){acted=v},
    get selId(){return selId}, set selId(v){selId=v},
    get mode(){return mode}, set mode(v){mode=v},
    get modeData(){return modeData}, set modeData(v){modeData=v},
    get gameOver(){return gameOver}, set gameOver(v){gameOver=v},
    get winner(){return winner}, set winner(v){winner=v},
    get victoryShown(){return victoryShown}, set victoryShown(v){victoryShown=v},
    get phase(){return phase}, set phase(v){phase=v},
    get deploySide(){return deploySide}, set deploySide(v){deploySide=v},
    get deployCfg(){return deployCfg}, set deployCfg(v){deployCfg=v},
    get seen(){return seen}, set seen(v){seen=v},
    get pendingMissiles(){return pendingMissiles}, set pendingMissiles(v){pendingMissiles=v},
    get smokeSeq(){return smokeSeq}, set smokeSeq(v){smokeSeq=v},
    get memoryFog(){return memoryFog}, set memoryFog(v){memoryFog=v},
    get viewMode(){return viewMode}, set viewMode(v){viewMode=v},
    get cur(){return cur}, set cur(v){cur=v},
    get logEntries(){return logEntries},
    UNITS, DEPLOY_TYPES, RECOMMEND, BUDGET, MELEE, N, BASES, SIDE_NAME, T_NAME, DIRS4,
    fn: { newGame, genMap, grid, key, unkey, manh, inMap, isBase, getCorps, U, typeName,
          isDay, dayNo, computeVision, visionRange, markSeen, unitVisibleTo, structVisibleAt,
          enemySizeClass, smokePatchAt, inFlare, patchCells, patchHasUnit,
          stationable, airStationable,
          spawnFromConfig, startPlay, deploySpent, deployConfigDefaults,
          meleeLoss, attrition, resolveMelee, strikeBase, strikeRange, canStrike, strikeHint,
          strikeCell, katyushaStrike, baseRadar,
          bfsFrom, blocksMove, computeMoveTargets, executeMove, checkWin, hasGround,
          resolveMissiles, endTurn, onNewRound, log, corpsLabel, posStr,
          boardMove, boardSplitPlace, doMerge, doRest, boardStrike, boardFortOp, boardBunker,
          boardThrow, boardMissile, beginMoveMode, startMove, startSplit, confirmSplit,
          startMerge, mergeCandidates, startStrike, startBuild, startDestroy, startDemolish,
          startBunker, startThrow, startMissile, strikeCells, buildCells, fortCells, throwCells,
          cancelMode, afterCommand, visibleFoesAt, death, groundEnemyAt, anyEnemyAt }
  });
}
