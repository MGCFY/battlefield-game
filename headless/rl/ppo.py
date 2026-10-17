"""
ppo.py —— PPO 核心（因子化动作 + 掩码 + GAE）
---------------------------------------------------------------------------
与 model.TacticalNet 的三个头对齐：

    采样  a = (u, t, c)
      u ~ Categorical(mask(unit_logits))                        [在 64 槽位里选]
      t ~ Categorical(mask(type_logits[b,u]))                   [该单位的合法类型]
      c ~ Categorical(mask(target_logits[b,u,t]))               [该 type 的合法格]

    更新  L = L_policy + 0.5*L_value - 0.01*L_entropy
      ratio    = exp(logp_new - logp_old)                       （三元组联合 logp）
      L_policy = -min(ratio*A, clip(ratio,1±eps)*A)

GAE 用标准公式；因为动作结算包含「整回合推进（对手行动）」，奖励是
稀疏 + 塑形混合，γ 取 0.995、λ 取 0.95。
"""
import torch
import torch.nn as nn
import torch.nn.functional as F


# ---------------------------------------------------------------- 采样
def sample_actions(out, unit_mask, type_mask, target_lists, n_cells, greedy=False):
    """
    out          : model 前向输出 {'unit','type','target','value'}
    unit_mask    : LongTensor [B,64]           可行动槽位
    type_mask    : LongTensor [B,64,4]         条件类型掩码
    target_lists : list[list[int]] 长度 B     每个样本的「合法 (type,target) 掩码」
                   形如 B 个 [4, n_cells] 的 0/1 张量（Python list 或 tensor）
    返回 (act_u, act_t, act_c, logp, entropy, value)
    """
    B = out['unit'].shape[0]
    dev = out['unit'].device

    # ---- unit 头 ----
    um = unit_mask.to(dev).float()
    u_logits = out['unit'].masked_fill(um <= 0, -1e9)
    u_dist = torch.distributions.Categorical(logits=u_logits)
    if greedy:
        act_u = u_logits.argmax(dim=-1)
    else:
        act_u = u_dist.sample()
    logp_u = u_dist.log_prob(act_u)
    ent_u = u_dist.entropy()

    # ---- type 头（条件于 act_u）----
    idx = act_u.view(B, 1, 1).expand(B, 1, 4)
    t_logits = out['type'].gather(1, idx).squeeze(1)          # [B,4]
    tm = type_mask.to(dev).float()
    tm_sel = tm.gather(1, act_u.view(B, 1, 1).expand(B, 1, 4)).squeeze(1)  # [B,4]
    t_logits = t_logits.masked_fill(tm_sel <= 0, -1e9)
    t_dist = torch.distributions.Categorical(logits=t_logits)
    if greedy:
        act_t = t_logits.argmax(dim=-1)
    else:
        act_t = t_dist.sample()
    logp_t = t_dist.log_prob(act_t)
    ent_t = t_dist.entropy()

    # ---- target 头（条件于 act_u, act_t）----
    # target_logits [B,U,4,N²] → 取 [b, act_u, act_t, :]
    pick_u = act_u.view(B, 1, 1, 1).expand(B, 1, 1, n_cells)
    t_all = out['target'].gather(1, pick_u).squeeze(1)        # [B,4,N²]
    pick_t = act_t.view(B, 1, 1).expand(B, 1, n_cells)
    c_logits = t_all.gather(1, pick_t).squeeze(1)             # [B,N²]

    # target 掩码：type ∈ {2,3} 时无目标，掩码全 0 → 用一个 dummy 单点分布
    cm = _stack_target_masks(target_lists, dev)               # [B,4,N²] float
    cm_sel = cm.gather(1, pick_t).squeeze(1)                  # [B,N²]
    need_target = ((act_t == 0) | (act_t == 1)).float().unsqueeze(-1)   # [B,1]
    cm_sel = cm_sel * need_target + (1 - need_target)          # 不需要目标时全 1（dummy）
    all_zero = (cm_sel.sum(dim=-1, keepdim=True) <= 0)
    cm_sel = torch.where(all_zero, torch.ones_like(cm_sel), cm_sel)

    c_logits = c_logits.masked_fill(cm_sel <= 0, -1e9)
    c_dist = torch.distributions.Categorical(logits=c_logits)
    if greedy:
        act_c = c_logits.argmax(dim=-1)
    else:
        act_c = c_dist.sample()
    logp_c = c_dist.log_prob(act_c)
    ent_c = c_dist.entropy()

    logp = logp_u + logp_t + logp_c
    entropy = ent_u + ent_t + ent_c
    return act_u, act_t, act_c, logp, entropy, out['value']


def evaluate_actions(out, unit_mask, type_mask, target_lists, n_cells,
                     act_u, act_t, act_c):
    """同 sample_actions，但对给定动作算 logp / entropy（PPO 更新用）"""
    B = out['unit'].shape[0]
    dev = out['unit'].device

    um = unit_mask.to(dev).float()
    u_logits = out['unit'].masked_fill(um <= 0, -1e9)
    u_dist = torch.distributions.Categorical(logits=u_logits)
    logp_u = u_dist.log_prob(act_u)
    ent_u = u_dist.entropy()

    idx = act_u.view(B, 1, 1).expand(B, 1, 4)
    t_logits = out['type'].gather(1, idx).squeeze(1)
    tm = type_mask.to(dev).float()
    tm_sel = tm.gather(1, act_u.view(B, 1, 1).expand(B, 1, 4)).squeeze(1)
    t_logits = t_logits.masked_fill(tm_sel <= 0, -1e9)
    t_dist = torch.distributions.Categorical(logits=t_logits)
    logp_t = t_dist.log_prob(act_t)
    ent_t = t_dist.entropy()

    pick_u = act_u.view(B, 1, 1, 1).expand(B, 1, 1, n_cells)
    t_all = out['target'].gather(1, pick_u).squeeze(1)
    pick_t = act_t.view(B, 1, 1).expand(B, 1, n_cells)
    c_logits = t_all.gather(1, pick_t).squeeze(1)
    cm = _stack_target_masks(target_lists, dev)
    cm_sel = cm.gather(1, pick_t).squeeze(1)
    need_target = ((act_t == 0) | (act_t == 1)).float().unsqueeze(-1)
    cm_sel = cm_sel * need_target + (1 - need_target)
    all_zero = (cm_sel.sum(dim=-1, keepdim=True) <= 0)
    cm_sel = torch.where(all_zero, torch.ones_like(cm_sel), cm_sel)
    c_logits = c_logits.masked_fill(cm_sel <= 0, -1e9)
    c_dist = torch.distributions.Categorical(logits=c_logits)
    logp_c = c_dist.log_prob(act_c)
    ent_c = c_dist.entropy()

    return logp_u + logp_t + logp_c, ent_u + ent_t + ent_c


def _stack_target_masks(target_lists, dev):
    """target_lists: B 个 [4, N²] 的 0/1（list 或 tensor）→ [B,4,N²] float"""
    if isinstance(target_lists, torch.Tensor):
        return target_lists.to(dev).float()
    arrs = [torch.as_tensor(t, dtype=torch.float32) for t in target_lists]
    return torch.stack(arrs, dim=0).to(dev)


# ---------------------------------------------------------------- GAE
def compute_gae(rewards, values, dones, gamma=0.995, lam=0.95, last_value=0.0):
    """
    rewards / values / dones : list[T]（每个 rollout 步）
    返回 (advantages, returns) —— 两者都是 [T] 的 tensor
    """
    T = len(rewards)
    adv = torch.zeros(T, dtype=torch.float32)
    last_gae = 0.0
    for t in reversed(range(T)):
        if t == T - 1:
            next_v = last_value
            nonterminal = 1.0 - float(dones[t])
        else:
            next_v = values[t + 1]
            nonterminal = 1.0 - float(dones[t])
        delta = rewards[t] + gamma * next_v * nonterminal - values[t]
        last_gae = delta + gamma * lam * nonterminal * last_gae
        adv[t] = last_gae
    ret = adv + torch.tensor(values, dtype=torch.float32)
    return adv, ret


# ---------------------------------------------------------------- PPO 更新
def ppo_loss(out, unit_mask, type_mask, target_lists, n_cells,
             act_u, act_t, act_c, old_logp, adv, ret, old_value,
             clip=0.2, vf_coef=0.5, ent_coef=0.01):
    logp, ent = evaluate_actions(out, unit_mask, type_mask, target_lists,
                                 n_cells, act_u, act_t, act_c)
    ratio = torch.exp(logp - old_logp)
    adv = adv.detach()
    adv_n = (adv - adv.mean()) / (adv.std() + 1e-8)

    surr1 = ratio * adv_n
    surr2 = torch.clamp(ratio, 1 - clip, 1 + clip) * adv_n
    policy_loss = -torch.min(surr1, surr2).mean()

    v = out['value']
    # 价值裁剪（PPO 原论文做法），抑制 value 爆炸
    v_clipped = old_value.detach() + torch.clamp(v - old_value.detach(), -clip, clip)
    vf_loss = 0.5 * torch.max((v - ret) ** 2, (v_clipped - ret) ** 2).mean()

    loss = policy_loss + vf_coef * vf_loss - ent_coef * ent.mean()
    return loss, {
        'policy_loss': float(policy_loss),
        'value_loss': float(vf_loss),
        'entropy': float(ent.mean()),
        'approx_kl': float((old_logp - logp).mean()),
        'clip_frac': float(((ratio - 1).abs() > clip).float().mean()),
    }
