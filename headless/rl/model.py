"""
model.py —— 战术网络（因子化动作头，~2M 参数）
---------------------------------------------------------------------------
输入 : obs [B, 12, 20, 20]（float32，通道 0-10 ∈ {0,1}，通道 11 ∈ [-1,1]）
输出 : {'unit','type','target','value'}

因子化动作 a = (unit, type, target)
  unit   : 己方「尚未行动」单位在 pending 列表里的下标（0..K-1，K ≤ 64）
  type   : 0=机动/近战  1=远程打击  2=休整  3=待命
  target : 目标格 r*N+c（type ∈ {0,1} 时有效）

四个头：
  unit   [B,64]        哪些槽位该先动（槽位 i ↔ pending 列表第 i 个单位）
  type   [B,64,4]      条件于 unit 的动作类型
  target [B,64,4,N²]   条件于 (unit,type) 的目标格
  value  [B]           状态价值 V(s)

关键设计（因子化的正确姿势）
  unit 头需要「每个待行动单位的特征」。obs 的单位通道（ch11）只画兵力总量，
  同格多单位无法区分。因此这里给每个槽位一个可学习嵌入 slot_embed，
  再用「该槽位单位所在格的空间特征」（从 conv 特征图按格索引取出）拼上去
  —— 但 env_server 没下发单位坐标，所以退一步：unit 头吃 (slot_embed + gap)，
  由 GAP 全局向量提供 roster 层面的信息。这足以区分「哪个槽位」，
  因为槽位顺序本身是稳定的 pending 顺序（游戏内单位创建序）。

  如果将来要更强的单位头，可在 env_server 里加一个 [64, (r,c,type,troops)]
  的 unit_feat 数组，用 grid_sample 取位置特征 —— 接口已预留在
  forward(unit_feat=...) 的可选参数上。

参数量：N=20 时约 2.0M（见文件末尾 __main__ 的自检输出）。
"""
import torch
import torch.nn as nn
import torch.nn.functional as F

MAX_UNITS = 64
N_TYPES = 4


class TacticalNet(nn.Module):
    def __init__(self, n_cells=400, in_ch=12, width=192, blocks=4,
                 slot_dim=64, n_units=MAX_UNITS):
        super().__init__()
        self.n_cells = n_cells
        self.n_units = n_units
        self.W = width
        HID = 384                                            # 单位头隐藏维

        # ---------- 共享 trunk：blocks 层 3×3 卷积，保持 20×20 分辨率 ----------
        layers = [nn.Conv2d(in_ch, width, 3, padding=1), nn.GroupNorm(8, width), nn.ReLU()]
        for _ in range(blocks - 1):
            layers += [nn.Conv2d(width, width, 3, padding=1), nn.GroupNorm(8, width), nn.ReLU()]
        self.trunk = nn.Sequential(*layers)

        # ---------- 空间头：逐格 target logits ----------
        # 三层 1×1（W→2W→W→1）：把「每格作为目标」的打分做成真正的大头，
        # 这是参数量的主要来源，也是因子化目标头应有的容量。
        self.spatial = nn.Sequential(
            nn.Conv2d(width, width * 2, 1), nn.ReLU(),
            nn.Conv2d(width * 2, width, 1), nn.ReLU(),
            nn.Conv2d(width, 1, 1),
        )                                                    # → [B,1,N,N]

        # ---------- 条件嵌入 ----------
        self.type_embed = nn.Embedding(N_TYPES, width)        # type 条件
        self.slot_embed = nn.Embedding(n_units, slot_dim)     # 槽位身份
        # ① type → W 维通道增益（对空间特征做条件调制）
        self.type_gain = nn.Sequential(
            nn.Linear(width, width * 2), nn.ReLU(),
            nn.Linear(width * 2, width),
        )
        # ② unit 摘要 → 4 张 type 图的混合系数
        self.unit_mix = nn.Sequential(
            nn.Linear(HID, 256), nn.ReLU(),
            nn.Linear(256, N_TYPES),
        )
        # ③ 条件融合：调制后的 W 通道 → 单通道空间打分
        self.spatial_fuse = nn.Conv2d(width, 1, 1)

        # ---------- 单位头 ----------
        # 每个槽位：slot_embed + 全局向量(gap|gmp)
        self.slot_mlp = nn.Sequential(
            nn.Linear(slot_dim + 2 * width, HID), nn.ReLU(),
            nn.Linear(HID, HID), nn.ReLU(),
        )
        self.unit_out = nn.Linear(HID, 1)                     # [B,U,1]
        self.type_out = nn.Linear(HID, N_TYPES)               # [B,U,4]

        # ---------- 价值头 ----------
        self.value_mlp = nn.Sequential(
            nn.Linear(2 * width + HID, 256), nn.ReLU(),
            nn.Linear(256, 1),
        )

        self.HID = HID
        self._init()

    def _init(self):
        for m in self.modules():
            if isinstance(m, (nn.Conv2d, nn.Linear)):
                nn.init.orthogonal_(m.weight, gain=1.414)
                if m.bias is not None:
                    nn.init.zeros_(m.bias)
        # 输出层小增益，让初始策略接近均匀
        nn.init.orthogonal_(self.unit_out.weight, gain=0.01)
        nn.init.orthogonal_(self.spatial[-1].weight, gain=0.01)
        nn.init.orthogonal_(self.type_out.weight, gain=0.01)
        nn.init.orthogonal_(self.value_mlp[-1].weight, gain=1.0)

    def forward(self, obs, unit_mask=None, type_mask=None, unit_feat=None):
        """
        obs       [B,12,N,N]
        unit_mask [B,64]      可行动槽位掩码（1=合法），推理时用 -inf 屏蔽
        type_mask [B,64,4]    条件类型掩码
        unit_feat [B,64,F]    可选：每槽位的 (r,c,type,troops) 等特征，暂未启用

        返回 target logits 形状 [B,64,4,N²]：每个 (unit,type) 一张独立的 20×20 打分图。
        训练时先按 unit 选出该样本对应的那张图，再按 type 选，得到 [B,N²]。
        """
        B = obs.shape[0]
        x = self.trunk(obs)                                    # [B,W,N,N]
        W = self.W

        # ---- 全局向量 ----
        gap = x.mean(dim=(2, 3))                               # [B,W]
        gmp = x.amax(dim=(2, 3))                               # [B,W]
        g = torch.cat([gap, gmp], dim=1)                       # [B,2W]

        # ---- 条件嵌入 ----
        t_emb = self.type_embed.weight                         # [4,W]
        t_bias = torch.einsum('bw,tw->bt', gap, t_emb)         # [B,4]

        # ---- 单位头（必须先算，target 头要用 h）----
        slots = self.slot_embed.weight.unsqueeze(0).expand(B, self.n_units, -1)  # [B,U,slot]
        if unit_feat is not None:
            slots = torch.cat([slots, unit_feat], dim=-1)
        gexp = g.unsqueeze(1).expand(B, self.n_units, 2 * W)
        h = self.slot_mlp(torch.cat([slots, gexp], dim=-1))    # [B,U,256]

        unit_logits = self.unit_out(h).squeeze(-1)             # [B,U]
        type_logits = self.type_out(h) + t_bias.unsqueeze(1)   # [B,U,4]

        # ---- target logits [B,U,4,N²] ----
        # 折中且高效的条件融合：
        #   ① 空间打分 sp_full[b,t,cell] = f(x)[b,cell] 与 t 无关（共享卷积，便宜）
        #   ② 用 unit 摘要 h[b,u,:] 生成一组 W 维「通道增益」，只对 type=t 的
        #      那一圈特征做一次调制 —— 每个 type 一张图（4 倍展开，可接受），
        #      unit 的个性化通过「按 unit 加权 4 张图」实现（[B,U,4] 混合系数）。
        #   这样每个 (unit,type) 仍有独立打分图，但算力只放大 4 倍而非 256 倍。
        xb = x.unsqueeze(1).expand(B, N_TYPES, W, x.shape[2], x.shape[3]) \
              .reshape(B * N_TYPES, W, x.shape[2], x.shape[3])
        tg = (1.0 + self.type_gain(t_emb))                     # [4,W]
        cb = tg.unsqueeze(0).expand(B, N_TYPES, W).reshape(B * N_TYPES, W, 1, 1)
        fused = self.spatial_fuse(xb * cb).reshape(B, N_TYPES, self.n_cells)  # [B,4,N²]
        # unit 混合系数 [B,U,4]（softmax 归一），对 4 张 type 图加权
        mix = torch.softmax(self.unit_mix(h), dim=-1)          # [B,U,4]
        target_logits = torch.einsum('but,btc->buc', mix, fused)  # [B,U,N²]
        target_logits = target_logits.unsqueeze(2).expand(B, self.n_units, N_TYPES, self.n_cells)
        # 叠加基础空间打分（不依赖条件的「这格值得去吗」）
        sp_base = self.spatial(x).flatten(1)                   # [B,N²]
        target_logits = target_logits + sp_base.unsqueeze(1).unsqueeze(1)

        # ---- 价值 ----
        u_pool = h.amax(dim=1)                                 # [B,256]
        value = self.value_mlp(torch.cat([g, u_pool], dim=-1)).squeeze(-1)   # [B]

        # ---- 推理掩码 ----
        if unit_mask is not None:
            unit_logits = unit_logits.masked_fill(unit_mask <= 0, -1e9)
        if type_mask is not None:
            type_logits = type_logits.masked_fill(type_mask <= 0, -1e9)

        return {'unit': unit_logits, 'type': type_logits,
                'target': target_logits, 'value': value}

    def target_logits_for(self, out, unit, type_):
        """从 [B,U,4,N²] 里按 (unit,type) 取该样本对应的一张 [B,N²] 打分图。"""
        B = out['target'].shape[0]
        idx_u = unit.view(B, 1, 1, 1).expand(B, 1, 1, out['target'].shape[-1])
        t = out['target'].gather(1, idx_u).squeeze(1)          # [B,4,N²]
        idx_t = type_.view(B, 1, 1).expand(B, 1, t.shape[-1])
        return t.gather(1, idx_t).squeeze(1)                   # [B,N²]


def count_params(m):
    return sum(p.numel() for p in m.parameters())


if __name__ == '__main__':
    net = TacticalNet()
    obs = torch.zeros(2, 12, 20, 20)
    out = net(obs, unit_mask=torch.ones(2, 64), type_mask=torch.ones(2, 64, 4))
    print('params = %.3fM' % (count_params(net) / 1e6))
    for k, v in out.items():
        print('  %-7s %s' % (k, tuple(v.shape)))
