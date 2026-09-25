// ============================================================
// battlefield.cpp —— 战场沙盘策略游戏（控制台版）
// 编译: g++ -std=c++17 -O2 -o battlefield battlefield.cpp
// 运行: ./battlefield   (Windows 建议在 Windows Terminal 下运行)
// ============================================================
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#endif

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <iostream>
#include <queue>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

using namespace std;

static const int N = 20; // 棋盘 20x20

// ---------------- ANSI 颜色 ----------------
static const char* RST = "\033[0m";
// 平地绿 / 高地白 / 河流蓝 / 禁地红
static const char* BG_TERRAIN[] = { "\033[42m", "\033[47m", "\033[44m", "\033[41m" };
static const char* BG_BRIDGE = "\033[43m";   // 桥:黄色
static const char* FG_SIDE[] = { "\033[91m", "\033[94m" }; // 红方/蓝方

// ---------------- 基础枚举 ----------------
enum Terrain  { PLAIN = 0, HIGHLAND, RIVER, FORBIDDEN };
enum UnitType { INFANTRY = 0, CAVALRY, ARTILLERY };
enum Side     { RED = 0, BLUE = 1 };

const char* unitChar(UnitType t) { return t == INFANTRY ? "步" : t == CAVALRY ? "骑" : "炮"; }
const char* typeName(UnitType t) { return t == INFANTRY ? "步兵" : t == CAVALRY ? "骑兵" : "炮兵"; }

// ---------------- 数据结构 ----------------
struct Corps {
    int      id = 0;
    Side     side = RED;
    UnitType type = INFANTRY;
    int      troops = 0;
    int      r = 0, c = 0;
    bool     resting = false;   // 休整状态
    int      fatigue = 0;       // 骑兵奔袭3格后的疲劳(>0 时不能移动)
    bool     alive = true;
};

Terrain terrain[N][N];
bool    bridge[N][N];
bool    fort[N][N];
int     basePos[2][2] = { {2,2}, {16,16} }; // 0-indexed: 第3行第3列 / 第17行第17列
const char* sideName[] = { "红方", "蓝方" };

vector<Corps> corps;
int  nextId  = 1;
bool gameOver = false;
Side winner  = RED;

mt19937 rng((unsigned)time(nullptr));

// ---------------- 工具函数 ----------------
bool inMap(int r, int c) { return r >= 0 && r < N && c >= 0 && c < N; }

// 该格是否可以驻扎/进入(禁地不可, 无桥河流不可)
bool stationable(int r, int c) {
    if (!inMap(r, c)) return false;
    Terrain t = terrain[r][c];
    if (t == FORBIDDEN) return false;
    if (t == RIVER && !bridge[r][c]) return false;
    return true;
}

bool isBase(int r, int c) {
    return (r == basePos[0][0] && c == basePos[0][1]) ||
           (r == basePos[1][0] && c == basePos[1][1]);
}

// 该格第一个存活兵团的下标, 没有则 -1
int corpsIndexAt(int r, int c) {
    for (size_t i = 0; i < corps.size(); i++)
        if (corps[i].alive && corps[i].r == r && corps[i].c == c) return (int)i;
    return -1;
}

// 该格敌方兵团下标
int enemyIndexAt(int r, int c, Side s) {
    for (size_t i = 0; i < corps.size(); i++)
        if (corps[i].alive && corps[i].side != s && corps[i].r == r && corps[i].c == c)
            return (int)i;
    return -1;
}

// ---------------- 输入 ----------------
int readInt(const string& prompt, int lo, int hi) {
    while (true) {
        cout << prompt;
        string line;
        if (!getline(cin, line)) { cout << "\n输入流结束, 游戏退出。\n"; exit(0); }
        stringstream ss(line);
        int v; char extra;
        if (ss >> v && !(ss >> extra) && v >= lo && v <= hi) return v;
        cout << "  输入无效, 请输入 " << lo << " ~ " << hi << " 之间的整数。\n";
    }
}

// ---------------- 地图生成 ----------------
// 生成一条自上而下的蜿蜒河流(四方向随机游走, 严格连通, 不自交, 避开大本营附近)
bool tryRiver(vector<pair<int,int>>& path) {
    path.clear();
    int c = 3 + (int)(rng() % 14);
    int r = 0;
    set<pair<int,int>> vis;
    int guard = 0;
    while (true) {
        if (++guard > 200000) return false;
        if (vis.count({ r, c })) return false;
        vis.insert({ r, c });
        path.push_back({ r, c });
        if (r == N - 1) return true;
        // 只允许四方向行走(下/左/右), 保证河流严格连通; 向下权重更高
        vector<pair<int,int>> cand;
        if (r + 1 < N && !vis.count({ r + 1, c })) {
            cand.push_back({ r + 1, c });
            cand.push_back({ r + 1, c });
            cand.push_back({ r + 1, c });
        }
        if (c - 1 >= 0 && !vis.count({ r, c - 1 })) cand.push_back({ r, c - 1 });
        if (c + 1 < N  && !vis.count({ r, c + 1 })) cand.push_back({ r, c + 1 });
        if (cand.empty()) return false;
        auto nxt = cand[rng() % cand.size()];
        r = nxt.first; c = nxt.second;
    }
}

void genMap() {
    for (int attempt = 0; attempt < 500; attempt++) {
        // 禁地:高地:平地 = 40:80:280 (即 1:2:7), 随机铺开
        vector<int> cells;
        for (int i = 0; i < 40;  i++) cells.push_back(FORBIDDEN);
        for (int i = 0; i < 80;  i++) cells.push_back(HIGHLAND);
        for (int i = 0; i < 280; i++) cells.push_back(PLAIN);
        shuffle(cells.begin(), cells.end(), rng);
        for (int r = 0; r < N; r++)
            for (int c = 0; c < N; c++)
                terrain[r][c] = (Terrain)cells[r * N + c];

        // 河流
        vector<pair<int,int>> river;
        if (!tryRiver(river)) continue;

        // 河流必须避开两个大本营周围(切比雪夫距离>=2), 保证大本营区域完整
        bool ok = true;
        for (auto& [r, c] : river) {
            for (int s = 0; s < 2; s++)
                if (max(abs(r - basePos[s][0]), abs(c - basePos[s][1])) <= 1) { ok = false; break; }
            if (!ok) break;
        }
        if (!ok) continue;
        if ((int)river.size() < 12) continue; // 河流太短重新生成

        for (auto& [r, c] : river) { terrain[r][c] = RIVER; bridge[r][c] = false; }

        // 大本营设为高地, 周围一圈清除禁地
        for (int s = 0; s < 2; s++) {
            int br = basePos[s][0], bc = basePos[s][1];
            terrain[br][bc] = HIGHLAND;
            for (int dr = -1; dr <= 1; dr++)
                for (int dc = -1; dc <= 1; dc++)
                    if (inMap(br + dr, bc + dc) && terrain[br + dr][bc + dc] == FORBIDDEN)
                        terrain[br + dr][bc + dc] = PLAIN;
        }

        // 三座桥: 约在河流 1/4、1/2、3/4 处, 带随机抖动且彼此拉开距离
        int L = (int)river.size();
        vector<int> idxs;
        bool okb = false;
        for (int t = 0; t < 100 && !okb; t++) {
            idxs.clear();
            int cand[3] = { L / 4, L / 2, 3 * L / 4 };
            for (int k = 0; k < 3; k++) {
                int j = cand[k] + (int)(rng() % (max(1, L / 8) + 1)) - max(1, L / 16);
                j = max(1, min(L - 2, j));
                idxs.push_back(j);
            }
            sort(idxs.begin(), idxs.end());
            okb = (idxs[1] - idxs[0] >= 3) && (idxs[2] - idxs[1] >= 3) &&
                  (idxs[0] != idxs[1] && idxs[1] != idxs[2]);
        }
        if (!okb) continue;
        for (int idx : idxs) bridge[river[idx].first][river[idx].second] = true;

        // 清空工事
        for (int r = 0; r < N; r++)
            for (int c = 0; c < N; c++) fort[r][c] = false;
        return;
    }
    // 理论上不会走到这里
    fprintf(stderr, "地图生成失败\n");
    exit(1);
}

// ---------------- 兵团初始化 ----------------
void initCorps() {
    corps.clear();
    nextId = 1;
    for (int s = 0; s < 2; s++) {
        const UnitType types[] = { INFANTRY, CAVALRY, ARTILLERY };
        const int troops[]     = { 400, 50, 30 };
        for (int k = 0; k < 3; k++) {
            Corps cp;
            cp.id = nextId++;
            cp.side = (Side)s;
            cp.type = types[k];
            cp.troops = troops[k];
            cp.r = basePos[s][0];
            cp.c = basePos[s][1];
            corps.push_back(cp);
        }
    }
}

// ---------------- 战斗结算 ----------------
void annihilate(Corps& cp) { cp.troops = 0; cp.alive = false; }

// 每轮基础损耗: 步:骑 = 1:3(骑兵损耗是步兵3倍), 其余对战 1:1
// 修正: 休整减半; 高地驻扎减半; 被进攻方处于工事上减半(仅守方)
int roundLoss(const Corps& self, const Corps& other, bool isDefender) {
    int base = (self.type == CAVALRY && other.type == INFANTRY) ? 3 : 1;
    double m = 1.0;
    if (self.resting) m *= 0.5;
    if (terrain[self.r][self.c] == HIGHLAND) m *= 0.5;
    if (isDefender && fort[self.r][self.c]) m *= 0.5;
    return max(1, (int)ceil(base * m));
}

// 近身消耗战, 直至一方完全阵亡(可能同归于尽)
void attrition(Corps& atk, Corps& def) {
    while (atk.alive && def.alive) {
        int la = roundLoss(atk, def, false);
        int ld = roundLoss(def, atk, true);
        atk.troops -= la;
        def.troops -= ld;
        if (atk.troops <= 0) annihilate(atk);
        if (def.troops <= 0) annihilate(def);
    }
}

// 攻方已站在目标格, 依次与格内守方兵团交战
void resolveMelee(Corps& atk) {
    int r = atk.r, c = atk.c;
    while (atk.alive) {
        int di = -1;
        for (size_t i = 0; i < corps.size(); i++) {
            const Corps& d = corps[i];
            if (d.alive && d.side != atk.side && d.r == r && d.c == c) { di = (int)i; break; }
        }
        if (di < 0) break; // 格内已无敌军, 攻方占据该格
        Corps& def = corps[di];
        // 炮兵遭遇骑兵/步兵: 炮兵全歼
        if (atk.type == ARTILLERY && def.type != ARTILLERY) { annihilate(atk); break; }
        // 步骑进攻炮兵: 炮兵全歼
        if (def.type == ARTILLERY && atk.type != ARTILLERY) { annihilate(def); continue; }
        attrition(atk, def); // 炮vs炮 或 步/骑互搏
    }
}

void checkWin() {
    // 占领对方大本营
    for (auto& cp : corps) {
        if (!cp.alive) continue;
        if (cp.r == basePos[1 - cp.side][0] && cp.c == basePos[1 - cp.side][1]) {
            gameOver = true; winner = cp.side; return;
        }
    }
    // 一方全灭
    bool red = false, blue = false;
    for (auto& cp : corps) if (cp.alive) (cp.side == RED ? red : blue) = true;
    if (!red || !blue) { gameOver = true; winner = red ? RED : BLUE; }
}

// ---------------- 移动 ----------------
// BFS 寻路: 途经格不可有兵团且可驻扎; 终点可为敌/友军所在格
vector<pair<int,int>> findPath(int sr, int sc, int tr, int tc, int maxSteps) {
    if (!stationable(tr, tc) || (sr == tr && sc == tc)) return {};
    vector<vector<int>> dist(N, vector<int>(N, -1));
    vector<vector<pair<int,int>>> prev(N, vector<pair<int,int>>(N, { -1,-1 }));
    queue<pair<int,int>> q;
    dist[sr][sc] = 0;
    q.push({ sr, sc });
    const int dr[] = { 1,-1,0,0 }, dc[] = { 0,0,1,-1 };
    while (!q.empty()) {
        auto [r, c] = q.front(); q.pop();
        if (r == tr && c == tc) break;
        for (int i = 0; i < 4; i++) {
            int nr = r + dr[i], nc = c + dc[i];
            if (!inMap(nr, nc) || dist[nr][nc] != -1 || !stationable(nr, nc)) continue;
            if (corpsIndexAt(nr, nc) >= 0 && !(nr == tr && nc == tc)) continue; // 不可穿越兵团
            dist[nr][nc] = dist[r][c] + 1;
            prev[nr][nc] = { r, c };
            q.push({ nr, nc });
        }
    }
    if (dist[tr][tc] == -1 || dist[tr][tc] > maxSteps) return {};
    vector<pair<int,int>> path;
    pair<int,int> cur = { tr, tc };
    while (!(cur.first == sr && cur.second == sc)) {
        path.push_back(cur);
        cur = prev[cur.first][cur.second];
    }
    reverse(path.begin(), path.end());
    return path;
}

void executeMove(Corps& cp, const vector<pair<int,int>>& path) {
    bool fought = false;
    int steps = 0;
    for (auto& [r, c] : path) {
        steps++;
        cp.r = r; cp.c = c;
        int ei = enemyIndexAt(r, c, cp.side);
        if (ei >= 0) { fought = true; resolveMelee(cp); break; }
    }
    // 移动后未发生进攻 → 休整状态解除
    if (!fought) cp.resting = false;
    // 骑兵奔袭3格 → 下个自己回合不能移动
    if (cp.alive && cp.type == CAVALRY && steps >= 3) cp.fatigue = 2;
    checkWin();
}

// ---------------- 显示 ----------------
string cellToken(int r, int c) {
    string s;
    const char* bg = bridge[r][c] ? BG_BRIDGE : BG_TERRAIN[terrain[r][c]];
    int ci = corpsIndexAt(r, c);
    if (ci >= 0) {
        Corps& cp = corps[ci];
        return string(bg) + FG_SIDE[cp.side] + unitChar(cp.type) + RST;
    }
    if (bridge[r][c]) return string(bg) + "==" + RST;
    if (isBase(r, c)) return string(bg) + "\033[30m营" + RST;
    if (fort[r][c])   return string(bg) + "\033[30m# " + RST;
    return string(bg) + "  " + RST;
}

void printMap() {
    printf("     ");
    for (int c = 0; c < N; c++) printf("%2d", c + 1);
    printf("\n");
    for (int r = 0; r < N; r++) {
        printf(" %2d  ", r + 1);
        for (int c = 0; c < N; c++) printf("%s", cellToken(r, c).c_str());
        printf("%s\n", RST);
    }
    printf("图例: 绿=平地  白=高地(营=大本营)  蓝=河流  红=禁地  黄==桥  "
           "步/骑/炮=兵团(亮红=红方,亮蓝=蓝方)  #=防御工事\n");
}

void printCorpsList(Side s) {
    printf("\n%s军团列表:\n", sideName[s]);
    for (auto& cp : corps) {
        if (!cp.alive || cp.side != s) continue;
        string st = cp.resting ? " [休整中]" : "";
        if (cp.fatigue > 0) st += " [疲劳:本回合不能移动]";
        printf("  #%d  %s  兵力%-4d  位置(%d,%d)%s\n",
               cp.id, typeName(cp.type), cp.troops, cp.r + 1, cp.c + 1, st.c_str());
    }
}

void showFrame(Side cur) {
    printf("\033[2J\033[H"); // 清屏
    printf("========== 战场沙盘策略游戏 ==========   当前行动方: %s\n\n", sideName[cur]);
    printMap();
    printCorpsList(cur);
    printf("\n");
}

// ---------------- 指令实现 ----------------
bool doMove(Corps& cp) {
    if (cp.type == CAVALRY && cp.fatigue > 0) {
        printf("  该骑兵兵团正处于疲劳状态, 本回合不能移动。\n");
        return false;
    }
    int steps = 1;
    if (cp.type == CAVALRY)
        steps = readInt("  移动步数(1-3, 走3格下回合不能移动): ", 1, 3);
    int tr = readInt("  目标行(1-20): ", 1, 20) - 1;
    int tc = readInt("  目标列(1-20): ", 1, 20) - 1;
    auto path = findPath(cp.r, cp.c, tr, tc, steps);
    if (path.empty()) {
        printf("  无法在 %d 步内到达 (%d,%d) —— 请检查距离/地形(禁地、无桥河流)/途中的兵团。\n",
               steps, tr + 1, tc + 1);
        return false;
    }
    executeMove(cp, path);
    if (cp.alive)
        printf("  军团 #%d 移动至 (%d,%d)。%s\n", cp.id, cp.r + 1, cp.c + 1,
               cp.resting ? "(交战, 休整保持)" : "");
    return true;
}

bool doSplit(Corps& cp) {
    if (cp.troops < 6) { printf("  兵力不足, 无法分兵(新军团需不少于5人且原军团至少保留1人)。\n"); return false; }
    int n = readInt("  分出的兵力(5 ~ " + to_string(cp.troops - 1) + "): ", 5, cp.troops - 1);
    vector<pair<int,int>> spots;
    for (int dr = -1; dr <= 1; dr++)
        for (int dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            int nr = cp.r + dr, nc = cp.c + dc;
            if (stationable(nr, nc) && corpsIndexAt(nr, nc) < 0) spots.push_back({ nr, nc });
        }
    if (spots.empty()) { printf("  周围没有可驻扎的空格, 无法分兵。\n"); return false; }
    printf("  可放置位置:\n");
    for (size_t i = 0; i < spots.size(); i++)
        printf("    %d) (%d,%d)\n", (int)i + 1, spots[i].first + 1, spots[i].second + 1);
    int k = readInt("  选择位置: ", 1, (int)spots.size()) - 1;
    Corps nc;
    nc.id = nextId++;
    nc.side = cp.side;
    nc.type = cp.type;
    nc.troops = n;
    nc.r = spots[k].first;
    nc.c = spots[k].second;
    corps.push_back(nc);
    cp.troops -= n;
    printf("  新建军团 #%d (%s x%d) 于 (%d,%d)。\n",
           nc.id, typeName(nc.type), n, nc.r + 1, nc.c + 1);
    return true;
}

bool doMerge(Corps& cp) {
    vector<int> cand;
    for (size_t i = 0; i < corps.size(); i++) {
        Corps& o = corps[i];
        if (!o.alive || o.side != cp.side || o.type != cp.type || o.id == cp.id) continue;
        if (max(abs(o.r - cp.r), abs(o.c - cp.c)) <= 1) cand.push_back((int)i);
    }
    if (cand.empty()) { printf("  周围没有同兵种的友方军团, 无法合兵。\n"); return false; }
    printf("  可合并目标:\n");
    for (size_t i = 0; i < cand.size(); i++) {
        Corps& o = corps[cand[i]];
        printf("    %d) 军团 #%d %s 兵力%d @ (%d,%d)\n",
               (int)i + 1, o.id, typeName(o.type), o.troops, o.r + 1, o.c + 1);
    }
    int k = readInt("  选择目标: ", 1, (int)cand.size()) - 1;
    Corps& tgt = corps[cand[k]];
    tgt.troops += cp.troops;
    printf("  军团 #%d 并入军团 #%d, 合并后兵力 %d。\n", cp.id, tgt.id, tgt.troops);
    cp.alive = false;
    return true;
}

bool doRest(Corps& cp) {
    cp.resting = true;
    printf("  军团 #%d 进入休整状态(被攻击时损耗减半)。\n", cp.id);
    return true;
}

bool doArtilleryStrike(Corps& cp) {
    vector<int> targets;
    for (size_t i = 0; i < corps.size(); i++) {
        Corps& t = corps[i];
        if (!t.alive || t.side == cp.side) continue;
        int d = max(abs(t.r - cp.r), abs(t.c - cp.c));
        bool ok = false;
        if (!cp.resting && d <= 2) ok = true;                                   // 未休整: 射程2, 任意目标
        else if (cp.resting) {
            if (terrain[cp.r][cp.c] == HIGHLAND && d <= 3) ok = true;           // 高地休整: 射程3, 任意目标
            else if (d <= 3 && !t.resting) ok = true;                           // 普通休整: 射程3, 仅未休整目标
        }
        if (ok) targets.push_back((int)i);
    }
    if (targets.empty()) { printf("  射程内没有满足条件的攻击目标。\n"); return false; }
    printf("  可攻击目标:\n");
    for (size_t i = 0; i < targets.size(); i++) {
        Corps& t = corps[targets[i]];
        printf("    %d) #%d %s %s 兵力%d @ (%d,%d)%s\n", (int)i + 1, t.id,
               sideName[t.side], typeName(t.type), t.troops, t.r + 1, t.c + 1,
               t.resting ? " [休整中]" : "");
    }
    int k = readInt("  选择目标: ", 1, (int)targets.size()) - 1;
    Corps& t = corps[targets[k]];
    int dmg = cp.troops;
    if (fort[t.r][t.c]) dmg = (dmg + 1) / 2; // 目标处于防御工事上, 损耗减半
    int realLoss = min(dmg, t.troops);
    t.troops -= dmg;
    printf("  炮击命中! %s军团 #%d 损失 %d 人。\n", sideName[t.side], t.id, realLoss);
    if (t.troops <= 0) { annihilate(t); printf("  该兵团已被全歼!\n"); }
    checkWin();
    return true;
}

bool adjacentCellsWith(const Corps& cp, bool wantFort, vector<pair<int,int>>& out) {
    out.clear();
    for (int dr = -1; dr <= 1; dr++)
        for (int dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            int nr = cp.r + dr, nc = cp.c + dc;
            if (stationable(nr, nc) && (fort[nr][nc] == wantFort)) out.push_back({ nr, nc });
        }
    return !out.empty();
}

bool pickCell(const vector<pair<int,int>>& cells, pair<int,int>& out) {
    printf("  相邻格子:\n");
    for (size_t i = 0; i < cells.size(); i++)
        printf("    %d) (%d,%d)%s\n", (int)i + 1, cells[i].first + 1, cells[i].second + 1,
               fort[cells[i].first][cells[i].second] ? " [有工事]" : "");
    int k = readInt("  选择格子: ", 1, (int)cells.size()) - 1;
    out = cells[k];
    return true;
}

bool doBuildFort(Corps& cp) {
    if (!cp.resting) { printf("  步兵必须处于休整状态才能建造工事。\n"); return false; }
    vector<pair<int,int>> cells;
    if (!adjacentCellsWith(cp, false, cells) || cells.empty()) {
        printf("  周围没有可建造工事的格子。\n"); return false;
    }
    pair<int,int> p;
    pickCell(cells, p);
    fort[p.first][p.second] = true;
    printf("  已在 (%d,%d) 建造防御工事。\n", p.first + 1, p.second + 1);
    return true;
}

bool doDestroyFort(Corps& cp, bool needRest) {
    if (needRest && !cp.resting) {
        printf("  步兵必须处于休整状态才能摧毁工事。\n"); return false;
    }
    vector<pair<int,int>> cells;
    if (!adjacentCellsWith(cp, true, cells) || cells.empty()) {
        printf("  周围没有防御工事。\n"); return false;
    }
    pair<int,int> p;
    pickCell(cells, p);
    fort[p.first][p.second] = false;
    printf("  已摧毁 (%d,%d) 的防御工事。\n", p.first + 1, p.second + 1);
    return true;
}

// 执行一条指令, 返回是否消耗了该军团的行动机会
bool commandMenu(Corps& cp) {
    printf("---- 指挥军团 #%d (%s %s 兵力%d @ (%d,%d)%s) ----\n",
           cp.id, sideName[cp.side], typeName(cp.type), cp.troops, cp.r + 1, cp.c + 1,
           cp.resting ? " [休整中]" : "");
    printf("  1) 移动   2) 分兵   3) 合兵   4) 休整");
    if (cp.type == ARTILLERY) printf("   5) 炮击");
    if (cp.type == INFANTRY)  printf("   5) 建造工事(需休整)   6) 摧毁工事(需休整)");
    if (cp.type == CAVALRY)   printf("   5) 拆毁工事");
    printf("   0) 返回\n");
    int cmd = readInt("  选择指令: ", 0, 6);
    switch (cmd) {
        case 0: return false;
        case 1: return doMove(cp);
        case 2: return doSplit(cp);
        case 3: return doMerge(cp);
        case 4: return doRest(cp);
        case 5:
            if (cp.type == ARTILLERY) return doArtilleryStrike(cp);
            if (cp.type == INFANTRY)  return doBuildFort(cp);
            if (cp.type == CAVALRY)   return doDestroyFort(cp, false);
            return false;
        case 6:
            if (cp.type == INFANTRY) return doDestroyFort(cp, true);
            printf("  无效指令。\n");
            return false;
    }
    return false;
}

// ---------------- 回合流程 ----------------
void sideTurn(Side side) {
    set<int> acted;
    while (!gameOver) {
        showFrame(side);
        int id = readInt("请输入要指挥的军团编号(0 = 结束回合): ", 0, 999999);
        if (id == 0) break;
        int idx = -1;
        for (size_t i = 0; i < corps.size(); i++)
            if (corps[i].alive && corps[i].side == side && corps[i].id == id) { idx = (int)i; break; }
        if (idx < 0) { printf("  找不到该编号的己方存活军团, 请重试。\n"); continue; }
        if (acted.count(id)) { printf("  该军团本轮已行动过(每个军团每回合只能执行一项指令)。\n"); continue; }
        if (commandMenu(corps[idx])) {
            acted.insert(id);
            checkWin();
        }
    }
    // 回合结束: 骑兵疲劳递减(3格奔袭后下个自己回合不能移动)
    for (auto& cp : corps)
        if (cp.alive && cp.side == side && cp.fatigue > 0) cp.fatigue--;
    if (!gameOver) checkWin();
}

void printIntro() {
    printf("\033[2J\033[H");
    printf("======================================================\n");
    printf("            战 场 沙 盘 策 略 游 戏\n");
    printf("======================================================\n");
    printf("  获胜条件: 占领对方大本营(第3行第3列 / 第17行第17列, 高地)\n");
    printf("  初始兵力: 每方 400步兵 + 50骑兵 + 30炮兵(驻扎于各自大本营)\n");
    printf("  每回合可对本方每个军团执行一项指令:\n");
    printf("    移动 / 分兵(新军团不少于5) / 合兵(限同兵种) / 休整\n");
    printf("    炮兵: 炮击    步兵: 建造/摧毁工事(需休整)    骑兵: 拆毁工事\n");
    printf("  移动: 步兵1格, 骑兵1-3格(3格则下回合不能移动), 炮兵1格\n");
    printf("  禁地与无桥河流不可进入; 河流上共有三座桥(黄色)\n");
    printf("  战斗: 兵团重叠即交战直至一方全歼; 步:骑损耗=1:3, 同兵种1:1\n");
    printf("        休整/高地驻扎减损一半; 炮兵遭遇步骑即全歼\n");
    printf("        炮兵未休整射程2格, 休整射程3格(仅未休整目标), 高地休整可打休整目标\n");
    printf("        炮击伤害=炮兵数量; 工事上的被进攻方减损一半\n");
    printf("======================================================\n");
    printf("按回车开始游戏...");
    string line;
    getline(cin, line);
}

int main() {
#ifdef _WIN32
    // 启用 ANSI 转义 + UTF-8 输出
    HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
    DWORD mode = 0;
    if (GetConsoleMode(h, &mode))
        SetConsoleMode(h, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
    SetConsoleOutputCP(65001);
#endif
    genMap();
    initCorps();
    printIntro();

    Side cur = RED;
    while (!gameOver) {
        sideTurn(cur);
        if (gameOver) break;
        cur = (cur == RED) ? BLUE : RED;
    }

    showFrame(cur);
    printf("\n******************************************************\n");
    printf("  游 戏 结 束 !  %s 获 胜 !\n", sideName[winner]);
    printf("******************************************************\n");
    return 0;
}
