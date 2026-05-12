const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const TEACHER_PIN = process.env.TEACHER_PIN || "";
const DATA_FILE = path.join(__dirname, "scores.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const GROUPS = Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 小组`);
const clients = new Set();

let votes = loadVotes();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    return serveFile(res, path.join(PUBLIC_DIR, "student.html"));
  }

  if (req.method === "GET" && url.pathname === "/teacher") {
    return serveFile(res, path.join(PUBLIC_DIR, "teacher.html"));
  }

  if (req.method === "GET" && url.pathname === "/api/stats") {
    return sendJson(res, buildStats());
  }

  if (req.method === "GET" && url.pathname === "/events") {
    return openEventStream(req, res);
  }

  if (req.method === "POST" && url.pathname === "/api/votes") {
    try {
      const body = await readJson(req);
      const group = String(body.group || "");
      const score = Number.parseInt(body.score, 10);
      const voterId = String(body.voterId || "");

      if (!GROUPS.includes(group)) {
        return sendJson(res, { error: "请选择 1-8 小组。" }, 400);
      }

      if (!Number.isInteger(score) || score < 0 || score > 10) {
        return sendJson(res, { error: "评分必须是 0-10 的整数。" }, 400);
      }

      if (voterId.length < 12) {
        return sendJson(res, { error: "匿名投票标识无效，请刷新页面后重试。" }, 400);
      }

      const voterHash = hashVoter(voterId);
      const existing = votes.find((vote) => vote.group === group && vote.voterHash === voterHash);
      const nextVote = {
        group,
        score,
        voterHash,
        time: new Date().toISOString()
      };

      if (existing) {
        Object.assign(existing, nextVote);
      } else {
        votes.push(nextVote);
      }

      saveVotes();
      broadcast();
      return sendJson(res, { ok: true, updated: Boolean(existing), stats: buildStats() });
    } catch {
      return sendJson(res, { error: "提交失败，请稍后重试。" }, 500);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    if (TEACHER_PIN) {
      const body = await readJson(req);
      if (String(body.pin || "") !== TEACHER_PIN) {
        return sendJson(res, { error: "教师 PIN 不正确。" }, 403);
      }
    }

    votes = [];
    saveVotes();
    broadcast();
    return sendJson(res, { ok: true });
  }

  if (req.method === "GET") {
    const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(PUBLIC_DIR, safePath);
    if (filePath.startsWith(PUBLIC_DIR)) {
      return serveFile(res, filePath);
    }
  }

  sendJson(res, { error: "Not found" }, 404);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`课堂评分服务已启动：http://localhost:${PORT}`);
  console.log(`学生评分页：http://localhost:${PORT}/`);
  console.log(`教师看板页：http://localhost:${PORT}/teacher`);
});

function loadVotes() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveVotes() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(votes, null, 2), "utf8");
}

function buildStats() {
  const groups = GROUPS.map((name) => {
    const groupVotes = votes.filter((vote) => vote.group === name);
    const scores = groupVotes.map((vote) => vote.score);
    const count = scores.length;
    const total = scores.reduce((sum, score) => sum + score, 0);
    const distribution = Array.from({ length: 11 }, (_, score) => ({
      score,
      count: scores.filter((item) => item === score).length
    }));

    return {
      name,
      count,
      average: count ? Number((total / count).toFixed(2)) : 0,
      high: count ? Math.max(...scores) : 0,
      low: count ? Math.min(...scores) : 0,
      distribution,
      latest: groupVotes
        .slice()
        .sort((a, b) => new Date(b.time) - new Date(a.time))
        .slice(0, 8)
        .map((vote, index) => ({
          label: `匿名 ${groupVotes.length - index}`,
          score: vote.score,
          time: new Date(vote.time).toLocaleString("zh-CN", { hour12: false })
        }))
    };
  });

  return {
    groups,
    totalVotes: votes.length,
    updatedAt: new Date().toLocaleString("zh-CN", { hour12: false })
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  }[ext] || "application/octet-stream";
}

function openEventStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.write(`data: ${JSON.stringify(buildStats())}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

function broadcast() {
  const message = `data: ${JSON.stringify(buildStats())}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

function hashVoter(voterId) {
  return crypto.createHash("sha256").update(voterId).digest("hex");
}
