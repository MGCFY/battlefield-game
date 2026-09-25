/* ============================================================
   联机消息协议（前后端共享，单一来源）
   所有 WebSocket 消息均为 JSON：{ type, ...payload }
   ============================================================ */
"use strict";

const MSG = {
  /* ---- 客户端 → 服务端 ---- */
  C_CREATE:   "create",      // 创建房间
  C_JOIN:     "join",        // {code, token?, resume?} 加入/重连
  C_DEPLOY:   "deploy",      // {cfg} 提交部署配置
  C_INTENT:   "intent",      // {action, ...params} 行动意图
  C_PING:     "ping",

  /* ---- 服务端 → 客户端 ---- */
  S_ASSIGNED: "assigned",    // {code, side, token}
  S_STATE:    "state",       // 快照（按玩家过滤视野）
  S_REPORTS:  "reports",     // {items:[battle|strike]} 仅发给行动方
  S_ERROR:    "error",       // {msg}
  S_NEEDCONF: "needConfirm", // {why} 需要二次确认（如侦察兵奔袭）
  S_OPP:      "opp",         // {online:boolean} 对手在线状态变化
};

/* 行动意图类型（服务端按此路由，逐一用引擎原函数校验结算） */
const ACT = {
  MOVE:    "move",      // {id, r, c, raid?}
  SPLIT:   "split",     // {id, n, r, c}
  MERGE:   "merge",     // {id, targetId}
  REST:    "rest",      // {id}
  LOAD:    "load",      // {id}  喀秋莎装填
  STRIKE:  "strike",    // {id, r, c}
  BUILD:   "build",     // {id, r, c}
  DESTROY: "destroy",   // {id, r, c}
  DEMOLISH:"demolish",  // {id, r, c}
  BUNKER:  "bunker",    // {id}
  THROW:   "throw",     // {id, kind:"flare"|"smoke", r, c}
  MISSILE: "missile",   // {id, r, c}
  ENDTURN: "endTurn",   // {}
};

function isPlainObj(v){ return v!==null && typeof v==="object" && !Array.isArray(v); }

/* 部署配置的形状校验（数值合法性由服务端用引擎再核一遍） */
function validDeployShape(cfg){
  if(!isPlainObj(cfg)) return false;
  for(const k of Object.keys(cfg)){
    const v = cfg[k];
    if(typeof v!=="number" || !Number.isInteger(v) || v<0 || v>10000) return false;
  }
  return true;
}

/* 意图消息的形状校验 */
function validIntentShape(msg){
  if(!isPlainObj(msg)) return false;
  const need = (cond)=>cond;
  switch(msg.action){
    case ACT.MOVE: case ACT.STRIKE: case ACT.MISSILE: case ACT.BUNKER:
      return need(Number.isInteger(msg.id) && Number.isInteger(msg.r) && Number.isInteger(msg.c));
    case ACT.SPLIT:
      return need(Number.isInteger(msg.id) && Number.isInteger(msg.n) && Number.isInteger(msg.r) && Number.isInteger(msg.c));
    case ACT.MERGE: case ACT.REST: case ACT.LOAD:
      return need(Number.isInteger(msg.id));
    case ACT.BUILD: case ACT.DESTROY: case ACT.DEMOLISH:
      return need(Number.isInteger(msg.id) && Number.isInteger(msg.r) && Number.isInteger(msg.c));
    case ACT.THROW:
      return need(Number.isInteger(msg.id) && Number.isInteger(msg.r) && Number.isInteger(msg.c)
        && (msg.kind==="flare" || msg.kind==="smoke"));
    case ACT.ENDTURN:
      return true;
    default:
      return false;
  }
}

/* 生成 6 位数字房间号（服务端使用；放共享文件便于测试复现） */
function genRoomCode(rand){
  const rnd = rand || Math.random;
  let s="";
  for(let i=0;i<6;i++) s += Math.floor(rnd()*10);
  return s;
}

if (typeof module!=="undefined" && module.exports){
  module.exports = { MSG, ACT, isPlainObj, validDeployShape, validIntentShape, genRoomCode };
}
if (typeof window!=="undefined"){
  window.MSG = MSG; window.ACT = ACT;
}
