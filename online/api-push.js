/* 通过 GitHub Git Data API 推送提交（github.com 被代理封锁、api.github.com 可用时的替代方案） */
const fs = require("fs"), path = require("path"), cp = require("child_process");
const { HttpsProxyAgent } = require("https-proxy-agent");

const REPO = "MGCFY/battlefield-game";
/* Token 从环境变量读取：GH_TOKEN=ghp_xxx node api-push.js（绝不硬编码进代码） */
const TOKEN = process.env.GH_TOKEN;
const REPO_DIR = path.join(__dirname, "..");
const COMMIT = "HEAD";   // 要推送的本地提交，默认当前 HEAD
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

(async () => {
  /* 1. 远端 main 当前指向 */
  const ref = await api("GET", "refs/heads/main");
  const baseSha = ref.object.sha;
  console.log("远端 main:", baseSha.slice(0, 8));

  /* 2. 本地提交元数据 */
  const meta = cp.execSync(
    `git log -1 --format="%an%n%ae%n%aI%n%s" ${COMMIT}`, { cwd: REPO_DIR, encoding: "utf8" }
  ).trim().split("\n");
  const [author, email, date, msg] = meta;

  /* 3. 文件清单 */
  const treeRaw = cp.execSync(`git ls-tree -r ${COMMIT}`, { cwd: REPO_DIR, encoding: "utf8" });
  const entries = treeRaw.trim().split("\n").map(line => {
    const m = line.match(/^(\d{6})\s+blob\s+([0-9a-f]{40})\t(.+)$/);
    if (!m) throw new Error("无法解析 ls-tree 行: " + line);
    return { mode: m[1], sha: m[2], path: m[3] };
  });
  console.log(`待上传 ${entries.length} 个文件`);

  /* 4. 逐个创建 blob（跳过远端已存在的对象） */
  let created = 0;
  for (const e of entries) {
    const local = cp.execSync(`git rev-parse ${e.sha}`, { cwd: REPO_DIR, encoding: "utf8" }).trim();
    try {
      const r = await api("POST", "blobs", {
        content: cp.execSync(`git cat-file blob ${e.sha}`, { cwd: REPO_DIR, maxBuffer: 64 * 1024 * 1024 }).toString("base64"),
        encoding: "base64",
      });
      if (r.sha !== e.sha) throw new Error(`blob sha 不匹配: ${e.path} 本地=${e.sha} 远端=${r.sha}`);
      created++;
    } catch (err) {
      if (String(err).includes("422")) { console.log(`  跳过(已存在): ${e.path}`); continue; }
      throw err;
    }
    process.stdout.write(`\r  blob ${created}/${entries.length}`);
  }
  console.log(`\n  blob 创建完成`);

  /* 5. 创建 tree（基于远端当前 tree，覆盖全部文件） */
  const baseCommit = await api("GET", `commits/${baseSha}`);
  const tree = await api("POST", "trees", {
    base_tree: baseCommit.tree.sha,
    tree: entries.map(e => ({ path: e.path, mode: e.mode === "100755" ? "100755" : "100644", type: "blob", sha: e.sha })),
  });
  console.log("tree:", tree.sha.slice(0, 8));

  /* 6. 创建 commit */
  const commit = await api("POST", "commits", {
    message: msg, tree: tree.sha, parents: [baseSha],
    author: { name: author, email: email, date },
    committer: { name: author, email: email, date },
  });
  console.log("commit:", commit.sha.slice(0, 8), "-", msg.slice(0, 40));

  /* 7. 更新 main */
  await api("PATCH", "refs/heads/main", { sha: commit.sha, force: false });
  console.log("✅ main 已更新，推送完成");
  console.log(`仓库地址: https://github.com/${REPO}/commit/${commit.sha.slice(0, 8)}`);
})().catch(e => { console.error("❌ 失败:", e.message); process.exit(1); });
