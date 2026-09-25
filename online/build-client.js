/* ============================================================
   build-client.js —— 从 ../battlefield-v3.html 生成 client/index.html
   复用 v3 的全部样式与页面骨架；替换脚本为联机模块；注入大厅 UI。
   用法: node build-client.js  （在 online/ 目录下运行）
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "battlefield-v3.html");
const DST = path.join(__dirname, "client", "index.html");

let html = fs.readFileSync(SRC, "utf8");

/* 1. 截到内联脚本之前（保留全部 head/CSS/body 骨架） */
const cut = html.indexOf("<script>");
if(cut < 0){ console.error("未找到脚本标记"); process.exit(1); }
let out = html.slice(0, cut);

/* 2. 标题 */
out = out.replace(/<title>[\s\S]*?<\/title>/, "<title>战场沙盘策略游戏 · 联机版</title>");

/* 3. 大厅样式（追加到 </style> 前） */
const lobbyCss = `
/* ---- 联机大厅 / 顶栏 ---- */
#lobbyWrap{ position:fixed; inset:0; background:rgba(236,240,241,.97); z-index:300;
  display:flex; align-items:center; justify-content:center; }
#lobbyWrap.hidden{ display:none; }
.lobby-card{ background:#fff; border:1px solid #e0e4e8; border-radius:16px; padding:34px 40px;
  width:400px; box-shadow:0 8px 30px rgba(30,40,60,.10); text-align:center; }
.lobby-card h1{ font-size:22px; margin:0 0 4px; color:#263238; }
.lobby-card .sub{ font-size:13px; color:#78909c; margin-bottom:22px; }
.lobby-sec{ border:1px dashed #cfd8dc; border-radius:12px; padding:16px; margin-top:14px; }
.lobby-sec .lab{ font-size:13px; color:#455a64; margin-bottom:10px; }
.lobby-sec input{ width:150px; font-size:18px; text-align:center; letter-spacing:6px; padding:6px 8px;
  border:1px solid #b0bec5; border-radius:8px; outline:none; }
.lobby-sec input:focus{ border-color:#1e88e5; }
.lobby-tip{ font-size:12px; color:#90a4ae; margin-top:12px; min-height:16px; }
.lobby-tip.err{ color:#c62828; }
#roomBar{ display:none; align-items:center; gap:10px; padding:6px 12px; background:#eceff1;
  border-bottom:1px solid #e0e4e8; font-size:13px; color:#455a64; }
#roomBar b{ color:#263238; letter-spacing:2px; }
#roomBar .dot{ width:8px; height:8px; border-radius:50%; background:#b0bec5; display:inline-block; margin-right:4px; }
#roomBar .dot.on{ background:#43a047; }
@media (max-width:900px){ #roomBar{ flex-wrap:wrap; } }
`;
out = out.replace("</style>", lobbyCss + "\n</style>");

/* 4. 大厅 UI（插在 body 开头） */
const lobbyHtml = `
<div id="lobbyWrap">
  <div class="lobby-card">
    <h1>⚔ 战场沙盘 · 双人联机</h1>
    <div class="sub">创建房间后把 6 位房间号告诉对方即可开战</div>
    <div class="lobby-sec">
      <div class="lab">创建新对局</div>
      <button class="btn primary" id="btnCreate">创建房间</button>
    </div>
    <div class="lobby-sec">
      <div class="lab">输入房间号加入</div>
      <input id="joinCode" maxlength="6" inputmode="numeric" placeholder="000000">
      <button class="btn primary" id="btnJoin">加入房间</button>
    </div>
    <div class="lobby-tip" id="lobbyTip">正在连接服务器…</div>
  </div>
</div>
<div id="roomBar">
  <span>房间号 <b id="rbCode">------</b></span>
  <span><span class="dot" id="rbOppDot"></span><span id="rbOppText">对手未连接</span></span>
  <span id="rbRole"></span>
</div>
`;
out = out.replace("<body>", "<body>\n" + lobbyHtml);

/* 5. 脚本区：联机模块 */
out += `
<script src="/protocol.js"></script>
<script src="/engine.js"></script>
<script src="/net.js"></script>
<script src="/online-main.js"></script>
</body>
</html>
`;

fs.writeFileSync(DST, out);
console.log("index.html 生成完毕:", DST, "行数:", out.split("\n").length);
