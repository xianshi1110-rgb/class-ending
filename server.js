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

const CHARADES_V2_STATE_FILE = path.join(__dirname, "charades-v2-state.json");
const CHARADES_V2_DEFAULT_WORDS = [
  { name: "第一组", words: ["老师", "举手", "提问", "PPT", "鼓励", "螺钿", "书法", "刺绣", "粤曲", "香囊", "拖堂", "因材施教", "课堂互动", "点石成金"] },
  { name: "第二组", words: ["学生", "黑板", "板书", "倾听", "讨论", "拓印", "扎染", "串珠", "拼豆", "篆刻", "忘词", "教学设计", "合作学习", "余音绕梁"] },
  { name: "第三组", words: ["考试", "点名", "点赞", "示范", "总结", "陶艺", "中国结", "掐丝珐琅", "点茶", "合香", "冷场", "课堂管理", "反馈", "循循善诱"] },
  { name: "第四组", words: ["回答", "作业", "批评", "爱心", "听不懂", "剪纸", "油画", "健身", "粘土", "金箔画", "熬夜", "AI教学", "教师成长", "不离不弃"] }
];
const charadesV2Clients = new Set();
let charadesV2TimerId = null;

const PEER_EVAL_FILE = path.join(__dirname, "peer-eval-results.json");
const PEER_ROSTER = [
  { group: 1, members: ["黄雯琪", "黄悦菡", "陈浩铭", "吴小悦", "梁紫斐"] },
  { group: 2, members: ["肖清蕾", "王漫玉", "张颖珍", "周天然", "梁嘉怡"] },
  { group: 3, members: ["董博原", "苏智锐", "覃浩哲", "杨少杰", "徐国梁"] },
  { group: 4, members: ["钟幸霖", "方美苏", "李佳兴"] },
  { group: 5, members: ["海尔文森", "黄子杰", "劳敬翔", "谭志选", "李逸然", "黎浩源"] },
  { group: 6, members: ["白艺馨", "娜迪热·热合曼江", "麦迪乃木·吾布力卡斯木", "李姗珊", "卓绮君"] },
  { group: 7, members: ["陈梓生", "张智森", "林奕鑫", "提列克·达木江"] },
  { group: 8, members: ["周健斌", "邝展豪", "黃宇軒", "唐棹晞", "帕科扎提·甫尔卡提"] },
  { group: 9, members: ["张超越"] }
];

let votes = loadVotes();
let charadesV2State = loadCharadesV2State();
let peerEvalSubmissions = loadPeerEvalSubmissions();

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

  // --- charades v2 game routes ---

  if (req.method === "GET" && url.pathname === "/charades-v2") {
    return serveFile(res, path.join(PUBLIC_DIR, "charades-game-v2.html"));
  }

  if (req.method === "GET" && url.pathname === "/api/charades-v2/state") {
    return sendJson(res, charadesV2State);
  }

  if (req.method === "GET" && url.pathname === "/api/charades-v2/events") {
    return openCharadesV2EventStream(req, res);
  }

  if (req.method === "POST" && url.pathname === "/api/charades-v2/select-group") {
    const body = await readJson(req);
    const index = Number(body.groupIndex);
    if (!Number.isInteger(index) || index < 0 || index >= charadesV2State.groups.length) {
      return sendJson(res, { error: "无效的小组索引。" }, 400);
    }
    charadesV2State.selectedIndex = index;
    charadesV2State.currentIndex = 0;
    charadesV2State.timeLeft = 60;
    charadesV2State.gameState = charadesV2State.results[index].completed ? "finished" : "idle";
    charadesV2State.updatedAt = new Date().toISOString();
    saveCharadesV2State();
    broadcastCharadesV2();
    return sendJson(res, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/charades-v2/start") {
    const group = charadesV2State.groups[charadesV2State.selectedIndex];
    if (!group || !group.words.length) {
      return sendJson(res, { error: "当前小组没有词语。" }, 400);
    }
    charadesV2State.currentIndex = 0;
    charadesV2State.timeLeft = 60;
    charadesV2State.results[charadesV2State.selectedIndex] = { score: 0, passes: 0, completed: false, duration: null };
    charadesV2State.gameState = "running";
    charadesV2State.updatedAt = new Date().toISOString();
    saveCharadesV2State();
    broadcastCharadesV2();
    startCharadesV2Timer();
    return sendJson(res, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/charades-v2/answer") {
    if (charadesV2State.gameState !== "running") {
      return sendJson(res, { error: "游戏未在进行中。" }, 400);
    }
    const body = await readJson(req);
    const correct = Boolean(body.correct);
    const result = charadesV2State.results[charadesV2State.selectedIndex];
    if (correct) {
      result.score += 1;
    } else {
      result.passes += 1;
    }
    charadesV2State.currentIndex += 1;
    if (charadesV2State.currentIndex >= charadesV2State.groups[charadesV2State.selectedIndex].words.length) {
      charadesV2State.gameState = "finished";
      result.completed = true;
      result.duration = 60 - charadesV2State.timeLeft;
    }
    charadesV2State.updatedAt = new Date().toISOString();
    saveCharadesV2State();
    broadcastCharadesV2();
    return sendJson(res, { ok: true, finished: charadesV2State.gameState === "finished", result });
  }

  if (req.method === "POST" && url.pathname === "/api/charades-v2/pause") {
    if (charadesV2State.gameState !== "running") {
      return sendJson(res, { error: "游戏未在进行中。" }, 400);
    }
    charadesV2State.gameState = "paused";
    charadesV2State.updatedAt = new Date().toISOString();
    stopCharadesV2Timer();
    saveCharadesV2State();
    broadcastCharadesV2();
    return sendJson(res, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/charades-v2/resume") {
    if (charadesV2State.gameState !== "paused") {
      return sendJson(res, { error: "游戏未在暂停中。" }, 400);
    }
    charadesV2State.gameState = "running";
    charadesV2State.updatedAt = new Date().toISOString();
    saveCharadesV2State();
    broadcastCharadesV2();
    startCharadesV2Timer();
    return sendJson(res, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/charades-v2/finish") {
    if (charadesV2State.gameState !== "running" && charadesV2State.gameState !== "paused") {
      return sendJson(res, { error: "游戏未在进行中。" }, 400);
    }
    const result = charadesV2State.results[charadesV2State.selectedIndex];
    charadesV2State.gameState = "finished";
    result.completed = true;
    result.duration = 60 - charadesV2State.timeLeft;
    stopCharadesV2Timer();
    charadesV2State.updatedAt = new Date().toISOString();
    saveCharadesV2State();
    broadcastCharadesV2();
    return sendJson(res, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/charades-v2/reset") {
    stopCharadesV2Timer();
    charadesV2State = createCharadesV2State();
    saveCharadesV2State();
    broadcastCharadesV2();
    return sendJson(res, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/charades-v2/import") {
    const body = await readJson(req);
    if (!body.groups || !Array.isArray(body.groups) || body.groups.length === 0) {
      return sendJson(res, { error: "词库数据无效。" }, 400);
    }
    charadesV2State.groups = body.groups;
    charadesV2State.selectedIndex = 0;
    charadesV2State.currentIndex = 0;
    charadesV2State.timeLeft = 60;
    charadesV2State.gameState = "idle";
    charadesV2State.results = body.groups.map(() => ({ score: 0, passes: 0, completed: false, duration: null }));
    charadesV2State.updatedAt = new Date().toISOString();
    saveCharadesV2State();
    broadcastCharadesV2();
    return sendJson(res, { ok: true });
  }

  // --- peer evaluation routes ---

  if (req.method === "GET" && url.pathname === "/peer-eval") {
    return serveFile(res, path.join(PUBLIC_DIR, "peer-eval.html"));
  }

  if (req.method === "GET" && url.pathname === "/peer-eval-teacher") {
    return serveFile(res, path.join(PUBLIC_DIR, "peer-eval-teacher.html"));
  }

  if (req.method === "GET" && url.pathname === "/api/peer-eval/roster") {
    return sendJson(res, { roster: PEER_ROSTER });
  }

  if (req.method === "POST" && url.pathname === "/api/peer-eval/submit") {
    try {
      const body = await readJson(req);
      const group = Number(body.group);
      const groupInfo = PEER_ROSTER.find((item) => item.group === group);
      const isLeader = Boolean(body.isLeader);
      const voterId = String(body.voterId || "");
      const ratings = Array.isArray(body.ratings) ? body.ratings : [];

      if (!groupInfo) {
        return sendJson(res, { error: "请选择有效组号。" }, 400);
      }
      if (voterId.length < 12) {
        return sendJson(res, { error: "匿名评分标识无效，请刷新页面后重试。" }, 400);
      }
      if (ratings.length !== groupInfo.members.length) {
        return sendJson(res, { error: "请为本组所有成员评分。" }, 400);
      }

      const normalizedRatings = groupInfo.members.map((name) => {
        const rating = ratings.find((item) => item.name === name);
        const score = Number.parseInt(rating && rating.score, 10);
        if (!Number.isInteger(score) || score < 0 || score > 10) {
          throw new Error("invalid score");
        }
        return { name, score };
      });

      const voterHash = hashVoter(voterId).slice(0, 16);
      const existing = peerEvalSubmissions.find((item) => item.group === group && item.voterHash === voterHash);
      const nextSubmission = {
        id: existing ? existing.id : crypto.randomUUID(),
        group,
        isLeader,
        voterHash,
        ratings: normalizedRatings,
        submittedAt: new Date().toISOString()
      };

      if (existing) {
        Object.assign(existing, nextSubmission);
      } else {
        peerEvalSubmissions.push(nextSubmission);
      }

      savePeerEvalSubmissions();
      return sendJson(res, { ok: true, updated: Boolean(existing) });
    } catch {
      return sendJson(res, { error: "提交失败，请检查分数是否为 0-10 的整数。" }, 400);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/peer-eval/stats") {
    return sendJson(res, buildPeerEvalStats());
  }

  if (req.method === "GET" && url.pathname === "/api/peer-eval/csv") {
    return sendCsv(res, buildPeerEvalCsv(), "peer-eval-details.csv");
  }

  if (req.method === "POST" && url.pathname === "/api/peer-eval/reset") {
    if (TEACHER_PIN) {
      const body = await readJson(req);
      if (String(body.pin || "") !== TEACHER_PIN) {
        return sendJson(res, { error: "教师 PIN 不正确。" }, 403);
      }
    }
    peerEvalSubmissions = [];
    savePeerEvalSubmissions();
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

function createCharadesV2State() {
  return {
    groups: structuredClone(CHARADES_V2_DEFAULT_WORDS),
    selectedIndex: 0,
    currentIndex: 0,
    timeLeft: 60,
    gameState: "idle",
    results: CHARADES_V2_DEFAULT_WORDS.map(() => ({ score: 0, passes: 0, completed: false, duration: null })),
    updatedAt: new Date().toISOString()
  };
}

function loadCharadesV2State() {
  try {
    const raw = JSON.parse(fs.readFileSync(CHARADES_V2_STATE_FILE, "utf8"));
    if (!raw.groups || !Array.isArray(raw.groups)) throw new Error("invalid");
    return raw;
  } catch {
    return createCharadesV2State();
  }
}

function saveCharadesV2State() {
  fs.writeFileSync(CHARADES_V2_STATE_FILE, JSON.stringify(charadesV2State, null, 2), "utf8");
}

function openCharadesV2EventStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.write(`data: ${JSON.stringify(charadesV2State)}\n\n`);
  charadesV2Clients.add(res);
  req.on("close", () => charadesV2Clients.delete(res));
}

function broadcastCharadesV2() {
  const message = `data: ${JSON.stringify(charadesV2State)}\n\n`;
  for (const client of charadesV2Clients) {
    client.write(message);
  }
}

function startCharadesV2Timer() {
  stopCharadesV2Timer();
  charadesV2TimerId = setInterval(() => {
    if (charadesV2State.gameState !== "running") {
      stopCharadesV2Timer();
      return;
    }
    charadesV2State.timeLeft -= 1;
    if (charadesV2State.timeLeft <= 0) {
      charadesV2State.timeLeft = 0;
      const result = charadesV2State.results[charadesV2State.selectedIndex];
      charadesV2State.gameState = "finished";
      result.completed = true;
      result.duration = 60;
      stopCharadesV2Timer();
    }
    charadesV2State.updatedAt = new Date().toISOString();
    saveCharadesV2State();
    broadcastCharadesV2();
  }, 1000);
}

function stopCharadesV2Timer() {
  if (charadesV2TimerId) {
    clearInterval(charadesV2TimerId);
    charadesV2TimerId = null;
  }
}

function loadPeerEvalSubmissions() {
  try {
    const raw = JSON.parse(fs.readFileSync(PEER_EVAL_FILE, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function savePeerEvalSubmissions() {
  fs.writeFileSync(PEER_EVAL_FILE, JSON.stringify(peerEvalSubmissions, null, 2), "utf8");
}

function buildPeerEvalStats() {
  const groups = PEER_ROSTER.map((groupInfo) => {
    const submissions = peerEvalSubmissions.filter((item) => item.group === groupInfo.group);
    const memberStats = groupInfo.members.map((name) => {
      const scores = submissions
        .map((submission) => submission.ratings.find((rating) => rating.name === name))
        .filter(Boolean)
        .map((rating) => rating.score);
      const total = scores.reduce((sum, score) => sum + score, 0);
      return {
        name,
        count: scores.length,
        average: scores.length ? Number((total / scores.length).toFixed(2)) : 0,
        scores
      };
    });

    return {
      group: groupInfo.group,
      members: groupInfo.members,
      submissionCount: submissions.length,
      leaderCount: submissions.filter((item) => item.isLeader).length,
      memberStats
    };
  });

  return {
    roster: PEER_ROSTER,
    groups,
    submissions: peerEvalSubmissions.map((submission) => ({
      id: submission.id,
      group: submission.group,
      isLeader: submission.isLeader,
      voterHash: submission.voterHash,
      submittedAt: submission.submittedAt,
      ratings: submission.ratings
    })),
    totalSubmissions: peerEvalSubmissions.length,
    updatedAt: new Date().toLocaleString("zh-CN", { hour12: false })
  };
}

function buildPeerEvalCsv() {
  const rows = [[
    "提交ID",
    "匿名评分ID",
    "评分者组号",
    "是否组长",
    "被评分同学",
    "分数",
    "提交时间"
  ]];

  for (const submission of peerEvalSubmissions) {
    for (const rating of submission.ratings) {
      rows.push([
        submission.id,
        submission.voterHash,
        `第${submission.group}组`,
        submission.isLeader ? "是" : "否",
        rating.name,
        String(rating.score),
        new Date(submission.submittedAt).toLocaleString("zh-CN", { hour12: false })
      ]);
    }
  }

  return "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function sendCsv(res, content, filename) {
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store"
  });
  res.end(content);
}
