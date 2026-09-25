/* ============================================================
   战场沙盘策略游戏 · 联机服务端
   - 每个房间一个独立引擎实例（vm 隔离，引擎与 v3 逐字一致）
   - 服务器权威：客户端只发意图，服务端用同一份引擎重算合法目标
     后调用引擎原函数结算；规则零分叉。
   - 快照按玩家过滤：视野外地形/工事置空，敌方单位只发"幽灵"
     （规模档位 + 休整状态），日志按方裁剪 —— 迷雾不可被 F12 破解。
   ============================================================ */
"use strict";

const http  = require("http");
const fs    = require("fs");
const path  = require("path");
const vm    = require("vm");
const crypto= require("crypto");
const { WebSocketServer } = require("ws");
const { MSG, ACT, isPlainObj, validDeployShape, validIntentShape, genRoomCode } = require("./shared/protocol.js");

const PORT = process.env.PORT ? parseInt(process.env.PORT,10) : 8787;
const ROOT = __dirname;

/* ---------------- 引擎装载（每房间独立上下文） ---------------- */
const ENGINE_SRC = fs.readFileSync(path.join(ROOT, "shared", "engine.js"), "utf8");

function stubEl(){
  return { innerHTML:"", textContent:"", className:"", value:"0", style:{}, dataset:{},
    scrollTop:0, scrollHeight:0, checked:true, disabled:false,
    classList:{ add(){}, remove(){}, contains(){ return false; } },
    addEventListener(){}, focus(){}, querySelectorAll(){ return []; },
    closest(){ return null; }, matches(){ return false; } };
}
function makeDocStub(){
  return { getElementById:()=>stubEl(), addEventListener(){}, querySelectorAll:()=>[],
           querySelector:()=>null, createElement:()=>stubEl(), body:stubEl() };
}
function createEngine(){
  const ctx = vm.createContext({
    document: makeDocStub(), alert(){}, setTimeout:()=>0, console: { log(){}, warn(){}, error(){} },
  });
  vm.runInContext(ENGINE_SRC, ctx, { filename:"engine.js" });
  // 捕获战报弹窗数据（原样转发给行动方客户端渲染，信息面与热座一致）
  vm.runInContext(`
    globalThis.__reports = [];
    showBattleModal = function(segs){ globalThis.__reports.push({ kind:"battle", segs:segs }); };
    showStrikeModal = function(cp,rep,lines,total,vehLost,vehDead){
      globalThis.__reports.push({ kind:"strike", cpId:cp.id, rep:rep, lines:lines, total:total,
                                  vehLost:vehLost, vehDead:vehDead });
    };
  `, ctx);
  let api = null;
  ctx.__ENGINE_EXPORT__ = (a)=>{ api = a; };
  vm.runInContext("__ENGINE_EXPORT__(typeof __ENGINE_EXPORT__!=='undefined'?undefined:undefined)", ctx); // 占位（真钩子在下方）
  return { ctx, api };
}
/* engine.js 的钩子通过 globalThis.__ENGINE_EXPORT__ 注入，上面 ctx 未预置，
   单独再跑一次真正的装载 */
function loadEngine(){
  const ctx = vm.createContext({
    document: makeDocStub(), alert(){}, setTimeout:()=>0, console: { log(){}, warn(){}, error(){} },
  });
  let api = null;
  ctx.__ENGINE_EXPORT__ = (a)=>{ api = a; };
  vm.runInContext(ENGINE_SRC, ctx, { filename:"engine.js" });
  vm.runInContext(`
    globalThis.__reports = [];
    showBattleModal = function(segs){ globalThis.__reports.push({ kind:"battle", segs:segs }); };
    showStrikeModal = function(cp,rep,lines,total,vehLost,vehDead){
      globalThis.__reports.push({ kind:"strike", cpId:cp.id, rep:rep, lines:lines, total:total,
                                  vehLost:vehLost, vehDead:vehDead });
    };
  `, ctx);
  ctx.run = (code)=>vm.runInContext(code, ctx);
  return { ctx, api };
}

/* ---------------- 房间 ---------------- */
const rooms = new Map();          // code -> room
function newRoom(){
  let code;
  do { code = genRoomCode(); } while(rooms.has(code));
  const eng = loadEngine();
  eng.api.fn.newGame();           // 引擎自带部署阶段初始化（地形生成等）
  const room = {
    code, eng,
    players: [null, null],        // {ws, token}
    tokens:  [null, null],
    cfgs:    [null, null],
    lastActive: Date.now(),
  };
  rooms.set(code, room);
  return room;
}
function roomOf(code){ return rooms.get(code) || null; }

/* ---------------- 快照（按玩家过滤） ---------------- */
function cloneCorpsFull(p){
  return { id:p.id, side:p.side, type:p.type, troops:p.troops, r:p.r, c:p.c,
           resting:!!p.resting, fatigue:p.fatigue, alive:true, acc:0, dur:p.dur,
           flare:p.flare, smoke:p.smoke, missile:p.missile, ammo:!!p.ammo };
}
function buildSnapshot(room, side){
  const { api } = room.eng;
  const N = api.N;
  const play = (api.phase === "play");
  const vis  = play ? api.fn.computeVision(side) : null;   // play 阶段才启用迷雾
  const seen = api.seen[side];
  const known = (r,c)=>{ const k=r+","+c; return vis ? (vis.has(k) || !!seen[r][c]) : true; };
  const visNow = (r,c)=>{ return vis ? vis.has(r+","+c) : true; };

  const mask2D = (g, keepFn, blank)=>{
    const out = new Array(N);
    for(let r=0;r<N;r++){ out[r]=new Array(N);
      for(let c=0;c<N;c++) out[r][c] = keepFn(r,c) ? g[r][c] : blank; }
    return out;
  };
  const terrain = mask2D(api.terrain, known, null);
  const bridge  = mask2D(api.bridge,  known, false);
  const fort    = mask2D(api.fort,    visNow, false);
  const bunker  = mask2D(api.bunker,  visNow, 0);
  const bunkerDead = mask2D(api.bunkerDead, visNow, false);

  /* 兵团：己方全量；敌方仅可见者，且只发"幽灵"（规模档位/休整/数量） */
  const visEnemies = new Map();                 // cellKey -> [realUnit]
  const out = [];
  for(const p of api.corps){
    if(!p.alive) continue;
    if(p.side === side){ out.push(cloneCorpsFull(p)); continue; }
    if(!vis || !api.fn.unitVisibleTo(p, side, vis)) continue;
    const k = p.r+","+p.c;
    if(!visEnemies.has(k)) visEnemies.set(k, []);
    visEnemies.get(k).push(p);
  }
  for(const [,list] of visEnemies){
    const size = api.fn.enemySizeClass(list);
    for(const p of list){
      out.push({ ghost:true, type:"ghost", id:p.id, side:p.side, r:p.r, c:p.c, alive:true,
                 resting:!!p.resting, size });
    }
  }

  const logs = api.logEntries.filter(e => e.side==null || e.side===side);

  return {
    type: MSG.S_STATE,
    code: room.code,
    mySide: side,
    phase: api.phase,
    turnSide: api.current,
    turnNo: api.turnNo,
    gameOver: api.gameOver,
    winner: api.winner,
    terrain, bridge, fort, bunker, bunkerDead,
    flare: api.flare, smokeLeft: api.smokeLeft, smokeId: api.smokeId,
    corps: out,
    acted: Array.from(api.acted),
    pendingMissiles: api.pendingMissiles,
    smokeSeq: api.smokeSeq,
    seen,
    logs,
    ready: [!!room.cfgs[0], !!room.cfgs[1]],
    oppOnline: !!room.players[1-side],
  };
}
function sendState(room, side){
  const pl = room.players[side];
  if(!pl || !pl.ws) return;
  try { pl.ws.send(JSON.stringify(buildSnapshot(room, side))); } catch(e){}
}
function broadcastState(room){
  sendState(room, 0); sendState(room, 1);
  room.lastActive = Date.now();
}
function sendTo(room, side, obj){
  const pl = room.players[side];
  if(!pl || !pl.ws) return;
  try { pl.ws.send(JSON.stringify(obj)); } catch(e){}
}

/* ---------------- 意图校验 + 结算（全部复用引擎原函数） ---------------- */
function fail(ws, msg){ try{ ws.send(JSON.stringify({ type:MSG.S_ERROR, msg })); }catch(e){} }
function failSide(room, side, msg){ sendTo(room, side, { type:MSG.S_ERROR, msg }); }

function handleIntent(room, side, msg){
  const { ctx, api } = room.eng;
  const fn = api.fn;
  if(api.phase !== "play" || api.gameOver) return failSide(room, side, "当前不在对局阶段。");
  if(api.current !== side)                  return failSide(room, side, "还没轮到你行动。");

  const base = (id)=>{
    const cp = fn.getCorps(id);
    if(!cp || !cp.alive || cp.side !== side) { failSide(room, side, "兵团不存在或不属于你。"); return null; }
    if(api.acted.has(id))                    { failSide(room, side, "该兵团本回合已行动。"); return null; }
    return cp;
  };
  const startMode = (cp, mode, modeData)=>{
    api.mode = mode; api.modeData = modeData;
  };
  const collectReports = ()=>{
    const items = ctx.run("globalThis.__reports") || [];
    ctx.run("globalThis.__reports = [];");
    if(items.length) sendTo(room, side, { type:MSG.S_REPORTS, items });
  };

  switch(msg.action){

    case ACT.MOVE: {
      const cp = base(msg.id); if(!cp) return;
      if(cp.fatigue>0 && cp.type==="scout") return failSide(room, side, "该侦察兵上回合奔袭3格，本回合不能移动。");
      const vis  = fn.computeVision(side);
      const targets = fn.computeMoveTargets(cp, api.UNITS[cp.type].move, vis);
      const k = msg.r+","+msg.c;
      let path = targets.empties.get(k);
      if(!path && targets.corpsCells.has(k)) path = targets.corpsCells.get(k).path;
      if(!path) return failSide(room, side, "该格不在可移动范围内。");
      if(cp.type==="scout" && path.length>=3 && !msg.raid)
        return sendTo(room, side, { type:MSG.S_NEEDCONF, why:"raid" });
      startMode(cp, "move", { id:cp.id, steps:api.UNITS[cp.type].move, vis,
        empties:targets.empties, corpsCells:targets.corpsCells,
        raidOk:!!msg.raid, raidCell:k });
      fn.boardMove(msg.r, msg.c);
      break;
    }

    case ACT.SPLIT: {
      const cp = base(msg.id); if(!cp) return;
      if(cp.troops < 6) return failSide(room, side, "兵力不足：新军团需≥5且原军团至少保留1。");
      const n = msg.n;
      if(!(n>=5 && n<=cp.troops-1)) return failSide(room, side, `分出兵力须在 5 ~ ${cp.troops-1} 之间。`);
      const vis = fn.computeVision(side), u = api.UNITS[cp.type], spots = new Set();
      const okCell = (r,c)=> u.air ? fn.airStationable(r,c) : fn.stationable(r,c);
      for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
        if(!dr && !dc) continue;
        const nr=cp.r+dr, nc=cp.c+dc;
        if(okCell(nr,nc) && !fn.blocksMove(nr,nc,cp.side,vis)) spots.add(nr+","+nc);
      }
      if(!spots.has(msg.r+","+msg.c)) return failSide(room, side, "该格不可放置新军团。");
      startMode(cp, "split-place", { id:cp.id, n, spots });
      fn.boardSplitPlace(msg.r, msg.c);
      break;
    }

    case ACT.MERGE: {
      const cp = base(msg.id); if(!cp) return;
      const cands = fn.mergeCandidates(cp).map(o=>o.id);
      if(!cands.includes(msg.targetId)) return failSide(room, side, "目标不是相邻同兵种友军。");
      startMode(cp, "merge", { id:cp.id, cands:[msg.targetId] });
      fn.doMerge(0);
      break;
    }

    case ACT.REST: {
      const cp = base(msg.id); if(!cp) return;
      if(!api.UNITS[cp.type].canRest) return failSide(room, side, "该兵种没有休整状态。");
      fn.doRest(cp);
      break;
    }

    case ACT.LOAD: {
      const cp = base(msg.id); if(!cp) return;
      if(cp.type!=="katyusha") return failSide(room, side, "只有喀秋莎需要装填弹药。");
      cp.ammo = true;
      fn.log(`${api.SIDE_NAME[side]}${fn.typeName(cp.type)}#${cp.id} 完成弹药装填，可随时发动打击。`, side===0?"red":"blue");
      api.acted.add(cp.id);
      api.mode="idle"; api.modeData={};
      fn.afterCommand();
      break;
    }

    case ACT.STRIKE: {
      const cp = base(msg.id); if(!cp) return;
      if(!fn.canStrike(cp)) return failSide(room, side, fn.strikeHint(cp) || "当前无法打击。");
      const cells = fn.strikeCells(cp);
      if(!cells.size) return failSide(room, side, "射程内没有可打击的格子。");
      if(!cells.has(msg.r+","+msg.c)) return failSide(room, side, "目标超出射程。");
      startMode(cp, "strike", { id:cp.id, cells });
      fn.boardStrike(msg.r, msg.c);
      break;
    }

    case ACT.BUILD: case ACT.DESTROY: case ACT.DEMOLISH: {
      const cp = base(msg.id); if(!cp) return;
      if(msg.action===ACT.BUILD){
        if(cp.type!=="inf")  return failSide(room, side, "只有步兵能修筑工事。");
        if(!cp.resting)      return failSide(room, side, "步兵必须休整才能修筑工事。");
        const cells = fn.buildCells(cp);
        if(!cells.has(msg.r+","+msg.c)) return failSide(room, side, "只能修筑在相邻可驻扎空格。");
        startMode(cp, "build", { id:cp.id, cells });
      } else if(msg.action===ACT.DESTROY){
        if(cp.type!=="inf")  return failSide(room, side, "只有步兵能摧毁工事。");
        if(!cp.resting)      return failSide(room, side, "步兵必须休整才能摧毁工事。");
        const cells = fn.fortCells(cp);
        if(!cells.has(msg.r+","+msg.c)) return failSide(room, side, "该格没有防御工事。");
        startMode(cp, "destroy", { id:cp.id, cells });
      } else {
        if(cp.type!=="cav")  return failSide(room, side, "只有骑兵能拆毁工事。");
        const cells = fn.fortCells(cp);
        if(!cells.has(msg.r+","+msg.c)) return failSide(room, side, "该格没有可拆毁的工事。");
        startMode(cp, "demolish", { id:cp.id, cells });
      }
      fn.boardFortOp(msg.r, msg.c);
      break;
    }

    case ACT.BUNKER: {
      const cp = base(msg.id); if(!cp) return;
      if(cp.type!=="inf")       return failSide(room, side, "只有步兵能修筑防空地堡。");
      if(!cp.resting)           return failSide(room, side, "步兵必须休整才能修筑防空地堡。");
      if(api.bunker[cp.r][cp.c]>0)   return failSide(room, side, "本格已有防空地堡。");
      if(api.bunkerDead[cp.r][cp.c]) return failSide(room, side, "本格地堡已失效，无法再建。");
      startMode(cp, "bunker", { id:cp.id });
      fn.boardBunker(cp.r, cp.c);
      break;
    }

    case ACT.THROW: {
      const cp = base(msg.id); if(!cp) return;
      if(!api.UNITS[cp.type].throwable) return failSide(room, side, "该兵种没有投掷物。");
      if(msg.kind==="flare" && cp.flare<=0) return failSide(room, side, "照明弹已用尽（需回大本营补给）。");
      if(msg.kind==="smoke" && cp.smoke<=0) return failSide(room, side, "烟雾弹已用尽（需回大本营补给）。");
      const cells = fn.throwCells(cp);
      if(!cells.has(msg.r+","+msg.c)) return failSide(room, side, "目标不在视野范围内。");
      startMode(cp, msg.kind, { id:cp.id, cells });
      fn.boardThrow(msg.r, msg.c);
      break;
    }

    case ACT.MISSILE: {
      const cp = base(msg.id); if(!cp) return;
      if(cp.type!=="bomber")  return failSide(room, side, "只有轰炸机能发射导弹。");
      if(cp.missile<=0)       return failSide(room, side, "导弹已用尽（需回大本营补给）。");
      const vr = fn.visionRange(cp), cells = new Set();
      for(let r=0;r<api.N;r++)for(let c=0;c<api.N;c++)
        if(fn.manh({r,c},cp)<=vr) cells.add(r+","+c);
      if(!cells.has(msg.r+","+msg.c)) return failSide(room, side, "目标超出射程。");
      startMode(cp, "missile", { id:cp.id, cells });
      fn.boardMissile(msg.r, msg.c);
      break;
    }

    case ACT.ENDTURN: {
      fn.endTurn();
      break;
    }

    default:
      return failSide(room, side, "未知指令。");
  }
  collectReports();
  broadcastState(room);

  function sideName(s){ return api.SIDE_NAME[s]; }
}

/* ---------------- 部署 ---------------- */
function handleDeploy(room, side, cfg){
  const { api } = room.eng;
  if(api.phase !== "deploy") return sendTo(room, side, { type:MSG.S_ERROR, msg:"部署阶段已结束。"});
  if(room.cfgs[side])        return sendTo(room, side, { type:MSG.S_ERROR, msg:"你已提交过部署。"});
  if(!validDeployShape(cfg)) return sendTo(room, side, { type:MSG.S_ERROR, msg:"部署配置格式错误。"});
  const spent = api.fn.deploySpent(cfg);
  if(spent > api.BUDGET)     return sendTo(room, side, { type:MSG.S_ERROR, msg:"积分超出预算。"});
  let ground = 0;
  for(const t of api.DEPLOY_TYPES) if((cfg[t]||0) > 0 && !api.UNITS[t].air) ground += cfg[t];
  if(!ground)                return sendTo(room, side, { type:MSG.S_ERROR, msg:"必须至少采购 1 支地面兵团。"});
  room.cfgs[side] = cfg;
  if(room.cfgs[0] && room.cfgs[1]){
    api.fn.spawnFromConfig(0, room.cfgs[0]);
    api.fn.spawnFromConfig(1, room.cfgs[1]);
    api.phase = "play";              // v3 中该赋值发生在热座 confirmDeploy 内，服务端需自行置位
    api.fn.startPlay();
  } else {
    api.fn.log(`${api.SIDE_NAME[side]} 已完成部署，等待对方…`, side===0?"red":"blue");
  }
  broadcastState(room);
}

/* ---------------- 连接管理 ---------------- */
function attach(ws){
  ws.roomCode = null; ws.side = null;
  ws.on("message", (raw)=>{
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e){ return; }
    if(!isPlainObj(msg)) return;
    const room = ws.roomCode ? roomOf(ws.roomCode) : null;

    switch(msg.type){

      case MSG.C_CREATE: {
        if(room) return fail(ws, "你已在房间中。");
        const r = newRoom();
        bindPlayer(r, 0, ws);
        break;
      }

      case MSG.C_JOIN: {
        if(room) return fail(ws, "你已在房间中。");
        const code = String(msg.code||"").trim();
        const r = roomOf(code);
        const sendErr = (m)=>{ try{ ws.send(JSON.stringify({ type:MSG.S_ERROR, msg:m })); }catch(e){} };
        if(!r)  return sendErr("房间不存在，请核对房间号。");
        // 重连：token 匹配则回收原席位
        if(msg.token && r.tokens[0]===msg.token){ bindPlayer(r, 0, ws, true); return; }
        if(msg.token && r.tokens[1]===msg.token){ bindPlayer(r, 1, ws, true); return; }
        const free = r.players[0] ? (r.players[1] ? -1 : 1) : 0;
        if(free < 0) return sendErr("房间已满员（2 人）。");
        bindPlayer(r, free, ws);
        break;
      }

      case MSG.C_DEPLOY: {
        if(!room || ws.side==null) return fail(ws, "请先加入房间。");
        handleDeploy(room, ws.side, msg.cfg);
        break;
      }

      case MSG.C_INTENT: {
        if(!room || ws.side==null) return fail(ws, "请先加入房间。");
        if(!validIntentShape(msg)) return fail(ws, "指令格式错误。");
        handleIntent(room, ws.side, msg);
        break;
      }

      case MSG.C_PING:
        try { ws.send(JSON.stringify({ type:"pong" })); } catch(e){}
        break;
    }
  });
  ws.on("close", ()=>{
    if(!ws.roomCode) return;
    const room = roomOf(ws.roomCode);
    if(!room) return;
    const side = ws.side;
    if(room.players[side] && room.players[side].ws === ws){
      room.players[side] = null;
      const other = room.players[1-side];
      if(other && other.ws){
        try { other.ws.send(JSON.stringify({ type:MSG.S_OPP, online:false })); } catch(e){}
        room.eng.api.fn.log(`${room.eng.api.SIDE_NAME[side]} 掉线，等待重连…`, "warn", side);
        sendState(room, 1-side);
      }
    }
  });
}
function bindPlayer(room, side, ws, resume){
  if(!room.tokens[side]) room.tokens[side] = crypto.randomBytes(12).toString("hex");
  room.players[side] = { ws, token:room.tokens[side] };
  ws.roomCode = room.code; ws.side = side;
  sendTo(room, side, { type:MSG.S_ASSIGNED, code:room.code, side, token:room.tokens[side] });
  if(resume){
    room.eng.api.fn.log(`${room.eng.api.SIDE_NAME[side]} 重新连接。`, side===0?"red":"blue", side);
  }
  sendState(room, side);
  const opp = room.players[1-side];
  if(opp && opp.ws){
    try { opp.ws.send(JSON.stringify({ type:MSG.S_OPP, online:true })); } catch(e){}
    sendState(room, 1-side);
  }
}

/* ---------------- 静态文件 ---------------- */
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
               ".css":"text/css; charset=utf-8", ".png":"image/png", ".json":"application/json" };
const server = http.createServer((req, res)=>{
  const url = (req.url||"/").split("?")[0];
  let file = null;
  if(url==="/" || url==="/index.html") file = path.join(ROOT, "client", "index.html");
  else if(url==="/engine.js")     file = path.join(ROOT, "shared", "engine.js");
  else if(url==="/protocol.js")   file = path.join(ROOT, "shared", "protocol.js");
  else if(url==="/net.js")        file = path.join(ROOT, "client", "net.js");
  else if(url==="/online-main.js")file = path.join(ROOT, "client", "online-main.js");
  else if(url==="/favicon.ico")   { res.writeHead(204); return res.end(); }
  if(!file || !fs.existsSync(file)){ res.writeHead(404); return res.end("Not Found"); }
  const ext = path.extname(file);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server });
wss.on("connection", attach);

/* 房间清理：双方都离线 10 分钟后销毁 */
setInterval(()=>{
  const now = Date.now();
  for(const [code, room] of rooms){
    const anyOnline = room.players.some(p=>p && p.ws);
    if(!anyOnline && now - room.lastActive > 10*60*1000){
      rooms.delete(code);
    }
  }
}, 60*1000);

server.listen(PORT, ()=>{
  console.log(`[battlefield-online] 已启动: http://localhost:${PORT}`);
});
