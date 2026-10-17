"""
bc_warmup.py —— 行为克隆预热
---------------------------------------------------------------------------
用途：在 PPO 自对局之前，用 collect.js 采到的「规则 AI 教师」数据做监督学习，
让策略网络先具备基本常识（别乱走、该开火就开火），再进入 RL 自博弈。

数据来源（可选，缺失时优雅跳过）：
    headless/data/bc_*/meta.json + *.npy     见 load_bc.py
采集命令：
    node collect.js --out data/bc_medium --games 400 --obs float --policy ai:medium

用法：
    python bc_warmup.py --data ../data/bc_medium --steps 3000 --out ckpt/bc.pt
    python bc_warmup.py --data ../data/bc_medium --device cpu
"""
import argparse
import os
import sys

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))          # 让 load_bc 可导入
sys.path.insert(0, HERE)

from model import TacticalNet, count_params      # noqa: E402


def try_load(path):
    try:
        from load_bc import load_bc
        return load_bc(path)
    except Exception as e:
        print('[bc] 无法加载 %s：%s' % (path, e))
        return None


def build_masks(ds, n_units=64):
    """从 CSR 合法项构造 [D,64] 与 [D,64,4] 掩码（不展开 target，省内存）"""
    D = len(ds)
    N2 = ds.N * ds.N
    um = np.zeros((D, n_units), dtype=np.uint8)
    tm = np.zeros((D, n_units, 4), dtype=np.uint8)
    for i in range(D):
        u = int(ds.unitIdx[i])
        if 0 <= u < n_units:
            um[i, u] = 1
            tm[i, u, :] = ds.legal_types[i, :4].astype(np.uint8)
    return um, tm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='../data/bc_medium')
    ap.add_argument('--steps', type=int, default=3000)
    ap.add_argument('--bs', type=int, default=128)
    ap.add_argument('--lr', type=float, default=3e-4)
    ap.add_argument('--device', default='cpu')
    ap.add_argument('--out', default='ckpt/bc.pt')
    ap.add_argument('--init', default=None, help='从已有权重继续（PPO 前热身）')
    args = ap.parse_args()

    ds = try_load(args.data)
    if ds is None or ds.obs is None:
        print('[bc] 没有可用数据，跳过预热。先用 collect.js 采集：')
        print('     cd .. && node collect.js -n 200 --red ai:hard --blue ai:medium \\')
        print('                     --out data/bc_medium --src ../battlefield-v3.9.16.html')
        # 仍然随机初始化一个权重，保证后续流程有起点
        net = TacticalNet(n_cells=400)
        os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
        torch.save({'model': net.state_dict(), 'meta': {'bc': False}}, args.out)
        print('[bc] 已写出随机初始化权重 → %s（参数 %.3fM）' % (args.out, count_params(net) / 1e6))
        return

    print('[bc] 数据：%s  样本 %d  合法率 %.2f%%' % (args.data, len(ds), ds.valid.mean() * 100))
    obs = ds.obs_float()                              # [D,12,N,N] float32
    sel = np.nonzero(ds.valid > 0)[0]
    obs, unit, typ, tgt = obs[sel], ds.unitIdx[sel], ds.type[sel], ds.target[sel]
    um, tm_all = build_masks(ds, 64)
    um, tm_all = um[sel], tm_all[sel]
    # 每个样本的 target 掩码（CSR → 稠密 4×N²，按需构造当前 type 的一行）
    N2 = ds.N * ds.N

    dev = torch.device(args.device)
    net = TacticalNet(n_cells=N2).to(dev)
    if args.init and os.path.exists(args.init):
        sd = torch.load(args.init, map_location='cpu')
        net.load_state_dict(sd['model'] if 'model' in sd else sd)
        print('[bc] 从 %s 继续训练' % args.init)
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)
    print('[bc] 参数 %.3fM  训练 %d 步' % (count_params(net) / 1e6, args.steps))

    D = len(sel)
    for step in range(args.steps):
        bi = np.random.randint(0, D, size=args.bs)
        ob = torch.as_tensor(obs[bi], dtype=torch.float32, device=dev)
        u = torch.as_tensor(unit[bi], dtype=torch.long, device=dev)
        t = torch.as_tensor(typ[bi], dtype=torch.long, device=dev)
        c = torch.as_tensor(tgt[bi], dtype=torch.long, device=dev)
        umb = torch.as_tensor(um[bi], dtype=torch.float32, device=dev)
        tmb = torch.as_tensor(tm_all[bi], dtype=torch.float32, device=dev)

        out = net(ob, unit_mask=umb, type_mask=tmb)
        # unit 头损失
        l_u = F.cross_entropy(out['unit'].masked_fill(umb <= 0, -1e9), u)
        # type 头损失（条件于教师 unit）
        idx = u.view(-1, 1, 1).expand(-1, 1, 4)
        tl = out['type'].gather(1, idx).squeeze(1)
        l_t = F.cross_entropy(tl.masked_fill(tmb.gather(1, u.view(-1, 1, 1).expand(-1, 1, 4)).squeeze(1) <= 0, -1e9), t)
        # target 头损失（仅 type ∈ {0,1}）
        need = (t <= 1)
        if need.any():
            # out['target'] [B,U,4,N²]
            #   ① 选 unit：gather dim=1，索引张量 [B,1,4,N²] → [B,1,4,N²]
            pu = u[need].view(-1, 1, 1, 1).expand(-1, 1, 4, N2)
            ta = out['target'][need].gather(1, pu).squeeze(1)          # [n,4,N²]
            #   ② 选 type：gather dim=1，索引张量 [n,1,N²] → [n,1,N²]
            pt = t[need].view(-1, 1, 1).expand(-1, 1, N2)
            cl = ta.gather(1, pt).squeeze(1)                           # [n,N²]
            l_c = F.cross_entropy(cl, c[need])
        else:
            l_c = torch.zeros((), device=dev)

        loss = l_u + l_t + l_c
        opt.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(net.parameters(), 1.0)
        opt.step()

        if (step + 1) % 200 == 0:
            acc_u = (out['unit'].masked_fill(umb <= 0, -1e9).argmax(-1) == u).float().mean()
            acc_t = (tl.masked_fill(tmb.gather(1, u.view(-1, 1, 1).expand(-1, 1, 4)).squeeze(1) <= 0, -1e9).argmax(-1) == t).float().mean()
            acc_c = (cl.argmax(-1) == c[need]).float().mean() if need.any() else torch.tensor(0.0)
            print('step %5d  loss %.4f (u %.3f t %.3f c %.3f)  acc u %.3f t %.3f c %.3f'
                  % (step + 1, loss.item(), l_u.item(), l_t.item(),
                     float(l_c), acc_u.item(), acc_t.item(), float(acc_c)))

    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    torch.save({'model': net.state_dict(), 'meta': {'bc': True, 'data': args.data}}, args.out)
    print('[bc] 已保存 → %s' % args.out)


if __name__ == '__main__':
    main()
