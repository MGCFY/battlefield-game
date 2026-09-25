/* ============================================================
   online-main.js —— 联机客户端主模块
   原则：
   - 规则引擎（engine.js）原样复用，渲染层做"己方视角"适配
   - 客户端只发"意图"，一切状态以服务端快照为准（服务器权威）
   - 本地引擎仅用于：交互预览（高亮合法目标）+ 读取己方信息
   ============================================================ */
"use strict";
(function(){

/* ---------------- 客户端会话状态 ---------------- */
let mySide = null;        // 0 红 / 1 蓝
let roomCode = null;
let turnSide = 0;         // 当前行动方（服务端快照提供）
let oppOnline = false;
let myDeployed = false;
let deployShown = false;
let connOpen = false;
let hasState = false;

const $ = (id)=>document.getElementById(id);

/* 幽灵兵种占位：服务端下发的可见敌方单位只带规模档位（脱敏），
   注册到 UNITS 让引擎遍历（寻路阻挡/攻击高亮等）不崩溃；
   其规模显示走 ghosts 自带的 size 字段（见 enemySizeClass 覆盖）。 */
UNITS.ghost = { ch:"敌", name:"敌方兵团", cost:0, move:0, vision:0,
                melee:0, air:0, veh:0, ranged:0, canRest:0 };

/* ============================================================
   大厅
   ============================================================ */
function showTip(msg, err){
  const t = $("lobbyTip");
  if(!t) return;
  t.textContent = msg;
  t.className = "lobby-tip" + (err?" err":"");
}
function enterGame(){
  $("lobbyWrap").classList.add("hidden");
  $("roomBar").style.display = "flex";
  $("rbCode").textContent = roomCode;
  $("rbRole").textContent = mySide===0 ? "你执红方（先行）" : "你执蓝方";
  updateOppBar();
}
function updateOppBar(){
  const dot = $("rbOppDot"), txt = $("rbOppText");
  if(!dot) return;
  dot.className = "dot" + (oppOnline?" on":"");
  txt.textContent = oppOnline ? "对手在线" : "对手未连接 / 掉线";
}
function bindLobby(){
  $("btnCreate").addEventListener("click", ()=>{
    if(!connOpen) return showTip("尚未连接服务器", true);
    Net.send({ type:MSG.C_CREATE });
  });
  $("btnJoin").addEventListener("click", ()=>{
    if(!connOpen) return showTip("尚未连接服务器", true);
    const code = $("joinCode").value.trim();
    if(!/^\d{6}$/.test(code)) return showTip("请输入 6 位数字房间号", true);
    Net.send({ type:MSG.C_JOIN, code });
  });
  $("joinCode").addEventListener("keydown", e=>{ if(e.key==="Enter") $("btnJoin").click(); });
}

/* ============================================================
   网络事件
   ============================================================ */
Net.on("_open", ()=>{
  connOpen = true;
  if(!roomCode){
    const s = Net.session();
    if(s && s.code){
      // 页面刷新后的自动重连
      Net.send({ type:MSG.C_JOIN, code:s.code, token:s.token, resume:true });
    }
  }
  showTip("已连接服务器");
});
Net.on("_close", ()=>{
  connOpen = false;
  if(!roomCode) showTip("连接断开，正在重连…", true);
});
Net.on("_resume", (s)=>{
  Net.send({ type:MSG.C_JOIN, code:s.code, token:s.token, resume:true });
});
Net.on(MSG.S_ASSIGNED, (m)=>{
  roomCode = m.code; mySide = m.side; oppOnline = false;
  Net.saveSession({ code:m.code, side:m.side, token:m.token });
  // 初始化本地部署界面（引擎全局）
  phase = "deploy";
  deploySide = mySide;
  deployCfg = deployConfigDefaults();
  myDeployed = false; deployShown = false; hasState = false;
  renderViewBtn(); hideViewBtn();
  enterGame();
  renderDeploy();
});
Net.on(MSG.S_ERROR, (m)=>{
  if(!roomCode) showTip(m.msg || "错误", true);
  else log("⚠ " + (m.msg||"指令被拒绝"), "warn", mySide);
});
Net.on(MSG.S_NEEDCONF, (m)=>{
  log("⚠ 服务端要求确认：" + (m.why==="raid"?"侦察兵奔袭需再次点击目标。":"请再次执行。"), "warn", mySide);
});
Net.on(MSG.S_OPP, (m)=>{
  oppOnline = !!m.online;
  updateOppBar();
});
Net.on(MSG.S_REPORTS, (m)=>{
  for(const it of (m.items||[])){
    if(it.kind==="battle") showBattleModal(it.segs);
    else if(it.kind==="strike"){
      const cp = getCorps(it.cpId);
      showStrikeModal(cp, it.rep, it.lines, it.total, it.vehLost, it.vehDead);
    }
  }
});
Net.on(MSG.S_STATE, loadSnapshot);

/* ============================================================
   快照加载 —— 一切状态的唯一来源
   ============================================================ */
function loadSnapshot(s){
  const firstPlay = (phase!=="play" && s.phase==="play");
  mySide = s.mySide;
  roomCode = s.code || roomCode;
  oppOnline = !!s.oppOnline;
  turnSide = s.turnSide;

  terrain = s.terrain;  bridge = s.bridge;
  fort = s.fort;        bunker = s.bunker; bunkerDead = s.bunkerDead;
  flare = s.flare;      smokeLeft = s.smokeLeft; smokeId = s.smokeId;
  corps = s.corps;
  nextId = s.nextId;    smokeSeq = s.smokeSeq;
  pendingMissiles = s.pendingMissiles;
  turnNo = s.turnNo;
  gameOver = s.gameOver; winner = s.winner;
  phase = s.phase;                    // 阶段也是服务端状态的一部分（部署/对局/结束）
  current = s.turnSide;               // 引擎内"当前行动方"，联机下等于真实回合方
  viewMode = "auto";
  acted.clear();
  for(const id of (s.acted||[])) acted.add(id);

  seen = [grid(false), grid(false)];
  seen[mySide] = s.seen;

  logEntries.length = 0;
  for(const e of (s.logs||[])) logEntries.push(e);

  /* 保留仍有效的选中，否则清空 */
  if(selId!=null){
    const cp = getCorps(selId);
    if(!cp || !cp.alive || cp.side!==mySide){ selId=null; }
  }
  mode = "idle"; modeData = {};

  if(s.phase==="deploy"){
    if(!myDeployed){
      if(!deployShown){ deployShown = true; renderDeploy(); }
    } else {
      renderDeployWaiting(s);
    }
    render();
    return;
  }

  if(s.phase==="play"){
    $("deployWrap").classList.add("hidden");
    hasState = true;
    if(firstPlay){
      logEntries.length = 0;
      for(const e of (s.logs||[])) logEntries.push(e);
      renderViewBtn();
    }
    render();
    if(s.gameOver && !victoryShown){ victoryShown = true; showVictory(); }
    return;
  }
}

/* 部署等待界面 */
function renderDeployWaiting(s){
  const wrap=$("deployWrap"), card=$("deployCard");
  if(!wrap || !card) return;
  wrap.classList.remove("hidden");
  const done = s.ready ? s.ready : [myDeployed, false];
  card.innerHTML = `<div class="handoff">
    <div class="icon">⏳</div>
    <h2>已提交部署</h2>
    <div class="deploy-sub">你的部署已锁定。<br>${done[0]?"✔":"…"} 红方　${done[1]?"✔":"…"} 蓝方<br>等待对方完成部署后开战。</div>
  </div>`;
}

/* ============================================================
   意图发送 —— 覆盖引擎的"执行层"函数
   （预览/高亮仍用本地引擎；真正结算只听服务端）
   ============================================================ */
function sendIntent(obj){
  Net.send(Object.assign({ type:MSG.C_INTENT }, obj));
}

/* 移动：保留本地路径确认（含侦察兵奔袭二次确认），确认后发意图 */
boardMove = function(r,c){
  const cp = getCorps(modeData.id);
  if(!cp){ cancelMode(); return; }
  const k = key(r,c);
  let path = null;
  if(modeData.empties && modeData.empties.has(k)) path = modeData.empties.get(k);
  else if(modeData.corpsCells && modeData.corpsCells.has(k)) path = modeData.corpsCells.get(k).path;
  if(!path) return;
  if(cp.type==="scout" && path.length>=3 && (!modeData.raidOk || modeData.raidCell!==k)){
    modeData.raidOk = true; modeData.raidCell = k;
    log("⚠ 侦察兵奔袭3格：下个回合将无法移动。请再点一次目标 / 再按 Enter 确认。", mySide===0?"red":"blue");
    render(); return;
  }
  sendIntent({ action:ACT.MOVE, id:modeData.id, r, c, raid:!!modeData.raidOk });
  mode="idle"; modeData={}; render();
};

boardSplitPlace = function(r,c){
  if(!modeData.spots || !modeData.spots.has(key(r,c))) return;
  const n = modeData.n;
  sendIntent({ action:ACT.SPLIT, id:modeData.id, n, r, c });
  mode="idle"; modeData={}; render();
};

doMerge = function(idx){
  const targetId = modeData.cands ? modeData.cands[idx] : null;
  if(targetId==null) return cancelMode();
  sendIntent({ action:ACT.MERGE, id:modeData.id, targetId });
  mode="idle"; modeData={}; render();
};

doRest = function(cp){
  if(!cp) return;
  sendIntent({ action:ACT.REST, id:cp.id });
  mode="idle"; modeData={}; render();
};

boardStrike = function(r,c){
  if(!modeData.cells || !modeData.cells.has(key(r,c))) return;
  sendIntent({ action:ACT.STRIKE, id:modeData.id, r, c });
  mode="idle"; modeData={}; render();
};

boardFortOp = function(r,c){
  if(!modeData.cells || !modeData.cells.has(key(r,c))) return;
  const act = mode==="build" ? ACT.BUILD : mode==="destroy" ? ACT.DESTROY : ACT.DEMOLISH;
  sendIntent({ action:act, id:modeData.id, r, c });
  mode="idle"; modeData={}; render();
};

boardBunker = function(r,c){
  const cp = getCorps(modeData.id);
  if(!cp) return cancelMode();
  if(cp.r!==r || cp.c!==c) return;
  sendIntent({ action:ACT.BUNKER, id:cp.id });
  mode="idle"; modeData={}; render();
};

boardThrow = function(r,c){
  if(!modeData.cells || !modeData.cells.has(key(r,c))) return;
  sendIntent({ action:ACT.THROW, id:modeData.id, kind:mode, r, c });
  mode="idle"; modeData={}; render();
};

boardMissile = function(r,c){
  if(!modeData.cells || !modeData.cells.has(key(r,c))) return;
  sendIntent({ action:ACT.MISSILE, id:modeData.id, r, c });
  mode="idle"; modeData={}; render();
};

endTurn = function(){
  if(phase!=="play" || gameOver || turnSide!==mySide) return;
  sendIntent({ action:ACT.ENDTURN });
};

/* 部署确认：本地校验同规则，通过后交服务端复核 */
confirmDeploy = function(){
  readDeployInputs();
  const left = BUDGET - deploySpent(deployCfg);
  if(left < 0){ alert("积分超出预算！请减少采购。"); return; }
  let ground = 0;
  for(const t of DEPLOY_TYPES) if((deployCfg[t]||0) > 0 && !UNITS[t].air) ground += deployCfg[t];
  if(!ground){ alert("必须至少采购 1 支地面兵团。"); return; }
  myDeployed = true;
  Net.send({ type:MSG.C_DEPLOY, cfg:deployCfg });
  renderDeployWaiting({ ready:[mySide===0, mySide===1] });
};

/* 再来一局：回大厅 */
newGame = function(){ Net.leave(); location.reload(); };

/* ============================================================
   视角适配 —— 联机下固定己方视角（迷雾/信息都以 mySide 计算）
   ============================================================ */
function hideViewBtn(){ const b=$("viewBtn"); if(b) b.style.display="none"; }

viewLocked = function(){
  if(phase!=="play") return false;
  return turnSide !== mySide;          // 对方回合：锁操作
};
cycleViewMode = function(){ /* 联机版禁用视角切换 */ };

/* 幽灵单位（服务端下发的可见敌人）始终视为可见 */
const _unitVisibleTo = unitVisibleTo;
unitVisibleTo = function(u, side, vis){
  if(u.ghost) return true;
  return _unitVisibleTo(u, side, vis);
};
/* 幽灵单位的规模档位由服务端按真实兵力计算 */
const _enemySizeClass = enemySizeClass;
enemySizeClass = function(stack){
  if(stack.length && stack[0].ghost) return stack[0].size;
  return _enemySizeClass(stack);
};

/* 日志：始终显示 己方 + 公开 */
renderLog = function(){
  const el=document.getElementById("log");
  if(!el) return;
  const rows=logEntries.filter(e=>e.side==null || e.side===mySide);
  el.innerHTML=rows.map(e=>`<div class="entry ${e.cls}">${e.msg}</div>`).join("");
  el.scrollTop=el.scrollHeight;
};

/* ---------- 棋盘渲染（改自引擎 renderBoard：current→mySide，敌人走幽灵） ---------- */
renderBoard = function(){
  const godView = false;
  const effSide = mySide;
  const noFog = (phase!=="play");
  const vis = phase==="play" ? computeVision(mySide) : null;
  if(!noFog && vis) markSeen(mySide, vis);
  const misSet=new Map();
  for(const m of pendingMissiles){
    const [br,bc]=BASES[1-m.side];
    if(mySide===m.side || Math.abs(m.r-br)+Math.abs(m.c-bc)<=5)
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
      const ev = seen[mySide][r][c];
      const dim = !v && memoryFog && ev;
      let cls="cell";
      if(v || dim) cls += " t-"+terrain[r][c] + (bridge[r][c]?" bridge":"");
      if(dim) cls += " fog-mem";
      if(!v && !dim) cls += " fog-unknown";
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
      if(mode==="bunker" && modeData.id!=null){ const sp=getCorps(modeData.id); if(sp&&sp.r===r&&sp.c===c) cls+=" hl-build"; }
      const sp0 = selId!=null ? getCorps(selId) : null;
      if(mode==="idle" && sp0 && sp0.alive){
        const vv=visionRange(sp0);
        if(Math.abs(sp0.r-r)+Math.abs(sp0.c-c)<=vv) cls+=" hl-vision";
      }
      if(sp0 && sp0.alive && sp0.r===r && sp0.c===c) cls+=" selected";
      if(phase==="play" && r===cur.r && c===cur.c) cls+=" cursor";

      let title=`(${r+1},${c+1})`;
      if(v && terrain[r][c]) title+=" "+T_NAME[terrain[r][c]]+(bridge[r][c]?" · 桥":"");
      else title+=" 未探明";
      if(v && fort[r][c]) title+=" · 有防御工事";
      if(v && bunker[r][c]>0) title+=` · 防空地堡(耐久${bunker[r][c]}/3)`;
      if(v && bunkerDead[r][c] && bunker[r][c]<=0) title+=" · 地堡废墟(不可再建)";

      let inner="";
      if(inFlare(r,c)) inner+=`<span class="fx fx-flare"></span>`;
      if(smokeLeft[r][c]>0) inner+=`<span class="fx fx-smoke"></span>`;
      if(isBase(r,c)) inner+=`<span class="base-tag">营</span>`;
      if(v && fort[r][c]) inner+=`<span class="fort-tag">#</span>`;
      if(v && bunker[r][c]>0) inner+=`<span class="bunk-tag">堡</span>`;

      const stack = corps.filter(p=>p.alive && p.r===r && p.c===c);
      const own = stack.filter(p=>p.side===mySide);
      const foes = stack.filter(p=>p.side!==mySide);
      if(own.length){
        let show=own[0];
        if(sp0 && sp0.alive && sp0.side===mySide && sp0.r===r && sp0.c===c && own.includes(sp0)) show=sp0;
        const st=[];
        if(show.resting) st.push("休整中");
        if(show.fatigue>0) st.push("下回合不能移动");
        if(U(show).air) st.push("空中单位");
        if(U(show).dur) st.push("耐久"+show.dur+"/3");
        if(show.type==="katyusha") st.push(show.ammo?"已装填":"未装填");
        if(U(show).throwable) st.push(`照明${show.flare}/烟雾${show.smoke}`);
        if(U(show).missile) st.push(`导弹${show.missile}`);
        title+=` · 我方 ${typeName(show.type)}#${show.id} x${show.troops}${st.length?" · "+st.join("/"):""}`;
        if(own.length>1) title+=`（本格共 ${own.length} 支我方兵团）`;
        inner+=`<span class="corps ${show.side===0?"red":"blue"}${U(show).air?" air":""}${acted.has(show.id)?" acted":""}">${U(show).ch}</span>`;
        if(own.length>1) inner+=`<span class="stack">×${own.length}</span>`;
        if(show.resting) inner+=`<span class="dot rest"></span>`;
        if(show.fatigue>0) inner+=`<span class="dot fat"></span>`;
        if(U(show).dur) inner+=`<span class="dot dur">${show.dur}</span>`;
      } else if(foes.length){
        const size=foes[0].size || enemySizeClass(foes);
        const anyRest=foes.some(p=>p.resting);
        title+=` · 敌方兵团（规模：${size}）${anyRest?" · 正在休整":""}`;
        inner+=`<span class="enemy-chip ${foes[0].side===0?"red":"blue"} ${size==="大"?"sz-l":size==="中"?"sz-m":"sz-s"}">${size}</span>`;
        if(foes.length>1) inner+=`<span class="stack">×${foes.length}</span>`;
        if(anyRest) inner+=`<span class="dot rest"></span>`;
      }
      if(v && (mode==="move"||mode==="move-choose") && modeData.corpsCells && modeData.corpsCells.has(k)){
        const mc=modeData.corpsCells.get(k);
        const mover=getCorps(modeData.id);
        if(mover && mc.type==="attack" && !U(mover).melee){
          cls+=" hl-attack";
          title+=" ⚠ 突入即被全歼（"+typeName(mover.type)+"无近战能力）";
        }
      }
      if(misSet.has(k)) inner+=`<span class="missile-mark">⊕</span>`;
      html+=`<div class="${cls}" data-cell="${r},${c}" title="${title}">${inner}</div>`;
    }
  }
  document.getElementById("board").innerHTML=html;
};

/* ---------- 面板渲染（改自引擎 renderPanel：turnSide 驱动回合信息） ---------- */
renderPanel = function(){
  const chip=document.getElementById("turnChip");
  const myTurn = turnSide===mySide;
  chip.textContent = myTurn ? "你的回合" : (SIDE_NAME[turnSide]+"行动中…");
  chip.className="turn-chip "+(turnSide===0?"red":"blue");
  const aliveOwn=corps.filter(p=>p.alive&&p.side===mySide).length;
  document.getElementById("turnRound").textContent =
    `第 ${turnNo} 回合 · 第 ${dayNo()} 天 · ` +
    (myTurn ? `已行动 ${acted.size}/${aliveOwn}` : `对方回合（你 ${aliveOwn} 支兵团）`);
  const dc=document.getElementById("dayChip");
  dc.textContent = isDay() ? "☀ 白天" : "🌙 夜晚";
  dc.className = "day-chip "+(isDay()?"day":"night");

  const thCard=document.getElementById("threatCard");
  const th=document.getElementById("threatText");
  let threat=false;
  for(const e of corps){
    if(!e.alive||e.side===mySide||!U(e).air) continue;
    for(const p of corps){
      if(!p.alive||p.side!==mySide) continue;
      if(manh(e,p)<=3){ threat=true; break; }
    }
    if(threat) break;
  }
  if(threat){
    thCard.style.display="block";
    th.textContent="⚠ 空中威胁：侦测到敌方空中单位活动（距我方某兵团 ≤3 格），但无法定位与攻击。";
  } else thCard.style.display="none";

  const info=document.getElementById("selInfo"), cmdArea=document.getElementById("cmdArea");
  const cp = selId!=null ? getCorps(selId) : null;
  if(!cp||!cp.alive){
    info.textContent = myTurn ? "点击棋盘上的己方军团进行指挥。" : "对方行动中，请稍候…";
    cmdArea.innerHTML="";
  } else {
    const u=U(cp);
    const own = cp.side===mySide;
    const canCmd = own && myTurn && !acted.has(cp.id) && !gameOver && mode==="idle";
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
        gameOver?"游戏已结束": !own?"对方兵团（仅可查看规模)": !myTurn?"对方行动中…":
        acted.has(cp.id)?"该军团本回合已行动。":"请先结束当前操作"}</span>`;
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
      html+=`<button class="btn small" data-action="end-turn" style="margin-top:6px">结束回合</button>`;
      cmdArea.innerHTML=html;
    }
  }

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

  const list=document.getElementById("corpsList");
  let lhtml="";
  const mine=corps.filter(p=>p.alive&&p.side===mySide);
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

  const vis=computeVision(mySide);
  const eCard=document.getElementById("enemyCard"), eList=document.getElementById("enemyList");
  const groups=new Map();
  for(const p of corps){
    if(!p.alive||p.side===mySide) continue;
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
      const size=arr[0].size || enemySizeClass(arr);
      e+=`<div class="corps-row" style="cursor:default">
        <span class="mini red">${SIDE_NAME[arr[0].side][0]}</span>
        <span>规模 <b>${size}</b> @ (${r+1},${c+1})</span>
        <span style="margin-left:auto">${arr.some(p=>p.resting)?'<span class="badge rest">休整</span>':''}${arr.length>1?`×${arr.length}`:""}</span></div>`;
    }
    eList.innerHTML=e;
  }
};

/* ---------------- 启动 ---------------- */
bindLobby();
Net.connect();

})();
