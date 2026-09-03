/**
 * pi-scheduler — 用 systemd user timer 给 pi 定时任务。
 *
 * 设计：
 *  - 数据（jobs/*.md + state/）只在 ~/.pi/scheduler/，units 是 sync 的生成产物。
 *  - 每 job 一个 <name>.md：YAML frontmatter（schedule/cwd/model/timeoutSec/enabled）+ prompt 正文。
 *  - cron 触发实际执行的是 bin/run-job <name>（本目录内，就地执行）。
 *  - factory 只注册命令，不做任何文件/进程/定时器工作（遵循扩展生命周期约束）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_JOB = path.join(EXT_DIR, "bin", "run-job");

const DATA_DIR = process.env.PI_SCHEDULER_DIR ?? path.join(homedir(), ".pi", "scheduler");
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const STATE_DIR = path.join(DATA_DIR, "state");
const HOOKS_DIR = path.join(DATA_DIR, "hooks");
const RUNS_LOG = path.join(STATE_DIR, "runs.jsonl");
const ENV_FILE = path.join(DATA_DIR, "env");
const UNITS_DIR = path.join(homedir(), ".config", "systemd", "user");
const UNIT_PREFIX = "pi-scheduler-";

const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

const WIDGET = "pi-scheduler";

const SCHEDULE_HELP = [
  "触发时间用 systemd OnCalendar 语法，按你的本地时区填，可留空 = daily",
  "  快捷名:   daily / hourly / weekly / monthly",
  "  每天 3:10       *-*-* 03:10:00",
  "  每周日 9:30     Sun *-*-* 09:30:00",
  "  工作日 9:00     Mon..Fri *-*-* 09:00:00",
  "  每 15 分钟      *:00/15",
  "  每小时          *-*-* *:00:00",
  "  每月 1 号 2:00  *-*-01 02:00:00",
  "",
  "其余字段都可留空：",
  "  cwd 默认 $HOME（job 内可再用绝对路径 cd 到别的仓库）",
  "  model 默认 = 你现在用的模型；省钱可填便宜档",
  "  timeoutSec 默认 0 = 不限时（建议长任务给个上限防挂死）",
  "",
  "下一步每一步都有默认值，直接回车即可。",
];

// ---------------------------------------------------------------- utils

function sh(cmd: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000 });
  return { code: r.status ?? (r.error ? 1 : 0), out: (r.stdout ?? "").toString(), err: (r.stderr ?? "").toString() };
}
function systemctl(args: string[]): { code: number; err: string } {
  const r = sh("systemctl", ["--user", ...args]);
  return { code: r.code, err: (r.err + r.out).trim() };
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function listJobs(): string[] {
  if (!fs.existsSync(JOBS_DIR)) return [];
  return fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
}

/** 解析 <name>.md：frontmatter（扁平 key: value，值允许双引号）+ 正文。 */
function parseJobFile(content: string): { meta: Record<string, string>; body: string } {
  const lines = content.split("\n");
  const meta: Record<string, string> = {};
  if (lines[0]?.trim() === "---") {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") { end = i; break; }
    }
    if (end > 0) {
      for (let i = 1; i < end; i++) {
        const m = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(lines[i]);
        if (m) meta[m[1]] = m[2].replace(/^"|"$/g, "");
      }
      return { meta, body: lines.slice(end + 1).join("\n") };
    }
  }
  return { meta, body: content };
}

function serializeJobFile(meta: Record<string, string>, body: string): string {
  const keys = ["schedule", "cwd", "model", "timeoutSec", "enabled"];
  const fm = keys.filter((k) => meta[k] !== undefined && meta[k] !== "")
    .map((k) => {
      const v = String(meta[k]);
      return /[#:"]/.test(v) ? `${k}: "${v.replace(/"/g, '\\"')}"` : `${k}: ${v}`;
    }).join("\n");
  return `---\n${fm}\n---\n${body}`;
}

function readJob(name: string): { meta: Record<string, string>; body: string } {
  return parseJobFile(fs.readFileSync(path.join(JOBS_DIR, `${name}.md`), "utf8"));
}
function writeJob(name: string, meta: Record<string, string>, body: string): void {
  ensureDir(JOBS_DIR);
  fs.writeFileSync(path.join(JOBS_DIR, `${name}.md`), serializeJobFile(meta, body), "utf8");
}

/** 用 systemd-analyze 校验 OnCalendar 表达式，返回规范化形式与下次触发时间。 */
function validateSchedule(expr: string): { ok: boolean; normalized?: string; next?: string; reason?: string } {
  const r = sh("systemd-analyze", ["calendar", expr]);
  if (r.code !== 0) return { ok: false, reason: r.err.trim() || r.out.trim() || "invalid schedule" };
  const norm = /Normalized form:\s*(.*)/.exec(r.out)?.[1]?.trim();
  const next = /Next elapse:\s*(.*)/.exec(r.out)?.[1]?.trim();
  return { ok: true, normalized: norm, next };
}

function lastRunRecord(name: string): string | null {
  if (!fs.existsSync(RUNS_LOG)) return null;
  const lines = fs.readFileSync(RUNS_LOG, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.includes(`"name":"${name}"`) && (l.includes('"evt":"end"') || l.includes('"evt":"skip"'))) return l;
  }
  return null;
}

function formatLastRun(record: string | null): string {
  if (!record) return "  last: (never run)";
  try {
    const o = JSON.parse(record);
    if (o.evt === "skip") return `  last: skipped (${o.reason ?? "?"})`;
    const when = o.ts ? new Date(o.ts * 1000).toISOString().replace("T", " ").slice(0, 16) : "?";
    return `  last: ${o.status ?? "?"} exit=${o.exit} dur=${o.dur}s @${when} session=${o.session ?? "-"}`;
  } catch {
    return "  last: (parse error)";
  }
}

// ---------------------------------------------------------------- units 生成 / sync

function serviceUnit(name: string): string {
  return [
    "[Unit]",
    `Description=pi-scheduler job: ${name}`,
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${RUN_JOB} ${name}`,
    `Environment=PI_SCHEDULER_DIR=${DATA_DIR}`,
    "",
  ].join("\n");
}

function timerUnit(name: string, schedule: string): string {
  return [
    "[Unit]",
    `Description=pi-scheduler timer: ${name} (${schedule})`,
    "",
    "[Timer]",
    `OnCalendar=${schedule}`,
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

const NOTIFY_TEMPLATE = `#!/usr/bin/env bash
# pi-scheduler notify hook — 由扩展在首次 sync 时安装，之后永不覆盖。
# 用法: notify <start|ok|fail|timeout|skip> <job-name> <run-id>
# 默认 no-op。要接 webhook / notify-send / 邮件，把逻辑写在这里。
# 结构化记录在 ~/.pi/scheduler/state/runs.jsonl（tail 一行即本次事件）。
exit 0
`;

/** 当前 systemd manager（/etc/localtime，无 TZ env）的时区上下文。 */
function tzContext(): { deltaMin: number; userZone: string; mgrZone: string } {
  const parseOffset = (r: { code: number; out: string }) => {
    const m = /([+-])(\d{2})(\d{2})/.exec(r.out.trim());
    if (!m) return 0;
    const min = (+m[2]) * 60 + (+m[3]);
    return m[1] === "-" ? -min : min;
  };
  const user = sh("date", ["+%z"]);
  const mgr = sh("env", ["-u", "TZ", "date", "+%z"]);
  const userMin = parseOffset(user);
  const mgrMin = parseOffset(mgr);
  return {
    deltaMin: userMin - mgrMin, // user 比 manager 快多少分钟；user→manager 时间 = user - delta
    userZone: user.out.trim() || "?",
    mgrZone: mgr.out.trim() || "?",
  };
}

/**
 * 把用户在本地时区输入的 schedule 换算成 manager 时区（写入 unit 的表达式）。
 * 返回 stored（unit 用）与说明。只处理带具体时间的普通写法；
 * 会跨日/跨星期/含 ~ 的日期形式无法安全换算时给 warn 并原样返回。
 */
function computeStoredSchedule(
  userExpr: string,
  tz: ReturnType<typeof tzContext>,
): { stored: string; note?: string; warn?: string } {
  const v = validateSchedule(userExpr);
  if (!v.ok) return { stored: userExpr, warn: v.reason ?? "invalid schedule" };
  const norm = v.normalized ?? userExpr;
  if (tz.deltaMin === 0) return { stored: norm };

  const sp = norm.lastIndexOf(" ");
  const dateP = sp > 0 ? norm.slice(0, sp) : "";
  const timeP = sp > 0 ? norm.slice(sp + 1) : norm;
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timeP);
  if (!tm) {
    return { stored: norm, warn: `no concrete time in "${norm}" — cannot convert to systemd timezone (${tz.mgrZone})` };
  }
  const total = +tm[1] * 60 + +tm[2] - tz.deltaMin;
  const roll = Math.floor(total / 1440);
  const t = ((total % 1440) + 1440) % 1440;
  // 只有“任意一天”（*-*-* 或带年份的 *-* / 具体月-*）跨日才安全；带星期名 / 固定日 / ~ 不行
  const dayTok = /^[^-]+-[^-]+-([^-]+)$/.exec(dateP);
  const hasWeekday = /^[A-Za-z]/.test(dateP);
  const dayIsWild = dayTok?.[1] === "*" ?? false;
  const safe = !hasWeekday && (dayIsWild || dateP.includes("-")) && !dateP.includes("~");
  if (roll !== 0 && !safe) {
    return {
      stored: norm,
      warn: `"${userExpr}" crosses a day boundary when converting to systemd timezone (${tz.mgrZone}) — left unconverted; it will fire in ${tz.mgrZone} wall time`,
    };
  }
  const hh = String(Math.floor(t / 60)).padStart(2, "0");
  const mm = String(t % 60).padStart(2, "0");
  const sec = tm[3] ? `:${tm[3]}` : "";
  return {
    stored: dateP ? `${dateP} ${hh}:${mm}${sec}` : `${hh}:${mm}${sec}`,
    note: `(${userExpr} in ${tz.userZone} → ${hh}:${mm} in ${tz.mgrZone})`,
  };
}

/** 给定写入 unit 的 stored 表达式，返回“下次触发（你的本地时间）”的可读串。 */
function nextFireLocal(storedExpr: string): string {
  const r = sh("env", ["-u", "TZ", "systemd-analyze", "calendar", storedExpr]);
  if (r.code !== 0) return "?";
  const m = /Next elapse:\s*(.*)/.exec(r.out);
  if (!m) return "?";
  const conv = sh("date", ["-d", m[1].trim()]);
  return conv.code === 0 ? conv.out.trim() : m[1].trim();
}

/** 从某个真实文件路径向上找到 node_modules/.bin。 */
function npmBinOf(file: string): string {
  let dir = path.dirname(file);
  for (let i = 0; i < 6; i++) {
    if (path.basename(dir) === "node_modules") return path.join(dir, ".bin");
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

/** 解析 pi：优先扫当前 PATH（交互式 shim，realpath 后通常是 cli.js）；再试 bash -lc。 */
function resolvePi(): { cli?: string; npmBin?: string } {
  const dirs = (process.env.PATH ?? "").split(":");
  for (const d of dirs) {
    if (!d) continue;
    try {
      const cand = path.join(d, "pi");
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        const real = fs.realpathSync(cand);
        return { cli: real.endsWith(".js") ? real : undefined, npmBin: npmBinOf(real) };
      }
    } catch { /* try next */ }
  }
  const r = sh("bash", ["-lc", "command -v pi"]);
  if (r.code === 0 && r.out.trim()) {
    try {
      const real = fs.realpathSync(r.out.trim());
      return { cli: real.endsWith(".js") ? real : undefined, npmBin: npmBinOf(real) };
    } catch { /* fallthrough */ }
  }
  return {};
}

/** 生成 env：真实 node/pi 路径。node 或 pi 升级后重跑 :sync 即可刷新。 */
function writeEnv(): { ok: boolean; note?: string } {
  const nodeBin = path.dirname(process.execPath);
  const { cli, npmBin } = resolvePi();
  const content = [
    `export PI_NODE="${nodeBin}/node"`,
    cli ? `export PI_CLI="${cli}"` : "# PI_CLI unresolved; run-job falls back to `pi` on PATH",
    `export PI_SCHEDULER_PATH="${[nodeBin, npmBin, "/usr/bin", "/bin"].filter(Boolean).join(":")}"`,
    "",
  ].join("\n");
  ensureDir(DATA_DIR);
  fs.writeFileSync(ENV_FILE, content, "utf8");
  return { ok: Boolean(cli), note: cli ? undefined : "could not resolve pi binary; will rely on pi being on PATH" };
}

function installNotifyHook(): void {
  const p = path.join(HOOKS_DIR, "notify");
  ensureDir(HOOKS_DIR);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, NOTIFY_TEMPLATE, "utf8");
    fs.chmodSync(p, 0o755);
  }
}

/** 同步：读 jobs → 生成 units → 清理失效 → reload → enable。返回人类可读摘要行。 */
function syncNow(): { ok: boolean; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  ensureDir(STATE_DIR);
  const envNote = writeEnv();
  if (envNote.note) lines.push(envNote.note);
  installNotifyHook();
  const tz = tzContext();
  if (tz.deltaMin !== 0) {
    lines.push(`systemd timer tz = ${tz.mgrZone}, your tz = ${tz.userZone}; schedules auto-converted`);
  }

  const jobs = listJobs();
  const desired = new Set<string>();
  for (const name of jobs) {
    const { meta } = readJob(name);
    if (meta.enabled === "false") {
      lines.push(`job ${name}: disabled, skipping unit generation`);
      continue;
    }
    const schedule = meta.schedule?.trim();
    if (!schedule) {
      errors.push(`job ${name}: missing schedule in frontmatter (skipped)`);
      continue;
    }
    const c = computeStoredSchedule(schedule, tz);
    if (c.warn) {
      errors.push(`job ${name}: ${c.warn}`);
      continue;
    }
    desired.add(name);
    fs.writeFileSync(path.join(UNITS_DIR, `${UNIT_PREFIX}${name}.service`), serviceUnit(name), "utf8");
    fs.writeFileSync(path.join(UNITS_DIR, `${UNIT_PREFIX}${name}.timer`), timerUnit(name, c.stored), "utf8");
    const note = c.note ? ` ${c.note}` : "";
    lines.push(`job ${name}: ${c.stored}${note} — next ${nextFireLocal(c.stored)}`);
  }

  // 清理：不再存在 / 被禁用的 job 的 unit 文件
  ensureDir(UNITS_DIR);
  const stale: string[] = [];
  for (const f of fs.readdirSync(UNITS_DIR)) {
    const m = new RegExp(`^${UNIT_PREFIX}(.+)\\.(timer|service)$`).exec(f);
    if (m && !desired.has(m[1])) stale.push(f);
  }
  for (const f of stale) {
    systemctl(["disable", "--now", f]); // 文件可能不在已加载状态，忽略错误
    fs.rmSync(path.join(UNITS_DIR, f), { force: true });
  }
  if (stale.length) lines.push(`removed stale units: ${stale.join(", ")}`);

  const rl = systemctl(["daemon-reload"]);
  if (rl.code !== 0) errors.push(`daemon-reload failed: ${rl.err}`);
  for (const name of desired) {
    const en = systemctl(["enable", "--now", `${UNIT_PREFIX}${name}.timer`]);
    if (en.code !== 0) errors.push(`enable ${name} failed: ${en.err}`);
  }
  lines.push(`enabled ${desired.size} timer(s)`);
  return { ok: errors.length === 0, lines, errors };
}

// ---------------------------------------------------------------- ui helpers

type Ctx = {
  signal?: AbortSignal;
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    confirm(title: string, body: string, opts?: unknown): Promise<boolean>;
    select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
    input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>;
    editor(title: string, prefilled?: string, opts?: unknown): Promise<string | undefined>;
    setWidget(key: string, lines: string[]): void;
    setStatus(key: string, text: string): void;
  };
};

async function pickJob(ui: Ctx["ui"], what: string): Promise<string | undefined> {
  const names = listJobs();
  if (names.length === 0) {
    ui.notify("pi-scheduler: no jobs yet — use /pi-scheduler:create <name>", "info");
    return undefined;
  }
  if (names.length === 1) return names[0];
  const pick = await ui.select(`pi-scheduler: ${what} which job?`, names);
  return pick ?? undefined;
}

function showWidget(ui: Ctx["ui"], title: string, content: string[]): void {
  const max = 60;
  const lines = [`─ ${title} ─`, ...content].slice(-max);
  ui.setWidget(WIDGET, lines);
}

// ---------------------------------------------------------------- commands

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("pi-scheduler:create", {
    description: "Create a scheduled pi job (systemd user timer)",
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const name = args.trim().split(/\s+/)[0] ?? "";
      if (!NAME_RE.test(name)) {
        ui.notify("usage: /pi-scheduler:create <name>  (name: letters/digits/_/-)", "error");
        return;
      }
      if (fs.existsSync(path.join(JOBS_DIR, `${name}.md`))) {
        ui.notify(`job "${name}" already exists — use :update`, "error");
        return;
      }
      const clearHelp = () => ui.setWidget(WIDGET, []);
      showWidget(ui, `pi-scheduler:create ${name} — 填法速查`, SCHEDULE_HELP);

      const scheduleRaw = await ui.input(
        "触发时间 OnCalendar（本地时区；留空=daily，例: *-*-* 03:10:00 或 Sun *-*-* 09:30:00）:",
        "daily",
      );
      if (scheduleRaw === undefined) { clearHelp(); ui.notify("cancelled", "info"); return; }
      const schedule = scheduleRaw.trim() || "daily";
      const c = computeStoredSchedule(schedule, tzContext());
      if (c.warn) {
        clearHelp();
        ui.notify(`schedule 不可用: ${c.warn}（试试上方示例里的写法）`, "error");
        return;
      }
      ui.notify(`✓ schedule ok — 下次触发: ${nextFireLocal(c.stored)}${c.note ? ` （${c.note}）` : ""}`, "info");

      const cwdRaw = await ui.input("工作目录 cwd（留空=$HOME；例: /home/you/src/repo）:", homedir());
      if (cwdRaw === undefined) { clearHelp(); ui.notify("cancelled", "info"); return; }
      const modelRaw = await ui.input("模型 model（留空=当前默认；省钱例: claude-haiku-4-5）:", "");
      if (modelRaw === undefined) { clearHelp(); ui.notify("cancelled", "info"); return; }
      const timeoutRaw = await ui.input("超时秒数 timeoutSec（0=不限；防挂死例: 1800）:", "0");
      if (timeoutRaw === undefined) { clearHelp(); ui.notify("cancelled", "info"); return; }

      const cwd = cwdRaw.trim() || homedir();
      const model = modelRaw.trim();
      const timeoutSec = timeoutRaw.trim() || "0";
      showWidget(ui, `pi-scheduler:create ${name} — 已填信息`, [
        `  名称:      ${name}`,
        `  触发:      ${schedule}${c.note ? `  ${c.note}` : ""}`,
        `  下次触发:  ${nextFireLocal(c.stored)}`,
        `  工作目录:  ${cwd}`,
        `  模型:      ${model || "(默认)"}`,
        `  超时:      ${timeoutSec === "0" ? "不限" : timeoutSec + "s"}`,
        "",
        "下一步打开编辑器写 prompt（任务指令）。内容会原样作为 prompt 交给 `pi -p`。",
      ]);

      const body = await ui.editor(
        `pi-scheduler: 写 "${name}" 的 prompt（frontmatter 在上面速查里改也可以，直接存）`,
        `# 任务目标

在这个文件里写 agent 要干的事。内容会原样作为 prompt 交给 \`pi -p\`。
写清楚：干什么、在哪个目录/仓库、完成标准、失败时怎么办。`,
      );
      if (!body?.trim()) { clearHelp(); ui.notify("empty prompt, cancelled", "info"); return; }

      writeJob(name, {
        schedule,
        cwd,
        model,
        timeoutSec,
        enabled: "true",
      }, body);

      const s = syncNow();
      clearHelp();
      ui.notify(`job "${name}" created. ${s.ok ? "timers synced" : "sync had errors"}`, s.ok ? "info" : "warning");
      if (s.errors.length) ui.notify(s.errors.join("; "), "error");
      showWidget(ui, `pi-scheduler: ${name}`, s.lines);
    },
  });

  pi.registerCommand("pi-scheduler:list", {
    description: "List scheduled pi jobs and last run status",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const names = listJobs();
      if (names.length === 0) {
        ui.notify("no jobs yet — use /pi-scheduler:create <name>", "info");
        return;
      }
      const out: string[] = [];
      for (const name of names) {
        const { meta } = readJob(name);
        const enabled = meta.enabled !== "false";
        const schedule = meta.schedule?.trim() || "daily";
        out.push(`• ${name}  ${enabled ? "" : "(disabled) "}${schedule}`);
        out.push(`  cwd: ${meta.cwd || homedir()}  model: ${meta.model || "default"}  timeout: ${meta.timeoutSec || 0}s`);
        out.push(formatLastRun(lastRunRecord(name)));
      }
      showWidget(ui, `pi-scheduler jobs (${names.length})`, out);
      ui.notify(`${names.length} job(s)`, "info");
    },
  });

  pi.registerCommand("pi-scheduler:update", {
    description: "Edit a job's metadata + prompt (opens editor with the whole job file)",
    getArgumentCompletions: (prefix) => {
      const f = listJobs().filter((n) => n.startsWith(prefix));
      return f.length ? f.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const name = args.trim() || (await pickJob(ui, "update"));
      if (!name || !NAME_RE.test(name) || !fs.existsSync(path.join(JOBS_DIR, `${name}.md`))) {
        ui.notify("job not found", "error");
        return;
      }
      const before = fs.readFileSync(path.join(JOBS_DIR, `${name}.md`), "utf8");
      const edited = await ui.editor(`pi-scheduler: edit job "${name}" (frontmatter + prompt)`, before);
      if (edited === undefined) { ui.notify("cancelled", "info"); return; }
      const { meta, body } = parseJobFile(edited);
      if (!body?.trim()) { ui.notify("empty prompt not allowed — job unchanged", "error"); return; }
      const schedule = (meta.schedule ?? "").trim() || "daily";
      const c = computeStoredSchedule(schedule, tzContext());
      if (c.warn) {
        ui.notify(`invalid/unsupported schedule "${schedule}" — job unchanged (${c.warn})`, "error");
        return;
      }
      meta.schedule = schedule; // job.md 保留用户本地时间的原表达式，unit 由 sync 换算生成
      writeJob(name, meta, body);
      const s = syncNow();
      ui.notify(`job "${name}" updated — next fire: ${nextFireLocal(c.stored)}`, s.ok ? "info" : "warning");
      if (s.errors.length) ui.notify(s.errors.join("; "), "error");
    },
  });

  pi.registerCommand("pi-scheduler:delete", {
    description: "Delete a job (job file + units + sessions)",
    getArgumentCompletions: (prefix) => {
      const f = listJobs().filter((n) => n.startsWith(prefix));
      return f.length ? f.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const name = args.trim() || (await pickJob(ui, "delete"));
      if (!name || !NAME_RE.test(name) || !fs.existsSync(path.join(JOBS_DIR, `${name}.md`))) {
        ui.notify("job not found", "error");
        return;
      }
      if (!(await ui.confirm("Delete job?", `Delete "${name}"? Its timer, sessions and logs will be removed.`))) {
        ui.notify("cancelled", "info");
        return;
      }
      fs.rmSync(path.join(JOBS_DIR, `${name}.md`), { force: true });
      systemctl(["disable", "--now", `${UNIT_PREFIX}${name}.timer`]);
      systemctl(["stop", `${UNIT_PREFIX}${name}.service`]);
      fs.rmSync(path.join(UNITS_DIR, `${UNIT_PREFIX}${name}.timer`), { force: true });
      fs.rmSync(path.join(UNITS_DIR, `${UNIT_PREFIX}${name}.service`), { force: true });
      fs.rmSync(path.join(STATE_DIR, `last-${name}.out`), { force: true });
      fs.rmSync(path.join(DATA_DIR, "sessions", name), { recursive: true, force: true });
      systemctl(["daemon-reload"]);
      ui.notify(`job "${name}" deleted`, "info");
    },
  });

  pi.registerCommand("pi-scheduler:toggle", {
    description: "Enable/disable a job (keeps job file, removes timer)",
    getArgumentCompletions: (prefix) => {
      const f = listJobs().filter((n) => n.startsWith(prefix));
      return f.length ? f.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const name = args.trim() || (await pickJob(ui, "toggle"));
      if (!name || !NAME_RE.test(name) || !fs.existsSync(path.join(JOBS_DIR, `${name}.md`))) {
        ui.notify("job not found", "error");
        return;
      }
      const { meta, body } = readJob(name);
      meta.enabled = meta.enabled === "false" ? "true" : "false";
      writeJob(name, meta, body);
      const s = syncNow();
      ui.notify(`job "${name}" ${meta.enabled === "true" ? "enabled" : "disabled"}`, s.ok ? "info" : "warning");
      if (s.errors.length) ui.notify(s.errors.join("; "), "error");
    },
  });

  pi.registerCommand("pi-scheduler:run", {
    description: "Run a job now (foreground, streams output to a widget)",
    getArgumentCompletions: (prefix) => {
      const f = listJobs().filter((n) => n.startsWith(prefix));
      return f.length ? f.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const name = args.trim() || (await pickJob(ui, "run"));
      if (!name || !NAME_RE.test(name) || !fs.existsSync(path.join(JOBS_DIR, `${name}.md`))) {
        ui.notify("job not found", "error");
        return;
      }
      ui.setStatus("pi-scheduler", `running ${name}…`);
      const child = spawn("/bin/bash", [RUN_JOB, name], { env: { ...process.env, PI_SCHEDULER_DIR: DATA_DIR } });
      const tail: string[] = [];
      let buf = "";
      const flush = (final = false) => {
        const parts = buf.split("\n");
        buf = final ? "" : (parts.pop() ?? "");
        for (const p of parts) {
          if (p.length) { tail.push(p); if (tail.length > 30) tail.shift(); }
        }
        showWidget(ui, `pi-scheduler: running ${name}`, tail);
      };
      child.stdout.on("data", (d) => { buf += d.toString(); flush(); });
      child.stderr.on("data", (d) => { buf += d.toString(); flush(); });
      if (ctx.signal) ctx.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      const code: number = await new Promise((resolve) => {
        child.on("close", (c) => resolve(c ?? 1));
        child.on("error", () => resolve(1));
      });
      ui.setStatus("pi-scheduler", "");
      flush(true);
      const rec = lastRunRecord(name);
      ui.notify(
        rec ? `run finished: ${rec}` : `run-job exited with code ${code}`,
        code === 0 ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("pi-scheduler:sync", {
    description: "Regenerate systemd timer units from ~/.pi/scheduler/jobs/*.md",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const s = syncNow();
      if (s.errors.length) ui.notify(s.errors.join("; "), "error");
      showWidget(ui, "pi-scheduler sync", s.lines);
      ui.notify(s.ok ? `sync ok — ${s.lines.filter((l) => l.startsWith("job ")).length} job(s) managed` : "sync had errors", s.ok ? "info" : "error");
    },
  });

  pi.registerCommand("pi-scheduler:logs", {
    description: "Show recent journal output for a job's service",
    getArgumentCompletions: (prefix) => {
      const f = listJobs().filter((n) => n.startsWith(prefix));
      return f.length ? f.map((n) => ({ value: n, label: n })) : null;
    },
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const name = args.trim() || (await pickJob(ui, "logs"));
      if (!name || !NAME_RE.test(name)) { ui.notify("job not found", "error"); return; }
      const r = sh("journalctl", ["--user", "-u", `${UNIT_PREFIX}${name}.service`, "-n", "80", "--no-pager"]);
      if (r.code !== 0) { ui.notify(r.err.trim() || "no journal output", "info"); return; }
      const lines = r.out.trimEnd().split("\n").filter((l) => l.trim());
      if (!lines.length) { ui.notify("no journal output for this job yet", "info"); return; }
      showWidget(ui, `journal: ${name}`, lines);
      ui.notify(`${lines.length} journal line(s)`, "info");
    },
  });
}
