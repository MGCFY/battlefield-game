"""
train.py —— PPO 自对局主循环（League Play）
---------------------------------------------------------------------------
流程
  1. [可选] BC 预热：加载 ckpt/bc.pt 作为起点（无该文件则随机初始化）
  2. 主循环：
       a. 从 League 采一个对手（60% 历史快照 / 40% 规则 AI）
       b. 用当前策略 rollout 一整局（或 N 步），收集 (obs, mask, act, logp, value, reward, done)
       c. 对手若为「历史快照」→ env 走 externalOpponent 模式，由该快照网络驱动
       d. 用 ppo_loss 更新 K 个 epoch
       e. 定期存快照进 League，定期评估 vs 规则 AI 并打印硬指标
  3. 评估：vs rush ≥80%、vs turtle ≥60% 且 <100 回合（对齐既有 accept.js 口径）

用法
    # 冒烟（几分钟）
    python train.py --envs 2 --iters 3 --rollout 1500 --smoke
    # 正式（CPU 会慢，建议先小规模验证）
    python train.py --envs 8 --iters 200 --rollout 20000 --bc ckpt/bc.pt
"""
import argparse
import os
import random
import sys
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch
import torch.nn as nn

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from env_client import EnvClient            # noqa: E402
from league import League                   # noqa: E402
from model import TacticalNet, count_params  # noqa: E402
from ppo import compute_gae                  # noqa: E402

N_CELLS = 400
N_UNITS = 64
N_TYPES = 4


# ------------------------------------------------------------------ 观测/掩码打包
def obs_to_tensor(obs_flat_list):
    """[B, N*N*C] → [B, C, N, N]，C=12, N=20（行优先 [r][c][ch]）"""
    a = np.asarray(obs_flat_list, dtype=np.float32)          # [B, 4800]
    B = a.shape[0]
    a = a.reshape(B, 20, 20, 12).transpose(0, 3, 1, 2)       # [B,12,20,20]
    return torch.from_numpy(np.ascontiguousarray(a))


def mask_to_tensors(mask):
    um = torch.as_tensor(np.asarray(mask['unit'], dtype=np.float32))          # [B,64]
    tm = torch.as_tensor(np.asarray(mask['type'], dtype=np.float32))          # [B,64,4]
    return um, tm


def dense_target_mask(env, unit, type_):
    """按 (unit,type) 从 env 取合法目标列表 → [4,N²] 0/1 张量（只填当前 type 那行）"""
    m = np.zeros((N_TYPES, N_CELLS), dtype=np.float32)
    if type_ in (0, 1):
        tg = env.targets(unit, type_)
        for c in tg:
            if 0 <= c < N_CELLS:
                m[type_, c] = 1.0
    return torch.from_numpy(m)


# ------------------------------------------------------------------ 策略推理
@torch.no_grad()
def policy_act(net, obs_np, um, tm, env, greedy=False):
    """用 net 对单个状态决策；返回 (unit,type,target, logp, value)"""
    ob = obs_to_tensor([obs_np])                              # [1,12,20,20]
    out = net(ob, unit_mask=um.unsqueeze(0), type_mask=tm.unsqueeze(0))

    u_logits = out['unit'][0].masked_fill(um <= 0, -1e9)
    u_dist = torch.distributions.Categorical(logits=u_logits)
    u = int(u_logits.argmax(-1).item()) if (greedy or um.sum() <= 1) else int(u_dist.sample().item())
    lp_u = float(u_dist.log_prob(torch.tensor(u)))

    t_logits = out['type'][0, u].masked_fill(tm[u] <= 0, -1e9)
    t_dist = torch.distributions.Categorical(logits=t_logits)
    t = int(t_logits.argmax(-1).item()) if greedy else int(t_dist.sample().item())
    lp_t = float(t_dist.log_prob(torch.tensor(t)))

    c, lp_c = 0, 0.0
    if t in (0, 1):
        tm_dense = dense_target_mask(env, u, t)               # [4,N²]
        row = tm_dense[t]
        if row.sum() > 0:
            c_logits = out['target'][0, u, t].masked_fill(row <= 0, -1e9)
            c_dist = torch.distributions.Categorical(logits=c_logits)
            c = int(c_logits.argmax(-1).item()) if greedy else int(c_dist.sample().item())
            lp_c = float(c_dist.log_prob(torch.tensor(c)))
    return u, t, c, lp_u + lp_t + lp_c, float(out['value'].item())


def net_act_from_opp(net, po):
    """用 net 驱动外部对手（po = env_client.opp_obs() 的返回）"""
    obs = np.asarray(po['obs'], dtype=np.float32)
    um = torch.as_tensor(np.asarray(po['mask']['unit'], dtype=np.float32))
    tm = torch.as_tensor(np.asarray(po['mask']['type'], dtype=np.float32))
    ob = torch.from_numpy(np.ascontiguousarray(
        obs.reshape(20, 20, 12).transpose(2, 0, 1))).unsqueeze(0)
    with torch.no_grad():
        out = net(ob, unit_mask=um.unsqueeze(0), type_mask=tm.unsqueeze(0))
    u_logits = out['unit'][0].masked_fill(um <= 0, -1e9)
    u = int(u_logits.argmax(-1).item())
    t_logits = out['type'][0, u].masked_fill(tm[u] <= 0, -1e9)
    t = int(t_logits.argmax(-1).item())
    c = 0
    if t in (0, 1):
        # 对手的目标掩码无法从 sparse mask 还原 → 用 argmax 取一个，再由
        # env 侧 opp-step 兜底（非法目标会被安全忽略并标记 acted）
        c = int(out['target'][0, u, t].argmax(-1).item())
    return bool(um.sum() > 0), u, t, c


# ------------------------------------------------------------------ rollout
def rollout_one(env, net, league, max_steps=4000, seed=None, greedy=False):
    """
    跑一整局，返回 (traj, summary)。
    traj: list of dict(obs, um, tm, u, t, c, logp, value, reward, done)
      注意 reward/done 记录在「执行该动作之后」的位置，用于 GAE。
    """
    kind, ref = league.sample()
    opponent = 'external' if kind == 'snapshot' else ref
    opp_net = None
    if kind == 'snapshot':
        opp_net = TacticalNet(n_cells=N_CELLS)
        try:
            sd = torch.load(ref, map_location='cpu')
            opp_net.load_state_dict(sd['model'] if isinstance(sd, dict) and 'model' in sd else sd)
        except Exception as e:
            print('[train] 快照加载失败 %s：%s → 退回规则 AI' % (ref, e))
            opponent, opp_net = 'ai:medium', None
        opp_net.eval()

    obs, mask, meta = env.reset(side=0, seed=seed or random.randint(1, 10 ** 9),
                                opponent=opponent)
    # 外部对手模式下，reset 后可能立刻就是对手回合
    if meta.get('externalOpp') and mask_is_empty(mask):
        pass

    traj = []
    steps = 0
    total_r = 0.0
    done = False
    while not done and steps < max_steps:
        um, tm = mask_to_tensors(mask)
        if um.sum() <= 0:
            break
        u, t, c, logp, v = policy_act(net, obs, um, tm, env, greedy=greedy)
        # 存下该 (unit,type) 的 target 掩码一行，供 PPO 更新时保持口径一致
        cm_row = None
        if t in (0, 1):
            dm = dense_target_mask(env, u, t)          # [4,N²]
            cm_row = dm[t]                             # [N²]
        obs, mask, reward, done, info, meta = env.step(u, t, c)
        steps += 1
        total_r += reward
        traj.append(dict(obs=obs_to_tensor([obs])[0], um=um, tm=tm,
                         u=u, t=t, c=c, logp=logp, value=v,
                         cm=cm_row,
                         reward=reward, done=bool(done)))
        # 外部对手回合
        if info and info.get('awaitingOpponent'):
            opp_done, opp_r = _drive_opponent(env, opp_net)
            if opp_done is not None:
                done = opp_done
                # 对手回合的奖励记在最后一步上（近似）
                if traj and opp_r:
                    traj[-1]['reward'] += opp_r
                    traj[-1]['done'] = bool(done)
    summary = dict(kind=kind, ref=ref, steps=steps, reward=total_r,
                   round=meta.get('round'), winner=meta.get('winner'), done=done)
    return traj, summary


def mask_is_empty(mask):
    return sum(mask['unit']) <= 0


def _drive_opponent(env, opp_net):
    """对手回合：把对手所有动作提交完；返回 (done|None, 该回合拿到的奖励)"""
    done, reward = None, 0.0
    guard = 0
    while guard < 800:
        guard += 1
        po = env.opp_obs()
        if not po:
            break
        if opp_net is not None:
            ok, u, t, c = net_act_from_opp(opp_net, po)
            if not ok:
                break
        else:
            u = random.randrange(po['pending'])
            types = [k for k in range(4) if po['mask']['type'][u][k]]
            t = random.choice(types) if types else 3
            c = 0
            if t in (0, 1):
                tg = env.opp_targets(u, t)
                c = random.choice(tg) if tg else 0
        r = env.opp_step(u, t, c)
        if r.get('pendingOpp') is None:
            done = r.get('done', False)
            reward = r.get('reward', 0.0) or 0.0
            break
    return done, reward


# ------------------------------------------------------------------ 训练
def train(args):
    dev = torch.device(args.device)
    net = TacticalNet(n_cells=N_CELLS).to(dev)
    if args.bc and os.path.exists(args.bc):
        sd = torch.load(args.bc, map_location='cpu')
        net.load_state_dict(sd['model'] if isinstance(sd, dict) and 'model' in sd else sd)
        print('[train] 已从 BC 权重 %s 初始化' % args.bc)
    else:
        print('[train] 未找到 BC 权重，从随机初始化开始')
    print('[train] 参数 %.3fM  设备 %s' % (count_params(net) / 1e6, dev))

    opt = torch.optim.Adam(net.parameters(), lr=args.lr, eps=1e-5)
    league = League(path=args.league)
    if args.seed is not None:
        random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)

    envs = [EnvClient(src=args.src) for _ in range(args.envs)]
    print('[train] 环境进程 %d 个  起始 League: %s' % (args.envs, league.stats()))

    recent = deque(maxlen=40)
    t0 = time.time()
    hist = []
    try:
        for it in range(1, args.iters + 1):
            net.eval()
            # ---------- rollout（多环境并发）----------
            # 关键性能点：单次 NDJSON RPC 往返约 4.4ms（Node 事件循环 + stdout 刷新），
            # 所以「串行遍历环境」会把 4 个环境白白串成 1 个。这里用线程池并发提交。
            #
            # ⚠️ 线程安全假设（改动本段前必读）
            # 下面这些条件同时成立时，并发 rollout 才是安全的。任一被破坏都必须
            # 改回 `--serial`（或重新论证），否则会出现难以复现的竞态：
            #   1. `net` 在此处只被【只读推理】：rollout 循环里禁止 net.train() /
            #      net.eval()、禁止 optimizer.step() / zero_grad()、禁止写
            #      net 上任何 buffer。训练态的切换（net.train()/eval()）与
            #      参数更新一律在主线程 update 阶段做，不跨线程。
            #   2. 每个线程独占一个 EnvClient（n_env 个 client ↔ n_env 个 Node
            #      子进程一对一），且 EnvClient.rpc 内置锁串行化同一连接的
            #      请求/响应读写；禁止让两个线程共用一个 EnvClient。
            #   3. 线程内不得触碰跨线程共享的可变 Python 对象。目前只共享 `net`
            #      （只读）与 `league`（其 sample() 内部有随机数，但读取的快照
            #      列表在 rollout 期间不被写 —— 快照保存只发生在主线程）。
            #   4. torch 推理算子会释放 GIL，因此并发确实能提速；但若将来把
            #      rollout 改成含可训练算子的前向（如需要对 value 反传），
            #      autograd 的全局状态不是线程安全的，必须改回串行。
            # 实测（CPU，20 轮）：串行 n=4 → 204 step/s；并发 n=4 → 611 step/s；
            # 并发 n=8 → 993 step/s。
            n_env = len(envs)
            results = [None] * n_env
            seeds = [random.randint(1, 10 ** 9) for _ in range(n_env)]

            def _work(idx):
                # 仅做只读推理 + 独立环境 I/O；见上方「线程安全假设」。
                results[idx] = rollout_one(envs[idx], net, league,
                                           max_steps=args.max_steps, seed=seeds[idx])

            if n_env == 1 or args.serial:
                for i in range(n_env):
                    _work(i)
            else:
                with ThreadPoolExecutor(max_workers=n_env) as pool:
                    list(pool.map(_work, range(n_env)))

            trajs = [r[0] for r in results]
            summaries = [r[1] for r in results]
            for sm in summaries:
                recent.append(sm['reward'])

            n_steps = sum(len(t) for t in trajs)
            mean_r = float(np.mean([s['reward'] for s in summaries]))
            win_rate = float(np.mean([1.0 if s['winner'] == 0 else 0.0 for s in summaries]))

            # ---------- 组装 batch（跨环境独立算 GAE 后拼接）----------
            OBS, UM, TM, U, T, C, LP, ADV, RET, VAL, CM = \
                [], [], [], [], [], [], [], [], [], [], []
            for tr in trajs:
                if not tr:
                    continue
                rews = [s['reward'] for s in tr]
                vals = [s['value'] for s in tr]
                dones = [s['done'] for s in tr]
                adv, ret = compute_gae(rews, vals, dones,
                                       gamma=args.gamma, lam=args.lam, last_value=0.0)
                for i, s in enumerate(tr):
                    OBS.append(s['obs']); UM.append(s['um']); TM.append(s['tm'])
                    U.append(s['u']); T.append(s['t']); C.append(s['c'])
                    LP.append(s['logp']); ADV.append(float(adv[i])); RET.append(float(ret[i]))
                    VAL.append(s['value'])
                    CM.append(s['cm'] if s['cm'] is not None
                              else np.zeros(N_CELLS, dtype=np.float32))
            if not OBS:
                print('[iter %3d] 空 rollout，跳过' % it)
                continue

            obs_t = torch.stack(OBS)
            um_t = torch.stack(UM); tm_t = torch.stack(TM)
            u_t = torch.tensor(U, dtype=torch.long)
            t_t = torch.tensor(T, dtype=torch.long)
            c_t = torch.tensor(C, dtype=torch.long)
            lp_t = torch.tensor(LP, dtype=torch.float32)
            adv_t = torch.tensor(ADV, dtype=torch.float32)
            ret_t = torch.tensor(RET, dtype=torch.float32)
            val_t = torch.tensor(VAL, dtype=torch.float32)
            cm_t = torch.tensor(np.stack(CM), dtype=torch.float32)      # [n,N²]

            # ---------- PPO 更新 ----------
            n = len(OBS)
            idx = np.arange(n)
            last_stats = {}
            net.train()
            stop_early = False
            for ep in range(args.epochs):
                if stop_early:
                    break
                np.random.shuffle(idx)
                for s0 in range(0, n, args.batch):
                    b = idx[s0:s0 + args.batch]
                    out = net(obs_t[b], unit_mask=um_t[b], type_mask=tm_t[b])
                    logp, ent = evaluate_from_dense(out, um_t[b], tm_t[b],
                                                    u_t[b], t_t[b], c_t[b],
                                                    tmask_all=cm_t[b])
                    ratio = torch.exp(logp - lp_t[b])
                    a = adv_t[b]
                    a = (a - a.mean()) / (a.std() + 1e-8)
                    s1 = ratio * a
                    s2 = torch.clamp(ratio, 1 - args.clip, 1 + args.clip) * a
                    pl = -torch.min(s1, s2).mean()
                    v = out['value']
                    v_clip = val_t[b] + torch.clamp(v - val_t[b], -args.clip, args.clip)
                    vl = 0.5 * torch.max((v - ret_t[b]) ** 2, (v_clip - ret_t[b]) ** 2).mean()
                    loss = pl + args.vf_coef * vl - args.ent_coef * ent.mean()
                    opt.zero_grad(); loss.backward()
                    nn.utils.clip_grad_norm_(net.parameters(), 1.0)
                    opt.step()
                    kl_now = float((lp_t[b] - logp).mean().detach())
                    last_stats = dict(policy_loss=float(pl.detach()), value_loss=float(vl.detach()),
                                      entropy=float(ent.mean().detach()),
                                      kl=kl_now,
                                      clip_frac=float(((ratio - 1).abs() > args.clip).float().mean().detach()))
                    # 早停：新旧策略偏离过大就停止本批的后续 epoch（PPO 稳定性关键）
                    if ep > 0 and abs(kl_now) > args.target_kl:
                        stop_early = True
                        break

            # ---------- 存快照 ----------
            if it % 20 == 0:
                league.save_snapshot(net.state_dict(), it)

            hist.append(dict(it=it, steps=n_steps, mean_r=mean_r, win=win_rate, **last_stats))
            print('[iter %3d] steps %5d  meanR %+.3f  win %.0f%%  pl %.4f  vl %.3f  ent %.3f  kl %+.4f  '
                  'clip %.3f  (%.1fs)'
                  % (it, n_steps, mean_r, win_rate * 100, last_stats.get('policy_loss', 0),
                     last_stats.get('value_loss', 0), last_stats.get('entropy', 0),
                     last_stats.get('kl', 0), last_stats.get('clip_frac', 0), time.time() - t0))

            if it % args.save_every == 0:
                os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
                torch.save({'model': net.state_dict(), 'iter': it,
                            'meta': {'args': vars(args)}}, args.out)
                print('       ↳ 已保存 %s' % args.out)

        os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
        torch.save({'model': net.state_dict(), 'iter': args.iters,
                    'meta': {'args': vars(args)}}, args.out)
        print('[train] 完成，最终权重 → %s' % args.out)
    finally:
        for e in envs:
            e.close()


def evaluate_from_dense(out, um, tm, u_act, t_act, c_act, tmask_all=None):
    """
    从共享的三个头算出「已选动作」的联合 logp 与 entropy。

    口径必须与 rollout 时的两阶段采样完全一致（否则 PPO 的 ratio 会因
    「掩码下标是否参与 softmax 归一」而系统性偏移 —— 这是首版 KL 爆表的根因）：
      · unit  : 按 unit_mask 掩码
      · type  : 按该 unit 的 type 掩码
      · target: 按该 (unit,type) 的 target 掩码（tmask_all[b,u,type,:]）
                tmask_all 为 None 时退化为不掩码（仅用于形状自检）
    """
    B = out['unit'].shape[0]

    u_logits = out['unit'].masked_fill(um <= 0, -1e9)
    u_dist = torch.distributions.Categorical(logits=u_logits)
    lp_u, ent_u = u_dist.log_prob(u_act), u_dist.entropy()

    pick_u = u_act.view(B, 1, 1).expand(B, 1, 4)
    tl = out['type'].gather(1, pick_u).squeeze(1)
    tm_sel = tm.gather(1, u_act.view(B, 1, 1).expand(B, 1, 4)).squeeze(1)
    tl = tl.masked_fill(tm_sel <= 0, -1e9)
    t_dist = torch.distributions.Categorical(logits=tl)
    lp_t, ent_t = t_dist.log_prob(t_act), t_dist.entropy()

    # ① 选 unit → [B,4,N²]
    pick_u2 = u_act.view(B, 1, 1, 1).expand(B, 1, 4, N_CELLS)
    t_all = out['target'].gather(1, pick_u2).squeeze(1)          # [B,4,N²]
    # ② 选 type → [B,N²]
    pick_t = t_act.view(B, 1, 1).expand(B, 1, N_CELLS)
    cl = t_all.gather(1, pick_t).squeeze(1)                       # [B,N²]

    # ③ 掩码：只对需要目标的动作（type 0/1）施加，且掩码必须与 rollout 一致
    need = ((t_act == 0) | (t_act == 1))
    if tmask_all is not None:
        # tmask_all: [B,4,N²]（已按 (u_act,t_act) 选好）或 [B,U,4,N²]
        cm = tmask_all
        if cm.dim() == 4:
            cm = cm.gather(1, pick_u2).squeeze(1).gather(1, pick_t).squeeze(1)
        cm = cm * need.float().unsqueeze(-1)
        # 全 0 行（不需要目标）→ 置全 1，避免 softmax 全 -1e9
        all_zero = (cm.sum(-1, keepdim=True) <= 0)
        cm = torch.where(all_zero, torch.ones_like(cm), cm)
        cl = cl.masked_fill(cm <= 0, -1e9)

    c_dist = torch.distributions.Categorical(logits=cl)
    lp_c, ent_c = c_dist.log_prob(c_act), c_dist.entropy()

    lp = lp_u + lp_t + need.float() * lp_c
    ent = ent_u + ent_t + need.float() * ent_c
    return lp, ent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='../battlefield-v3.9.16.html')
    ap.add_argument('--envs', type=int, default=4)
    ap.add_argument('--iters', type=int, default=100)
    ap.add_argument('--max-steps', type=int, default=4000, help='单局步数上限')
    ap.add_argument('--lr', type=float, default=3e-4)
    ap.add_argument('--gamma', type=float, default=0.995)
    ap.add_argument('--lam', type=float, default=0.95)
    ap.add_argument('--clip', type=float, default=0.2)
    ap.add_argument('--vf-coef', type=float, default=0.5, dest='vf_coef',
                    help='价值损失系数（默认 0.5）')
    ap.add_argument('--ent-coef', type=float, default=0.01, dest='ent_coef',
                    help='熵奖励系数。太小→策略坍塌；太大→学不收敛（默认 0.01，'
                         '基线训练中熵从 2.3 升到 3.1，属健康）')
    ap.add_argument('--epochs', type=int, default=4)
    ap.add_argument('--target-kl', type=float, default=0.05, dest='target_kl',
                    help='早停阈值：单批 KL 超过它就结束本批剩余 epoch')
    ap.add_argument('--batch', type=int, default=256)
    ap.add_argument('--bc', default='ckpt/bc.pt')
    ap.add_argument('--league', default='ckpt/league')
    ap.add_argument('--out', default='ckpt/ppo.pt')
    ap.add_argument('--save-every', type=int, default=10, dest='save_every')
    ap.add_argument('--device', default='cpu')
    ap.add_argument('--serial', action='store_true',
                    help='串行跑环境（默认并发；排障时可用）')
    ap.add_argument('--seed', type=int, default=None)
    ap.add_argument('--smoke', action='store_true')
    args = ap.parse_args()
    if args.smoke:
        args.envs, args.iters, args.max_steps = max(args.envs, 2), 3, 600
    train(args)


if __name__ == '__main__':
    main()
