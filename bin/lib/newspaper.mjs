import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, appendFile, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SAFE_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EDITIONS = new Set(["hourly", "daily", "weekly"]);

export const DEFAULT_MODEL = "qwen-token-plan/deepseek-v4-flash-0731";
export const AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function pad(value) {
  return String(value).padStart(2, "0");
}

export function localDate(value) {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function editionWindow(edition, now = new Date()) {
  if (!EDITIONS.has(edition)) throw new Error(`unknown newspaper edition: ${edition}`);
  const end = new Date(now);
  if (edition === "hourly") {
    end.setMinutes(0, 0, 0);
    const start = new Date(end);
    start.setHours(start.getHours() - 1);
    return { start, end };
  }
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - (edition === "daily" ? 1 : 7));
  return { start, end };
}

export function periodLabel(edition, window) {
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  if (edition === "hourly") return `${date.format(window.start)}, ${time.format(window.start)}–${time.format(window.end)}`;
  if (edition === "daily") return date.format(window.start);
  const inclusiveEnd = new Date(window.end);
  inclusiveEnd.setDate(inclusiveEnd.getDate() - 1);
  return `${date.format(window.start)}–${date.format(inclusiveEnd)}`;
}

export function archiveName(edition, window) {
  if (edition === "hourly") {
    return `${localDate(window.end)}T${pad(window.end.getHours())}00.md`;
  }
  if (edition === "daily") return `${localDate(window.start)}.md`;
  return `${localDate(window.start)}--${localDate(new Date(window.end.getTime() - 1))}.md`;
}

export function parseRepositoryRegistry(text, projectsRoot) {
  const repositories = [];
  const seen = new Set();
  for (const raw of String(text).split("\n")) {
    const entry = raw.split("#", 1)[0].trim();
    if (!entry) continue;
    const path = entry.startsWith("/") ? resolve(entry) : resolve(projectsRoot, entry);
    const key = basename(path).toLowerCase();
    if (!SAFE_KEY.test(key)) throw new Error(`malformed newspaper repository: ${entry}`);
    if (seen.has(path)) continue;
    seen.add(path);
    repositories.push({ key, path });
  }
  if (!repositories.length) throw new Error("newspaper repository registry is empty");
  return repositories;
}

async function git(path, args, options = {}) {
  const result = await execFile(options.gitBin ?? "git", ["-C", path, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

export async function collectGitEvidence(repositories, window, options = {}) {
  const sections = [];
  let commitCount = 0;
  for (const repository of repositories) {
    const root = (await git(repository.path, ["rev-parse", "--show-toplevel"], options)).trim();
    const countText = await git(root, [
      "rev-list", "--all", "--count",
      `--since=${window.start.toISOString()}`,
      `--until=${window.end.toISOString()}`,
    ], options);
    const count = Number.parseInt(countText.trim(), 10) || 0;
    commitCount += count;
    const history = count === 0 ? "(No commits in this period.)" : (await git(root, [
      "log", "--all",
      `--since=${window.start.toISOString()}`,
      `--until=${window.end.toISOString()}`,
      "--date=iso-strict",
      "--pretty=format:commit %H%nDate: %ad%nAuthor: %an%nSubject: %s%n",
      "--stat", "--no-renames",
    ], options)).trim();
    sections.push(`## ${repository.key}\nRepository: ${root}\n\n${history}`);
  }
  return { commitCount, text: sections.join("\n\n") };
}

export async function collectWeeklyEvidence(archiveRoot, window) {
  const sections = [];
  const day = new Date(window.start);
  while (day < window.end) {
    const key = localDate(day);
    const path = join(archiveRoot, "daily", `${key}.md`);
    let content;
    try { content = (await readFile(path, "utf8")).trim(); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      content = "(No daily edition was archived.)";
    }
    sections.push(`## ${key}\n\n${content}`);
    day.setDate(day.getDate() + 1);
  }
  return { commitCount: sections.length, text: sections.join("\n\n") };
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function atomicWrite(path, content) {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function optionalFile(path, fallback) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return fallback; throw error; }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function directoryEntries(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
}

export async function pruneNewspaperState(stateRoot, options = {}) {
  const now = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
  const retentionMs = Number(options.retentionMs ?? AUDIT_RETENTION_MS);
  if (!Number.isFinite(now) || !Number.isFinite(retentionMs) || retentionMs < 0) throw new Error("newspaper retention values are invalid");
  const cutoff = now - retentionMs;
  let removed = 0;

  const runsRoot = join(stateRoot, "runs");
  for (const entry of await directoryEntries(runsRoot)) {
    if (!entry.isDirectory()) continue;
    const path = join(runsRoot, entry.name);
    const activePath = join(path, ".active");
    let active = false;
    try {
      const pid = Number.parseInt((await readFile(activePath, "utf8")).trim(), 10);
      active = processAlive(pid);
      if (!active) await unlink(activePath).catch(() => {});
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (active) continue;
    if ((await stat(path)).mtimeMs < cutoff) { await rm(path, { recursive: true, force: true }); removed += 1; }
  }

  const archiveRoot = join(stateRoot, "archive");
  for (const edition of await directoryEntries(archiveRoot)) {
    if (!edition.isDirectory()) continue;
    const path = join(archiveRoot, edition.name);
    for (const entry of await directoryEntries(path)) {
      if (!entry.isFile()) continue;
      const file = join(path, entry.name);
      if ((await stat(file)).mtimeMs < cutoff) { await unlink(file); removed += 1; }
    }
  }
  return removed;
}

async function recordActivity(options, event, detail = {}) {
  const timestamp = new Date().toISOString();
  const value = { timestamp, edition: options.edition, run_id: options.runId, event, ...detail };
  await appendFile(options.activityPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await atomicWrite(options.statusPath, `${JSON.stringify({
    edition: options.edition,
    run_id: options.runId,
    state: detail.state ?? "running",
    stage: detail.stage ?? event.split(".", 1)[0],
    event,
    started_at: options.startedAt,
    last_activity_at: timestamp,
  }, null, 2)}\n`);
}

function assistantParts(event) {
  if (event?.type !== "message_end" || event?.message?.role !== "assistant" || !Array.isArray(event.message.content)) return [];
  return event.message.content;
}

async function runPi(args, options) {
  await recordActivity(options.audit, `${options.stage}.started`, { stage: options.stage });
  const child = spawn(options.piBin, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = createWriteStream(options.stderrPath, { flags: "a", mode: 0o600 });
  child.stderr.pipe(stderr, { end: false });
  let spawnError;
  child.once("error", (error) => { spawnError = error; });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  let timer;
  if (options.timeoutMs > 0) timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);

  let output = "";
  let updates = 0;
  let recordedUpdates = 0;
  let lastProgress = 0;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) {
    let event;
    try { event = JSON.parse(line); }
    catch {
      await recordActivity(options.audit, `${options.stage}.protocol-error`, { stage: options.stage, bytes: Buffer.byteLength(line) });
      continue;
    }
    if (event.type === "message_update") {
      updates += 1;
      const now = Date.now();
      if (recordedUpdates === 0 || now - lastProgress >= 5_000) {
        await recordActivity(options.audit, `${options.stage}.output`, { stage: options.stage, updates });
        recordedUpdates = updates;
        lastProgress = now;
      }
      continue;
    }
    for (const part of assistantParts(event)) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) output = part.text;
      if (part.type === "toolCall") {
        await recordActivity(options.audit, "investigator.requested", {
          stage: options.stage,
          tool: part.name,
          request: typeof part.arguments?.request === "string" ? part.arguments.request : undefined,
        });
      }
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      await recordActivity(options.audit, event.type === "tool_execution_start" ? "investigator.started" : "investigator.finished", {
        stage: options.stage,
        tool: event.toolName,
        call_id: event.toolCallId,
      });
    }
  }
  const result = await closed;
  if (timer) clearTimeout(timer);
  stderr.end();
  if (updates > recordedUpdates) await recordActivity(options.audit, `${options.stage}.output`, { stage: options.stage, updates });
  if (spawnError) {
    await recordActivity(options.audit, `${options.stage}.failed`, { stage: options.stage, state: "failed", error: spawnError.message });
    throw spawnError;
  }
  if (result.code !== 0) {
    const error = `newspaper ${options.stage} exited ${result.signal ? `on ${result.signal}` : `with status ${result.code}`}`;
    await recordActivity(options.audit, `${options.stage}.failed`, { stage: options.stage, state: "failed", error });
    throw new Error(error);
  }
  if (!output.trim()) {
    await recordActivity(options.audit, `${options.stage}.failed`, { stage: options.stage, state: "failed", error: "empty response" });
    throw new Error("newspaper agent returned an empty response");
  }
  await recordActivity(options.audit, `${options.stage}.finished`, { stage: options.stage, characters: output.length });
  return `${output.trim()}\n`;
}

export function writerSystemPrompt(template, edition, period) {
  return template.replaceAll("{edition}", edition).replaceAll("{period}", period);
}

export async function runNewsroom(options) {
  const {
    root, stateRoot, edition, period, source, previous,
    model = DEFAULT_MODEL, thinking = "high",
    piBin = "pi", timeoutMs = 0,
  } = options;
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replaceAll(":", "-").replace(".", "-")}-${edition}-${randomUUID().slice(0, 8)}`;
  const runRoot = join(stateRoot, "runs", runId);
  await privateDirectory(runRoot);
  const activePath = join(runRoot, ".active");
  const sourcePath = join(runRoot, "evidence.md");
  const previousPath = join(runRoot, "previous.md");
  const draftPath = join(runRoot, "draft.md");
  const finalPath = join(runRoot, "final.md");
  const investigationsPath = join(runRoot, "investigations.md");
  const writerPromptPath = join(runRoot, "writer-system.md");
  const activityPath = join(runRoot, "activity.jsonl");
  const stderrPath = join(runRoot, "stderr.log");
  const statusPath = join(stateRoot, "status", `${edition}.json`);
  const investigatorPromptPath = join(root, "prompts", "services", "newspaper-investigator.md");
  const editorPromptPath = join(root, "prompts", "services", "newspaper-editor.md");
  const writerTemplate = await readFile(join(root, "prompts", "services", "newspaper-writer.md"), "utf8");
  const audit = { edition, runId, startedAt, activityPath, statusPath };
  await writeFile(activePath, `${process.pid}\n`, { mode: 0o600 });
  await writeFile(sourcePath, source, { mode: 0o600 });
  await writeFile(previousPath, previous, { mode: 0o600 });
  await writeFile(investigationsPath, "# Investigations\n\n", { mode: 0o600 });
  await writeFile(writerPromptPath, writerSystemPrompt(writerTemplate, edition, period), { mode: 0o600 });
  await writeFile(stderrPath, "", { mode: 0o600 });
  await writeFile(activityPath, "", { mode: 0o600 });
  await recordActivity(audit, "run.started", { stage: "collecting", model, period });

  const shared = [
    "--model", model, "--thinking", thinking, "--mode", "json",
    "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session", "-p",
  ];
  const webExtension = options.webExtension ?? join(process.env.HOME || homedir(), ".pi", "agent", "npm", "node_modules", "@juicesharp", "rpiv-web-tools", "index.ts");
  const writerEnv = {
    ...process.env,
    QQ_NEWSPAPER_ROOT: root,
    QQ_NEWSPAPER_STATE_ROOT: stateRoot,
    QQ_NEWSPAPER_SOURCE: sourcePath,
    QQ_NEWSPAPER_INVESTIGATIONS: investigationsPath,
    QQ_NEWSPAPER_INVESTIGATOR_PROMPT: investigatorPromptPath,
    QQ_NEWSPAPER_PI_BIN: piBin,
    QQ_NEWSPAPER_MODEL: model,
    QQ_NEWSPAPER_THINKING: thinking,
    QQ_NEWSPAPER_WEB_EXTENSION: webExtension,
    QQ_NEWSPAPER_PERIOD: period,
    QQ_NEWSPAPER_REPOSITORIES: options.repositorySummary ?? "",
  };

  try {
    const draft = await runPi([
      "--system-prompt", writerPromptPath,
      "--no-extensions", "--extension", join(root, "extensions", "newspaper-investigate.ts"),
      "--no-builtin-tools", "--tools", "investigate",
      ...shared, `@${sourcePath}`, `@${previousPath}`, "Write this edition now.",
    ], { piBin, cwd: root, env: writerEnv, timeoutMs, stage: "writer", audit, stderrPath });
    await writeFile(draftPath, draft, { mode: 0o600 });
    await recordActivity(audit, "draft.saved", { stage: "writer", characters: draft.length });
    const investigations = await optionalFile(investigationsPath, "# Investigations\n\n");
    const editionText = await runPi([
      "--system-prompt", editorPromptPath,
      "--no-extensions", "--no-tools",
      ...shared,
      `@${sourcePath}`, `@${investigationsPath}`, `@${draftPath}`, `@${previousPath}`,
      "Edit this edition now.",
    ], { piBin, cwd: root, env: process.env, timeoutMs, stage: "editor", audit, stderrPath });
    await writeFile(finalPath, editionText, { mode: 0o600 });
    await recordActivity(audit, "run.finished", { stage: "complete", state: "complete", characters: editionText.length });
    return { edition: editionText, draft, investigations, runId, runRoot };
  } catch (error) {
    await recordActivity(audit, "run.failed", { stage: "failed", state: "failed", error: error instanceof Error ? error.message : String(error) }).catch(() => {});
    throw error;
  } finally {
    await unlink(activePath).catch(() => {});
  }
}

export async function publishEdition(options) {
  const root = resolve(options.root);
  const edition = options.edition;
  if (!EDITIONS.has(edition)) throw new Error(`unknown newspaper edition: ${edition}`);
  const stateRoot = resolve(options.stateRoot ?? join(process.env.XDG_STATE_HOME || join(process.env.HOME || homedir(), ".local", "state"), "qq", "newspaper"));
  await pruneNewspaperState(stateRoot, {
    now: options.pruneNow ?? options.now ?? new Date(),
    retentionMs: options.retentionMs ?? AUDIT_RETENTION_MS,
  });
  const archiveRoot = join(stateRoot, "archive");
  const currentRoot = join(stateRoot, "current");
  const window = editionWindow(edition, options.now ?? new Date());
  const archivePath = join(archiveRoot, edition, archiveName(edition, window));
  try {
    await access(archivePath);
    return { published: false, reason: "already-published", archivePath };
  } catch (error) { if (error?.code !== "ENOENT") throw error; }

  let evidence;
  let repositorySummary = "";
  if (edition === "weekly") {
    evidence = await collectWeeklyEvidence(archiveRoot, window);
  } else {
    const registryPath = resolve(options.registryPath ?? join(root, "config", "newspaper-repositories"));
    const projectsRoot = resolve(options.projectsRoot ?? join(process.env.HOME || homedir(), "projects"));
    const repositories = parseRepositoryRegistry(await readFile(registryPath, "utf8"), projectsRoot);
    repositorySummary = repositories.map(({ key, path }) => `${key}: ${path}`).join("\n");
    evidence = await collectGitEvidence(repositories, window, options);
    if (edition === "hourly" && evidence.commitCount === 0) return { published: false, reason: "quiet", archivePath };
  }

  const period = periodLabel(edition, window);
  const source = `# Reporting material\n\nEdition: ${edition}\nPeriod: ${period}\n\n${evidence.text.trim()}\n`;
  const currentPath = join(currentRoot, `${edition}.md`);
  const previous = await optionalFile(currentPath, "(There is no previous edition.)\n");
  const newsroom = await (options.newsroom ?? runNewsroom)({
    ...options, root, stateRoot, edition, period, source, previous, repositorySummary,
  });
  const content = String(newsroom.edition ?? "").trim();
  if (!content) throw new Error("newspaper editor returned an empty edition");
  await atomicWrite(archivePath, `${content}\n`);
  await atomicWrite(currentPath, `${content}\n`);
  return { published: true, archivePath, currentPath, period };
}

export async function withNewspaperLock(stateRoot, edition, callback) {
  if (!EDITIONS.has(edition)) throw new Error(`unknown newspaper edition: ${edition}`);
  await privateDirectory(stateRoot);
  const path = join(stateRoot, `${edition}.lock`);
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) {
    if (error?.code === "EEXIST") return { published: false, reason: "busy" };
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n`);
    return await callback();
  } finally {
    await handle.close();
    await unlink(path).catch(() => {});
  }
}
