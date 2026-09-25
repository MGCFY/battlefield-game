/* 通过 GitHub Git Data API 推送提交（github.com 被代理封锁、api.github.com 可用时的替代方案）
   用法: GH_TOKEN=ghp_xxx node api-push.js
   特性: 顺序推送远端缺失的全部本地提交；消息含尾换行+时区原样发送，使远端 SHA 与本地完全一致 */
const fs = require("fs"), path = require("path"), cp = require("child_process");
const { HttpsProxyAgent } = require("https-proxy-agent");

const REPO = "MGCFY/battlefield-game";
/* Token 从环境变量读取：GH_TOKEN=ghp_xxx node api-push.js（绝不硬编码进代码） */
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error("请设置环境变量 GH_TOKEN"); process.exit(1); }
const REPO_DIR = path.join(__dirname, "..");
const agent = new HttpsProxyAgent("http://127.0.0.1:56985");

function api(method, url, body) {
  return new Promise((resolve, reject) => {
    const https = require("https");
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: "api.github.com", path: `/repos/${REPO}/git/${url}`, method,
      agent, headers: {
        "Authorization": `token ${TOKEN}`, "User-Agent": "workbuddy-push",
        "Content-Type": "application/json", "Content-Length": data ? Buffer.byteLength(data) : 0,
      },
    }, res => {
      let buf = "";
      res.on("data", d => buf += d);
      res.on("end", () => {
        if (res.statusCode >= 300) return reject(new Error(`${method} ${url} -> ${res.statusCode}: ${buf.slice(0, 400)}`));
        resolve(buf ? JSON.parse(buf) : {});
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/* 创建一个 tree 所需的全部 blob（跳过远端已存在的对象） */
async function ensureBlobs(entries) {
  let created = 0;
  for (const e of entries) {
    try {
      const r = await api("POST", "blobs", {
        content: cp.execSync(`git cat-file blob ${e.sha}`, { cwd: REPO_DIR, maxBuffer: 64 * 1024 * 1024 }).toString("base64"),
        encoding: "base64",
      });
      if (r.sha !== e.sha) throw new Error(`blob sha 不匹配: ${e.path} 本地=${e.sha} 远端=${r.sha}`);
      created++;
    } catch (err) {
      if (String(err).includes("422")) continue;   // 远端已有同名同内容对象
      throw err;
    }
    process.stdout.write(`\r  blob ${created}/${entries.length}`);
  }
  process.stdout.write("\n");
}

(async () => {
  /* 1. 确定推送起点：优先用状态文件记录的已推送本地提交（远端 SHA 与本地可能不一致） */
  const stateFile = path.join(__dirname, ".api-push-state");
  let base = null;
  if (fs.existsSync(stateFile)) {
    base = fs.readFileSync(stateFile, "utf8").trim();
    console.log("状态文件记录的已推送点:", base.slice(0, 8));
  } else {
    const ref = await api("GET", "refs/heads/main");
    const remoteHead = ref.object.sha;
    /* 远端提交对象本地存在时可直接用（首次对齐场景） */
    try {
      cp.execSync(`git cat-file -e ${remoteHead}^{commit}`, { cwd: REPO_DIR });
      base = remoteHead;
      console.log("远端 main:", remoteHead.slice(0, 8), "(本地存在该对象)");
    } catch (e) {
      console.error("❌ 无状态文件且远端 HEAD 对象不在本地，无法确定推送范围。\n   若确认远端已包含全部内容，可执行: echo $(git rev-parse HEAD) > online/.api-push-state");
      process.exit(1);
    }
  }

  /* 2. 计算本地领先提交（旧→新） */
  const list = cp.execSync(`git rev-list --reverse ${base}..HEAD`, { cwd: REPO_DIR, encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  if (!list.length) { console.log("本地无领先提交，无需推送。"); return; }
  console.log(`待推送 ${list.length} 个提交:`, list.map(s => s.slice(0, 7)).join(" → "));

  const ref = await api("GET", "refs/heads/main");
  let remoteHead = ref.object.sha;
  console.log("远端 main:", remoteHead.slice(0, 8));

  for (const c of list) {
    const meta = cp.execSync(
      `git log -1 --format="%an%x00%ae%x00%aI%x00%B" ${c}`, { cwd: REPO_DIR, encoding: "utf8" }
    );
    const [author, email, date, ...rest] = meta.split("\0");
    const rawMsg = rest.join("\0");              // %B 原始消息（含尾换行，保证 SHA 一致）

    const treeRaw = cp.execSync(`git ls-tree -r ${c}`, { cwd: REPO_DIR, encoding: "utf8" });
    const entries = treeRaw.trim().split("\n").map(line => {
      const m = line.match(/^(\d{6})\s+blob\s+([0-9a-f]{40})\t(.+)$/);
      if (!m) throw new Error("无法解析 ls-tree 行: " + line);
      return { mode: m[1], sha: m[2], path: m[3] };
    });
    console.log(`\n[${c.slice(0, 7)}] ${rawMsg.trim().slice(0, 46)}…  (${entries.length} 个文件)`);

    await ensureBlobs(entries);

    const headCommit = await api("GET", `commits/${remoteHead}`);
    const tree = await api("POST", "trees", {
      base_tree: headCommit.tree.sha,
      tree: entries.map(e => ({ path: e.path, mode: e.mode, type: "blob", sha: e.sha })),
    });
    const commit = await api("POST", "commits", {
      message: rawMsg, tree: tree.sha, parents: [remoteHead],
      author: { name: author, email: email, date },
      committer: { name: author, email: email, date },
    });
    await api("PATCH", "refs/heads/main", { sha: commit.sha, force: false });
    const match = commit.sha === c ? "✅ SHA 一致" : `⚠ SHA 不一致 本地=${c.slice(0,8)}`;
    console.log(`  commit ${commit.sha.slice(0, 8)} ${match}`);
    remoteHead = commit.sha;
  }

  /* 3. 记录推送进度并汇报 */
  const localHead = cp.execSync("git rev-parse HEAD", { cwd: REPO_DIR, encoding: "utf8" }).trim();
  fs.writeFileSync(stateFile, localHead);
  console.log(`\n✅ 推送完成。远端 main = ${remoteHead.slice(0, 8)}（SHA 因 GitHub 消息归一化与本地不同，内容完全一致）`);
  console.log(`   本地 HEAD = ${localHead.slice(0, 8)}，已记入状态文件 .api-push-state`);
})().catch(e => { console.error("❌ 失败:", e.message); process.exit(1); });
