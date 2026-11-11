// Minimal to-do server: serves index.html and a JSON API backed by a file.
// Run with: node webapp/server.js   (PORT defaults to 3000, HOST to 0.0.0.0)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "tasks.json");
const PAGE = path.join(__dirname, "index.html");
const MAX_BODY = 16 * 1024;

function loadTasks() {
  try {
    const tasks = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(tasks) ? tasks : [];
  } catch (e) {
    return [];
  }
}

function saveTasks(tasks) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function findIndex(tasks, id) {
  return tasks.findIndex((t) => t.id === id);
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "tasks", id?]
  if (parts[1] !== "tasks") return send(res, 404, { error: "Not found" });

  let tasks = loadTasks();

  if (parts.length === 2 && req.method === "GET") {
    return send(res, 200, tasks);
  }

  if (parts.length === 2 && req.method === "POST") {
    const body = await readJson(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return send(res, 400, { error: "Task text is required" });
    if (text.length > 200) return send(res, 400, { error: "Task text must be 200 characters or fewer" });
    const task = { id: crypto.randomUUID(), text, done: false, createdAt: new Date().toISOString() };
    tasks.push(task);
    saveTasks(tasks);
    return send(res, 201, task);
  }

  if (parts.length === 3 && parts[2] === "completed" && req.method === "DELETE") {
    tasks = tasks.filter((t) => !t.done);
    saveTasks(tasks);
    return send(res, 204, "", "text/plain");
  }

  if (parts.length === 3) {
    const id = parts[2];
    const i = findIndex(tasks, id);
    if (i === -1) return send(res, 404, { error: "Task not found" });

    if (req.method === "PATCH") {
      const body = await readJson(req);
      if (typeof body.done === "boolean") tasks[i].done = body.done;
      if (typeof body.text === "string") {
        const text = body.text.trim();
        if (!text || text.length > 200) return send(res, 400, { error: "Task text must be 1 to 200 characters" });
        tasks[i].text = text;
      }
      saveTasks(tasks);
      return send(res, 200, tasks[i]);
    }

    if (req.method === "DELETE") {
      tasks.splice(i, 1);
      saveTasks(tasks);
      return send(res, 204, "", "text/plain");
    }
  }

  return send(res, 405, { error: "Method not allowed" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(res, 200, fs.readFileSync(PAGE, "utf8"), "text/html; charset=utf-8");
    }

    return send(res, 404, "Not found", "text/plain; charset=utf-8");
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    return send(res, status, { error: status === 500 ? "Server error" : err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`To-do server listening on http://${HOST}:${PORT}`);
});
