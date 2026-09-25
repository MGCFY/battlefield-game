/* ============================================================
   build-engine.js —— 从 ../battlefield-v3.html 生成 shared/engine.js
   引擎本体逐字保留；只在尾部追加 Node 适配钩子（浏览器端为空操作）。
   用法: node build-engine.js  （在 online/ 目录下运行）
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "battlefield-v3.html");
const DST = path.join(__dirname, "shared", "engine.js");

const html = fs.readFileSync(SRC, "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if(!m){ console.error("未在 v3 HTML 中找到脚本"); process.exit(1); }
let code = m[1].replace(/\nnewGame\(\);\s*$/, "\n");   // 去掉自动开局（由服务端/客户端控制）

const shim = `
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
`;

fs.writeFileSync(DST, code + shim);
console.log("engine.js 生成完毕:", DST, "行数:", (code + shim).split("\n").length);
