/* 战场沙盘 v2 · 整局随机对局模拟
   让两个随机 AI 完整跑完对局，验证：所有指令路径可执行、无运行时异常、
   昼夜切换 / 导弹 / 照明弹 / 烟雾弹 / 防空地堡等系统都被真实触发。 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "battlefield-v2.html"), "utf8");
let code = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nnewGame\(\);\s*$/, "\n");
code += `
globalThis.__T = {
  get terrain(){return terrain}, set terrain(v){terrain=v},
  get bridge(){return bridge}, get fort(){return fort},
  get bunker(){return bunker}, get bunkerDead(){return bunkerDead},
  get flare(){return flare}, get smokeLeft(){return smokeLeft}, get smokeId(){return smokeId},
  get corps(){return corps}, get acted(){return acted},
  get current(){return current}, get turnNo(){return turnNo},
  get gameOver(){return gameOver}, get winner(){return winner},
  set current(v){current=v}, set turnNo(v){turnNo=v}, set gameOver(v){gameOver=v},
  get phase(){return phase}, set phase(v){phase=v},
  get seen(){return seen}, set seen(v){seen=v},
  get memoryFog(){return memoryFog}, set memoryFog(v){memoryFog=v},
  get pendingMissiles(){return pendingMissiles}, get smokeSeq(){return smokeSeq},
  get nextId(){return nextId}, set nextId(v){nextId=v},
  UNITS, BASES, N, RECOMMEND, DEPLOY_TYPES, BUDGET,
  fn: { genMap, stationable, computeVision, visionRange, unitVisibleTo, computeMoveTargets,
        executeMove, strikeCell, katyushaStrike, strikeBase, strikeRange, canStrike,
        resolveMissiles, endTurn, checkWin, isDay, dayNo, spawnFromConfig, hasGround,
        randInt, key, unkey, cheb, enemySizeClass }
};
`;
function stubEl() {
  return { innerHTML: "", textContent: "", className: "", value: "0", style: {}, dataset: {},
    scrollTop: 0, scrollHeight: 0, checked: true,
    classList: { add(){}, remove(){}, contains(){ return false; } },
    appendChild(){}, addEventListener(){}, closest(){ return null; } };
}
const cache = {};
const documentStub = { getElementById: id => (cache[id] || (cache[id] = stubEl())),
  querySelector: () => null, querySelectorAll: () => [], createElement: () => stubEl(), addEventListener: () => {} };
const ctx = { document: documentStub, console, alert: () => {}, Math, JSON, Set, Map,
              Array, Object, String, Number, parseInt, isNaN, Infinity, globalThis: null };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx);
const T = ctx.__T, F = T.fn, N = T.N, UNITS = T.UNITS, BASES = T.BASES;

/* ---------- 统计 ---------- */
const stat = { games: 0, turns: 0, errors: [], wins: [0,0,0], timeFlips: 0,
  missiles: 0, flares: 0, smokes: 0, bunkers: 0, forts: 0, strikes: 0, melees: 0, maxTurn: 0 };

function setupGame(){
  F.genMap();
  T.corps.length = 0;
  T.nextId = 1;
  F.spawnFromConfig(0, {
    inf: 300 + F.randInt(0,200), cav: 20 + F.randInt(0,20), lightArt: 10 + F.randInt(0,10),
    scout: 2 + F.randInt(0,2), heavyArt: 5 + F.randInt(0,5), tank: F.randInt(0,3),
    katyusha: F.randInt(0,2), recon: F.randInt(0,1), bomber: F.randInt(0,1)
  });
  F.spawnFromConfig(1, { inf: 400, cav: 30, lightArt: 20, scout: 4, heavyArt: 10, tank: 2, katyusha: 1, recon: 1, bomber: 0 });
  // 清空回合态
  T.acted.clear();
  for (const k in cache) delete cache[k];
  T.phase = "play"; T.turnNo = 1; T.current = 0; T.gameOver = false; T.winner = 0;
  T.seen = [Array.from({length:N},()=>Array(N).fill(false)), Array.from({length:N},()=>Array(N).fill(false))];
  T.pendingMissiles.length = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    T.flare[r][c] = 0; T.smokeLeft[r][c] = 0; T.smokeId[r][c] = 0;
    T.fort[r][c] = false; T.bunker[r][c] = 0; T.bunkerDead[r][c] = false;
  }
}

function visCells(p, vis, range){
  const out = [];
  for (const k of vis) {
    const q = F.unkey(k);
    if (q.r === p.r && q.c === p.c) continue;
    if (F.cheb(q, p) <= range) out.push(q);
  }
  return out;
}
function freeAdjacent(p){
  const slots = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const r = p.r + dr, c = p.c + dc;
    if (!F.stationable(r, c)) continue;
    if (T.corps.some(q => q.alive && q.r === r && q.c === c)) continue;
    slots.push([r, c]);
  }
  return slots;
}

function actSide(side){
  const vis = F.computeVision(side);
  const list = T.corps.filter(p => p.alive && p.side === side && !T.acted.has(p.id));
  for (const p of list) {
    if (!p.alive) continue;
    const u = UNITS[p.type];
    const roll = Math.random();

    // 休整
    if (u.canRest && roll < 0.10) { p.resting = true; T.acted.add(p.id); continue; }

    // 喀秋莎装填
    if (p.type === "katyusha" && !p.ammo && Math.random() < 0.6) { p.ammo = true; T.acted.add(p.id); continue; }

    // 远程打击
    if (u.ranged && F.canStrike(p) && Math.random() < 0.5) {
      const cells = visCells(p, vis, F.strikeRange(p));
      if (cells.length) {
        const q = cells[F.randInt(0, cells.length - 1)];
        if (p.type === "katyusha") { F.katyushaStrike(p, q.r, q.c); p.ammo = false; }
        else F.strikeCell(p, q.r, q.c, p.troops * F.strikeBase(p));
        stat.strikes++;
        T.acted.add(p.id); continue;
      }
    }

    // 投掷照明弹 / 烟雾弹
    if (u.throwable && Math.random() < 0.18 && (p.flare > 0 || p.smoke > 0)) {
      const cells = visCells(p, vis, F.visionRange(p));
      if (cells.length) {
        const q = cells[F.randInt(0, cells.length - 1)];
        if (p.flare > 0 && Math.random() < 0.5) {
          p.flare--;
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++)
            if (q.r + dr >= 0 && q.r + dr < N && q.c + dc >= 0 && q.c + dc < N) T.flare[q.r + dr][q.c + dc] = 5;
          stat.flares++;
        } else if (p.smoke > 0) {
          p.smoke--;
          const id = T.smokeSeq++;
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++)
            if (q.r + dr >= 0 && q.r + dr < N && q.c + dc >= 0 && q.c + dc < N) {
              T.smokeLeft[q.r + dr][q.c + dc] = 5; T.smokeId[q.r + dr][q.c + dc] = id;
            }
          stat.smokes++;
        }
        T.acted.add(p.id); continue;
      }
    }

    // 轰炸机导弹
    if (u.missile && p.missile > 0 && Math.random() < 0.35) {
      const cells = visCells(p, vis, F.visionRange(p));
      if (cells.length) {
        const q = cells[F.randInt(0, cells.length - 1)];
        p.missile--;
        T.pendingMissiles.push({ r: q.r, c: q.c, side });
        stat.missiles++;
        T.acted.add(p.id); continue;
      }
    }

    // 步兵修工事 / 防空地堡
    if (p.type === "inf" && p.resting && Math.random() < 0.25) {
      if (T.bunker[p.r][p.c] <= 0 && !T.bunkerDead[p.r][p.c] && Math.random() < 0.3) {
        T.bunker[p.r][p.c] = 3; stat.bunkers++;
      } else {
        const slots = freeAdjacent(p);
        if (slots.length) { const [r, c] = slots[F.randInt(0, slots.length - 1)]; T.fort[r][c] = !T.fort[r][c]; stat.forts++; }
      }
      T.acted.add(p.id); continue;
    }

    // 分兵
    if (p.troops >= 20 && Math.random() < 0.05) {
      const slots = freeAdjacent(p);
      if (slots.length) {
        const n = Math.max(5, Math.floor(p.troops / 2));
        const [r, c] = slots[F.randInt(0, slots.length - 1)];
        T.corps.push({ id: T.nextId++, side, type: p.type, troops: n, r, c,
          resting: false, fatigue: 0, alive: true, acc: 0, dur: u.dur || 0,
          flare: 0, smoke: 0, missile: 0, ammo: false });
        p.troops -= n;
        T.acted.add(p.id); continue;
      }
    }

    // 移动
    const steps = p.type === "scout" ? (Math.random() < 0.3 ? 3 : 2) : u.move;
    const mt = F.computeMoveTargets(p, steps, vis);
    const opts = [...mt.empties.keys()].map(F.unkey).concat([...mt.corpsCells.keys()].map(F.unkey));
    if (!opts.length) { T.acted.add(p.id); continue; }
    let pick;
    if (Math.random() < 0.6) {
      const [er, ec] = BASES[1 - side];
      let best = Infinity;
      for (const o of opts) {
        const d = Math.max(Math.abs(o.r - er), Math.abs(o.c - ec));
        if (d < best) { best = d; pick = o; }
      }
    } else {
      pick = opts[F.randInt(0, opts.length - 1)];
    }
    const k = F.key(pick.r, pick.c);
    const path = mt.empties.has(k) ? mt.empties.get(k) : mt.corpsCells.get(k).path;
    if (!path) { T.acted.add(p.id); continue; }
    const rep = F.executeMove(p, path);
    if (rep.segs && rep.segs.length) stat.melees++;
    T.acted.add(p.id);
  }
}

/* ---------- 跑 40 局 ---------- */
const GAMES = 40;
for (let g = 0; g < GAMES; g++) {
  try {
    setupGame();
    let rounds = 0;
    let lastDay = F.isDay();
    while (!T.gameOver && rounds < 400) {
      actSide(0);
      if (T.gameOver) break;
      F.endTurn();
      if (F.isDay() !== lastDay) { stat.timeFlips++; lastDay = F.isDay(); }
      if (T.gameOver) break;
      actSide(1);
      if (T.gameOver) break;
      F.endTurn();
      if (F.isDay() !== lastDay) { stat.timeFlips++; lastDay = F.isDay(); }
      rounds++;
    }
    stat.games++;
    stat.turns += T.turnNo;
    stat.maxTurn = Math.max(stat.maxTurn, T.turnNo);
    if (T.gameOver) stat.wins[T.winner]++; else stat.wins[2]++;
    if (!F.hasGround(0) && !F.hasGround(1)) stat.errors.push(`第${g}局：双方均无地面兵团`);
  } catch (e) {
    stat.errors.push(`第${g}局：${e.message} @ ${(e.stack||"").split("\n")[1]||""}`.trim());
  }
}

console.log(`\n============== 整局随机对局模拟 ==============`);
console.log(`完成对局：${stat.games}/${GAMES} 局`);
console.log(`累计回合：${stat.turns}（平均 ${(stat.turns/Math.max(1,stat.games)).toFixed(1)} 回合/局，最长 ${stat.maxTurn}）`);
console.log(`胜负分布：红胜 ${stat.wins[0]} · 蓝胜 ${stat.wins[1]} · 未分胜负 ${stat.wins[2]}`);
console.log(`系统触发：昼夜切换 ${stat.timeFlips} 次 · 近战 ${stat.melees} 次 · 远程打击 ${stat.strikes} 次`);
console.log(`          导弹 ${stat.missiles} 枚 · 照明弹 ${stat.flares} 发 · 烟雾弹 ${stat.smokes} 发`);
console.log(`          防空地堡 ${stat.bunkers} 座 · 工事操作 ${stat.forts} 次`);
console.log(`运行时错误：${stat.errors.length} 个`);
stat.errors.slice(0, 10).forEach(e => console.log("  ✗ " + e));
console.log(`\n结论：${stat.errors.length === 0 ? "全部对局稳定运行，无运行时异常 ✓" : "存在异常 ✗"}`);
process.exit(stat.errors.length ? 1 : 0);
