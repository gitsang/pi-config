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
import { Type } from "typebox";
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
  "触发时间用 systemd OnCalendar 语法，留空 = 不装 timer（只能被外部触发）",
  "  不带时区时按 systemd 的系统时区解释（不做换算）；要指定时区就写在表达式末尾",
  "  快捷名:   daily / hourly / weekly / monthly",
  "  每天 3:10       *-*-* 03:10:00",
  "  每周日 9:30     Sun *-*-* 09:30:00",
  "  工作日 9:00     Mon..Fri *-*-* 09:00:00",
  "  每 15 分钟      *:00/15",
  "  每小时          *-*-* *:00:00",
  "  每月 1 号 2:00  *-*-01 02:00:00",
  "  显式时区        Fri *-*-* 05:00:00 Asia/Shanghai",
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

/** 删除一个 job：job 文件 + units + sessions + last-out（命令与工具共用）。 */
function removeJob(name: string): void {
  fs.rmSync(path.join(JOBS_DIR, `${name}.md`), { force: true });
  systemctl(["disable", "--now", `${UNIT_PREFIX}${name}.timer`]);
  systemctl(["stop", `${UNIT_PREFIX}${name}.service`]);
  fs.rmSync(path.join(UNITS_DIR, `${UNIT_PREFIX}${name}.timer`), { force: true });
  fs.rmSync(path.join(UNITS_DIR, `${UNIT_PREFIX}${name}.service`), { force: true });
  fs.rmSync(path.join(STATE_DIR, `last-${name}.out`), { force: true });
  fs.rmSync(path.join(DATA_DIR, "sessions", name), { recursive: true, force: true });
  systemctl(["daemon-reload"]);
}

function jobExists(name: string): boolean {
  return NAME_RE.test(name) && fs.existsSync(path.join(JOBS_DIR, `${name}.md`));
}

function jobCardLines(name: string): string[] {
  const { meta } = readJob(name);
  const enabled = meta.enabled !== "false";
  const schedule = meta.schedule?.trim() || "(no timer — external/manual only)";
  return [
    `• ${name}  ${enabled ? "" : "(disabled) "}${schedule}`,
    `  cwd: ${meta.cwd || homedir()}  model: ${meta.model || "default"}  timeout: ${meta.timeoutSec || 0}s`,
    formatLastRun(lastRunRecord(name)),
  ];
}

// ---------------------------------------------------------------- units 生成 / sync

function serviceUnit(name: string): string {
  return [
    "[Unit]",
    `Description=pi-scheduler job: ${name}`,
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${RUN_JOB} ${name} --trigger timer`,
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

/** systemd manager 的时区名。不带时区的 OnCalendar 就是按它解释的。 */
function systemTz(): string {
  const r = sh("timedatectl", ["show", "--property=Timezone", "--value"]);
  const v = r.out.trim();
  return r.code === 0 && v ? v : "UTC";
}

/**
 * 取 OnCalendar 表达式里显式写的时区后缀（如 `… 05:00:00 Asia/Shanghai`），没有则 null。
 * 仅用于给用户加注解；表达式是否合法一律以 systemd 的校验为准。
 */
function explicitTzOf(expr: string): string | null {
  const toks = expr.trim().split(/\s+/);
  if (toks.length < 2) return null;
  const last = toks[toks.length - 1] ?? "";
  const prev = toks[toks.length - 2] ?? "";
  if (!/\d:\d{2}/.test(prev)) return null; // 时区必须紧跟在一个时间后面
  return /^[A-Za-z][A-Za-z0-9_/+.-]*$/.test(last) ? last : null;
}

/**
 * 校验 OnCalendar 表达式，返回写入 unit 的形式。
 *
 * **不做任何时区换算**：不带时区的表达式由 systemd 按系统时区（systemd 惯例）解释，
 * 想指定别的时区请在表达式里显式写后缀，例如 `Fri *-*-* 05:00:00 Asia/Shanghai`。
 */
function computeStoredSchedule(userExpr: string): { stored: string; note?: string; warn?: string } {
  // 空 schedule = 明确表示「不装 timer」：job 仍然有效，只由外部（pi-trigger / 手动）触发。
  if (!userExpr.trim()) return { stored: "" };
  const v = validateSchedule(userExpr);
  if (!v.ok) return { stored: userExpr, warn: v.reason ?? "invalid schedule" };
  const stored = v.normalized ?? userExpr;
  const tz = explicitTzOf(userExpr);
  return tz
    ? { stored, note: `时区: ${tz}` }
    : { stored, note: `按系统时区 ${systemTz()} 解释` };
}

/**
 * 给定写入 unit 的表达式，返回带时区标注的“下次触发”。
 * 主显示用 systemd 的原始输出（系统时区），本机时区不同再补一个明确标注的等价时刻。
 */
function nextFire(storedExpr: string): string {
  if (!storedExpr.trim()) return "(无 timer)";
  const r = sh("env", ["-u", "TZ", "systemd-analyze", "calendar", storedExpr]);
  if (r.code !== 0) return "?";
  const m = /Next elapse:\s*(.*)/.exec(r.out);
  if (!m) return "?";
  const syst = m[1].trim();
  const conv = sh("date", ["-d", syst]);
  const local = conv.code === 0 ? conv.out.trim() : "";
  if (!local || local === syst) return syst;
  return `${syst}（本机 ${local}）`;
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
  const tz = systemTz();
  lines.push(`schedules without an explicit timezone are interpreted in the system timezone of systemd (${tz})`);

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
      // 不装 timer。desired 不含它 → 下面的 stale 清理会顺手删掉遗留 unit。
      lines.push(`job ${name}: no schedule — timer not managed (可被 bin/run-job 外部触发)`);
      continue;
    }
    const c = computeStoredSchedule(schedule);
    if (c.warn) {
      errors.push(`job ${name}: ${c.warn}`);
      continue;
    }
    desired.add(name);
    fs.writeFileSync(path.join(UNITS_DIR, `${UNIT_PREFIX}${name}.service`), serviceUnit(name), "utf8");
    fs.writeFileSync(path.join(UNITS_DIR, `${UNIT_PREFIX}${name}.timer`), timerUnit(name, c.stored), "utf8");
    const note = c.note ? ` ${c.note}` : "";
    lines.push(`job ${name}: ${c.stored}${note} — next ${nextFire(c.stored)}`);
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

// ---------------------------------------------------------------- tools（agent 可调用）

const SCHEDULE_GUIDE =
  "OnCalendar（systemd）语法。不带时区时按 systemd 的系统时区解释（不做任何换算）；" +
  "要指定时区就显式写在表达式末尾，例如 Fri *-*-* 05:00:00 Asia/Shanghai。" +
  "示例：daily / hourly / weekly（快捷名）；每天 03:10 → *-*-* 03:10:00；每周日 09:30 → Sun *-*-* 09:30:00；" +
  "工作日 09:00 → Mon..Fri *-*-* 09:00:00；每 15 分钟 → *:00/15；每小时 → *-*-* *:00:00；每月 1 号 02:00 → *-*-01 02:00:00";

type ToolExecCtx = { hasUI?: boolean; signal?: AbortSignal; ui?: Ctx["ui"] };

function toolText(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function registerSchedulerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pi_scheduler_list",
    label: "Pi Scheduler: List",
    description: "列出 pi-scheduler 的全部定时 job：名称/触发/启用状态/最近一次运行结果。只读，无副作用。",
    promptSnippet: "List pi scheduled jobs and their last run status",
    promptGuidelines: [
      "Use pi_scheduler_list when the user asks what scheduled pi jobs exist, or whether/when a scheduled job last ran.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const names = listJobs();
      if (!names.length) return toolText("pi-scheduler: 还没有任何 job。");
      const lines = names.flatMap(jobCardLines);
      return toolText(`pi-scheduler jobs (${names.length}):\n${lines.join("\n")}`, { jobs: names });
    },
  });

  pi.registerTool({
    name: "pi_scheduler_create",
    label: "Pi Scheduler: Create",
    description:
      `创建一个 pi job：写 jobs/<name>.md（frontmatter + prompt 正文）。schedule 非空 → 注册 systemd user timer；留空 → 不装 timer（job 仍有效，可由 bin/run-job / pi-trigger 外部触发）。自动完成 sync。` +
      `⚠️ 注意成本：每个定时触发都会真实运行一次 pi -p agent（消耗 token），使用前应把这一点告诉用户。` +
      `必填 name、schedule、prompt。${SCHEDULE_GUIDE}。`,  // 实际语义拼接在下方 promptGuidelines 之外
    promptSnippet: "Create a scheduled pi job (systemd user timer)",
    promptGuidelines: [
      "Use pi_scheduler_create when the user asks to set up a recurring pi task (e.g. \"every morning at 9, review yesterday's PRs\").",
      "Before creating, tell the user the job will run a real pi agent on schedule and consume tokens.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "job 名：仅字母/数字/_/-，最长 40（例: daily-report）" }),
      schedule: Type.String({ description: `触发时间，OnCalendar（systemd）语法；留空 = 不装 timer（job 仍有效，可被外部触发）。${SCHEDULE_GUIDE}` }),
      prompt: Type.String({ description: "任务指令正文（markdown）：每次触发时原样作为 prompt 交给 pi -p。写清楚目标/工作目录/完成标准/失败怎么处理。" }),
      cwd: Type.Optional(Type.String({ description: "工作目录，默认 $HOME（prompt 里也可用绝对路径 cd 到别的仓库）" })),
      model: Type.Optional(Type.String({ description: "运行模型，留空=当前默认；省钱可填便宜档（例: claude-haiku-4-5）" })),
      timeoutSec: Type.Optional(Type.String({ description: "单次运行超时秒数（字符串），留空=0 不限（建议给上限防挂死）" })),
    }),
    async execute(
      _id,
      params: { name: string; schedule: string; prompt: string; cwd?: string; model?: string; timeoutSec?: string },
    ) {
      const { name, schedule, prompt } = params;
      if (!NAME_RE.test(name)) return toolText(`ERROR: name "${name}" 不合法（仅字母/数字/_/-，≤40）`);
      if (!prompt?.trim()) return toolText("ERROR: prompt 不能为空");
      if (fs.existsSync(path.join(JOBS_DIR, `${name}.md`))) return toolText(`ERROR: job "${name}" 已存在，请用 pi_scheduler_update 修改`);
      const userSchedule = schedule.trim();
      const c = computeStoredSchedule(userSchedule);
      if (c.warn) return toolText(`ERROR: schedule 不可用 — ${c.warn}\n${SCHEDULE_GUIDE}`);
      writeJob(
        name,
        {
          schedule: userSchedule,
          cwd: params.cwd?.trim() || homedir(),
          model: params.model?.trim() ?? "",
          timeoutSec: params.timeoutSec?.trim() || "0",
          enabled: "true",
        },
        prompt,
      );
      const s = syncNow();
      const next = nextFire(c.stored);
      const head = userSchedule
        ? `job "${name}" 已创建并启用，timer 已注册。\n下次触发：${next}${c.note ? `（${c.note}）` : ""}\n⚠️ 每次触发都会运行一次 pi -p agent，消耗 token。`
        : `job "${name}" 已创建。schedule 为空 → 未注册 timer，只能由外部（bin/run-job / pi-trigger）或手动触发。\n⚠️ 每次触发都会运行一次 pi -p agent，消耗 token。`;
      return toolText(
        `${head}\n${s.errors.length ? "sync 错误: " + s.errors.join("; ") : "timers synced"}`,
        { ok: s.ok, name, stored: c.stored, next },
      );
    },
  });

  pi.registerTool({
    name: "pi_scheduler_update",
    label: "Pi Scheduler: Update",
    description: `修改已有 job：可改 schedule/cwd/model/timeoutSec/enabled，或用新 prompt 整体替换正文。只传要改的字段；enabled 传 \"false\" 可停用（保留 job 文件）；schedule 传空串可移除 timer（job 保留）。${SCHEDULE_GUIDE}`,
    promptSnippet: "Update an existing scheduled pi job",
    promptGuidelines: [
      "Use pi_scheduler_update to change a job's trigger time, working directory, model, timeout, enabled flag, or full prompt text.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "要修改的 job 名" }),
      schedule: Type.Optional(Type.String({ description: `新的触发时间，OnCalendar（systemd）语法。${SCHEDULE_GUIDE}` })),
      prompt: Type.Optional(Type.String({ description: "新的 prompt 全文（整体替换正文；不传则不修改）" })),
      cwd: Type.Optional(Type.String({ description: "新的工作目录" })),
      model: Type.Optional(Type.String({ description: "新的模型" })),
      timeoutSec: Type.Optional(Type.String({ description: "新的超时秒数" })),
      enabled: Type.Optional(Type.String({ description: "\"true\" 启用 / \"false\" 停用" })),
    }),
    async execute(
      _id,
      params: {
        name: string;
        schedule?: string;
        prompt?: string;
        cwd?: string;
        model?: string;
        timeoutSec?: string;
        enabled?: string;
      },
    ) {
      if (!jobExists(params.name)) return toolText(`ERROR: job "${params.name}" 不存在，先 pi_scheduler_list 看看`);
      const { meta, body } = readJob(params.name);
      let changed = false;
      const changedFields: string[] = [];
      if (params.schedule !== undefined) {
        const userSchedule = params.schedule.trim();
        const c = computeStoredSchedule(userSchedule);
        if (c.warn) return toolText(`ERROR: schedule 不可用 — ${c.warn}\n${SCHEDULE_GUIDE}`);
        meta.schedule = userSchedule;
        changed = true;
        changedFields.push("schedule");
      }
      let newBody = body;
      if (params.prompt !== undefined && params.prompt.trim()) {
        newBody = params.prompt;
        changed = true;
        changedFields.push("prompt");
      }
      if (params.cwd !== undefined) { meta.cwd = params.cwd.trim(); changed = true; changedFields.push("cwd"); }
      if (params.model !== undefined) { meta.model = params.model.trim(); changed = true; changedFields.push("model"); }
      if (params.timeoutSec !== undefined) { meta.timeoutSec = params.timeoutSec.trim(); changed = true; changedFields.push("timeoutSec"); }
      if (params.enabled !== undefined) {
        if (params.enabled !== "true" && params.enabled !== "false") return toolText('ERROR: enabled 只接受 "true" 或 "false"');
        meta.enabled = params.enabled;
        changed = true;
        changedFields.push("enabled");
      }
      if (!changed) return toolText("没有提供任何要修改的字段（至少传 schedule/prompt/cwd/model/timeoutSec/enabled 之一）");
      writeJob(params.name, meta, newBody);
      const s = syncNow();
      const rec = lastRunRecord(params.name);
      return toolText(
        `job "${params.name}" 已更新字段: ${changedFields.join(", ")}\n${s.errors.length ? "sync 错误: " + s.errors.join("; ") : "timers synced"}${rec ? "\n" + rec : ""}`,
        { ok: s.ok, name: params.name, changed: changedFields },
      );
    },
  });

  pi.registerTool({
    name: "pi_scheduler_delete",
    label: "Pi Scheduler: Delete",
    description: `删除一个 job（job 文件 + systemd timer + sessions + 日志）。破坏性操作：有交互界面时需用户确认；无界面环境（子代理/headless）会拒绝执行。`,
    promptSnippet: "Delete a scheduled pi job",
    promptGuidelines: ["Use pi_scheduler_delete only when the user clearly asks to remove a scheduled job."],
    parameters: Type.Object({ name: Type.String({ description: "要删除的 job 名" }) }),
    async execute(_id, params: { name: string }, _signal, _onUpdate, ctx: ToolExecCtx) {
      if (!jobExists(params.name)) return toolText(`ERROR: job "${params.name}" 不存在`);
      if (!ctx.hasUI || !ctx.ui) {
        return toolText(`需要人工确认：当前无交互界面，不能删除 job。请在 pi TUI 里执行 /pi-scheduler:delete ${params.name}`);
      }
      const ok = await ctx.ui.confirm("pi-scheduler: 删除 job?", `删除 "${params.name}"？会同时移除 systemd timer、sessions 与日志。`);
      if (!ok) return toolText("已取消删除");
      removeJob(params.name);
      return toolText(`job "${params.name}" 已删除（timer/sessions/日志已清理）`);
    },
  });

  pi.registerTool({
    name: "pi_scheduler_run",
    label: "Pi Scheduler: Run Now",
    description: `立即运行一次指定 job（前台等待完成，返回退出码与输出尾部）。⚠️ 会真实运行一次 pi agent（消耗 token）。有交互界面时需用户确认；无界面环境会拒绝。`,
    promptSnippet: "Run a scheduled pi job once, right now",
    promptGuidelines: ["Use pi_scheduler_run when the user asks to run a scheduled job immediately (not wait for its timer)."],
    parameters: Type.Object({ name: Type.String({ description: "要运行的 job 名" }) }),
    async execute(_id, params: { name: string }, signal, onUpdate, ctx: ToolExecCtx) {
      if (!jobExists(params.name)) return toolText(`ERROR: job "${params.name}" 不存在`);
      if (!ctx.hasUI || !ctx.ui) {
        return toolText(`需要人工确认：当前无交互界面，不能立即运行（会消耗 token）。请在 pi TUI 里执行 /pi-scheduler:run ${params.name}`);
      }
      const ok = await ctx.ui.confirm("pi-scheduler: 立即运行?", `立即运行 "${params.name}"？会真实执行一次 pi agent（消耗 token）。`);
      if (!ok) return toolText("已取消运行");
      onUpdate?.({ content: [{ type: "text", text: `正在运行 ${params.name}…` }] });
      const out: string[] = [];
      const child = spawn("/bin/bash", [RUN_JOB, params.name], { env: { ...process.env, PI_SCHEDULER_DIR: DATA_DIR } });
      let buf = "";
      const push = (d: Buffer | string) => {
        buf += d.toString();
        const ls = buf.split("\n");
        buf = ls.pop() ?? "";
        for (const l of ls) if (l.trim()) { out.push(l); if (out.length > 30) out.shift(); }
      };
      child.stdout.on("data", push);
      child.stderr.on("data", push);
      if (signal) signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      const code: number = await new Promise((res) => {
        child.on("close", (c) => res(c ?? 1));
        child.on("error", () => res(1));
      });
      const rec = lastRunRecord(params.name);
      const tail = out.slice(-15).join("\n");
      return toolText(
        `run finished exit=${code}${rec ? "\n" + rec : ""}\n--- output tail ---\n${tail || "(no output)"}`,
        { exit: code, record: rec },
      );
    },
  });
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
        "触发时间 OnCalendar（留空=不装 timer，只由外部/手动触发；例: *-*-* 03:10:00）:",
        "",
      );
      if (scheduleRaw === undefined) { clearHelp(); ui.notify("cancelled", "info"); return; }
      const schedule = scheduleRaw.trim();
      const c = computeStoredSchedule(schedule);
      if (c.warn) {
        clearHelp();
        ui.notify(`schedule 不可用: ${c.warn}（试试上方示例里的写法）`, "error");
        return;
      }
      if (!schedule) ui.notify("schedule 留空 → 不注册 timer（可由外部/手动触发）", "info");
      else ui.notify(`✓ schedule ok — 下次触发: ${nextFire(c.stored)}${c.note ? ` （${c.note}）` : ""}`, "info");

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
        `  触发:      ${schedule || "(无 timer，只由外部/手动触发)"}${c.note ? `  ${c.note}` : ""}`,
        `  下次触发:  ${nextFire(c.stored)}`,
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
        const schedule = meta.schedule?.trim() || "(no timer — external/manual only)";
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
      // 空 schedule 合法：表示不装 timer（只由外部/手动触发）。
      const schedule = (meta.schedule ?? "").trim();
      const c = computeStoredSchedule(schedule);
      if (c.warn) {
        ui.notify(`invalid/unsupported schedule "${schedule}" — job unchanged (${c.warn})`, "error");
        return;
      }
      meta.schedule = schedule; // job.md 原样保留用户写的表达式，unit 直接照抄（不做时区换算）
      writeJob(name, meta, body);
      const s = syncNow();
      ui.notify(`job "${name}" updated — next fire: ${nextFire(c.stored)}`, s.ok ? "info" : "warning");
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
      removeJob(name);
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

  registerSchedulerTools(pi);
}
