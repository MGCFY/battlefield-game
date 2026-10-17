"""
league.py —— League Play 对手池
---------------------------------------------------------------------------
方案：每次 reset 时按 60% / 40% 采样对手来源
  60% 历史快照（self-play，对手是过去某个时刻的自己 → 难度阶梯、防策略坍塌）
  40% 规则 AI（ai:easy / ai:medium / ai:hard → 保证不脱离游戏本体强度）

历史快照的管理：
  - Trainer 每 N 次更新把当前权重存进 `ckpt/league/<iters>.pt`
  - 池子里最多保留 MAX_SNAPSHOTS 个，超出后按「优先淘汰最老、但保留最早的一个
    （防止能力分布退化）」策略淘汰
  - 采样概率按池内序号做温和的指数加权：越新的快照概率略高，但老快照仍有机会

对手在 env_server 里怎么跑？
  规则 AI：直接传 opponent='ai:medium'，由 Node 侧 policies.js 驱动。
  历史快照：Node 侧不认识 PyTorch 权重 —— 因此快照对手采用「Python 侧驱动」模式：
    env_server 支持 opponent='external'，即轮到对手时 env_server 返回一个
    needs_opponent_action 标记，由 Python 用快照网络决策后再喂回去。
    （见 env_server 的 'set-opp-policy' / 'submit-opp' 扩展；本文件提供封装。）
"""
import glob
import os
import random
import re
import shutil

RULE_OPPONENTS = ['ai:easy', 'ai:medium', 'ai:hard']
# 规则 AI 内部的档位权重：中等档为主（它是最强的规则对手），困难档次之
RULE_WEIGHTS = {'ai:easy': 0.15, 'ai:medium': 0.55, 'ai:hard': 0.30}

SNAPSHOT_FRAC = 0.6        # 60% 概率抽历史快照
MAX_SNAPSHOTS = 12         # 池子上限
SNAPSHOT_EVERY = 20        # 每多少次 PPO 更新存一个快照


class League:
    def __init__(self, path='ckpt/league', rule_opponents=None,
                 snapshot_frac=SNAPSHOT_FRAC, max_snapshots=MAX_SNAPSHOTS):
        self.path = path
        self.rule_opponents = rule_opponents or RULE_OPPONENTS
        self.snapshot_frac = snapshot_frac
        self.max_snapshots = max_snapshots
        os.makedirs(path, exist_ok=True)

    # ---------- 快照管理 ----------
    def list_snapshots(self):
        """返回按迭代号升序的 [(iters, filepath), ...]"""
        out = []
        for p in glob.glob(os.path.join(self.path, 'it*.pt')):
            m = re.search(r'it(\d+)\.pt$', os.path.basename(p))
            if m:
                out.append((int(m.group(1)), p))
        out.sort(key=lambda x: x[0])
        return out

    def save_snapshot(self, model, iters):
        p = os.path.join(self.path, 'it%06d.pt' % iters)
        tmp = p + '.tmp'
        try:
            # 用 state_dict 存（不 pickle 模块对象，避免 torch 版本耦合）
            sd = model.state_dict() if hasattr(model, 'state_dict') else model
            torch_save(sd, tmp)
            os.replace(tmp, p)
        except Exception as e:
            print('[league] 快照保存失败 %s：%s' % (p, e))
            if os.path.exists(tmp):
                os.remove(tmp)
            return None
        self._prune()
        return p

    def _prune(self):
        snaps = self.list_snapshots()
        if len(snaps) <= self.max_snapshots:
            return
        # 淘汰中间最老的一批，但保留第 0 个（最早的对手，提供最弱基线）
        keep_first = snaps[:1]
        rest = snaps[1:]
        rest = rest[-(self.max_snapshots - 1):]
        keep = keep_first + rest
        keep_set = {p for _, p in keep}
        for it, p in snaps:
            if p not in keep_set:
                try:
                    os.remove(p)
                except OSError:
                    pass

    # ---------- 采样 ----------
    def sample(self):
        """
        返回 ('rule', 'ai:medium') 或 ('snapshot', filepath)
        """
        snaps = self.list_snapshots()
        use_snap = snaps and (random.random() < self.snapshot_frac)
        if use_snap:
            # 温和指数加权：越新概率越高（权重 = i+1）
            weights = [i + 1 for i in range(len(snaps))]
            it, p = random.choices(snaps, weights=weights, k=1)[0]
            return ('snapshot', p)
        names = list(RULE_WEIGHTS.keys())
        w = [RULE_WEIGHTS[n] for n in names]
        return ('rule', random.choices(names, weights=w, k=1)[0])

    def stats(self):
        snaps = self.list_snapshots()
        return {
            'snapshots': len(snaps),
            'newest': snaps[-1][0] if snaps else None,
            'oldest': snaps[0][0] if snaps else None,
            'rule_opponents': self.rule_opponents,
        }


# ---------- torch 延迟导入（没有 torch 也能 import 本文件做统计） ----------
def torch_save(obj, path):
    import torch
    torch.save(obj, path)


def torch_load(path, map_location='cpu'):
    import torch
    return torch.load(path, map_location=map_location)


if __name__ == '__main__':
    lg = League(path='ckpt/league_test')
    print('初始:', lg.stats())
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from model import TacticalNet
    net = TacticalNet()
    for it in [20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280]:
        lg.save_snapshot(net, it)
    print('填满后:', lg.stats())
    from collections import Counter
    c = Counter()
    for _ in range(400):
        kind, ref = lg.sample()
        c[kind if kind == 'rule' else 'snapshot'] += 1
        if kind == 'rule':
            c['rule:' + ref] += 1
    print('采样分布(400 次):', dict(c))
    shutil.rmtree('ckpt/league_test', ignore_errors=True)
