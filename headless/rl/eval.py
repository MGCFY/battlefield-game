"""
eval.py —— 用训练出的策略网络对打规则基线，复核硬指标
---------------------------------------------------------------------------
与既有 headless/accept.js 的口径对齐：
  中等 AI 对速推(rush)  ≥ 80%
  中等 AI 对龟缩(turtle) ≥ 60% 且平均回合 < 100

这里的「AI」换成了 PPO 学到的策略网络（agent 侧），对手是 rush / turtle。
评估必须**关闭随机性**（greedy=True）且固定种子组，保证可复现。

用法
    python eval.py --ckpt ckpt/ppo.pt --games 40 --opp turtle
    python eval.py --ckpt ckpt/ppo.pt --games 40 --opp rush --side 0
"""
import argparse
import os
import sys
import time

import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from env_client import EnvClient                 # noqa: E402
from model import TacticalNet                    # noqa: E402
from train import policy_act, mask_to_tensors, N_CELLS   # noqa: E402


def play_one(env, net, opp, seed, side=0, max_steps=6000):
    obs, mask, meta = env.reset(side=side, seed=seed, opponent=opp)
    done = False
    steps = 0
    while not done and steps < max_steps:
        um, tm = mask_to_tensors(mask)
        if um.sum() <= 0:
            break
        u, t, c, _, _ = policy_act(net, obs, um, tm, env, greedy=True)
        obs, mask, reward, done, info, meta = env.step(u, t, c)
        steps += 1
    return dict(winner=meta.get('winner'), round=meta.get('round'),
                steps=steps, done=done, side=side,
                reason=(info or {}).get('reason') if isinstance(info, dict) else None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='../battlefield-v3.9.16.html')
    ap.add_argument('--ckpt', default='ckpt/ppo.pt')
    ap.add_argument('--games', type=int, default=40)
    ap.add_argument('--opp', default='turtle', help='rush | turtle | hold | ai:medium ...')
    ap.add_argument('--side', type=int, default=0)
    ap.add_argument('--seed0', type=int, default=1000)
    ap.add_argument('--envs', type=int, default=4)
    args = ap.parse_args()

    net = TacticalNet(n_cells=N_CELLS)
    if os.path.exists(args.ckpt):
        sd = torch.load(args.ckpt, map_location='cpu')
        net.load_state_dict(sd['model'] if isinstance(sd, dict) and 'model' in sd else sd)
        print('[eval] 已加载 %s' % args.ckpt)
    else:
        print('[eval] 警告：%s 不存在，使用随机权重（仅用于验证评估链路）' % args.ckpt)
    net.eval()

    envs = [EnvClient(src=args.src) for _ in range(args.envs)]
    t0 = time.time()
    results = []
    try:
        for g in range(args.games):
            e = envs[g % args.envs]
            r = play_one(e, net, args.opp, args.seed0 + g, side=args.side)
            results.append(r)
    finally:
        for e in envs:
            e.close()

    wins = []
    for r in results:
        # 超时局不算胜：与 accept.js 口径一致（accept.js 里超时计为「未歼灭」）
        if r.get('reason') == 'timeout':
            wins.append(0.0)
        else:
            wins.append(1.0 if r['winner'] == args.side else 0.0)
    wr = float(np.mean(wins))
    rounds = [r['round'] for r in results if r['round'] is not None]
    avg_round = float(np.mean(rounds)) if rounds else 0.0
    timeouts = sum(1 for r in results if r['reason'] == 'timeout')

    print('-' * 60)
    print('  对手        %s        （agent side=%d）' % (args.opp, args.side))
    print('  对局数      %d' % len(results))
    print('  胜率        %.1f%%   (%d/%d)' % (wr * 100, int(sum(wins)), len(results)))
    print('  平均回合    %.1f    （超时局 %d）' % (avg_round, timeouts))
    print('  用时        %.1fs' % (time.time() - t0))
    print('-' * 60)

    # 硬指标判定（与 accept.js 口径一致）
    if args.opp == 'rush':
        ok = wr >= 0.80
        print('  门槛(rush):  胜率 ≥80%%  → %s (%.1f%%)' % ('✅ 达标' if ok else '❌ 未达标', wr * 100))
    elif args.opp == 'turtle':
        ok = wr >= 0.60 and avg_round < 100
        print('  门槛(turtle): 胜率 ≥60%% 且 <100 回合 → %s (%.1f%% / %.1f 回合)'
              % ('✅ 达标' if ok else '❌ 未达标', wr * 100, avg_round))
    return 0


if __name__ == '__main__':
    sys.exit(main())
