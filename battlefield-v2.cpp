/* ============================================================
   战场沙盘策略游戏 · 视野版（C++ 控制台移植版）
   与 battlefield-v2.html（最新网页版）规则完全一致：
   - 战争迷雾视野 / 记忆地形 / 视角切换（自动/红/蓝/上帝）
   - 昼夜交替（每10回合转换，20回合=1天）
   - 9 兵种 1000 积分部署
   - 近战小数累积损耗 / 远程打击（脱敏战报：只报消灭人数、
     载具耐久损耗与敌方规模变化）
   - 喀秋莎 3×3 面杀伤 / 轰炸机延迟导弹 / 防空地堡3次耐久
   - 照明弹 / 烟雾弹 / 空中回营补给 / 大本营雷达
   - 战报日志分方可见（只显示己方行动 + 公开情报）
   - 桥梁只在河流直行格生成、两岸均为可通行陆地

   编译： g++ -std=c++17 -O2 -o battlefield-v2 battlefield-v2.cpp
   运行： Windows Terminal（若乱码先执行 chcp 65001）
   ============================================================ */

#include <iostream>
#include <string>
#include <vector>
#include <set>
#include <map>
#include <queue>
#include <sstream>
#include <algorithm>
#include <random>
#include <iomanip>
#include <cmath>
#include <climits>
#include <cstdlib>
#include <cstring>
#include <ctime>
using namespace std;

/* ---------------- 基础常量 ---------------- */
static const int N = 20;
static const int BUDGET = 1000;
static const int BASES[2][2] = { {2,2}, {16,16} };   // 0起始：第3行第3列 / 第17行第17列
static const char* SIDE_NAME[2] = { "红方", "蓝方" };

enum Terrain { PLAIN = 0, HIGHLAND = 1, RIVER = 2, FORBID = 3 };

/* 兵种表 */
enum { T_INF, T_CAV, T_LIGHT, T_SCOUT, T_HEAVY, T_TANK, T_KAT, T_RECON, T_BOMBER, T_N };
struct Spec {
    const char* ch; const char* name;
    int cost, move, vision;
    bool melee, air, veh, ranged, canRest, scout, heavy;
    int dur;                                          // 载具耐久上限（0=无）
    bool area, throwable, missile;
};
static const Spec SPEC[T_N] = {
    /* ch   name    cost move vis melee air   veh   rngd  rest  scout heavy dur  area  thow  msil */
    { "步", "步兵",   1,   1,   2,  true, false,false,false,true, false,false,0,   false,false,false },
    { "骑", "骑兵",   4,   3,   3,  true, false,false,false,true, false,false,0,   false,false,false },
    { "轻", "轻炮兵", 5,   1,   3,  false,false,false,true, true, false,false,0,   false,false,false },
    { "侦", "侦察兵", 5,   2,   6,  false,false,false,false,true, true, false,0,   false,true, false },
    { "重", "重炮兵", 10,  1,   3,  false,false,false,true, true, false,true, 0,   false,false,false },
    { "坦", "坦克",   50,  2,   4,  true, false,true, true, true, false,false,3,   false,false,false },
    { "喀", "喀秋莎", 50,  2,   4,  true, false,true, true, true, false,false,3,   true, false,false },
    { "机", "侦查机", 100, 2,   3,  false,true, true, false,false,false,false,0,   false,true, false },
    { "轰", "轰炸机", 200, 2,   3,  false,true, true, false,false,false,false,0,   false,true, true  },
};
static const int DEPLOY_ORDER[T_N] = { T_INF,T_CAV,T_LIGHT,T_SCOUT,T_HEAVY,T_TANK,T_KAT,T_RECON,T_BOMBER };
static const int RECOMMEND[T_N] = { 400, 30, 20, 4, 10, 2, 1, 1, 0 };

/* 兵团 */
struct Corps {
    int id, side, type, troops, r, c, dur;
    double acc;
    int fatigue, flare, smoke, missile;
    bool resting, alive, ammo;
    Corps() : id(0), side(0), type(0), troops(0), r(0), c(0), dur(0), acc(0.0),
              fatigue(0), flare(0), smoke(0), missile(0),
              resting(false), alive(true), ammo(false) {}
};

struct PendingMissile { int r, c, side, shooterId; };
struct LogEntry { string msg; int side; };                 // side=-1 公开

/* ---------------- 全局状态 ---------------- */
static int  terrain[N][N];
static bool bridge_[N][N], fort_[N][N], bunkerDead_[N][N];
static int  bunker_[N][N], flareT_[N][N], smokeLeft_[N][N], smokeId_[N][N];
static bool seen_[2][N][N];
static vector<Corps> corps;
static int  nextId = 1;
static int  current = 0, turnNo = 1;
static set<int> acted;
static int  selId = 0;                    // 0 = 未选中
static bool gameOver = false; static int winner = 0;
enum Phase { PH_DEPLOY, PH_HANDOFF, PH_PLAY };
static Phase phase = PH_DEPLOY;
static int  deploySide = 0;
static vector<int> deployCfg(T_N, 0);
static vector<PendingMissile> pendingMissiles;
static int  smokeSeq = 1;
static bool memoryFog = true;
static string viewMode = "auto";          // auto / red / blue / god
static vector<LogEntry> logEntries;

/* ---------------- 工具 ---------------- */
static int randInt(int a, int b) { return a + rand() % (b - a + 1); }
static int manh(int r1, int c1, int r2, int c2) { return abs(r1 - r2) + abs(c1 - c2); }
static bool inMap(int r, int c) { return r >= 0 && r < N && c >= 0 && c < N; }
static int cellKey(int r, int c) { return r * N + c; }
static bool isBaseCell(int r, int c) {
    return (r == BASES[0][0] && c == BASES[0][1]) || (r == BASES[1][0] && c == BASES[1][1]);
}
static Corps* getCorps(int id) {
    for (auto& p : corps) if (p.id == id) return &p;
    return nullptr;
}
static bool isDay() { return ((turnNo - 1) / 10) % 2 == 0; }
static int  dayNo() { return (turnNo - 1) / 20 + 1; }
static const char* typeName(int t) { return SPEC[t].name; }
static string posStr(int r, int c) { return "(" + to_string(r + 1) + "," + to_string(c + 1) + ")"; }
static string corpsLabel(const Corps& p) {
    return string(SIDE_NAME[p.side]) + typeName(p.type) + "#" + to_string(p.id);
}

/* ---------------- 日志（分方可见） ---------------- */
// side: -1=公开情报, -2=默认当前行动方, 0/1=指定方
static void logMsg(const string& msg, int side = -2) {
    int sd = (side == -2) ? current : side;
    logEntries.push_back({ msg, sd });
    if (logEntries.size() > 400)
        logEntries.erase(logEntries.begin(), logEntries.begin() + (logEntries.size() - 400));
}
static void death(Corps& p) { p.troops = 0; p.alive = false; p.acc = 0.0; }

/* ---------------- 地图生成 ---------------- */
static bool stationable(int r, int c) {
    if (!inMap(r, c)) return false;
    if (terrain[r][c] == FORBID) return false;
    if (terrain[r][c] == RIVER && !bridge_[r][c]) return false;
    return true;
}
static bool airStationable(int r, int c) { return inMap(r, c); }

static vector<pair<int,int>> tryRiver() {
    set<int> vis; vector<pair<int,int>> path;
    int c = randInt(3, 16), r = 0; int guard = 0;
    while (true) {
        if (++guard > 200000) return {};
        if (vis.count(cellKey(r, c))) return {};
        vis.insert(cellKey(r, c)); path.push_back(make_pair(r, c));
        if (r == N - 1) return path;
        vector<pair<int,int>> cand;
        if (r + 1 < N && !vis.count(cellKey(r + 1, c))) {
            cand.push_back(make_pair(r + 1, c));
            cand.push_back(make_pair(r + 1, c));
            cand.push_back(make_pair(r + 1, c));
        }
        if (c - 1 >= 0 && !vis.count(cellKey(r, c - 1))) cand.push_back(make_pair(r, c - 1));
        if (c + 1 < N  && !vis.count(cellKey(r, c + 1))) cand.push_back(make_pair(r, c + 1));
        if (cand.empty()) return {};
        pair<int,int> nxt = cand[randInt(0, (int)cand.size() - 1)];
        r = nxt.first; c = nxt.second;
    }
}

static void genMap() {
    for (int attempt = 0; attempt < 800; attempt++) {
        vector<int> cells;
        for (int i = 0; i < 40; i++)  cells.push_back(FORBID);
        for (int i = 0; i < 80; i++)  cells.push_back(HIGHLAND);
        for (int i = 0; i < 280; i++) cells.push_back(PLAIN);
        mt19937 rng((unsigned)(time(nullptr) ^ (attempt * 7919 + 3)));
        shuffle(cells.begin(), cells.end(), rng);
        for (int r = 0; r < N; r++)
            for (int c = 0; c < N; c++) terrain[r][c] = cells[r * N + c];
        for (int r = 0; r < N; r++)
            for (int c = 0; c < N; c++) {
                bridge_[r][c] = false; fort_[r][c] = false; bunkerDead_[r][c] = false;
                bunker_[r][c] = 0; flareT_[r][c] = 0; smokeLeft_[r][c] = 0; smokeId_[r][c] = 0;
            }
        vector<pair<int,int>> river = tryRiver();
        if (river.empty()) continue;
        bool ok = true;
        for (size_t i = 0; i < river.size() && ok; i++)
            for (int s = 0; s < 2; s++)
                if (manh(river[i].first, river[i].second, BASES[s][0], BASES[s][1]) <= 1) { ok = false; break; }
        if (!ok || (int)river.size() < 12) continue;
        for (size_t i = 0; i < river.size(); i++) terrain[river[i].first][river[i].second] = RIVER;
        for (int s = 0; s < 2; s++) {
            int br = BASES[s][0], bc = BASES[s][1];
            terrain[br][bc] = HIGHLAND;
            for (int dr = -1; dr <= 1; dr++) for (int dc = -1; dc <= 1; dc++) {
                int r = br + dr, c = bc + dc;
                if (inMap(r, c) && terrain[r][c] == FORBID) terrain[r][c] = PLAIN;
            }
        }
        int L = (int)river.size();
        // 桥位候选：河流在该格"直行"（上下游同列不拐弯），且左右两岸均为地图内真实陆地
        vector<int> cand;
        for (int i = 1; i < L - 1; i++) {
            int r = river[i].first,   c = river[i].second;
            int pr = river[i-1].first, pc = river[i-1].second;
            int nr = river[i+1].first, nc = river[i+1].second;
            if (pc != c || nc != c) continue;                       // 上下游必须同列 → 直行通过
            if (abs(pr - r) != 1 || abs(nr - r) != 1) continue;
            if (c - 1 < 0 || c + 1 >= N) continue;                  // 两岸必须都在地图内
            int bankL = terrain[r][c-1], bankR = terrain[r][c+1];
            if (bankL != PLAIN && bankL != HIGHLAND) continue;      // 两岸禁地/河流 → 无法过河
            if (bankR != PLAIN && bankR != HIGHLAND) continue;
            cand.push_back(i);
        }
        // 前/中/后三段各随机取一，间隔≥3
        bool found = false; int idxs[3] = { 0,0,0 };
        for (int t = 0; t < 300 && !found; t++) {
            vector<int> z1, z2, z3;
            for (size_t i = 0; i < cand.size(); i++) {
                int ii = cand[i];
                if (ii < L / 3) z1.push_back(ii);
                else if (ii < 2 * L / 3) z2.push_back(ii);
                else z3.push_back(ii);
            }
            if (z1.empty() || z2.empty() || z3.empty()) break;
            int p[3] = { z1[randInt(0,(int)z1.size()-1)],
                         z2[randInt(0,(int)z2.size()-1)],
                         z3[randInt(0,(int)z3.size()-1)] };
            sort(p, p + 3);
            if (p[1] - p[0] >= 3 && p[2] - p[1] >= 3) {
                idxs[0] = p[0]; idxs[1] = p[1]; idxs[2] = p[2];
                found = true;
            }
        }
        if (!found) continue;                                       // 找不到3个合法桥位 → 重新生成
        for (int i = 0; i < 3; i++) bridge_[river[idxs[i]].first][river[idxs[i]].second] = true;
        return;
    }
    cout << "地图生成失败，请重试" << endl;
    exit(1);
}

/* ---------------- 视野系统 ---------------- */
static int smokePatchAt(int r, int c) {
    return (inMap(r, c) && smokeLeft_[r][c] > 0) ? smokeId_[r][c] : -1;
}
static bool inFlare(int r, int c) { return inMap(r, c) && flareT_[r][c] > 0; }
static vector<pair<int,int>> patchCells(int id) {
    vector<pair<int,int>> out;
    for (int r = 0; r < N; r++) for (int c = 0; c < N; c++)
        if (smokeId_[r][c] == id && smokeLeft_[r][c] > 0) out.push_back(make_pair(r, c));
    return out;
}
static bool patchHasUnit(int id, int side) {
    for (size_t i = 0; i < corps.size(); i++)
        if (corps[i].alive && corps[i].side == side && smokePatchAt(corps[i].r, corps[i].c) == id) return true;
    return false;
}
static int visionRange(const Corps& p) {
    int v;
    if (isDay()) v = SPEC[p.type].vision;
    else v = SPEC[p.type].scout ? SPEC[p.type].vision - 2 : SPEC[p.type].vision - 1;
    if (!SPEC[p.type].air && smokePatchAt(p.r, p.c) != -1) v = min(v, 1);   // 烟幕内视野降为1
    return max(1, v);
}
static set<int> computeVision(int side) {
    set<int> vis;
    for (size_t i = 0; i < corps.size(); i++) {
        const Corps& p = corps[i];
        if (!p.alive || p.side != side) continue;
        int v = visionRange(p);
        for (int r = 0; r < N; r++) for (int c = 0; c < N; c++)
            if (manh(r, c, p.r, p.c) <= v) vis.insert(cellKey(r, c));
    }
    // 烟幕内的己方单位可以看到整片烟幕
    set<int> patches;
    for (size_t i = 0; i < corps.size(); i++) {
        const Corps& p = corps[i];
        if (!p.alive || p.side != side) continue;
        int id = smokePatchAt(p.r, p.c);
        if (id != -1) patches.insert(id);
    }
    for (set<int>::iterator it = patches.begin(); it != patches.end(); ++it) {
        vector<pair<int,int>> pc = patchCells(*it);
        for (size_t j = 0; j < pc.size(); j++) vis.insert(cellKey(pc[j].first, pc[j].second));
    }
    // 照明区全图可见
    for (int r = 0; r < N; r++) for (int c = 0; c < N; c++)
        if (flareT_[r][c] > 0) vis.insert(cellKey(r, c));
    return vis;
}
static void markSeen(int side, const set<int>& vis) {
    for (set<int>::iterator it = vis.begin(); it != vis.end(); ++it) {
        int k = *it;
        seen_[side][k / N][k % N] = true;
    }
}
static bool unitVisibleTo(const Corps& u, int side, const set<int>& vis) {
    if (!u.alive) return false;
    if (u.side == side) return true;
    if (SPEC[u.type].air) return false;                 // 敌方空中单位永不可见
    if (inFlare(u.r, u.c)) return true;                 // 照明区内全图可见
    int id = smokePatchAt(u.r, u.c);
    if (id != -1) return patchHasUnit(id, side);        // 烟幕内仅同烟幕单位可见
    return vis.count(cellKey(u.r, u.c)) > 0;
}
static bool structVisibleAt(int r, int c, int side, const set<int>& vis) {
    if (!fort_[r][c] && bunker_[r][c] <= 0) return false;
    int id = smokePatchAt(r, c);
    if (id != -1 && !patchHasUnit(id, side)) return false;
    return vis.count(cellKey(r, c)) > 0;
}
/* 敌方规模：只暴露大中小 */
static string enemySizeClass(const vector<const Corps*>& stack) {
    vector<const Corps*> nonScout;
    for (size_t i = 0; i < stack.size(); i++)
        if (!SPEC[stack[i]->type].scout) nonScout.push_back(stack[i]);
    if (nonScout.empty()) return "小";                   // 全是侦察兵 → 永远小
    int pts = 0;
    for (size_t i = 0; i < nonScout.size(); i++)
        pts += SPEC[nonScout[i]->type].cost * nonScout[i]->troops;
    if (pts >= 200) return "大";
    if (pts >= 50) return "中";
    return "小";
}
static vector<const Corps*> visibleFoesAt(int side, int r, int c, const set<int>& vis) {
    vector<const Corps*> out;
    for (size_t i = 0; i < corps.size(); i++) {
        const Corps& p = corps[i];
        if (p.alive && p.side != side && p.r == r && p.c == c &&
            !SPEC[p.type].air && unitVisibleTo(p, side, vis))
            out.push_back(&p);
    }
    return out;
}

/* ---------------- 战斗：近战损耗（小数累积） ---------------- */
static bool isArtOrGroundVeh(const Corps& p) {
    return p.type == T_LIGHT || p.type == T_HEAVY || p.type == T_TANK || p.type == T_KAT;
}
static int meleeBase(int self, int opp) {
    if (self == T_INF) return 1;
    if (self == T_CAV) return (opp == T_INF) ? 3 : 1;
    if (self == T_TANK || self == T_KAT) return (opp == T_INF) ? 20 : ((opp == T_CAV) ? 10 : 1);
    return 1;
}
static double meleeLoss(const Corps& self, const Corps& opp, bool isDefender) {
    if (!SPEC[self.type].melee) return (double)self.troops;   // 无近战能力 → 被全歼
    if (!SPEC[opp.type].melee) return 0.0;                    // 对方无近战能力
    double base = (double)meleeBase(self.type, opp.type);
    double m = 1.0;
    if (self.resting) m *= 0.5;                               // 休整减半
    if (terrain[self.r][self.c] == HIGHLAND) m *= 0.5;        // 高地减半
    if (isDefender && fort_[self.r][self.c]) m *= 0.5;        // 工事(被进攻方)减半
    if (SPEC[self.type].dur) m *= self.dur / 3.0;             // 载具耐久 n/3
    return base * m;
}
struct MRound { int la, lb, aLeft, bLeft; };
struct Seg {
    int atkId, atkType, atkSide, atk0;
    int defId, defType, defSide, def0;
    bool defRest, defDead, atkDead;
    vector<MRound> rounds;
    Seg() : atkId(0), atkType(0), atkSide(0), atk0(0),
            defId(0), defType(0), defSide(0), def0(0),
            defRest(false), defDead(false), atkDead(false) {}
};
static void attrition(Corps& A, Corps& B, Seg& seg) {
    int guard = 0;
    A.acc = 0.0; B.acc = 0.0;
    while (A.alive && B.alive) {
        if (++guard > 20000) break;
        double fa = meleeLoss(A, B, false), fb = meleeLoss(B, A, true);
        A.acc += fa; B.acc += fb;
        int la = (int)floor(A.acc), lb = (int)floor(B.acc);
        A.acc -= la; B.acc -= lb;
        A.troops -= la; B.troops -= lb;
        MRound rd; rd.la = la; rd.lb = lb;
        rd.aLeft = max(0, A.troops); rd.bLeft = max(0, B.troops);
        seg.rounds.push_back(rd);
        if (A.troops <= 0) death(A);
        if (B.troops <= 0) death(B);
    }
}
static Corps* groundEnemyAt(int r, int c, int side) {
    for (size_t i = 0; i < corps.size(); i++) {
        Corps& p = corps[i];
        if (p.alive && p.side != side && p.r == r && p.c == c && !SPEC[p.type].air) return &p;
    }
    return nullptr;
}
static vector<Seg> resolveMelee(Corps* atk) {
    vector<Seg> segs;
    int r = atk->r, c = atk->c;
    while (atk->alive) {
        Corps* def = groundEnemyAt(r, c, atk->side);
        if (!def) break;
        Seg seg;
        seg.atkId = atk->id; seg.atkType = atk->type; seg.atkSide = atk->side; seg.atk0 = atk->troops;
        seg.defId = def->id; seg.defType = def->type; seg.defSide = def->side; seg.def0 = def->troops;
        seg.defRest = def->resting;
        attrition(*atk, *def, seg);
        seg.defDead = !def->alive; seg.atkDead = !atk->alive;
        segs.push_back(seg);
    }
    return segs;
}

/* ---------------- 战斗：远程打击 ---------------- */
static int strikeBase(const Corps& p) {
    if (p.type == T_LIGHT) return p.resting ? 5 : 3;
    if (p.type == T_HEAVY) return 8;
    if (p.type == T_TANK) return 20;
    if (p.type == T_KAT) return 30;
    return 0;
}
static int strikeRange(const Corps& p) {
    int hi = (terrain[p.r][p.c] == HIGHLAND) ? 1 : 0;
    if (p.type == T_LIGHT) return (p.resting ? 5 : 4) + hi;
    if (p.type == T_HEAVY) return 8 + hi;
    if (p.type == T_TANK) return (p.resting ? 4 : 3) + hi;
    if (p.type == T_KAT) return 4 + hi;
    return 0;
}
static bool canStrike(const Corps& p) {
    if (!SPEC[p.type].ranged) return false;
    if (p.type == T_HEAVY) return p.resting;            // 重炮仅休整可打
    if (p.type == T_KAT) return p.ammo;                 // 需先装填弹药
    return true;
}
static string strikeHint(const Corps& p) {
    if (p.type == T_HEAVY && !p.resting) return "重炮兵仅在休整状态下才能打击。";
    if (p.type == T_KAT && !p.ammo) return "喀秋莎尚未装填弹药，需先执行「装填弹药」。";
    return "";
}
struct Hit { int corpseId; int dmg, real; bool dead, vehLost, vehDead; };
struct StrikeCellRep { int r, c; vector<Hit> hits; bool none; };
struct StrikeRep {
    vector<StrikeCellRep> cells;
    int fort, bunker, bunkerDeadN;
    bool area;
    StrikeRep() : fort(0), bunker(0), bunkerDeadN(0), area(false) {}
};
static void strikeCell(Corps* shooter, int r, int c, double power, StrikeRep& rep) {
    StrikeCellRep cr; cr.r = r; cr.c = c; cr.none = false;
    if (fort_[r][c]) { fort_[r][c] = false; rep.fort++; }
    double mult = 1.0;
    if (bunker_[r][c] > 0) {
        bunker_[r][c]--; rep.bunker++;
        mult = 0.5;
        if (bunker_[r][c] == 0) { bunkerDead_[r][c] = true; rep.bunkerDeadN++; }
    }
    vector<Corps*> targets;
    for (size_t i = 0; i < corps.size(); i++) {
        Corps& t = corps[i];
        if (t.alive && t.side != shooter->side && t.r == r && t.c == c && !SPEC[t.type].air)
            targets.push_back(&t);
    }
    stable_sort(targets.begin(), targets.end(),
                [](const Corps* a, const Corps* b) { return a->troops > b->troops; });
    if (targets.empty()) cr.none = true;
    for (size_t i = 0; i < targets.size(); i++) {
        Corps* t = targets[i];
        double m = mult;
        if (t->resting) m *= 0.5;
        if (terrain[r][c] == HIGHLAND) m *= 0.5;
        int dmg = (int)llround(power * m);
        if (power > 0 && dmg < 1) dmg = 1;
        int real = min(dmg, t->troops);
        t->troops -= dmg;
        bool hadDur = (SPEC[t->type].dur != 0);
        int durBefore = t->dur;
        if (SPEC[t->type].dur && isArtOrGroundVeh(*shooter)) t->dur--;
        bool vehLost = hadDur && (t->dur < durBefore);
        bool vehDead = hadDur && (t->dur <= 0);
        bool dead = (t->troops <= 0) || vehDead;
        if (dead) death(*t);
        Hit h; h.corpseId = t->id; h.dmg = dmg; h.real = real;
        h.dead = dead; h.vehLost = vehLost; h.vehDead = vehDead;
        cr.hits.push_back(h);
    }
    rep.cells.push_back(cr);
}
static StrikeRep katyushaStrike(Corps* cp, int cr0, int cc0) {
    double total = (double)cp->troops * strikeBase(*cp);
    StrikeRep rep; rep.area = true;
    strikeCell(cp, cr0, cc0, total * 0.5, rep);
    double per = (total * 0.5) / 8.0;
    vector<pair<int,int>> nb;
    for (int dr = -1; dr <= 1; dr++) for (int dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        int r = cr0 + dr, c = cc0 + dc;
        if (inMap(r, c)) nb.push_back(make_pair(r, c));
    }
    map<int, double> acc;
    for (int i = 0; i < 8; i++) {
        pair<int,int> rc = nb[randInt(0, (int)nb.size() - 1)];
        acc[cellKey(rc.first, rc.second)] += per;
    }
    for (map<int, double>::iterator it = acc.begin(); it != acc.end(); ++it)
        strikeCell(cp, it->first / N, it->first % N, it->second, rep);
    return rep;
}
/* 大本营雷达：感知来袭炮兵/载具距被打击地的格数（仅防守方可见） */
static bool baseRadar(Corps* shooter, const vector<pair<int,int>>& cells) {
    if (!shooter) return false;
    int defSide = 1 - shooter->side;
    int br = BASES[defSide][0], bc = BASES[defSide][1];
    bool hit = false; int minD = INT_MAX;
    for (size_t i = 0; i < cells.size(); i++) {
        if (manh(cells[i].first, cells[i].second, br, bc) <= 5) {
            hit = true;
            minD = min(minD, manh(shooter->r, shooter->c, cells[i].first, cells[i].second));
        }
    }
    if (hit) {
        logMsg(string("📡 大本营雷达（") + SIDE_NAME[defSide] + "）：侦测到敌方远程火力打击，来袭火力距被打击地 " +
               to_string(minD) + " 格。", defSide);
    }
    return hit;
}

/* ---------------- 移动 ---------------- */
static bool cellBlocked(int r, int c, int side, const set<int>& vis) {
    for (size_t i = 0; i < corps.size(); i++) {
        const Corps& p = corps[i];
        if (!p.alive || p.r != r || p.c != c) continue;
        if (p.side == side) return true;                 // 己方单位阻挡
        if (unitVisibleTo(p, side, vis)) return true;    // 可见敌军阻挡
    }
    return false;
}
struct MoveTgt { vector<pair<int,int>> path; vector<int> ids; bool attack; };
struct MoveSets { map<int, MoveTgt> empties, cells; };

static MoveSets computeMoveTargets(const Corps& cp, int steps, const set<int>& vis) {
    MoveSets ms;
    if (SPEC[cp.type].air) {
        // 空中：曼哈顿菱形内自由飞行
        for (int dr = -steps; dr <= steps; dr++) for (int dc = -steps; dc <= steps; dc++) {
            if (!dr && !dc) continue;
            if (abs(dr) + abs(dc) > steps) continue;
            int r = cp.r + dr, c = cp.c + dc;
            if (!airStationable(r, c)) continue;
            MoveTgt t; t.attack = false;
            t.path.push_back(make_pair(r, c));
            ms.empties[cellKey(r, c)] = t;
        }
        return ms;
    }
    // BFS
    vector<int> dist(N * N, -1), prv(N * N, -1);
    queue<pair<int,int>> q;
    dist[cellKey(cp.r, cp.c)] = 0;
    q.push(make_pair(cp.r, cp.c));
    static const int DR[4] = { 1,-1,0,0 }, DC[4] = { 0,0,1,-1 };
    while (!q.empty()) {
        pair<int,int> cur = q.front(); q.pop();
        int r = cur.first, c = cur.second;
        for (int d = 0; d < 4; d++) {
            int nr = r + DR[d], nc = c + DC[d];
            if (!inMap(nr, nc) || dist[cellKey(nr, nc)] != -1 || !stationable(nr, nc)) continue;
            if (cellBlocked(nr, nc, cp.side, vis)) continue;
            dist[cellKey(nr, nc)] = dist[cellKey(r, c)] + 1;
            prv[cellKey(nr, nc)] = cellKey(r, c);
            q.push(make_pair(nr, nc));
        }
    }
    // 回溯路径
    struct Recon {
        const vector<int>* prv;
        vector<pair<int,int>> operator()(int tr, int tc, int sr, int sc) const {
            vector<pair<int,int>> path;
            int cur = tr * N + tc;
            while (!(cur / N == sr && cur % N == sc)) {
                path.push_back(make_pair(cur / N, cur % N));
                cur = (*prv)[cur];
                if (cur < 0) { path.clear(); return path; }
            }
            reverse(path.begin(), path.end());
            return path;
        }
    } reconstruct;
    reconstruct.prv = &prv;

    for (int r = 0; r < N; r++) for (int c = 0; c < N; c++) {
        int d = dist[cellKey(r, c)];
        if (d >= 1 && d <= steps && !cellBlocked(r, c, cp.side, vis)) {
            vector<pair<int,int>> path = reconstruct(r, c, cp.r, cp.c);
            if (!path.empty()) {
                MoveTgt t; t.attack = false; t.path = path;
                ms.empties[cellKey(r, c)] = t;
            }
        }
    }
    for (size_t i = 0; i < corps.size(); i++) {
        const Corps& p = corps[i];
        if (!p.alive) continue;
        bool isOwn = (p.side == cp.side);
        if (!isOwn) {
            if (SPEC[p.type].air) continue;                       // 空中单位不可见、不可攻击
            if (!unitVisibleTo(p, cp.side, vis)) continue;        // 不可见敌军不列为目标
            if (cp.type == T_SCOUT) continue;                     // 侦察兵无法进攻
        }
        int k = cellKey(p.r, p.c);
        map<int, MoveTgt>::iterator it = ms.cells.find(k);
        if (it != ms.cells.end()) {
            it->second.ids.push_back(p.id);
            if (!isOwn) it->second.attack = true;
            continue;
        }
        MoveTgt best; bool has = false;
        for (int d = 0; d < 4; d++) {
            int nr = p.r + DR[d], nc = p.c + DC[d];
            if (!inMap(nr, nc)) continue;
            int dd = dist[cellKey(nr, nc)];
            if (dd >= 0 && dd + 1 <= steps) {
                vector<pair<int,int>> base = reconstruct(nr, nc, cp.r, cp.c);
                if (base.empty()) continue;
                base.push_back(make_pair(p.r, p.c));
                if (!has || (int)base.size() < (int)best.path.size()) { best.path = base; has = true; }
            }
        }
        if (has) {
            best.ids.push_back(p.id);
            best.attack = !isOwn;
            ms.cells[k] = best;
        }
    }
    return ms;
}

/* ---------------- 胜负 ---------------- */
static bool hasGround(int side) {
    for (size_t i = 0; i < corps.size(); i++)
        if (corps[i].alive && corps[i].side == side && !SPEC[corps[i].type].air) return true;
    return false;
}
static void checkWin() {
    if (gameOver) return;
    for (size_t i = 0; i < corps.size(); i++) {
        const Corps& p = corps[i];
        if (!p.alive || SPEC[p.type].air) continue;          // 需地面兵团占领
        if (p.r == BASES[1 - p.side][0] && p.c == BASES[1 - p.side][1]) {
            gameOver = true; winner = p.side; return;
        }
    }
    bool g0 = hasGround(0), g1 = hasGround(1);
    if (!g0 || !g1) { gameOver = true; winner = g0 ? 0 : 1; }
}

/* ---------------- 前置声明 ---------------- */
static void afterCommand();
static void printBattleReport(const vector<Seg>& segs);

/* ---------------- 移动执行 ---------------- */
static void executeMove(Corps* cp, const vector<pair<int,int>>& path) {
    const Spec& u = SPEC[cp->type];
    int steps = 0; bool fought = false;
    int fr = cp->r, fc = cp->c;
    vector<Seg> segs;
    for (size_t i = 0; i < path.size(); i++) {
        steps++;
        cp->r = path[i].first; cp->c = path[i].second;
        if (!u.air && groundEnemyAt(cp->r, cp->c, cp->side)) {
            fought = true;
            segs = resolveMelee(cp);
            break;
        }
    }
    if (!fought) cp->resting = false;                        // 移动未交战 → 休整解除
    if (cp->type == T_SCOUT && steps >= 3) cp->fatigue = 2;  // 侦察兵奔袭3格 → 下回合不能移动
    logMsg(corpsLabel(*cp) + " 从" + posStr(fr, fc) + "移动到 " + posStr(cp->r, cp->c), cp->side);
    // 空中载具降落自家大本营 → 补充弹药
    if (cp->alive && u.air && cp->r == BASES[cp->side][0] && cp->c == BASES[cp->side][1]) {
        bool needSupply = (u.throwable && (cp->flare < 1 || cp->smoke < 1)) || (u.missile && cp->missile < 1);
        if (u.throwable) { cp->flare = 1; cp->smoke = 1; }
        if (u.missile && cp->missile <= 0) cp->missile = 1;
        if (needSupply)
            logMsg(string(SIDE_NAME[cp->side]) + " " + typeName(cp->type) + "#" + to_string(cp->id) + " 返回大本营完成补给。", cp->side);
    }
    if (!segs.empty()) printBattleReport(segs);
    checkWin();
}

/* ---------------- 部署 ---------------- */
static int deploySpent(const vector<int>& cfg) {
    int s = 0;
    for (int i = 0; i < T_N; i++) s += cfg[i] * SPEC[i].cost;
    return s;
}
static void spawnFromConfig(int side, const vector<int>& cfg) {
    int br = BASES[side][0], bc = BASES[side][1];
    for (int i = 0; i < T_N; i++) {
        int t = DEPLOY_ORDER[i];
        int n = cfg[t];
        if (n <= 0) continue;
        Corps c;
        c.id = nextId++; c.side = side; c.type = t; c.troops = n; c.r = br; c.c = bc;
        c.dur = SPEC[t].dur;
        c.flare = SPEC[t].throwable ? 1 : 0;
        c.smoke = SPEC[t].throwable ? 1 : 0;
        c.missile = SPEC[t].missile ? 1 : 0;
        corps.push_back(c);
    }
}
static void startPlay() {
    current = 0; turnNo = 1; acted.clear(); selId = 0;
    logMsg("全员集结完毕，战斗开始！红方先行。", -1);
    logMsg("☀ 白天（第 1 天）· 视野范围正常。", -1);
}

/* ---------------- 各类指令 ---------------- */
static void cmdMove(Corps* cp) {
    if (cp->fatigue > 0 && cp->type == T_SCOUT) {
        logMsg("⚠ 该侦察兵上回合奔袭3格，本回合不能移动。", cp->side);
        return;
    }
    set<int> vis = computeVision(cp->side);
    MoveSets ms = computeMoveTargets(*cp, SPEC[cp->type].move, vis);
    while (true) {
        cout << "  输入落点「行 列」(1~20，0 取消)：";
        string line;
        if (!getline(cin, line)) return;
        istringstream iss(line);
        int r, c;
        if (!(iss >> r)) { cout << "  输入无效。\n"; continue; }
        if (r == 0) { cout << "  已取消。\n"; return; }
        if (!(iss >> c)) { cout << "  需要两个数字：行 列。\n"; continue; }
        r--; c--;
        if (!inMap(r, c)) { cout << "  超出棋盘范围。\n"; continue; }
        int k = cellKey(r, c);
        vector<pair<int,int>> path;
        if (ms.empties.count(k)) path = ms.empties[k].path;
        else if (ms.cells.count(k)) path = ms.cells[k].path;
        else { cout << "  该格不可达（超出步数 / 被阻挡 / 不可驻扎）。\n"; continue; }
        if (cp->type == T_SCOUT && (int)path.size() >= 3) {
            cout << "  ⚠ 侦察兵奔袭3格：下个回合将无法移动。确认？(y=确认 / 其他=重选)：";
            string yn;
            if (!getline(cin, yn)) return;
            if (yn != "y" && yn != "Y") continue;
        }
        acted.insert(cp->id);
        executeMove(cp, path);
        break;
    }
    afterCommand();
}
static void cmdSplit(Corps* cp) {
    if (cp->troops < 6) { logMsg("⚠ 兵力不足：新军团需≥5且原军团至少保留1。", cp->side); return; }
    int v = 0;
    while (true) {
        cout << "  分出兵力（5 ~ " << cp->troops - 1 << "，0 取消）：";
        string line;
        if (!getline(cin, line)) return;
        istringstream iss(line);
        if (!(iss >> v)) { cout << "  输入无效。\n"; continue; }
        if (v == 0) { cout << "  已取消。\n"; return; }
        if (v < 5 || v > cp->troops - 1) { cout << "  请输入 5 ~ " << cp->troops - 1 << " 之间的整数。\n"; continue; }
        break;
    }
    set<int> vis = computeVision(cp->side);
    vector<pair<int,int>> spots;
    for (int dr = -1; dr <= 1; dr++) for (int dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        int nr = cp->r + dr, nc = cp->c + dc;
        bool ok = SPEC[cp->type].air ? airStationable(nr, nc) : stationable(nr, nc);
        if (ok && !cellBlocked(nr, nc, cp->side, vis)) spots.push_back(make_pair(nr, nc));
    }
    if (spots.empty()) { logMsg("⚠ 周围没有可放置新军团的空格。", cp->side); return; }
    cout << "  可放置位置：";
    for (size_t i = 0; i < spots.size(); i++) cout << posStr(spots[i].first, spots[i].second) << " ";
    cout << "\n";
    while (true) {
        cout << "  输入新军团放置位置「行 列」(0 取消)：";
        string line;
        if (!getline(cin, line)) return;
        istringstream iss(line);
        int r, c;
        if (!(iss >> r)) { cout << "  输入无效。\n"; continue; }
        if (r == 0) { cout << "  已取消。\n"; return; }
        if (!(iss >> c)) { cout << "  需要两个数字：行 列。\n"; continue; }
        r--; c--;
        bool okSpot = false;
        for (size_t i = 0; i < spots.size(); i++)
            if (spots[i].first == r && spots[i].second == c) { okSpot = true; break; }
        if (!okSpot) { cout << "  该位置不可用。\n"; continue; }
        // 先取快照，再 push（避免 vector 扩容导致指针失效）
        int pid = cp->id, pside = cp->side, ptype = cp->type, pdur = cp->dur, ptroop = cp->troops;
        Corps nc;
        nc.id = nextId++; nc.side = pside; nc.type = ptype; nc.troops = v; nc.r = r; nc.c = c;
        nc.dur = pdur;
        corps.push_back(nc);
        Corps* cp2 = getCorps(pid);
        cp2->troops = ptroop - v;
        logMsg(corpsLabel(*cp2) + " 分兵 → 新建 " + string(typeName(ptype)) + "#" + to_string(nc.id) +
               "(x" + to_string(v) + ") 于 " + posStr(r, c), pside);
        acted.insert(pid);
        break;
    }
    afterCommand();
}
static vector<int> mergeCandidates(const Corps& cp) {
    vector<int> out;
    for (size_t i = 0; i < corps.size(); i++) {
        const Corps& o = corps[i];
        if (o.alive && o.side == cp.side && o.type == cp.type && o.id != cp.id &&
            manh(o.r, o.c, cp.r, cp.c) <= 1) out.push_back(o.id);
    }
    return out;
}
static void cmdMerge(Corps* cp) {
    vector<int> cands = mergeCandidates(*cp);
    if (cands.empty()) { logMsg("⚠ 周围（含同格）没有同兵种友军。", cp->side); return; }
    cout << "  选择合并目标：\n";
    for (size_t i = 0; i < cands.size(); i++) {
        Corps* o = getCorps(cands[i]);
        cout << "   " << (i + 1) << ". " << corpsLabel(*o) << " (x" << o->troops << ") @ " << posStr(o->r, o->c) << "\n";
    }
    while (true) {
        cout << "  输入编号 (0 取消)：";
        string line;
        if (!getline(cin, line)) return;
        istringstream iss(line);
        int v;
        if (!(iss >> v)) { cout << "  输入无效。\n"; continue; }
        if (v == 0) { cout << "  已取消。\n"; return; }
        if (v < 1 || v > (int)cands.size()) { cout << "  编号无效。\n"; continue; }
        int tid = cands[v - 1];
        int a = cp->troops, cpId = cp->id, cpSide = cp->side;
        Corps* t = getCorps(tid);
        if (!t || !t->alive) { cout << "  目标已不存在。\n"; return; }
        int b = t->troops;
        t->troops = a + b;
        if (SPEC[t->type].dur) t->dur = max(t->dur, cp->dur);   // 合并取较高耐久
        logMsg(corpsLabel(*cp) + "(x" + to_string(a) + ") 并入 #" + to_string(t->id) + "(x" +
               to_string(b) + ")，合并后 " + to_string(t->troops), cpSide);
        Corps* cpSelf = getCorps(cpId);
        if (cpSelf) death(*cpSelf);
        acted.insert(cpId);
        selId = tid;
        break;
    }
    afterCommand();
}
static void cmdRest(Corps* cp) {
    if (!SPEC[cp->type].canRest) { logMsg(string("⚠ ") + typeName(cp->type) + "没有休整状态。", cp->side); return; }
    cp->resting = !cp->resting;
    logMsg(corpsLabel(*cp) + (cp->resting ? " 进入" : " 解除") + "休整状态", cp->side);
    acted.insert(cp->id);
    afterCommand();
}
static void cmdStrike(Corps* cp) {
    if (!canStrike(*cp)) { logMsg("⚠ " + strikeHint(*cp), cp->side); return; }
    int range = strikeRange(*cp);
    cout << "  打击射程 " << range << " 格（曼哈顿距离 · 可盲打）";
    if (cp->type == T_KAT) cout << "，将以目标格为中心发动 3×3 面杀伤";
    cout << "\n";
    while (true) {
        cout << "  输入打击目标「行 列」(0 取消)：";
        string line;
        if (!getline(cin, line)) return;
        istringstream iss(line);
        int r, c;
        if (!(iss >> r)) { cout << "  输入无效。\n"; continue; }
        if (r == 0) { cout << "  已取消。\n"; return; }
        if (!(iss >> c)) { cout << "  需要两个数字：行 列。\n"; continue; }
        r--; c--;
        if (!inMap(r, c)) { cout << "  超出棋盘范围。\n"; continue; }
        if (r == cp->r && c == cp->c) { cout << "  不能打击自身所在格。\n"; continue; }
        if (manh(r, c, cp->r, cp->c) > range) { cout << "  超出射程。\n"; continue; }
        set<int> vis = computeVision(cp->side);
        // 打击范围：定点=1格，喀秋莎=以落点为中心的3×3
        vector<pair<int,int>> hitCells;
        for (int dr = -1; dr <= 1; dr++) for (int dc = -1; dc <= 1; dc++) {
            int rr = r + dr, cc = c + dc;
            if (!inMap(rr, cc)) continue;
            if (cp->type != T_KAT && (dr || dc)) continue;
            hitCells.push_back(make_pair(rr, cc));
        }
        // 打击前记录可见敌军的规模档位
        map<int, string> before;
        for (size_t i = 0; i < hitCells.size(); i++) {
            vector<const Corps*> f = visibleFoesAt(cp->side, hitCells[i].first, hitCells[i].second, vis);
            if (!f.empty()) before[cellKey(hitCells[i].first, hitCells[i].second)] = enemySizeClass(f);
        }
        StrikeRep rep;
        if (cp->type == T_KAT) rep = katyushaStrike(cp, r, c);
        else strikeCell(cp, r, c, (double)cp->troops * strikeBase(*cp), rep);
        if (cp->type == T_KAT) cp->ammo = false;             // 装填消耗
        // 战果汇总（脱敏：只报消灭人数 / 载具损耗 / 规模变化）
        int total = 0, vehLost = 0, vehDead = 0;
        vector<string> lines, sizeChanges;
        for (size_t i = 0; i < rep.cells.size(); i++) {
            StrikeCellRep& cell = rep.cells[i];
            int k = cellKey(cell.r, cell.c);
            string beforeSize = before.count(k) ? before[k] : "";
            vector<const Corps*> foesAfter = visibleFoesAt(cp->side, cell.r, cell.c, vis);
            string afterSize = foesAfter.empty() ? "" : enemySizeClass(foesAfter);
            int kills = 0;
            for (size_t j = 0; j < cell.hits.size(); j++) kills += cell.hits[j].real;
            total += kills;
            for (size_t j = 0; j < cell.hits.size(); j++) {
                if (cell.hits[j].vehLost) vehLost++;
                if (cell.hits[j].vehDead) vehDead++;
            }
            if (!beforeSize.empty() && afterSize != beforeSize)
                sizeChanges.push_back(posStr(cell.r, cell.c) + " " + beforeSize + "→" +
                                      (afterSize.empty() ? "已歼灭" : afterSize));
            if (beforeSize.empty() && cell.hits.empty()) continue;   // 无目标、无情报 → 不显示该格
            string s = posStr(cell.r, cell.c) + "：";
            s += cell.hits.empty() ? "未取得战果" : ("消灭 " + to_string(kills) + " 人");
            if (vehLost) s += "，载具受损" + string(vehDead ? "并被击毁" : "");
            if (!beforeSize.empty())
                s += " · 敌方规模 " + beforeSize + " → " + (afterSize.empty() ? "已歼灭" : afterSize);
            lines.push_back(s);
        }
        string msg = "🎯 " + corpsLabel(*cp) + " 打击 " + posStr(r, c) + (rep.area ? "[3×3面杀伤]" : "") +
                     "：消灭 " + to_string(total) + " 人";
        if (vehLost) msg += "，载具受损" + to_string(vehLost) + "次" +
                            (vehDead ? "（击毁" + to_string(vehDead) + "辆）" : "");
        if (!sizeChanges.empty()) {
            msg += "，敌方规模 ";
            for (size_t i = 0; i < sizeChanges.size(); i++) { if (i) msg += "、"; msg += sizeChanges[i]; }
        }
        if (rep.fort) msg += "，摧毁防御工事" + to_string(rep.fort) + "座";
        if (rep.bunker) msg += "，命中防空地堡" + to_string(rep.bunker) + "次" + (rep.bunkerDeadN ? "（已失效）" : "");
        if (!total && !rep.fort && !rep.bunker) msg += "，未取得战果";
        logMsg(msg, cp->side);
        // 打击报告
        cout << "\n  ═══ 🎯 打击报告 ═══\n";
        cout << "  " << corpsLabel(*cp) << (rep.area ? " · 3×3 面杀伤" : " · 定点打击") << "\n";
        for (size_t i = 0; i < lines.size(); i++) cout << "   " << lines[i] << "\n";
        cout << "  合计消灭 " << total << " 人";
        if (vehLost) cout << " · 载具受损 " << vehLost << " 次" <<
                             (vehDead ? "（击毁 " + to_string(vehDead) + " 辆）" : "");
        cout << "\n  ※ 战果仅显示消灭人数、载具耐久损耗与敌方规模变化，具体兵种与剩余兵力不可侦察。\n\n";
        vector<pair<int,int>> radarCells;
        for (size_t i = 0; i < rep.cells.size(); i++)
            radarCells.push_back(make_pair(rep.cells[i].r, rep.cells[i].c));
        baseRadar(cp, radarCells);
        acted.insert(cp->id);
        checkWin();
        break;
    }
    afterCommand();
}
static void cmdLoad(Corps* cp) {
    cp->ammo = true;
    logMsg(corpsLabel(*cp) + " 完成弹药装填，可随时发动打击。", cp->side);
    acted.insert(cp->id);
    afterCommand();
}
static vector<pair<int,int>> buildCellsOf(const Corps& cp) {
    vector<pair<int,int>> out;
    for (int dr = -1; dr <= 1; dr++) for (int dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        int r = cp.r + dr, c = cp.c + dc;
        if (stationable(r, c) && !fort_[r][c]) out.push_back(make_pair(r, c));
    }
    return out;
}
static vector<pair<int,int>> fortCellsOf(const Corps& cp) {
    vector<pair<int,int>> out;
    for (int dr = -1; dr <= 1; dr++) for (int dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        int r = cp.r + dr, c = cp.c + dc;
        if (inMap(r, c) && fort_[r][c]) out.push_back(make_pair(r, c));
    }
    return out;
}
static void cmdBuild(Corps* cp) {
    if (!cp->resting) { logMsg("⚠ 步兵必须休整才能修筑工事。", cp->side); return; }
    vector<pair<int,int>> s = buildCellsOf(*cp);
    if (s.empty()) { logMsg("⚠ 周围没有可修筑工事的格子。", cp->side); return; }
    cout << "  可修筑位置：";
    for (size_t i = 0; i < s.size(); i++) cout << posStr(s[i].first, s[i].second) << " ";
    cout << "\n";
    while (true) {
        cout << "  输入修筑位置「行 列」(0 取消)：";
        string line;
        if (!getline(cin, line)) return;
        istringstream iss(line);
        int r, c;
        if (!(iss >> r)) { cout << "  输入无效。\n"; continue; }
        if (r == 0) { cout << "  已取消。\n"; return; }
        if (!(iss >> c)) { cout << "  需要两个数字：行 列。\n"; continue; }
        r--; c--;
        bool ok = false;
        for (size_t i = 0; i < s.size(); i++)
            if (s[i].first == r && s[i].second == c) { ok = true; break; }
        if (!ok) { cout << "  该位置不可用。\n"; continue; }
        fort_[r][c] = true;
        logMsg(corpsLabel(*cp) + " 修筑了 " + posStr(r, c) + " 防御工事", cp->side);
        acted.insert(cp->id);
        break;
    }
    afterCommand();
}
static void cmdDestroy(Corps* cp) {
    if (!cp->resting) { logMsg("⚠ 步兵必须休整才能摧毁工事。", cp->side); return; }
    vector<pair<int,int>> s = fortCellsOf(*cp);
    if (s.empty()) { logMsg("⚠ 周围没有防御工事。", cp->side); return; }
    cout << "  可摧毁位置：";
    for (size_t i = 0; i < s.size(); i++) cout << posStr(s[i].first, s[i].second) << " ";
    cout << "\n";
    while (true) {
        cout << "  输入摧毁位置「行 列」(0 取消)：";
        string line;
        if (!getline(cin, line)) return;
        istringstream iss(line);
        int r, c;
        if (!(iss >> r)) { cout << "  输入无效。\n"; continue; }
        if (r == 0) { cout << "  已取消。\n"; return; }
        if (!(iss >> c)) { cout << "  需要两个数字：行 列。\n"; continue; }
        r--; c--;
        bool ok = false;
        for (size_t i = 0; i < s.size(); i++)
            if (s[i].first == r && s[i].second == c) { ok = true; break; }
        if (!ok) { cout << "  该位置没有工事。\n"; continue; }
        fort_[r][c] = false;
        logMsg(corpsLabel(*cp) + " 摧毁了 " + posStr(r, c) + " 的防御工事", cp->side);
        acted.insert(cp->id);
        break;
    }
    afterCommand();
}
static void cmdDemolish(Corps* cp) {
    vector<pair<int,int>> s = fortCellsOf(*cp);
    if (s.empty()) { logMsg("⚠ 周围没有可拆毁的防御工事。", cp->side); return; }
    cout << "  可拆毁位置：";
    for (size_t i = 0; i < s.size(); i++) cout << posStr(s[i].first, s[i].second) << " ";
    cout << "\n";
    while (true) {
        cout << "  输入拆毁位置「行 列」(0 取消)：";
        string line;
        if (!getline(cin, line)) return;
        istringstream iss(line);
        int r, c;
        if (!(iss >> r)) { cout << "  输入无效。\n"; continue; }
        if (r == 0) { cout << "  已取消。\n"; return; }
        if (!(iss >> c)) { cout << "  需要两个数字：行 列。\n"; continue; }
        r--; c--;
        bool ok = false;
        for (size_t i = 0; i < s.size(); i++)
            if (s[i].first == r && s[i].second == c) { ok = true; break; }
        if (!ok) { cout << "  该位置没有工事。\n"; continue; }
        fort_[r][c] = false;
        logMsg(corpsLabel(*cp) + " 拆毁了 " + posStr(r, c) + " 的防御工事", cp->side);
        acted.insert(cp->id);
        break;
    }
    afterCommand();
}
static void cmdBunker(Corps* cp) {
    if (!cp->resting) { logMsg("⚠ 步兵必须休整才能修筑防空地堡。", cp->side); return; }
    if (bunker_[cp->r][cp->c] > 0) { logMsg("⚠ 本格已有防空地堡。", cp->side); return; }
    if (bunkerDead_[cp->r][cp->c]) { logMsg("⚠ 本格防空地堡已被摧毁，无法再次修筑。", cp->side); return; }
    bunker_[cp->r][cp->c] = 3;
    logMsg(corpsLabel(*cp) + " 在 " + posStr(cp->r, cp->c) + " 修筑防空地堡（3点耐久）", cp->side);
    acted.insert(cp->id);
    afterCommand();
}
static void cmdThrow(Corps* cp, bool isFlare) {
    const Spec& u = SPEC[cp->type];
    if (!u.throwable) return;
    if (isFlare && cp->flare <= 0) { logMsg("⚠ 照明弹已用尽（需飞回大本营补给）。", cp->side); return; }
    if (!isFlare && cp->smoke <= 0) { logMsg("⚠ 烟雾弹已用尽（需飞回大本营补给）。", cp->side); return; }
    int vr = visionRange(*cp);
    cout << "  投掷范围：视野 " << vr << " 格内（3×3 区域生效，持续5回合）\n";
    while (true) {
        cout << "  输入投掷目标「行 列」(0 取消)：";
        string line;
        if (!getline(cin, line)) return;
        istringstream iss(line);
        int r, c;
        if (!(iss >> r)) { cout << "  输入无效。\n"; continue; }
        if (r == 0) { cout << "  已取消。\n"; return; }
        if (!(iss >> c)) { cout << "  需要两个数字：行 列。\n"; continue; }
        r--; c--;
        if (!inMap(r, c) || manh(r, c, cp->r, cp->c) > vr) { cout << "  超出视野范围。\n"; continue; }
        if (isFlare) {
            cp->flare--;
            for (int dr = -1; dr <= 1; dr++) for (int dc = -1; dc <= 1; dc++) {
                int rr = r + dr, cc = c + dc;
                if (inMap(rr, cc)) flareT_[rr][cc] = 5;
            }
            logMsg(corpsLabel(*cp) + " 投掷照明弹 → " + posStr(r, c) +
                   "，3×3 照明区持续5回合（区内兵团全图可见）", cp->side);
        } else {
            cp->smoke--;
            int id = smokeSeq++;
            for (int dr = -1; dr <= 1; dr++) for (int dc = -1; dc <= 1; dc++) {
                int rr = r + dr, cc = c + dc;
                if (inMap(rr, cc)) { smokeLeft_[rr][cc] = 5; smokeId_[rr][cc] = id; }
            }
            logMsg(corpsLabel(*cp) + " 投掷烟雾弹 → " + posStr(r, c) +
                   "，3×3 烟幕持续5回合（区外无法窥视）", cp->side);
        }
        acted.insert(cp->id);
        break;
    }
    afterCommand();
}
static void cmdMissile(Corps* cp) {
    if (cp->type != T_BOMBER) return;
    if (cp->missile <= 0) { logMsg("⚠ 轰炸机没有导弹（飞回大本营可补充）。", cp->side); return; }
    int vr = visionRange(*cp);
    cout << "  导弹射程：视野 " << vr << " 格内（可盲打，下一回合命中；无地堡则该格地面单位全歼，敌我不分）\n";
    while (true) {
        cout << "  输入落点「行 列」(0 取消)：";
        string line;
        if (!getline(cin, line)) return;
        istringstream iss(line);
        int r, c;
        if (!(iss >> r)) { cout << "  输入无效。\n"; continue; }
        if (r == 0) { cout << "  已取消。\n"; return; }
        if (!(iss >> c)) { cout << "  需要两个数字：行 列。\n"; continue; }
        r--; c--;
        if (!inMap(r, c) || manh(r, c, cp->r, cp->c) > vr) { cout << "  超出射程。\n"; continue; }
        cp->missile--;
        PendingMissile ms; ms.r = r; ms.c = c; ms.side = cp->side; ms.shooterId = cp->id;
        pendingMissiles.push_back(ms);
        logMsg("🚀 " + corpsLabel(*cp) + " 向 " + posStr(r, c) + " 发射导弹，将于下一回合命中！", cp->side);
        acted.insert(cp->id);
        break;
    }
    afterCommand();
}

/* ---------------- 导弹结算 ---------------- */
static void resolveMissiles() {
    if (pendingMissiles.empty()) return;
    vector<PendingMissile> list = pendingMissiles;
    pendingMissiles.clear();
    for (size_t i = 0; i < list.size(); i++) {
        int r = list[i].r, c = list[i].c, side = list[i].side;
        bool bunkerHit = false, bunkerKilled = false;
        if (fort_[r][c]) fort_[r][c] = false;
        if (bunker_[r][c] > 0) {
            bunker_[r][c]--; bunkerHit = true;
            if (bunker_[r][c] == 0) { bunkerDead_[r][c] = true; bunkerKilled = true; }
        }
        vector<Corps*> targets;
        for (size_t j = 0; j < corps.size(); j++) {
            Corps& t = corps[j];
            if (t.alive && t.r == r && t.c == c && !SPEC[t.type].air) targets.push_back(&t);
        }
        if (targets.empty()) {
            logMsg("🚀 导弹命中 " + posStr(r, c) + "，该格已空无一人。", side);
        } else if (!bunkerHit) {
            for (size_t j = 0; j < targets.size(); j++) death(*targets[j]);
            logMsg("💥 导弹命中 " + posStr(r, c) + "，该格 " + to_string(targets.size()) + " 支兵团被全歼！", side);
        } else {
            for (size_t j = 0; j < targets.size(); j++) {
                targets[j]->troops = max(0, targets[j]->troops - (int)llround(targets[j]->troops * 0.5));
                if (targets[j]->troops <= 0) death(*targets[j]);
            }
            logMsg("💥 导弹命中 " + posStr(r, c) + "，防空地堡拦截，损耗减半" +
                   string(bunkerKilled ? "，地堡已失效" : "") + "。", side);
        }
        vector<pair<int,int>> oneCell;
        oneCell.push_back(make_pair(r, c));
        baseRadar(getCorps(list[i].shooterId), oneCell);
        if (bunkerHit && !bunkerKilled)
            logMsg("🛡 防空地堡承受打击，剩余耐久 " + to_string(bunker_[r][c]) + "/3。", 1 - side);
    }
    checkWin();
}

/* ---------------- 回合 / 昼夜 ---------------- */
static void onNewRound(bool wasDay) {
    resolveMissiles();
    for (int r = 0; r < N; r++) for (int c = 0; c < N; c++) {
        if (flareT_[r][c] > 0) flareT_[r][c]--;
        if (smokeLeft_[r][c] > 0) smokeLeft_[r][c]--;
    }
    if (isDay() != wasDay) {
        logMsg(string("⏱ 时间转换 → ") + (isDay() ? "☀ 白天" : "🌙 夜晚") +
               "（第 " + to_string(dayNo()) + " 天）", -1);
        logMsg(isDay() ? "白天视野恢复。" : "夜晚：除侦察兵(-2格外)所有兵团视野 -1 格。", -1);
    }
}
static void endTurn() {
    if (gameOver || phase != PH_PLAY) return;
    selId = 0;
    for (size_t i = 0; i < corps.size(); i++) {
        Corps& p = corps[i];
        if (p.alive && p.side == current && p.fatigue > 0) p.fatigue--;
    }
    checkWin();
    if (gameOver) return;
    logMsg(string("—— ") + SIDE_NAME[current] + " 回合结束 ——", current);
    current = 1 - current;
    if (current == 0) {
        bool wasDay = isDay();
        turnNo++;
        onNewRound(wasDay);
        if (gameOver) return;
    }
    acted.clear(); selId = 0;
    logMsg(string("轮到 ") + SIDE_NAME[current] + " 行动（第 " + to_string(turnNo) + " 回合）", current);
}
static void afterCommand() { checkWin(); }

/* ---------------- 控制台渲染 ---------------- */
static const string RESET = "\033[0m";
static string C(int code) { return "\033[" + to_string(code) + "m"; }
static void clearScreen() { cout << "\033[2J\033[H"; }

static bool viewLocked() {
    if (phase != PH_PLAY) return false;
    if (viewMode == "god") return true;
    if (viewMode == "auto") return false;
    return viewMode != (current == 0 ? string("red") : string("blue"));
}
static int effSide() {
    if (viewMode == "red") return 0;
    if (viewMode == "blue") return 1;
    return current;   // auto（god 不使用）
}

/* 交战报告（仅当前行动方在屏幕上看到） */
static void printBattleReport(const vector<Seg>& segs) {
    cout << "\n  ═══ ⚔ 交战报告 ═══\n";
    for (size_t s = 0; s < segs.size(); s++) {
        const Seg& seg = segs[s];
        cout << "  ── " << SIDE_NAME[seg.atkSide] << typeName(seg.atkType) << "#" << seg.atkId
             << "(" << seg.atk0 << ") vs " << SIDE_NAME[seg.defSide] << typeName(seg.defType) << "#"
             << seg.defId << "(" << seg.def0 << (seg.defRest ? " · 休整" : "") << ") ──\n";
        int shown = min((int)seg.rounds.size(), 40);
        for (int i = 0; i < shown; i++) {
            cout << "   第" << (i + 1) << "轮：攻损 " << seg.rounds[i].la << " → 剩 " << seg.rounds[i].aLeft
                 << " ｜ 守损 " << seg.rounds[i].lb << " → 剩 " << seg.rounds[i].bLeft << "\n";
        }
        if ((int)seg.rounds.size() > 40)
            cout << "   … 共 " << seg.rounds.size() << " 轮\n";
        cout << "   结果：";
        bool any = false;
        if (seg.defDead) { cout << typeName(seg.defType) << " 被全歼"; any = true; }
        if (seg.atkDead) { cout << (any ? "；" : "") << "攻方被全歼"; any = true; }
        if (!any) cout << "交战结束";
        cout << "\n";
    }
    cout << "  （按回车继续）";
    string tmp; getline(cin, tmp);
    cout << "\n";
}

/* 指令可用性：返回 ("可用", "") 或 ("不可用", 原因) */
static pair<bool, string> cmdAvailable(const Corps& cp, int n) {
    const Spec& u = SPEC[cp.type];
    switch (n) {
        case 1: // 移动
            if (cp.fatigue > 0 && cp.type == T_SCOUT) return make_pair(false, "上回合奔袭，疲劳中");
            return make_pair(true, string(""));
        case 2: // 分兵
            if (cp.troops < 6) return make_pair(false, "兵力不足(需≥6)");
            return make_pair(true, string(""));
        case 3: // 合兵
            if (mergeCandidates(cp).empty()) return make_pair(false, "无相邻同兵种友军");
            return make_pair(true, string(""));
        case 4: // 休整
            if (!u.canRest) return make_pair(false, "该兵种无休整状态");
            return make_pair(true, string(""));
        case 5: // 打击
            if (!u.ranged) return make_pair(false, "");
            if (!canStrike(cp)) return make_pair(false, strikeHint(cp));
            return make_pair(true, string(""));
        case 6: // 装填
            if (cp.type != T_KAT) return make_pair(false, "");
            return make_pair(true, string(""));
        case 7: // 修筑工事
            if (cp.type != T_INF) return make_pair(false, "");
            if (!cp.resting) return make_pair(false, "需休整");
            if (buildCellsOf(cp).empty()) return make_pair(false, "无可修筑格");
            return make_pair(true, string(""));
        case 8: // 摧毁工事
            if (cp.type != T_INF) return make_pair(false, "");
            if (!cp.resting) return make_pair(false, "需休整");
            if (fortCellsOf(cp).empty()) return make_pair(false, "周围无工事");
            return make_pair(true, string(""));
        case 9: // 修筑地堡
            if (cp.type != T_INF) return make_pair(false, "");
            if (!cp.resting) return make_pair(false, "需休整");
            if (bunker_[cp.r][cp.c] > 0) return make_pair(false, "本格已有地堡");
            if (bunkerDead_[cp.r][cp.c]) return make_pair(false, "地堡已毁不可再建");
            return make_pair(true, string(""));
        case 10: // 拆毁工事
            if (cp.type != T_CAV) return make_pair(false, "");
            if (fortCellsOf(cp).empty()) return make_pair(false, "周围无工事");
            return make_pair(true, string(""));
        case 11: // 照明弹
            if (!u.throwable) return make_pair(false, "");
            if (cp.flare <= 0) return make_pair(false, "照明弹已用尽");
            return make_pair(true, string(""));
        case 12: // 烟雾弹
            if (!u.throwable) return make_pair(false, "");
            if (cp.smoke <= 0) return make_pair(false, "烟雾弹已用尽");
            return make_pair(true, string(""));
        case 13: // 导弹
            if (!u.missile) return make_pair(false, "");
            if (cp.missile <= 0) return make_pair(false, "无导弹(回营补给)");
            return make_pair(true, string(""));
    }
    return make_pair(false, "");
}
static const char* CMD_NAME[14] = { "", "移动", "分兵", "合兵", "休整/解除", "打击", "装填弹药",
                                    "修筑工事", "摧毁工事", "修筑防空地堡", "拆毁工事",
                                    "照明弹", "烟雾弹", "发射导弹" };
static void runCommand(int n, Corps* cp) {
    switch (n) {
        case 1:  cmdMove(cp); break;
        case 2:  cmdSplit(cp); break;
        case 3:  cmdMerge(cp); break;
        case 4:  cmdRest(cp); break;
        case 5:  cmdStrike(cp); break;
        case 6:  cmdLoad(cp); break;
        case 7:  cmdBuild(cp); break;
        case 8:  cmdDestroy(cp); break;
        case 9:  cmdBunker(cp); break;
        case 10: cmdDemolish(cp); break;
        case 11: cmdThrow(cp, true); break;
        case 12: cmdThrow(cp, false); break;
        case 13: cmdMissile(cp); break;
    }
}

/* ---------------- 部署界面 ---------------- */
static void deploymentScreen() {
    while (true) {
        clearScreen();
        cout << "══════════════════════════════════════════════════════\n";
        cout << "  部署阶段 · " << SIDE_NAME[deploySide] << "\n";
        cout << "  可支配 " << BUDGET << " 积分，兵团开局驻守己方大本营（第 "
             << BASES[deploySide][0] + 1 << " 行第 " << BASES[deploySide][1] + 1 << " 列）\n";
        cout << "  必须至少采购 1 支地面兵团（无地面兵团即判负）\n";
        cout << "══════════════════════════════════════════════════════\n";
        const char* unitWord[T_N] = { "名","名","名","名","名","辆","辆","架","架" };
        for (int i = 0; i < T_N; i++) {
            int t = DEPLOY_ORDER[i];
            const Spec& u = SPEC[t];
            cout << "  " << (i + 1) << ". [" << u.ch << "] " << left << setw(8) << u.name
                 << right << " " << setw(3) << u.cost << "分/" << unitWord[i]
                 << "  已购 " << setw(4) << deployCfg[t]
                 << "   (移" << u.move << " 视" << u.vision
                 << (u.ranged ? " 远程" : "") << (u.air ? " 空中" : "") << (u.scout ? " 侦察" : "")
                 << (u.dur ? " 耐久3" : "") << (u.area ? " 3×3" : "")
                 << (u.throwable ? " 照明/烟幕" : "") << (u.missile ? " 导弹" : "") << ")\n";
        }
        int left = BUDGET - deploySpent(deployCfg);
        cout << "------------------------------------------------------\n";
        cout << "  剩余积分 " << left << " / " << BUDGET << (left < 0 ? "   ⚠ 超出预算！" : "") << "\n";
        cout << "  输入「编号 数量」修改；r=推荐配置 c=清空 ok=确认部署：";
        string line;
        if (!getline(cin, line)) exit(0);
        istringstream iss(line);
        string tok; iss >> tok;
        if (tok == "r" || tok == "R") {
            for (int i = 0; i < T_N; i++) deployCfg[i] = RECOMMEND[i];
            continue;
        }
        if (tok == "c" || tok == "C") {
            for (int i = 0; i < T_N; i++) deployCfg[i] = 0;
            continue;
        }
        if (tok == "ok") {
            int ground = 0;
            for (int t = 0; t < T_N; t++)
                if (deployCfg[t] > 0 && !SPEC[t].air) ground += deployCfg[t];
            if (deploySpent(deployCfg) > BUDGET) {
                cout << "  ⚠ 积分超出预算！请减少采购。（回车继续）";
                string s; getline(cin, s);
                continue;
            }
            if (!ground) {
                cout << "  ⚠ 必须至少采购 1 支地面兵团。（回车继续）";
                string s; getline(cin, s);
                continue;
            }
            spawnFromConfig(deploySide, deployCfg);
            logMsg(string(SIDE_NAME[deploySide]) + " 部署完成，投入 " + to_string(deploySpent(deployCfg)) + " 积分。", deploySide);
            if (deploySide == 0) {
                deploySide = 1;
                for (int i = 0; i < T_N; i++) deployCfg[i] = 0;
                clearScreen();
                cout << "\n\n        🤝  请将设备交给 蓝方 玩家  🤝\n\n        （按回车开始蓝方部署）";
                string s; getline(cin, s);
                continue;
            } else {
                phase = PH_PLAY;
                viewMode = "auto";
                startPlay();
                return;
            }
        }
        istringstream iss2(tok);
        int idx, cnt;
        if ((iss2 >> idx) && (iss >> cnt) && idx >= 1 && idx <= T_N && cnt >= 0) {
            deployCfg[DEPLOY_ORDER[idx - 1]] = cnt;
        } else {
            cout << "  输入无效。\n";
        }
    }
}

/* ---------------- 主渲染 ---------------- */
static void render() {
    clearScreen();
    bool godView = (viewMode == "god");
    int eSide = godView ? current : effSide();
    bool noFog = (phase != PH_PLAY) || godView;
    set<int> visR, visB;
    if (phase == PH_PLAY) {
        visR = computeVision(0); visB = computeVision(1);
        if (!noFog) { markSeen(0, visR); markSeen(1, visB); }   // 观战(上帝)不污染记忆
    }
    static const set<int> emptySet;
    const set<int>* pvis = &emptySet;
    if (!noFog) pvis = (eSide == 0) ? &visR : &visB;
    const set<int>& vis = *pvis;

    // 顶栏
    cout << (current == 0 ? C(41) + C(97) : C(44) + C(97))
         << " " << SIDE_NAME[current] << "行动 " << RESET
         << "  第 " << turnNo << " 回合 · 第 " << dayNo() << " 天 · "
         << (isDay() ? "☀ 白天" : "🌙 夜晚");
    if (godView) cout << " · 👁 上帝视角";
    else if (viewMode == "red") cout << " · 👁 红方视角";
    else if (viewMode == "blue") cout << " · 👁 蓝方视角";
    if (!memoryFog) cout << " · (记忆地形关)";
    int aliveOwn = 0;
    for (size_t i = 0; i < corps.size(); i++)
        if (corps[i].alive && corps[i].side == current) aliveOwn++;
    cout << " · 已行动 " << acted.size() << "/" << aliveOwn << "\n";
    cout << string(66, '=') << "\n";

    // 棋盘
    cout << "   ";
    for (int c = 0; c < N; c++) cout << setw(2) << (c + 1) % 10;
    cout << "\n";
    for (int r = 0; r < N; r++) {
        cout << setw(2) << (r + 1) << " ";
        for (int c = 0; c < N; c++) {
            int k = cellKey(r, c);
            bool v = noFog || (vis.count(k) > 0);
            bool ev = (eSide >= 0) ? seen_[eSide][r][c] : true;
            bool dim = !v && memoryFog && ev;
            string bg, fg, token = "  ";
            if (v) {
                switch (terrain[r][c]) {
                    case PLAIN:    bg = C(42); break;
                    case HIGHLAND: bg = C(47); break;
                    case RIVER:    bg = C(44); break;
                    default:       bg = C(41); break;
                }
                if (bridge_[r][c]) bg = C(103);
                if (flareT_[r][c] > 0) bg = C(103);
                else if (smokeLeft_[r][c] > 0) bg = C(100);
                // 收集本格单位
                vector<const Corps*> stack;
                for (size_t i = 0; i < corps.size(); i++)
                    if (corps[i].alive && corps[i].r == r && corps[i].c == c) stack.push_back(&corps[i]);
                vector<const Corps*> own, foes;
                for (size_t i = 0; i < stack.size(); i++) {
                    const Corps* p = stack[i];
                    if (godView) own.push_back(p);
                    else if (p->side == eSide) own.push_back(p);
                    else if (!SPEC[p->type].air && unitVisibleTo(*p, eSide, vis)) foes.push_back(p);
                }
                if (!own.empty()) {
                    const Corps* show = own[0];
                    for (size_t i = 0; i < own.size(); i++)
                        if (selId && own[i]->id == selId) { show = own[i]; break; }
                    token = SPEC[show->type].ch;
                    if (acted.count(show->id)) fg = C(90);            // 已行动 → 灰
                    else fg = (show->side == 0) ? "\033[1;31m" : "\033[1;34m";
                } else if (!foes.empty()) {
                    string size = enemySizeClass(foes);
                    token = size;
                    fg = (foes[0]->side == 0) ? "\033[1;31m" : "\033[1;34m";
                } else if (fort_[r][c] && (noFog || structVisibleAt(r, c, eSide, vis))) {
                    token = " #"; fg = C(30);
                } else if (bunker_[r][c] > 0 && (noFog || structVisibleAt(r, c, eSide, vis))) {
                    token = "堡"; fg = C(30);
                } else if (isBaseCell(r, c)) {
                    token = "营"; fg = C(30);
                } else if (bridge_[r][c]) {
                    token = "=="; fg = C(30);
                }
            } else if (dim) {
                bg = C(100); fg = C(90); token = "░░";
            } else {
                bg = C(40); token = "  ";
            }
            cout << bg << fg << token << RESET;
        }
        cout << "\n";
    }

    // 图例
    cout << "  绿=平地 白=高地 蓝=河流 红=禁地 黄=桥 灰░=已探明迷雾 黑=未探明"
         << "  #=工事 堡=地堡 营=大本营\n";
    cout << "  单位：步/骑/轻/侦/重/坦/喀/机/轰（红=红方 蓝=蓝方 灰=已行动）"
         << "  大/中/小=敌方规模\n";
    cout << string(66, '-') << "\n";

    // 空中威胁预警（仅当前方）
    bool threat = false;
    for (size_t i = 0; i < corps.size() && !threat; i++) {
        const Corps& e = corps[i];
        if (!e.alive || e.side == current || !SPEC[e.type].air) continue;
        for (size_t j = 0; j < corps.size(); j++) {
            const Corps& p = corps[j];
            if (!p.alive || p.side != current) continue;
            if (manh(e.r, e.c, p.r, p.c) <= 3) { threat = true; break; }
        }
    }
    if (threat && !gameOver)
        cout << "  ⚠ 空中威胁：侦测到敌方空中单位活动（距我方某兵团 ≤3 格），但无法定位与攻击。\n";

    // 导弹预警（发射方始终可见；防守方仅雷达范围内可见）
    for (size_t i = 0; i < pendingMissiles.size(); i++) {
        const PendingMissile& m = pendingMissiles[i];
        int br = BASES[1 - m.side][0], bc = BASES[1 - m.side][1];
        bool show = (current == m.side) || (manh(m.r, m.c, br, bc) <= 5);
        if (show)
            cout << "  ⊕ 导弹来袭预警：落点 " << posStr(m.r, m.c)
                 << "（下一回合命中）\n";
    }

    // 选中信息与指令
    Corps* cp = selId ? getCorps(selId) : nullptr;
    if (!cp || !cp->alive) {
        cout << "  未选中军团。输入军团编号选择（见下方列表）。\n";
    } else {
        const Spec& u = SPEC[cp->type];
        cout << "  选中：" << corpsLabel(*cp) << " 兵力 " << cp->troops << " @ " << posStr(cp->r, cp->c)
             << (cp->resting ? " [休整中]" : "") << (cp->fatigue > 0 ? " [疲劳]" : "")
             << (u.air ? " [空中]" : "") << (u.dur ? " [耐久 " + to_string(cp->dur) + "/3]" : "")
             << (acted.count(cp->id) ? " [已行动]" : "") << "\n";
        cout << "   视野 " << visionRange(*cp) << " 格";
        if (u.ranged) cout << " · 打击射程 " << strikeRange(*cp) << " 格";
        if (cp->type == T_KAT) cout << " · " << (cp->ammo ? "已装填" : "未装填");
        if (u.throwable) cout << " · 照明弹 " << cp->flare << "/烟雾弹 " << cp->smoke;
        if (u.missile) cout << " · 导弹 " << cp->missile;
        cout << "\n";
        cout << "  可用指令：\n";
        for (int n = 1; n <= 13; n++) {
            pair<bool, string> av = cmdAvailable(*cp, n);
            if (av.first) cout << "   " << n << ". " << CMD_NAME[n] << "\n";
        }
        if (acted.count(cp->id)) cout << "   （该军团本回合已行动）\n";
        if (viewLocked()) cout << "   （当前视角被锁定，无法操作）\n";
    }

    // 己方军团列表
    cout << string(66, '-') << "\n  己方军团：\n";
    bool anyOwn = false;
    for (size_t i = 0; i < corps.size(); i++) {
        const Corps& p = corps[i];
        if (!p.alive || p.side != current) continue;
        anyOwn = true;
        const Spec& u = SPEC[p.type];
        cout << "   [" << u.ch << "] #" << p.id << " " << u.name << " x" << p.troops
             << " @ " << posStr(p.r, p.c)
             << (p.resting ? " [休整]" : "") << (p.fatigue > 0 ? " [疲劳]" : "")
             << (u.dur ? " [耐" + to_string(p.dur) + "]" : "")
             << (acted.count(p.id) ? " [已行动]" : "")
             << (selId == p.id ? "  ◀ 当前选中" : "") << "\n";
    }
    if (!anyOwn) cout << "   （已无兵团）\n";

    // 已发现的敌方兵团
    {
        map<int, vector<const Corps*>> groups;
        for (size_t i = 0; i < corps.size(); i++) {
            const Corps& p = corps[i];
            if (!p.alive || p.side == current) continue;
            if (!unitVisibleTo(p, current, vis)) continue;
            groups[cellKey(p.r, p.c)].push_back(&p);
        }
        if (!groups.empty()) {
            cout << "  已发现的敌方兵团：\n";
            for (map<int, vector<const Corps*>>::iterator it = groups.begin(); it != groups.end(); ++it) {
                int k = it->first;
                string size = enemySizeClass(it->second);
                bool anyRest = false;
                for (size_t j = 0; j < it->second.size(); j++) if (it->second[j]->resting) { anyRest = true; break; }
                cout << "   规模[" << size << "] @ " << posStr(k / N, k % N)
                     << (anyRest ? " · 正在休整" : "")
                     << (it->second.size() > 1 ? " ×" + to_string(it->second.size()) : "") << "\n";
            }
        }
    }

    // 战报日志（分方可见：仅显示己方 + 公开）
    cout << string(66, '-') << "\n  战报日志：\n";
    {
        vector<const LogEntry*> rows;
        for (size_t i = 0; i < logEntries.size(); i++) {
            const LogEntry& e = logEntries[i];
            if (e.side == -1 || e.side == current) rows.push_back(&e);
        }
        int start = max(0, (int)rows.size() - 10);
        for (size_t i = (size_t)start; i < rows.size(); i++)
            cout << "   " << rows[i]->msg << "\n";
        if (rows.empty()) cout << "   （暂无）\n";
    }

    // 全局命令提示
    cout << string(66, '-') << "\n";
    cout << "  全局命令：编号=执行选中军团指令 | 军团编号=选择军团 | e=结束回合\n";
    cout << "            v=切换视角(自动/红/蓝/上帝) m=记忆地形开关 n=重新开局 q=退出 | 0=取消选择\n";
    cout << "  输入> ";
}

/* ---------------- 新开局 ---------------- */
static void newGame() {
    genMap();
    corps.clear(); nextId = 1; acted.clear(); selId = 0;
    current = 0; turnNo = 1; gameOver = false; winner = 0;
    pendingMissiles.clear();
    smokeSeq = 1;
    for (int r = 0; r < N; r++) for (int c = 0; c < N; c++) {
        flareT_[r][c] = 0; smokeLeft_[r][c] = 0; smokeId_[r][c] = 0;
    }
    for (int s = 0; s < 2; s++)
        for (int r = 0; r < N; r++) for (int c = 0; c < N; c++) seen_[s][r][c] = false;
    logEntries.clear();
    for (int i = 0; i < T_N; i++) deployCfg[i] = 0;
    phase = PH_DEPLOY; deploySide = 0;
    viewMode = "auto";
}

/* ---------------- 胜利画面 ---------------- */
static void victoryScreen() {
    clearScreen();
    cout << "\n\n";
    cout << "  ══════════════════════════════════════\n";
    cout << "          🏆  " << SIDE_NAME[winner] << " 获胜！  🏆\n";
    cout << "      共经历 " << turnNo << " 个回合（第 " << dayNo() << " 天）\n";
    cout << "  ══════════════════════════════════════\n\n";
    cout << "  n=再来一局  q=退出\n  输入> ";
    string line;
    if (!getline(cin, line)) exit(0);
    if (line == "n" || line == "N") newGame();
    else exit(0);
}

/* ---------------- 主循环 ---------------- */
int main() {
    srand((unsigned)time(nullptr));
    cout << "\033[2J\033[H";
    newGame();
    while (true) {
        if (phase == PH_DEPLOY) { deploymentScreen(); continue; }
        if (gameOver) { victoryScreen(); continue; }
        render();
        string line;
        if (!getline(cin, line)) break;
        // 去除首尾空白
        size_t b = line.find_first_not_of(" \t\r\n");
        if (b == string::npos) continue;
        size_t e = line.find_last_not_of(" \t\r\n");
        string cmd = line.substr(b, e - b + 1);

        if (cmd == "q" || cmd == "Q") break;
        if (cmd == "n" || cmd == "N") { newGame(); continue; }
        if (cmd == "m" || cmd == "M") { memoryFog = !memoryFog; continue; }
        if (cmd == "v" || cmd == "V") {
            const char* order[4] = { "auto", "red", "blue", "god" };
            int idx = 0;
            for (int i = 0; i < 4; i++) if (viewMode == order[i]) { idx = i; break; }
            viewMode = order[(idx + 1) % 4];
            if (viewLocked()) { selId = 0; }
            continue;
        }
        if (cmd == "0") { selId = 0; continue; }
        if (cmd == "e" || cmd == "E") { endTurn(); continue; }
        if (cmd.compare(0, 2, "s ") == 0 || cmd.compare(0, 2, "S ") == 0) {
            istringstream iss(cmd.substr(2));
            int id;
            if (iss >> id) {
                Corps* p = getCorps(id);
                if (p && p->alive && p->side == current) selId = id;
            }
            continue;
        }
        // 纯数字
        {
            istringstream iss(cmd);
            int num;
            if (iss >> num) {
                if (selId == 0) {
                    // 选择军团（按 id）
                    Corps* p = getCorps(num);
                    if (p && p->alive && p->side == current) selId = num;
                } else if (num >= 1 && num <= 13) {
                    Corps* cp = getCorps(selId);
                    if (cp && cp->alive && !viewLocked() && !gameOver) {
                        pair<bool, string> av = cmdAvailable(*cp, num);
                        if (av.first) runCommand(num, cp);
                        else cout << "  ⚠ 该指令不可用：" << av.second << "\n";
                    }
                }
                continue;
            }
        }
        cout << "  无法识别的命令。\n";
    }
    cout << "\033[2J\033[H" << "再见！\n";
    return 0;
}
