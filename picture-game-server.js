const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3001);
const DATA_FILE = path.join(__dirname, "picture-game-state.json");
const IMAGES_DIR = path.join(__dirname, "picture-game-images");
const PUBLIC_DIR = path.join(__dirname, "public");

// Ensure images directory exists
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ── State ────────────────────────────────────────────────────────────────
let state = loadState();
const sseClients = new Set();

function defaultState() {
  return {
    images: [],    // [{ id: number, name: string, ext: string }]
    nextImageId: 1,
    students: [],  // [{ name: string, imageId: number | null, pickedAt: string | null }]
    updatedAt: new Date().toISOString()
  };
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!raw.students || !Array.isArray(raw.students)) throw new Error("invalid");
    return raw;
  } catch {
    return defaultState();
  }
}

function saveState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf8");
}

function broadcast() {
  const msg = `data: ${JSON.stringify(buildPublicState())}\n\n`;
  for (const c of sseClients) c.write(msg);
}

// Public state includes image metadata but not data URLs
function buildPublicState() {
  return {
    images: state.images,
    students: state.students,
    updatedAt: state.updatedAt
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) req.destroy(); // 50MB limit for image uploads
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch (e) { reject(e); }
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
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg"
    };
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

// ── Assign image to student ──────────────────────────────────────────────
function assignImage(studentName) {
  const student = state.students.find(s => s.name === studentName);
  if (!student) return null;

  if (student.imageId !== null) {
    const img = state.images.find(i => i.id === student.imageId);
    return { image: img, student };
  }

  if (state.images.length === 0) return { error: "图片库为空，请等待老师上传PDF。" };

  // Pick images not yet assigned to anyone (or least-used)
  const usedIds = new Set(state.students.filter(s => s.imageId !== null).map(s => s.imageId));
  const available = state.images.filter(i => !usedIds.has(i.id));
  const pool = available.length > 0 ? available : state.images;
  const picked = pool[Math.floor(Math.random() * pool.length)];

  student.imageId = picked.id;
  student.pickedAt = new Date().toISOString();
  state.updatedAt = new Date().toISOString();
  saveState();
  broadcast();

  return { image: picked, student };
}

// ── Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── Pages ──────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/picture-game") {
    return serveFile(res, path.join(PUBLIC_DIR, "picture-game-student.html"));
  }

  if (req.method === "GET" && url.pathname === "/picture-game/teacher") {
    return serveFile(res, path.join(PUBLIC_DIR, "picture-game-teacher.html"));
  }

  // ── API: get public state ──────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/picture-game/state") {
    return sendJson(res, buildPublicState());
  }

  // ── API: SSE stream ────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/picture-game/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write(`data: ${JSON.stringify(buildPublicState())}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // ── API: upload PDF pages (as base64 images from client) ───────────
  if (req.method === "POST" && url.pathname === "/api/picture-game/upload-pdf") {
    try {
      const body = await readJson(req);
      const pages = body.pages;
      if (!pages || !Array.isArray(pages) || pages.length === 0) {
        return sendJson(res, { error: "未收到有效的图片数据。" }, 400);
      }

      // Clear old images
      for (const oldImg of state.images) {
        const oldPath = path.join(IMAGES_DIR, `${oldImg.id}.${oldImg.ext}`);
        try { fs.unlinkSync(oldPath); } catch {}
      }
      state.images = [];
      state.nextImageId = 1;

      // Save new images
      for (let i = 0; i < pages.length; i++) {
        const dataUrl = pages[i];
        const match = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
        if (!match) continue;

        const ext = match[1] === "png" ? "png" : "jpg";
        const buffer = Buffer.from(match[2], "base64");
        const id = state.nextImageId++;
        const filename = `${id}.${ext}`;
        fs.writeFileSync(path.join(IMAGES_DIR, filename), buffer);

        state.images.push({ id, name: `第 ${i + 1} 页`, ext });
      }

      // Reset all student assignments (images changed)
      for (const s of state.students) {
        s.imageId = null;
        s.pickedAt = null;
      }

      state.updatedAt = new Date().toISOString();
      saveState();
      broadcast();
      return sendJson(res, { ok: true, count: state.images.length });
    } catch (e) {
      return sendJson(res, { error: "上传失败。" }, 500);
    }
  }

  // ── API: serve image file ──────────────────────────────────────────
  if (req.method === "GET" && url.pathname.startsWith("/api/picture-game/image/")) {
    const idStr = url.pathname.split("/").pop();
    const id = Number.parseInt(idStr, 10);
    const img = state.images.find(i => i.id === id);
    if (!img) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Image not found");
      return;
    }
    return serveFile(res, path.join(IMAGES_DIR, `${img.id}.${img.ext}`));
  }

  // ── API: import student names ──────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/picture-game/import") {
    try {
      const body = await readJson(req);
      const names = (body.names || [])
        .map(n => String(n).trim())
        .filter(n => n.length > 0);

      if (names.length === 0) {
        return sendJson(res, { error: "请至少输入一个学生姓名。" }, 400);
      }

      const existingNames = new Set(state.students.map(s => s.name));
      const newStudents = names
        .filter(n => !existingNames.has(n))
        .map(name => ({ name, imageId: null, pickedAt: null }));

      state.students = [...state.students, ...newStudents];
      state.updatedAt = new Date().toISOString();
      saveState();
      broadcast();
      return sendJson(res, { ok: true, added: newStudents.length, total: state.students.length });
    } catch {
      return sendJson(res, { error: "导入失败。" }, 500);
    }
  }

  // ── API: student picks name → assign random image ──────────────────
  if (req.method === "POST" && url.pathname === "/api/picture-game/pick") {
    try {
      const body = await readJson(req);
      const name = String(body.name || "").trim();
      if (!name) return sendJson(res, { error: "请提供学生姓名。" }, 400);

      const result = assignImage(name);
      if (!result) return sendJson(res, { error: "未找到该学生姓名。" }, 404);
      if (result.error) return sendJson(res, { error: result.error }, 400);

      return sendJson(res, { ok: true, image: result.image, student: result.student });
    } catch {
      return sendJson(res, { error: "操作失败。" }, 500);
    }
  }

  // ── API: reset all assignments ─────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/picture-game/reset") {
    for (const s of state.students) {
      s.imageId = null;
      s.pickedAt = null;
    }
    state.updatedAt = new Date().toISOString();
    saveState();
    broadcast();
    return sendJson(res, { ok: true });
  }

  // ── API: clear everything ──────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/picture-game/clear") {
    // Delete image files
    for (const img of state.images) {
      try { fs.unlinkSync(path.join(IMAGES_DIR, `${img.id}.${img.ext}`)); } catch {}
    }
    state = defaultState();
    saveState();
    broadcast();
    return sendJson(res, { ok: true });
  }

  // ── Static files fallback ──────────────────────────────────────────
  if (req.method === "GET") {
    const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(PUBLIC_DIR, safePath);
    if (filePath.startsWith(PUBLIC_DIR)) return serveFile(res, filePath);
  }

  sendJson(res, { error: "Not found" }, 404);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`图片游戏服务已启动：http://localhost:${PORT}`);
  console.log(`学生端：http://localhost:${PORT}/picture-game`);
  console.log(`教师端：http://localhost:${PORT}/picture-game/teacher`);
});
