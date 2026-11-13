const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");

const MAX_OUTPUT = 64 * 1024 * 1024;

// One long-lived sqlite3 CLI process per database. Requests are serialized over stdin and delimited by a sentinel line.
// Any failing statement makes `-bail` exit the process, which rejects the request; the next request starts a fresh one.
class SQLiteServer {
  constructor({ cli, extension, databasePath }) {
    this.cli = cli;
    this.extension = extension;
    this.databasePath = databasePath;
    this.sentinel = `__LLMS_DONE_${randomBytes(12).toString("hex")}__`;
    this.child = null;
    this.startedAt = 0;
    this.requests = 0;
    this.queue = Promise.resolve();
    this.current = null;
    this.stderr = "";
  }
  get running() { return !!this.child; }
  info() {
    return { databasePath: this.databasePath, pid: this.child ? this.child.pid : null, running: this.running, startedAt: this.startedAt, requests: this.requests };
  }
  start() {
    if (this.child) return;
    const quoted = this.extension.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const child = spawn(this.cli, ["-batch", "-bail", "-json", "-cmd", ".timeout 5000", "-cmd", `.load "${quoted}"`, this.databasePath], { windowsHide: true });
    this.child = child;
    this.startedAt = Date.now();
    this.stderr = "";
    this.output = "";
    this.setRef(false);
    child.on("error", error => this.onExit(child, new Error(`Unable to start SQLite CLI: ${error.message}. See setup instructions.`)));
    child.stdin.on("error", () => { /* surfaced through the exit handler */ });
    child.stdout.on("data", data => this.onData(child, data));
    child.stderr.on("data", data => { if (this.stderr.length < 8192) this.stderr += data.toString().slice(0, 8192 - this.stderr.length); });
    child.on("close", code => this.onExit(child, null, code));
  }
  setRef(active) {
    const child = this.child;
    if (!child) return;
    const method = active ? "ref" : "unref";
    for (const handle of [child, child.stdin, child.stdout, child.stderr]) if (handle && typeof handle[method] === "function") handle[method]();
  }
  onData(child, data) {
    if (child !== this.child) return;
    this.output += data;
    if (this.output.length > MAX_OUTPUT) {
      this.settle(new Error("SQLite output exceeds 64 MiB."));
      this.stop();
      return;
    }
    const marker = `${this.sentinel}\n`;
    const end = this.output.indexOf(marker);
    if (end === -1) return;
    const result = this.output.slice(0, end);
    this.output = this.output.slice(end + marker.length);
    this.settle(null, result);
  }
  onExit(child, error, code) {
    if (child !== this.child) return;
    this.child = null;
    const message = this.stderr.trim();
    this.settle(error || new Error(message || `SQLite process exited with code ${code}`), null, message);
  }
  settle(error, result, stderr) {
    const pending = this.current;
    if (!pending) return;
    this.current = null;
    if (error) pending.reject(Object.assign(error, { stderr: stderr || this.stderr.trim() }));
    else pending.resolve(result);
  }
  run(sql) {
    const task = this.queue.then(() => new Promise((resolve, reject) => {
      this.start();
      this.requests++;
      this.current = { resolve, reject };
      this.setRef(true);
      this.child.stdin.write(`${sql}\n.print ${this.sentinel}\n`);
    }).finally(() => this.setRef(false)));
    this.queue = task.catch(() => {});
    return task;
  }
  stop() {
    const child = this.child;
    if (!child) return false;
    this.child = null;
    this.settle(new Error("SQLite server was stopped."));
    try { child.stdin.end(); } catch (_) { /* already closed */ }
    child.kill();
    return true;
  }
}

// Tracks every database server started by the plugin so they can be inspected and killed independently of any store.
class SQLiteManager {
  constructor() { this.servers = new Map(); }
  acquire(options) {
    let server = this.servers.get(options.databasePath);
    if (!server || server.cli !== options.cli || server.extension !== options.extension) {
      if (server) server.stop();
      server = new SQLiteServer(options);
      this.servers.set(options.databasePath, server);
    }
    return server;
  }
  list() {
    return [...this.servers.values()].map(server => server.info()).filter(info => info.running);
  }
  stopAll() {
    let stopped = 0;
    for (const server of this.servers.values()) if (server.stop()) stopped++;
    this.servers.clear();
    return stopped;
  }
}

const manager = new SQLiteManager();

module.exports = { SQLiteServer, SQLiteManager, sqliteManager: manager };
