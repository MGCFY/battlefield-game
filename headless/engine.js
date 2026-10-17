'use strict';
/*
 * engine.js —— 战场沙盘「无头（headless）引擎」
 * ---------------------------------------------------------------------------
 * 目标：把单文件 HTML 游戏（battlefield-vX.html）的完整规则逻辑搬进 Node，
 *       在没有浏览器、没有 DOM、没有动画的前提下高速跑完整对局。
 *
 * 做法：
 *   1. 从 HTML 中抽出 <script> 里的游戏代码；
 *   2. 在代码尾部追加一段「导出层」，把内部状态与函数挂到 globalThis.__H；
 *   3. 构造一个"什么都吃"的沙盒（DOM / 定时器 / storage / canvas 桩 + 可复现 RNG）；
 *   4. vm.createContext + runInContext 载入；
 *   5. 载入后把纯渲染 / 快照 / 落盘类函数替换成 no-op（这是高速的关键）；
 *   6. 返回一层干净的 API 供 sim.js / cli.js 使用。
 *
 * 注意：本引擎不修改磁盘上的游戏文件，所有替换都发生在内存中的沙盒里。
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* ------------------------------------------------------------------ *
 *  默认源文件候选（按优先级）
 * ------------------------------------------------------------------ */
const DEFAULT_SRC = [
  path.resolve(__dirname, '..', 'battlefield-v3.9.23.html'),
  path.resolve(__dirname, '..', 'battlefield-v3.9.22.html'),
  path.resolve(__dirname, '..', 'battlefield-v3.9.21.html'),
  path.resolve(__dirname, '..', 'battlefield-v3.9.20.html'),
  path.resolve(__dirname, '..', 'battlefield-v3.9.19.html'),
  path.resolve(__dirname, '..', 'battlefield-v3.9.18.html'),
  path.resolve(__dirname, '..', 'battlefield-v3.9.17.html'),
  path.resolve(__dirname, '..', 'battlefield-v3.9.16.html'),
  path.resolve(__dirname, '..', 'battlefield-v3.9.15.html'),
  path.resolve(__dirname, '..', 'battlefield-v3.9.14.html'),
  path.resolve(__dirname, '..', '..', '..', '..', 'Desktop', 'battlefield-v3.9.13(1).html'),
  'C:/Users/OMEN/Desktop/battlefield-v3.9.13(1).html',
  'C:/Users/OMEN/Desktop/battlefield-v3.9.13.html',
  path.resolve(__dirname, '..', 'battlefield-v3.9.13(1).html'),
  path.resolve(__dirname, '..', 'battlefield-v3.9.html'),
  path.resolve(__dirname, '..', '..', 'battlefield-site', 'index.html'),
];

function resolveSource(src) {
  const list = src ? [src] : DEFAULT_SRC;
  for (const p of list) {
    try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* 继续 */ }
  }
  throw new Error('找不到游戏源文件，请用 src 选项或 --src 指定 .html 路径');
}

/* ------------------------------------------------------------------ *
 *  可复现随机数
 * ------------------------------------------------------------------ */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(s) {
  if (typeof s === 'number' && Number.isFinite(s)) return s >>> 0;
  let h = 2166136261 >>> 0;
  const str = String(s == null ? 1 : s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* ------------------------------------------------------------------ *
 *  DOM / BOM 桩：任何访问都不应抛错，且尽量廉价
 * ------------------------------------------------------------------ */
const NOOP = function () {};

function makeCanvasCtx() {
  const ctx = {
    canvas: null,
    save: NOOP, restore: NOOP, scale: NOOP, rotate: NOOP, translate: NOOP, transform: NOOP, setTransform: NOOP,
    beginPath: NOOP, closePath: NOOP, moveTo: NOOP, lineTo: NOOP, rect: NOOP, arc: NOOP, ellipse: NOOP,
    quadraticCurveTo: NOOP, bezierCurveTo: NOOP, fill: NOOP, stroke: NOOP, clip: NOOP,
    fillRect: NOOP, strokeRect: NOOP, clearRect: NOOP,
    fillText: NOOP, strokeText: NOOP,
    drawImage: NOOP, putImageData: NOOP, createImageData: () => ({ data: [] }),
    getImageData: () => ({ data: [], width: 0, height: 0 }),
    setLineDash: NOOP,
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop: NOOP }),
    createRadialGradient: () => ({ addColorStop: NOOP }),
    createPattern: () => null,
    getLineDash: () => [],
  };
  return ctx;
}

function makeElement(id) {
  const el = {
    id: id || '',
    tagName: 'DIV',
    nodeType: 1,
    innerHTML: '', outerHTML: '', innerText: '', textContent: '', value: '0',
    checked: true, disabled: false, hidden: false, readOnly: false,
    className: '', width: 680, height: 680, clientWidth: 680, clientHeight: 680,
    offsetWidth: 680, offsetHeight: 680, scrollTop: 0, scrollLeft: 0, scrollHeight: 680, scrollWidth: 680,
    style: { setProperty: NOOP, removeProperty: NOOP, getPropertyValue: () => '', cssText: '' },
    dataset: {},
    classList: { add: NOOP, remove: NOOP, toggle: NOOP, contains: () => false, replace: NOOP, item: () => null, length: 0 },
    children: [], childNodes: [], firstChild: null, lastChild: null, firstElementChild: null, lastElementChild: null,
    parentNode: null, parentElement: null, nextSibling: null, previousSibling: null, ownerDocument: null,
    appendChild: (n) => n, insertBefore: (n) => n, removeChild: (n) => n, replaceChild: (n) => n,
    remove: NOOP, append: NOOP, prepend: NOOP, before: NOOP, after: NOOP,
    insertAdjacentHTML: NOOP, insertAdjacentElement: () => null, insertAdjacentText: NOOP,
    addEventListener: NOOP, removeEventListener: NOOP, dispatchEvent: () => true,
    querySelector: () => null, querySelectorAll: () => [],
    getElementsByTagName: () => [], getElementsByClassName: () => [],
    closest: () => null, matches: () => false, contains: () => false,
    focus: NOOP, blur: NOOP, click: NOOP, scrollIntoView: NOOP, animate: () => ({ cancel: NOOP, finished: Promise.resolve() }),
    setAttribute: NOOP, getAttribute: () => null, removeAttribute: NOOP, hasAttribute: () => false,
    setAttributeNS: NOOP, getAttributeNS: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 680, bottom: 680, width: 680, height: 680 }),
    getContext: () => makeCanvasCtx(),
    toDataURL: () => '', toBlob: NOOP,
    cloneNode: function () { return this; },
    play: NOOP, pause: NOOP, load: NOOP,
  };
  return el;
}

function makeDocument() {
  const cache = new Map();
  const body = makeElement('body');
  const doc = {
    body,
    documentElement: makeElement('html'),
    head: makeElement('head'),
    title: '',
    cookie: '',
    hidden: false,
    visibilityState: 'visible',
    readyState: 'complete',
    activeElement: null,
    getElementById(id) { if (!cache.has(id)) cache.set(id, makeElement(id)); return cache.get(id); },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    getElementsByName: () => [],
    createElement: (t) => { const e = makeElement(''); e.tagName = String(t || 'div').toUpperCase(); return e; },
    createElementNS: (ns, t) => doc.createElement(t),
    createTextNode: (t) => ({ nodeType: 3, nodeValue: t, textContent: t }),
    createDocumentFragment: () => makeElement(''),
    createEvent: () => ({ initEvent: NOOP }),
    addEventListener: NOOP,
    removeEventListener: NOOP,
    dispatchEvent: () => true,
    execCommand: () => true,
    __cache: cache,
  };
  return doc;
}

/* ------------------------------------------------------------------ *
 *  沙盒构造
 * ------------------------------------------------------------------ */
function buildSandbox(opts) {
  const rng = opts.rng;
  const quiet = opts.quiet !== false;

  // Math 是浅引用的话改不了 random（不可枚举），需要浅拷贝一份
  const M = {};
  for (const k of Object.getOwnPropertyNames(Math)) M[k] = Math[k];
  M.random = rng;

  const silentConsole = quiet
    ? { log: NOOP, info: NOOP, warn: NOOP, error: NOOP, debug: NOOP, trace: NOOP, table: NOOP, group: NOOP, groupEnd: NOOP, time: NOOP, timeEnd: NOOP, assert: NOOP, dir: NOOP, count: NOOP }
    : console;

  const storage = {
    getItem: () => null, setItem: NOOP, removeItem: NOOP, clear: NOOP,
    key: () => null, length: 0, __data: {},
  };

  const sandbox = {
    console: silentConsole,
    document: makeDocument(),
    Math: M,
    JSON, Date, RegExp, Error, TypeError, RangeError, SyntaxError,
    Set, Map, WeakSet, WeakMap, Proxy, Reflect, Promise, Symbol,
    Array, Object, String, Number, Boolean, Function,
    parseInt, parseFloat, isNaN, isFinite, Infinity, NaN, undefined,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    setTimeout: () => 0, clearTimeout: NOOP, setInterval: () => 0, clearInterval: NOOP,
    requestAnimationFrame: () => 0, cancelAnimationFrame: NOOP,
    requestIdleCallback: () => 0, cancelIdleCallback: NOOP,
    alert: NOOP, confirm: () => true, prompt: () => null,
    addEventListener: NOOP, removeEventListener: NOOP, dispatchEvent: () => true,
    matchMedia: () => ({ matches: false, media: '', addListener: NOOP, removeListener: NOOP, addEventListener: NOOP, removeEventListener: NOOP }),
    getComputedStyle: () => ({ getPropertyValue: () => '', width: '0px', height: '0px' }),
    localStorage: storage, sessionStorage: storage,
    location: { href: 'file://headless/', protocol: 'file:', search: '', hash: '', host: '', hostname: '', pathname: '/', reload: NOOP, assign: NOOP, replace: NOOP },
    navigator: { userAgent: 'battlefield-headless', platform: 'node', language: 'zh-CN', languages: ['zh-CN'], clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') } },
    performance: { now: () => Date.now(), timeOrigin: 0, mark: NOOP, measure: NOOP },
    innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1, scrollX: 0, scrollY: 0,
    screen: { width: 1600, height: 900, availWidth: 1600, availHeight: 900 },
    Image: function () { return makeElement('img'); },
    Audio: function () { return { play: NOOP, pause: NOOP, cloneNode() { return this; }, volume: 0, currentTime: 0, addEventListener: NOOP }; },
    Event: function (t, o) { return Object.assign({ type: t, preventDefault: NOOP, stopPropagation: NOOP }, o || {}); },
    MutationObserver: function () { return { observe: NOOP, disconnect: NOOP, takeRecords: () => [] }; },
    IntersectionObserver: function () { return { observe: NOOP, disconnect: NOOP, unobserve: NOOP }; },
    ResizeObserver: function () { return { observe: NOOP, disconnect: NOOP, unobserve: NOOP }; },
    Blob: function () { return { size: 0, type: '' }; },
    URL: { createObjectURL: () => 'blob:headless', revokeObjectURL: NOOP },
    FileReader: function () { return { readAsText: NOOP, readAsDataURL: NOOP, addEventListener: NOOP, removeEventListener: NOOP }; },
    TextEncoder: typeof TextEncoder !== 'undefined' ? TextEncoder : undefined,
    TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : undefined,
    structuredClone: (v) => JSON.parse(JSON.stringify(v)),
  };

  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  sandbox.frames = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

/* ------------------------------------------------------------------ *
 *  HTML → 游戏 JS
 * ------------------------------------------------------------------ */
function extractGameScript(html) {
  const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  if (!blocks.length) throw new Error('HTML 中未找到 <script> 代码块');
  // 游戏本体是最大的那一块
  blocks.sort((a, b) => b.length - a.length);
  let js = blocks[0];
  // 只裁掉末尾的自动启动调用（renderLegend(); showWelcome();），
  // 用 lastIndexOf 精确定位，避免误伤脚本中间的同名调用。
  const i = js.lastIndexOf('renderLegend()');
  const j = js.lastIndexOf('showWelcome()');
  if (i >= 0 && j > i && (j - i) < 400) js = js.slice(0, i) + '\n';
  return js;
}

/* ------------------------------------------------------------------ *
 *  导出层：在游戏作用域内追加，暴露状态与函数
 * ------------------------------------------------------------------ */
const EXPORT_SNIPPET = `
/* ===== headless 导出层（由 engine.js 注入，不改动游戏逻辑） ===== */
globalThis.__H = (function(){
  const G = {
    /* ---- 只读状态 ---- */
    get corps(){ return corps; },
    get terrain(){ return terrain; },
    get bridge(){ return bridge; },
    get mine(){ return mine; },
    get ruin(){ return ruin; },
    get bunker(){ return bunker; },
    get bunkerDead(){ return bunkerDead; },
    get fortH(){ return fortH; },
    get fortV(){ return fortV; },
    get ferryDur(){ return (typeof ferryDur!=="undefined" ? ferryDur : null); },
    get acted(){ return acted; },
    get winner(){ return winner; },
    get baseHold(){ return baseHold; },
    get turnNo(){ return turnNo; },
    get current(){ return current; },
    get gameOver(){ return gameOver; },
    get phase(){ return phase; },
    get nextId(){ return nextId; },
    get logEntries(){ return logEntries; },
    get battleRecord(){ return battleRecord; },
    get battleStats(){ return battleStats; },
    get reinforcements(){ return reinforcements; },
    get spentBudget(){ return spentBudget; },
    get aiDoctrine(){ return aiDoctrine; },
    get aiTurtlePhase(){ return (typeof aiTurtlePhase!=="undefined" ? aiTurtlePhase : null); },
    get aiThreatProfile(){ return (typeof aiThreatProfile!=="undefined" ? aiThreatProfile : null); },
    get aiSawMainForce(){ return (typeof aiSawMainForce!=="undefined" ? aiSawMainForce : null); },
    get aiEverRush(){ return (typeof aiEverRush!=="undefined" ? aiEverRush : null); },
    get aiGuardId(){ return (typeof aiGuardId!=="undefined" ? aiGuardId : null); },
    get aiDiag(){ return (typeof __lastDiag!=="undefined" ? __lastDiag : null); },
    get aiWhy(){ return (typeof __lastWhy!=="undefined" ? __lastWhy : null); },
    get UNITS(){ return UNITS; },
    get DEPLOY_TYPES(){ return DEPLOY_TYPES; },
    get BASES(){ return BASES; },
    get N(){ return N; },
    get AI_PROFILES(){ return (typeof AI_PROFILES!=="undefined" ? AI_PROFILES : null); },
    get FIXMAPS(){ return (typeof FIXMAPS!=="undefined" ? FIXMAPS : null); },
    get SIDE_NAME(){ return SIDE_NAME; },
    /* ---- 可写状态 ---- */
    get aiSide(){ return aiSide; }, set aiSide(v){ aiSide = v; },
    get aiDiff(){ return aiDiff; }, set aiDiff(v){ aiDiff = v; },
    get gameBudget(){ return gameBudget; }, set gameBudget(v){ gameBudget = v; },
    get mapKind(){ return mapKind; }, set mapKind(v){ mapKind = v; },
    get current(){ return current; }, set current(v){ current = v; },
    get turnNo(){ return turnNo; }, set turnNo(v){ turnNo = v; },
    get gameOver(){ return gameOver; }, set gameOver(v){ gameOver = v; },
    get winner(){ return winner; }, set winner(v){ winner = v; },
    get phase(){ return phase; }, set phase(v){ phase = v; },
    get nextId(){ return nextId; }, set nextId(v){ nextId = v; },
    get corps(){ return corps; }, set corps(v){ corps = v; },
    get acted(){ return acted; }, set acted(v){ acted = v; },
    get deploySide(){ return deploySide; }, set deploySide(v){ deploySide = v; },
    get deployCfg(){ return deployCfg; }, set deployCfg(v){ deployCfg = v; },
    /* ---- UI 视角 / 悬停（供「真实渲染」模式做端到端 UI 自检；其它模式不触碰） ---- */
    get viewMode(){ return (typeof viewMode!=="undefined" ? viewMode : null); }, set viewMode(v){ viewMode = v; },
    get hoverCell(){ return (typeof hoverCell!=="undefined" ? hoverCell : null); }, set hoverCell(v){ hoverCell = v; },
    /* ---- 函数 ---- */
    fn: {
      /* 初始化 / 地图 */
      newGame, genMap, initGrids: (typeof initGrids!=="undefined"?initGrids:null),
      /* 部署 */
      deployConfigDefaults, readDeployInputs, confirmDeploy, spawnFromConfig, deploySpent,
      aiDeployConfig, aiAutoDeploy, aiDisguiseDeploy, startPlay,
      /* 回合 */
      endTurn, checkWin, checkBaseCapture, hasGround, onNewRound,
      tickStructures, tickReinforcements, updateExposure, takeSnapshot,
      /* AI */
      aiAct, aiActOne, aiGroupCharge, aiPlanDoctrine, aiVisFor, aiUpdateMemory,
      /* 视野 / 移动 / 战斗 */
      computeVision, unitVisibleTo, computeMoveTargets, executeMove, stationable,
      strikeRange, strikeRangeTo, canStrike, performStrike, performKatyusha, performBomb, doRest,
      chargeEligible, meleeCapable, coLocatedEnemy, aiPickTarget, aiStepToward,
      /* 工具 */
      U, getCorps, grid, key, unkey, manh, inMap, isBase, randInt, isDay, dayNo,
      enemySizeClass, typeName, unitTag, summonRemaining,
      /* 统计辅助 */
      hasGroundSide: (s)=>corps.some(p=>p.alive&&p.side===s),

      /* ---- 可选优化：视野计算缓存（same-turn memoization） ----
         作用：AI 决策内部会在同一回合反复调用 computeVision（每次 O(单位数×N²)）。
         做法：以「回合号 + 己方各单位(位置/视程) + 全图光照/烟雾」构造指纹，
         指纹相同则直接返回上一次的 Set。任何会改变视野的因素都在指纹里，
         因此结果与逐次重算完全等价；默认不启用，需显式开启并用 selfcheck 验证。 */
      __installVisionCache: function(){
        if (typeof computeVision !== "function" || computeVision.__cached) return false;
        const orig = computeVision;
        const hash = (h, x) => (Math.imul(h, 31) + (x|0)) | 0;
        // 地图身份：地形若被重建（换图/新一局）则 id 变化；配合显式 reset 双保险
        const mapIds = new WeakMap(); let nextMapId = 1;
        const mapId = () => { let v = mapIds.get(terrain); if (v === undefined) { v = nextMapId++; mapIds.set(terrain, v); } return v; };
        const fingerprint = function(side){
          let h = hash(0, turnNo);
          h = hash(h, N);
          h = hash(h, mapId());
          for (const p of corps){
            if (!p.alive || p.side !== side) continue;
            h = hash(h, p.r); h = hash(h, p.c);
            h = hash(h, visionRange(p));
            h = hash(h, U(p).air ? 1 : 0);
          }
          // 光照与烟幕都必须计入：照明弹改变 flare，烟雾弹改变 smokeLeft/smokeId
          for (let r=0;r<N;r++) for (let c=0;c<N;c++){
            const f = flare[r][c], sm = smokeLeft[r][c];
            if (f > 0 || sm > 0){
              h = hash(hash(h, r), c);
              h = hash(h, f * 31 + sm);
              h = hash(h, (typeof smokeId !== "undefined" && smokeId) ? smokeId[r][c] : 0);
            }
          }
          return h;
        };
        let lastSide = null, lastKey = null, lastVal = null;
        const wrapped = function(side){
          const k = fingerprint(side);
          if (lastVal !== null && lastSide === side && lastKey === k) return lastVal;
          const v = orig.apply(this, arguments);
          lastSide = side; lastKey = k; lastVal = v;
          return v;
        };
        wrapped.__cached = true;
        wrapped.__reset = function(){ lastSide = null; lastKey = null; lastVal = null; };
        computeVision = wrapped;
        return true;
      },
      __resetVisionCache: function(){
        if (typeof computeVision === "function" && computeVision.__reset) { computeVision.__reset(); return true; }
        return false;
      },
      __visionCacheOn: ()=>!!(typeof computeVision === "function" && computeVision.__cached),
    },
  };
  return G;
})();
`;

/* ------------------------------------------------------------------ *
 *  载入后打补丁：把纯渲染 / 快照 / 落盘类函数换成 no-op
 * ------------------------------------------------------------------ */
const NOOP_TARGETS = [
  'render', 'renderBoard', 'renderPanel', 'renderLegend', 'renderMapCard',
  'renderDeploy', 'renderViewBtn', 'renderHover',
  'showVictory', 'showWelcome',
  'takeSnapshot', 'flushRecordSave', 'beginRecord',
  // updateExposure 每回合对每个单位重算一次敌方全场视野，只用于战后「情报推测链」
  // 展示（写 p.exposedTurn / p.exposeCount），不参与 AI 决策与胜负 → 默认跳过。
  'updateExposure',
];

function applyFastPatches(sandbox, opts) {
  const patched = [];
  const targets = NOOP_TARGETS.slice();
  if (opts.keepExposure) {
    const i = targets.indexOf('updateExposure');
    if (i >= 0) targets.splice(i, 1);
  }
  if (opts.fastLog) targets.push('log');
  for (const name of targets) {
    if (typeof sandbox[name] === 'function') {
      try { sandbox[name] = NOOP; patched.push(name); } catch (e) { /* 忽略不可写 */ }
    }
  }
  return patched;
}

/* ------------------------------------------------------------------ *
 *  主入口
 * ------------------------------------------------------------------ */
function loadEngine(opts) {
  opts = opts || {};
  const htmlPath = resolveSource(opts.src);
  const html = fs.readFileSync(htmlPath, 'utf8');
  const gameJs = extractGameScript(html);
  const code = gameJs + '\n' + EXPORT_SNIPPET;

  const seed = opts.seed === undefined ? 1 : opts.seed;
  const rng = mulberry32(hashSeed(seed));
  const sandbox = buildSandbox({ rng, quiet: opts.quiet !== false });

  // DOM 写入计数（用于确认渲染确实被跳过）
  sandbox.__writeCount = 0;

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: htmlPath });

  const H = sandbox.__H;
  if (!H) throw new Error('导出层未生效：游戏代码结构可能与预期不同');

  const patched = opts.fast === false ? [] : applyFastPatches(sandbox, opts);
  let visionCache = false;
  if (opts.visionCache) {
    try { visionCache = !!H.fn.__installVisionCache(); } catch (e) { visionCache = false; }
  }

  /* ---------------- 对外 API ---------------- */
  const api = {
    src: htmlPath,
    sandbox,
    H,
    fn: H.fn,
    patched,
    visionCache,

    /** 读内部状态 */
    get(name) { return H[name]; },
    /** 写内部状态 */
    set(name, value) { H[name] = value; return value; },
    /** 设置随机种子（就地重置 RNG，后续随机序列可复现） */
    reseed(s) { const r = mulberry32(hashSeed(s)); sandbox.Math.random = r; return s; },

    /** 当前棋盘尺寸 */
    get size() { return H.N; },
    /** 存活兵团 */
    aliveCorps() { return H.corps.filter((p) => p.alive); },
    /** 某方存活兵团 */
    aliveOf(side) { return H.corps.filter((p) => p.alive && p.side === side); },

    /**
     * 以「兵力价值」衡量的某方残存实力。
     * 重火力按耐久 × 20 步兵当量折算（与游戏内消耗比一致），其余按 troops × 单价。
     */
    strength(side) {
      const UNITS = H.UNITS;
      let val = 0, men = 0;
      for (const p of H.corps) {
        if (!p.alive || p.side !== side) continue;
        const u = UNITS[p.type];
        men += p.troops || 0;
        if (u.cls === 'hf') val += (p.dur || 0) * 20;
        else if (u.air) val += (p.troops || 0) * u.cost;
        else val += (p.troops || 0) * u.cost;
      }
      return { value: val, men };
    },

    /** 单位类型统计（type -> 数量/兵力） */
    census(side) {
      const out = {};
      for (const p of H.corps) {
        if (!p.alive) continue;
        if (side !== undefined && p.side !== side) continue;
        const k = p.side + ':' + p.type;
        if (!out[k]) out[k] = { count: 0, troops: 0, dur: 0 };
        out[k].count++;
        out[k].troops += p.troops || 0;
        out[k].dur += p.dur || 0;
      }
      return out;
    },

    /** 地图信息（供统计 / 复现记录）。未开局时 terrain 尚未初始化 → 返回 null */
    mapInfo() {
      const N = H.N, t = H.terrain;
      if (!t || !t.length || !t[0]) return null;
      const hist = {};
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) hist[t[r][c]] = (hist[t[r][c]] || 0) + 1;
      return { N, kind: H.mapKind, hist, bases: H.BASES.map((b) => b.slice()) };
    },
  };
  return api;
}

/* ---------------- 独立运行支持 ---------------- */
if (require.main === module) {
  const t0 = Date.now();
  const api = loadEngine({ seed: 1 });
  console.log('[headless] 引擎载入成功');
  console.log('  源文件   :', api.src);
  console.log('  载入耗时 :', (Date.now() - t0) + 'ms');
  console.log('  兵种数   :', Object.keys(api.get('UNITS')).length);
  console.log('  no-op 补丁:', api.patched.join(', ') || '(无)');
  const t1 = Date.now();
  api.set('aiSide', -1);
  api.set('gameBudget', [3000, 3000]);
  api.fn.newGame();
  console.log('  开局耗时 :', (Date.now() - t1) + 'ms');
  console.log('  地图信息 :', JSON.stringify(api.mapInfo()));
}

module.exports = { loadEngine, mulberry32, hashSeed, resolveSource, extractGameScript };
