/* 桥梁生成压测：300 张地图，验证桥位于直行格、两岸为真实陆地、恰好3座 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "battlefield-v2.html"), "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
let code = m[1].replace(/\nnewGame\(\);\s*$/, "\n");
code += `
globalThis.__T = {
  get terrain(){return terrain}, get bridge(){return bridge},
  get N(){return N}, fn: { genMap },
};`;
const elCache = {};
const stubEl = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} },
                        addEventListener() {}, appendChild() {}, innerHTML: "", textContent: "" });
const sandbox = {
  console, alert: () => {},
  document: {
    getElementById: id => (elCache[id] || (elCache[id] = stubEl())),
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => stubEl(), addEventListener() {},
  },
  window: {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const T = sandbox.__T;

let ok = 0, fail = 0; const failReasons = {};
for (let g = 0; g < 300; g++) {
  T.fn.genMap();
  const N = T.N, terrain = T.terrain, bridge = T.bridge;
  const bridges = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (bridge[r][c]) bridges.push([r, c]);
  let good = true, why = "";
  if (bridges.length !== 3) { good = false; why = "桥数=" + bridges.length; }
  for (const [r, c] of bridges) {
    if (terrain[r][c] !== "river") { good = false; why = "桥不在河上"; break; }
    if (!(terrain[r - 1] && terrain[r - 1][c] === "river") || !(terrain[r + 1] && terrain[r + 1][c] === "river")) {
      good = false; why = "桥位非直行格"; break;
    }
    const L = terrain[r][c - 1], R = terrain[r][c + 1];
    const land = (t) => t === "plain" || t === "highland";
    if (!land(L) || !land(R)) { good = false; why = `岸不可通行(${L}/${R})`; break; }
  }
  if (good) ok++; else { fail++; failReasons[why] = (failReasons[why] || 0) + 1; }
}
console.log(`300 张地图：桥梁全部合法 ${ok} 张，失败 ${fail} 张`, fail ? JSON.stringify(failReasons) : "");
