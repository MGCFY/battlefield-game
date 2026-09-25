/* ============================================================
   net.js —— WebSocket 客户端薄封装
   - 自动重连（指数退避），重连后自动用 token 恢复席位
   - 对上层只暴露 on(type, fn) / send(obj)
   ============================================================ */
"use strict";
(function(){
  const SESSION_KEY = "bf_online_session";      // {code, side, token}
  let ws = null;
  let backoff = 800;
  let handlers = {};
  let closedByUser = false;

  function session(){ 
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)) || null; } 
    catch(e){ return null; }
  }
  function saveSession(s){ sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
  function clearSession(){ sessionStorage.removeItem(SESSION_KEY); }

  function connect(){
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/");
    ws.onopen = ()=>{
      backoff = 800;
      const s = session();
      if(s && s.code){ emit("_resume", s); }
      emit("_open");
    };
    ws.onmessage = (ev)=>{
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch(e){ return; }
      if(msg && msg.type) emit(msg.type, msg);
    };
    ws.onclose = ()=>{
      emit("_close");
      if(closedByUser) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10000);
    };
    ws.onerror = ()=>{ try{ ws.close(); }catch(e){} };
  }

  function emit(type, data){ (handlers[type]||[]).forEach(fn=>{ try{ fn(data); }catch(e){ console.error(e); } }); }

  window.Net = {
    on(type, fn){ (handlers[type] = handlers[type]||[]).push(fn); },
    send(obj){ if(ws && ws.readyState===1) ws.send(JSON.stringify(obj)); },
    connect,
    leave(){ closedByUser = true; try{ ws.close(); }catch(e){} clearSession(); },
    session, saveSession, clearSession,
  };
})();
