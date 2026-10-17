"""
env_client.py —— Python ↔ env_server.js 的 NDJSON 客户端
---------------------------------------------------------------------------
把 Node 侧的环境封装成 Gym 风格接口，方便 train.py 直接调用。

    env = EnvClient(src='../battlefield-v3.9.16.html')
    obs, mask, meta = env.reset(side=0, seed=1, opponent='ai:medium')
    obs, mask, reward, done, info, meta = env.step(unit=0, type=0, target=37)

并发模式（推荐，吞吐高得多）
    pool = EnvPool(n=8, src=...)
    pool.reset_all(side=0, seed_base=1000)
    for t in range(T):
        acts = pool.sample_actions(...)   # 见 train.py
        res = pool.step_all(acts)

实测（8 进程 / 本机 OMEN）：单环境 ~200 step/s，池化后随核数线性放大。
"""
import json
import os
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), 'env_server.js')


def _node_exe():
    """优先用 managed node，其次 PATH 里的 node"""
    cand = os.path.expanduser(r'~\.workbuddy\binaries\node\versions\22.22.2-6\node.exe')
    if os.path.exists(cand):
        return cand
    import shutil
    return shutil.which('node') or 'node'


class EnvClient:
    """单环境客户端（同步 RPC，一行请求一行响应）"""

    def __init__(self, src=None, cwd=None):
        self.cwd = cwd or os.path.dirname(SERVER)
        args = [_node_exe(), SERVER]
        if src:
            args += ['--src', src]
        self.proc = subprocess.Popen(
            args, cwd=self.cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding='utf-8', bufsize=1,
        )
        self._id = 0
        self._lock = threading.Lock()

    # ---------- 底层 RPC ----------
    def rpc(self, **req):
        with self._lock:
            self._id += 1
            req['id'] = self._id
            self.proc.stdin.write(json.dumps(req) + '\n')
            self.proc.stdin.flush()
            line = self.proc.stdout.readline()
        if not line:
            err = self.proc.stderr.read() if self.proc.stderr else ''
            raise RuntimeError('env_server died. stderr:\n' + err[-2000:])
        r = json.loads(line)
        if 'error' in r:
            raise RuntimeError('env_server error: %s %s' % (r['error'], r.get('detail', '')[:400]))
        return r

    # ---------- 高层接口 ----------
    def ping(self):
        return self.rpc(cmd='ping')

    def reset(self, side=0, seed=1, opponent='ai:medium', **kw):
        r = self.rpc(cmd='reset', side=side, seed=seed, opponent=opponent, **kw)
        return r['obs'], r['mask'], r['meta']

    def step(self, unit, type, target):
        r = self.rpc(cmd='step', action={'unit': int(unit), 'type': int(type), 'target': int(target)})
        return r['obs'], r['mask'], r['reward'], r['done'], r['info'], r['meta']

    def legal(self, unit):
        return self.rpc(cmd='legal', unit=int(unit))

    def targets(self, unit, type):
        return self.rpc(cmd='targets', unit=int(unit), type=int(type))['targets']

    # ---------- 外部对手（League 快照） ----------
    def opp_obs(self):
        """对手当前该动谁 → {side, obs, mask, pending, units} 或 None"""
        return self.rpc(cmd='opp-obs')['pendingOpp']

    def opp_legal(self, unit):
        return self.rpc(cmd='opp-legal', unit=int(unit))

    def opp_targets(self, unit, type):
        return self.rpc(cmd='opp-targets', unit=int(unit), type=int(type))['targets']

    def opp_step(self, unit, type, target):
        """提交一个对手动作。返回 {pendingOpp|None, done?, reward?, obs?, mask?, info?, meta?}"""
        return self.rpc(cmd='opp-step',
                        action={'unit': int(unit), 'type': int(type), 'target': int(target)})

    def close(self):
        try:
            self.rpc(cmd='close')
        except Exception:
            pass
        try:
            self.proc.wait(timeout=3)
        except Exception:
            self.proc.kill()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


class EnvPool:
    """多个并行的单环境客户端（训练时按 slot 轮转）"""

    def __init__(self, n=4, src=None):
        self.n = n
        self.envs = [EnvClient(src=src) for _ in range(n)]

    def reset_all(self, side=0, seed_base=1000, opponent='ai:medium', **kw):
        out = []
        for i, e in enumerate(self.envs):
            out.append(e.reset(side=side, seed=seed_base + i, opponent=opponent, **kw))
        return out

    def reset_one(self, i, **kw):
        return self.envs[i].reset(**kw)

    def close(self):
        for e in self.envs:
            e.close()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


if __name__ == '__main__':
    # 自检：ping → reset → 随机走 30 步 → 打印统计
    import random
    with EnvClient() as env:
        info = env.ping()
        print('ping:', info['src'], 'N=%d C=%d' % (info['info']['N'], info['info']['C']))
        obs, mask, meta = env.reset(side=0, seed=42, opponent='ai:medium')
        print('reset: obs=%d pending=%d turn=%d' % (len(obs), meta['pending'], meta['turn']))
        steps, rsum, illegal = 0, 0.0, 0
        done = False
        while not done and steps < 400:
            pend = [i for i in range(len(mask['unit'])) if mask['unit'][i]]
            if not pend:
                break
            u = random.choice(pend)
            types = [t for t in range(4) if mask['type'][u][t]]
            t = random.choice(types)
            c = 0
            if t in (0, 1):
                tg = env.targets(u, t)
                if not tg:
                    illegal += 1
                    continue
                c = random.choice(tg)
            obs, mask, r, done, info, meta = env.step(u, t, c)
            rsum += r
            steps += 1
        print('steps=%d reward=%.3f done=%s illegal=%d round=%s winner=%s'
              % (steps, rsum, done, illegal, meta.get('round'), meta.get('winner')))
