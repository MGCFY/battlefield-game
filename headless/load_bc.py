#!/usr/bin/env python3
"""
load_bc.py —— 读取 headless/collect.js 产出的行为克隆数据集
---------------------------------------------------------------------------
训练侧零解析：所有张量都是标准 .npy，np.load 直接可用。

用法
    from load_bc import load_bc, dense_masks
    ds = load_bc('data/bc_hard')
    ds.obs            # uint8  [D, 12, 20, 20]（若采集时 --obs none 则为 None）
    ds.unit, ds.type, ds.target, ds.valid   # [D] 动作三元组与合法标记
    ds.legal_types    # uint8  [D, 4]
    ds.legal_ptr      # int32  [D+1]  CSR 行指针
    ds.legal_items    # int32  [K, 2] (type, target)

    # 需要稠密掩码时（例如喂给因子化动作头）：
    um, tm, cm = dense_masks(ds, n_units=64)   # unit [D,64] / type [D,64,4] / target [D,4,N*N]
"""
import json
import os
import numpy as np

META_COLS = ['game', 'round', 'turn', 'side', 'unitIdx', 'unitType', 'type', 'target', 'valid']


class BCDataset:
    def __init__(self, path):
        self.path = path
        with open(os.path.join(path, 'meta.json'), encoding='utf-8') as f:
            self.spec = json.load(f)
        self.N = self.spec['board']['N']
        self.C = self.spec['board']['channels']

        def rd(name, required=True):
            p = os.path.join(path, name)
            if not os.path.exists(p):
                if required:
                    raise FileNotFoundError(p)
                return None
            return np.load(p)

        self.obs = rd('obs.npy', required=False)
        meta = rd('meta.npy')
        for i, col in enumerate(META_COLS):
            setattr(self, col, meta[:, i])
        self.meta = meta
        self.legal_types = rd('legal_types.npy')
        self.legal_count = rd('legal_count.npy')
        self.legal_items = rd('legal_items.npy')
        self.legal_ptr = rd('legal_ptr.npy')
        # 单位类型名（与 meta 的 unitType 列对应，便于按兵种做掩码/统计）
        self.unit_types = self.spec.get('unitTypes') or None

    @property
    def unit_type_names(self):
        """把 unitType 列还原成兵种名数组（未采集到映射时返回 None）"""
        if not self.unit_types:
            return None
        lut = np.array(self.unit_types)
        idx = self.unitType.astype(np.int64)
        out = np.full(idx.shape, '', dtype=object)
        ok = (idx >= 0) & (idx < len(lut))
        out[ok] = lut[idx[ok]]
        return out

    def __len__(self):
        return int(self.meta.shape[0])

    def obs_float(self):
        """把量化观测还原成 float32 [D, C, N, N]（通道 0-10 → 0/1，通道 11 → [-1,1]，0 精确还原）"""
        if self.obs is None:
            return None
        if self.obs.dtype == np.uint8:
            a = self.obs.astype(np.float32) / 255.0
            a[:, 11] = self.obs[:, 11].astype(np.float32) / 127.0 - 1.0
            return a
        return self.obs.astype(np.float32)

    def summary(self):
        d = len(self)
        return {
            '样本': d,
            '对局': int(self.spec['stats']['games']),
            '合法率': f"{(self.valid.mean() * 100):.2f}%",
            '动作分布': {k: int(v) for k, v in zip(['机动', '远程', '休整', '待命'],
                                                  np.bincount(self.type, minlength=4)[:4].tolist())},
            '棋盘': f"{self.N}x{self.N}",
            '通道': self.C,
            '有效样本(valid=1)': int(self.valid.sum()),
        }


def load_bc(path):
    return BCDataset(path)


def dense_masks(ds, n_units=64, only_valid=True):
    """
    生成稠密掩码张量。建议只在过滤 off valid 样本或分 batch 时使用（体积较大）。
    返回 (unit_mask [D,n_units] uint8, type_mask [D,n_units,4] uint8, target_mask [D,4,N*N] uint8)
    """
    D = len(ds)
    N2 = ds.N * ds.N
    if only_valid:
        sel = np.nonzero(ds.valid > 0)[0]
    else:
        sel = np.arange(D)
    um = np.zeros((len(sel), n_units), dtype=np.uint8)
    tm = np.zeros((len(sel), n_units, 4), dtype=np.uint8)
    cm = np.zeros((len(sel), 4, N2), dtype=np.uint8)
    real = np.zeros((len(sel), 4), dtype=np.uint8)
    for row, i in enumerate(sel):
        u = int(ds.unitIdx[i])
        if u < n_units:
            um[row, u] = 1
            tm[row, u, :] = ds.legal_types[i, :].astype(np.uint8)
        a, b = ds.legal_ptr[i], ds.legal_ptr[i + 1]
        items = ds.legal_items[a:b]
        for t in range(4):
            real[row, t] = ds.legal_types[i, t]
        for t, cell in items:
            if 0 <= t < 4 and 0 <= cell < N2:
                cm[row, t, cell] = 1
    return um, tm, cm, real, sel


if __name__ == '__main__':
    import sys
    p = sys.argv[1] if len(sys.argv) > 1 else 'data/bc_hard'
    ds = load_bc(p)
    print(json.dumps(ds.summary(), ensure_ascii=False, indent=2))
