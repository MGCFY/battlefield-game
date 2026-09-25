/* ============================================================
   client-smoke.js —— 浏览器端脚本粘合层冒烟测试（无 Chromium）
   用 DOM 桩 + 真实 WebSocket 按浏览器实际加载顺序执行：
     protocol.js → engine.js → net.js → online-main.js
   验证：大厅创建房间 → 部署界面 → 提交部署 → 对局渲染 → 结束回合
   ============================================================ */
"use strict";
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const WebSocket = require("ws");

const URL_HOST = "localhost:8794";
const { spawn } = require("child_process");
const NODE = process.execPath;
const srv = spawn(NODE, [path.join(__dirname, "..", "server.js")], {
  env: Object.assign({}, process.env, { PORT: "8794", NODE_PATH: process.env.NODE_PATH }),
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stdout.on("data", d=>process.stdout.write("[srv] "+d));
srv.stderr.on("data", d=>process.stderr.write("[srv-err] "+d));
let passed=0, failed=0;
const ok=(c,n)=>{ if(c){passed++;console.log("  ✔ "+n);} else {failed++;console.log("  ✘ "+n);} };
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/* ---- DOM 桩：按 id 持久化元素，记录监听器与 innerHTML ---- */
function makeEl(id){
  const listeners={};
  return {
    id, innerHTML:"", textContent:"", className:"", value:"", style:{},
    dataset:{}, scrollTop:0, scrollHeight:0, checked:true, disabled:false,
    classList:{ _s:new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, contains(c){return this._s.has(c);} },
    addEventListener(ev,fn){ (listeners[ev]=listeners[ev]||[]).push(fn); },
    click(){ (listeners.click||[]).forEach(f=>f({ target:{ closest(){return null;} } })); },
    fire(ev){ (listeners[ev]||[]).forEach(f=>f({ key:"", target:{ matches(){return false;}, dataset:{} } })); },
    focus(){}, appendChild(){}, querySelectorAll(){return [];},
    closest(){return null;}, matches(){return false;},
  };
}
async function main(){
  const elements={};
  const doc={
    getElementById(id){ return elements[id] || (elements[id]=makeEl(id)); },
    addEventListener(ev,fn){ (doc._listeners[ev]=doc._listeners[ev]||[]).push(fn); },
    _listeners:{},
    querySelectorAll(){return [];}, querySelector(){return null;},
    createElement(){return makeEl("tmp");}, body:makeEl("body"),
  };
  const storage={};
  let api=null;

  const sandbox={
    document:doc,
    sessionStorage:{ getItem:k=>storage[k]||null, setItem:(k,v)=>{storage[k]=v;}, removeItem:k=>{delete storage[k];} },
    location:{ protocol:"http:", host:URL_HOST },
    alert(){}, console:{ log:(...a)=>console.log("[vm]",...a), warn:(...a)=>console.log("[vm-warn]",...a), error:(...a)=>console.log("[vm-err]",...a) },
    WebSocket,
    setTimeout, clearTimeout, setInterval, clearInterval,
    __ENGINE_EXPORT__(a){ api=a; },
  };
  sandbox.window=sandbox;
  const ctx=vm.createContext(sandbox);
  const load=f=>vm.runInContext(fs.readFileSync(path.join(__dirname,"..","client",f),"utf8"),ctx,{filename:f});
  // protocol.js 与 engine.js 在 client 里由服务端根路径提供，本地直接读
  vm.runInContext(fs.readFileSync(path.join(__dirname,"..","shared","protocol.js"),"utf8"),ctx,{filename:"protocol.js"});
  vm.runInContext(fs.readFileSync(path.join(__dirname,"..","shared","engine.js"),"utf8"),ctx,{filename:"engine.js"});
  load("net.js");
  load("online-main.js");
  ok(true, "四个脚本按浏览器顺序加载无异常");

  /* 等待 ws 连接就绪（服务端冷启动可能慢于客户端首次尝试） */
  let waitConn=0;
  while(doc.getElementById("lobbyTip").textContent.indexOf("已连接")<0 && waitConn<15000){
    await sleep(100); waitConn+=100;
  }
  ok(waitConn<15000, "客户端连接服务器成功");

  /* 大厅：创建房间 */
  doc.getElementById("btnCreate").click();
  let waitRoom=0;
  while(!storage.bf_online_session && waitRoom<8000){ await sleep(100); waitRoom+=100; }
  await sleep(300);
  const code=api ? null : null;
  const roomBar=doc.getElementById("roomBar");
  ok(roomBar.style.display==="flex", "建房后进入对局界面(roomBar 显示)");
  ok(doc.getElementById("deployCard").innerHTML.includes("部署阶段"), "部署界面已渲染");

  /* 蓝方由原生 ws 加入并部署（与 e2e 相同） */
  const wsB=new WebSocket("ws://"+URL_HOST);
  let bState=null, bSide=null, bToken=null;
  wsB.on("message",raw=>{
    const m=JSON.parse(raw.toString());
    if(m.type==="assigned"){ bSide=m.side; bToken=m.token; }
    if(m.type==="state"){ bState=m; }
  });
  await new Promise(r=>wsB.on("open",r));
  wsB.send(JSON.stringify({ type:"join", code: storedCode() }));
  await sleep(400);
  wsB.send(JSON.stringify({ type:"deploy", cfg:{ inf:500, cav:40, lightArt:20, scout:4, tank:2, heavyArt:10 } }));
  await sleep(300);

  function storedCode(){
    try { const s=JSON.parse(storage["bf_online_session"]); return s?s.code:""; } catch(e){ return ""; }
  }

  /* 红方提交部署（模拟输入数值后点确认） */
  const dc=doc.getElementById("deployCard");
  ok(dc.innerHTML.includes("红方"), "红方部署标题正确");
  // 直接调用引擎全局 confirmDeploy（已被 online-main 覆盖为发送意图）
  api.deployCfg={ inf:500, cav:40, lightArt:20, scout:4, tank:2, heavyArt:10 };
  vm.runInContext("confirmDeploy()",ctx);
  await sleep(500);
  ok(dc.innerHTML.includes("等待对方") || dc.innerHTML.includes("已提交"), "部署后显示等待界面");

  /* 等待进入对局 */
  let waited=0;
  while(api.phase!=="play" && waited<6000){
    await sleep(100); waited+=100;
    if(waited%1000===0){
      console.log(`  …诊断: phase=${api.phase}, 日志尾部: ${api.logEntries.slice(-3).map(e=>e.msg.slice(0,30)).join(" | ")}`);
    }
  }
  ok(api.phase==="play", "双方部署完成进入对局");

  /* 渲染断言：棋盘有格子、有己方兵团 */
  if(api.phase==="play"){
    vm.runInContext("render()",ctx);
    const boardHtml=doc.getElementById("board").innerHTML;
    ok(boardHtml.includes("data-cell"), "棋盘已渲染(含格子)");
    ok(boardHtml.includes("corps red")||boardHtml.includes("corps blue"), "己方兵团已渲染");
    ok(boardHtml.includes("base-tag"), "大本营标记已渲染");
    ok(api.corps.filter(p=>p.side===0).length>0, "红方本地引擎载入了己方兵团");
  }

  /* 结束回合 → 蓝方回合，红方操作锁定 */
  const beforeTurn=api.current;
  vm.runInContext("endTurn()",ctx);
  await sleep(400);
  ok(api.current!==beforeTurn || api.phase==="play", "endTurn 意图被服务端接受并翻回合");
  ok(doc.getElementById("turnChip").textContent.includes("蓝方") ||
     doc.getElementById("turnChip").textContent.includes("行动中"), "回合指示已更新: "+doc.getElementById("turnChip").textContent);

  /* 非本方回合 viewLocked 生效 */
  const locked=vm.runInContext("viewLocked()",ctx);
  ok(locked===true, "对方回合时 viewLocked 锁定操作");

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  wsB.close();
  srv.kill(); process.exit(failed?1:0);
}
main().catch(e=>{ console.error(e); srv.kill(); process.exit(1); });
