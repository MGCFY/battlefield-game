// 随机对局模拟 v2：正确跟踪行动集合，AI 偏向推进，验证完整胜负流程
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "battlefield.html"), "utf8");
let code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function makeEl() {
  return { innerHTML:"", textContent:"", className:"", value:"", style:{}, dataset:{},
    classList:{ add(){}, remove(){}, contains(){return false;} },
    addEventListener(){}, appendChild(){}, scrollTop:0, scrollHeight:0 };
}
const els = {};
global.document = { getElementById(id){ return els[id]||(els[id]=makeEl()); },
  createElement(){ return makeEl(); }, addEventListener(){} };
global.alert = (m)=>{ throw new Error("alert: "+m); };

code += `
;globalThis.__G = {
  get corps(){ return corps; },
  get current(){ return current; }, get turnNo(){ return turnNo; },
  get gameOver(){ return gameOver; }, get winner(){ return winner; },
  get acted(){ return acted; },
  get terrain(){ return terrain; }, get bridge(){ return bridge; }, get fort(){ return fort; },
  computeMoveTargets, executeMove, artTargets, doArtilleryStrike, mergeCandidates,
  buildCells, fortCells, checkWin, getCorps, stationable, endTurn, newGame, doRest,
  BASES,
};
`;
eval(code);
const G = globalThis.__G;
const randInt = (a,b)=> a+Math.floor(Math.random()*(b-a+1));
const choice = arr => arr[randInt(0,arr.length-1)];

const ENEMY_BASE = side => G.BASES[1-side];
const distTo = (p, [br,bc]) => Math.abs(p.r-br)+Math.abs(p.c-bc);

let errors = 0, wins = [0,0], totalTurns = 0, totalBattles = 0;

for (let game = 0; game < 30; game++) {
  G.newGame();
  let safety = 0;
  while (!G.gameOver && safety++ < 5000) {
    totalTurns++;
    const side = G.current;
    const pool = G.corps.filter(p => p.alive && p.side === side && !G.acted.has(p.id));
    if (!pool.length) { G.endTurn(); continue; }
    const cp = choice(pool);
    try {
      const cmds = [];
      // —— 移动(带推进倾向) ——
      const steps = cp.type === "cav" ? (Math.random()<0.5?3:randInt(1,2)) : 1;
      const tg = G.computeMoveTargets(cp, steps);
      if (tg.empties.size || tg.corpsCells.size) cmds.push("move");
      cmds.push("rest");
      if (cp.type === "art" && G.artTargets(cp).length) cmds.push("art", "art"); // 炮兵爱开火
      if (cp.troops >= 6) {
        const hasSpot = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]].some(([dr,dc])=>{
          const nr=cp.r+dr,nc=cp.c+dc;
          return G.stationable(nr,nc) && !G.corps.some(p=>p.alive&&p.r===nr&&p.c===nc);
        });
        if (hasSpot) cmds.push("split");
      }
      if (G.mergeCandidates(cp).length) cmds.push("merge");
      if (cp.type === "inf" && cp.resting && G.buildCells(cp).size) cmds.push("build");
      if (cp.type === "inf" && cp.resting && G.fortCells(cp).size) cmds.push("destroy");
      if (cp.type === "cav" && G.fortCells(cp).size) cmds.push("demolish");

      const cmd = choice(cmds);
      if (cmd === "move") {
        const entries = [];
        tg.empties.forEach((path,k)=>entries.push({k, path, corps:false}));
        tg.corpsCells.forEach((v,k)=>entries.push({k, path:v.path, corps:true}));
        let pick;
        if (Math.random() < 0.75) {
          // 朝敌方大本营推进
          const eb = ENEMY_BASE(side);
          entries.sort((a,b)=>{
            const [ar,ac]=a.k.split(",").map(Number), [br2,bc]=b.k.split(",").map(Number);
            return (Math.abs(ar-eb[0])+Math.abs(ac-eb[1])) - (Math.abs(br2-eb[0])+Math.abs(bc-eb[1]));
          });
          pick = entries[0];
        } else pick = choice(entries);
        const beforeAlive = G.corps.filter(p=>p.alive).length;
        G.executeMove(cp, pick.path);
        totalBattles += beforeAlive - G.corps.filter(p=>p.alive).length;
        G.acted.add(cp.id);
      } else if (cmd === "rest") { G.doRest(cp); G.acted.add(cp.id); }
      else if (cmd === "art") {
        const t = choice(G.artTargets(cp));
        G.doArtilleryStrike(cp, t);
        G.acted.add(cp.id);
      } else if (cmd === "split") {
        const n = randInt(5, cp.troops-1);
        const spots = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]
          .map(([dr,dc])=>[cp.r+dr,cp.c+dc])
          .filter(([nr,nc])=>G.stationable(nr,nc)&&!G.corps.some(p=>p.alive&&p.r===nr&&p.c===nc));
        if (spots.length) {
          const [nr,nc] = choice(spots);
          G.corps.push({ id: Date.now()%1e7 + randInt(1,999), side:cp.side, type:cp.type,
            troops:n, r:nr, c:nc, resting:false, fatigue:0, alive:true });
          cp.troops -= n;
          G.acted.add(cp.id);
        }
      } else if (cmd === "merge") {
        const tgt = choice(G.mergeCandidates(cp));
        tgt.troops += cp.troops; cp.alive = false; cp.troops = 0;
        G.acted.add(cp.id);
      } else if (cmd === "build") {
        const [r,c] = choice([...G.buildCells(cp)]).split(",").map(Number);
        G.fort[r][c] = true; G.acted.add(cp.id);
      } else if (cmd === "destroy" || cmd === "demolish") {
        const [r,c] = choice([...G.fortCells(cp)]).split(",").map(Number);
        G.fort[r][c] = false; G.acted.add(cp.id);
      }
      G.checkWin();
    } catch (err) {
      errors++;
      console.error(`第${game+1}局 异常:`, err.message, err.stack.split("\n")[1]);
      break;
    }
  }
  if (G.gameOver) wins[G.winner]++;
  else console.log(`第${game+1}局: ${Math.floor(safety/2)}回合未分胜负`);
}
console.log(`\n30 局模拟完成: 红胜${wins[0]} 蓝胜${wins[1]} | 运行时错误 ${errors} | 总回合 ${totalTurns} | 阵亡/交战次数约 ${totalBattles}`);
process.exit(errors ? 1 : 0);
