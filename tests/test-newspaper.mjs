import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import registerInvestigator from "../extensions/newspaper-investigate.ts";
import {
  archiveName,
  editionWindow,
  parseRepositoryRegistry,
  pruneNewspaperState,
  publishEdition,
  runNewsroom,
  withNewspaperLock,
  writerSystemPrompt,
} from "../bin/lib/newspaper.mjs";

process.env.TZ = "UTC";
const root = process.argv[2] ?? process.cwd();
const scratch = await mkdtemp(join(tmpdir(), "qq-newspaper-test-"));

const hourly = editionWindow("hourly", new Date("2026-08-14T10:23:00Z"));
assert.equal(hourly.start.toISOString(), "2026-08-14T09:00:00.000Z");
assert.equal(hourly.end.toISOString(), "2026-08-14T10:00:00.000Z");
assert.equal(archiveName("hourly", hourly), "2026-08-14T1000.md");
const daily = editionWindow("daily", new Date("2026-08-14T05:00:00Z"));
assert.equal(daily.start.toISOString(), "2026-08-13T00:00:00.000Z");
assert.equal(daily.end.toISOString(), "2026-08-14T00:00:00.000Z");
const weekly = editionWindow("weekly", new Date("2026-08-17T06:00:00Z"));
assert.equal(weekly.start.toISOString(), "2026-08-10T00:00:00.000Z");
assert.equal(archiveName("weekly", weekly), "2026-08-10--2026-08-16.md");
assert.deepEqual(parseRepositoryRegistry("# live\nqq\n/opt/discuss\nqq\n", "/projects"), [
  { key: "qq", path: "/projects/qq" },
  { key: "discuss", path: "/opt/discuss" },
]);

const writerTemplate = await readFile(join(root, "prompts/services/newspaper-writer.md"), "utf8");
const rendered = writerSystemPrompt(writerTemplate, "daily", "yesterday");
assert.match(rendered, /^Write the daily edition of the qq newspaper/);
assert.match(rendered, /reporting material for yesterday/);
assert.doesNotMatch(rendered, /coding assistant|Available tools|Guidelines:/);

const projects = join(scratch, "projects");
const repo = join(projects, "one");
await mkdir(repo, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
await writeFile(join(repo, "story.txt"), "one\n");
execFileSync("git", ["add", "."], { cwd: repo });
execFileSync("git", ["commit", "-q", "-m", "the story moves"], {
  cwd: repo,
  env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-14T09:30:00Z", GIT_COMMITTER_DATE: "2026-08-14T09:30:00Z" },
});
const registry = join(scratch, "repositories");
await writeFile(registry, "one\n");
const stateRoot = join(scratch, "state");
let newsroomCalls = 0;
const published = await publishEdition({
  root, stateRoot, edition: "hourly", now: new Date("2026-08-14T10:23:00Z"),
  registryPath: registry, projectsRoot: projects,
  newsroom: async ({ source, previous }) => {
    newsroomCalls += 1;
    assert.match(source, /Subject: the story moves/);
    assert.match(previous, /no previous edition/i);
    return { edition: "# A real change\n\nThe project moved." };
  },
});
assert.equal(published.published, true);
assert.equal(newsroomCalls, 1);
assert.equal(await readFile(join(stateRoot, "current/hourly.md"), "utf8"), "# A real change\n\nThe project moved.\n");
const duplicate = await publishEdition({
  root, stateRoot, edition: "hourly", now: new Date("2026-08-14T10:23:00Z"),
  registryPath: registry, projectsRoot: projects,
  newsroom: async () => { throw new Error("duplicate should skip"); },
});
assert.equal(duplicate.reason, "already-published");
const quiet = await publishEdition({
  root, stateRoot, edition: "hourly", now: new Date("2026-08-14T11:23:00Z"),
  registryPath: registry, projectsRoot: projects,
  newsroom: async () => { throw new Error("quiet hour should skip"); },
});
assert.equal(quiet.reason, "quiet");

const fakePi = join(scratch, "fake-pi");
const capture = join(scratch, "capture");
await mkdir(capture);
await writeFile(fakePi, `#!/usr/bin/env node\nconst fs=require("fs");\nconst args=process.argv.slice(2);\nfs.appendFileSync(process.env.QQ_TEST_CAPTURE+"/args",args.join(" ")+"\\n");\nconst at=args.indexOf("--system-prompt"); const prompt=args[at+1]; const writer=prompt.endsWith("writer-system.md");\nfs.copyFileSync(prompt,process.env.QQ_TEST_CAPTURE+(writer?"/writer-system":"/editor-system"));\nconst emit=(value)=>console.log(JSON.stringify(value));\nemit({type:"session",timestamp:new Date().toISOString()});\nemit({type:"message_update",assistantMessageEvent:{type:"thinking_delta",delta:"PRIVATE REASONING"}});\nif(writer){\n emit({type:"message_end",message:{role:"assistant",content:[{type:"thinking",thinking:"PRIVATE REASONING"},{type:"toolCall",name:"investigate",arguments:{request:"Confirm the fact."}},{type:"text",text:"# Draft\\n\\nA draft."}]}});\n emit({type:"tool_execution_start",toolName:"investigate",toolCallId:"call-1"});\n emit({type:"tool_execution_end",toolName:"investigate",toolCallId:"call-1"});\n}else emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"# Final\\n\\nAn edition."}]}});\nemit({type:"agent_end"});\n`, { mode: 0o700 });
process.env.QQ_TEST_CAPTURE = capture;
const newsroom = await runNewsroom({
  root, stateRoot: join(scratch, "agent-state"), edition: "daily", period: "yesterday",
  source: "# Source\n", previous: "# Previous\n", repositorySummary: `one: ${repo}`,
  piBin: fakePi, timeoutMs: 10_000,
});
assert.equal(newsroom.edition, "# Final\n\nAn edition.\n");
assert.equal(await readFile(join(capture, "writer-system"), "utf8"), rendered);
assert.equal(await readFile(join(capture, "editor-system"), "utf8"), await readFile(join(root, "prompts/services/newspaper-editor.md"), "utf8"));
const capturedArgs = await readFile(join(capture, "args"), "utf8");
assert.match(capturedArgs, /--no-context-files/);
assert.match(capturedArgs, /--no-builtin-tools --tools investigate/);
assert.match(capturedArgs, /--no-extensions --no-tools/);
assert.match(capturedArgs, /--mode json/);
const runDirectories = await readdir(join(scratch, "agent-state", "runs"));
assert.equal(runDirectories.length, 1);
const auditRoot = join(scratch, "agent-state", "runs", runDirectories[0]);
assert.equal(await readFile(join(auditRoot, "draft.md"), "utf8"), "# Draft\n\nA draft.\n");
assert.equal(await readFile(join(auditRoot, "final.md"), "utf8"), "# Final\n\nAn edition.\n");
const activity = await readFile(join(auditRoot, "activity.jsonl"), "utf8");
assert.match(activity, /"event":"writer.started"/);
assert.match(activity, /"event":"investigator.requested"/);
assert.match(activity, /"event":"investigator.finished"/);
assert.match(activity, /"event":"editor.finished"/);
assert.doesNotMatch(activity, /PRIVATE REASONING/);

const retentionRoot = join(scratch, "retention");
const oldRun = join(retentionRoot, "runs", "old");
const activeRun = join(retentionRoot, "runs", "active");
const oldArchive = join(retentionRoot, "archive", "hourly", "old.md");
await mkdir(oldRun, { recursive: true });
await mkdir(activeRun, { recursive: true });
await mkdir(join(retentionRoot, "archive", "hourly"), { recursive: true });
await writeFile(join(oldRun, "activity.jsonl"), "old\n");
await writeFile(join(activeRun, ".active"), `${process.pid}\n`);
await writeFile(oldArchive, "old\n");
const oldTime = new Date("2026-08-01T00:00:00Z");
await utimes(oldRun, oldTime, oldTime);
await utimes(activeRun, oldTime, oldTime);
await utimes(oldArchive, oldTime, oldTime);
assert.equal(await pruneNewspaperState(retentionRoot, { now: new Date("2026-08-10T00:00:00Z") }), 2);
await assert.rejects(access(oldRun), { code: "ENOENT" });
await assert.rejects(access(oldArchive), { code: "ENOENT" });
await access(activeRun);

const lockRoot = join(scratch, "locks");
await mkdir(lockRoot);
await writeFile(join(lockRoot, "hourly.lock"), "99999999\n");
assert.equal(await withNewspaperLock(lockRoot, "hourly", async () => "recovered"), "recovered");
await writeFile(join(lockRoot, "hourly.lock"), `${process.pid}\n`);
assert.deepEqual(await withNewspaperLock(lockRoot, "hourly", async () => "unexpected"), { published: false, reason: "busy" });

let tool;
const investigationLog = join(scratch, "investigations.md");
await writeFile(investigationLog, "# Investigations\n\n");
registerInvestigator({
  registerTool(value) { tool = value; },
  async exec() { throw new Error("unexpected default exec"); },
}, {
  env: {
    QQ_NEWSPAPER_ROOT: root,
    QQ_NEWSPAPER_SOURCE: join(scratch, "source.md"),
    QQ_NEWSPAPER_INVESTIGATIONS: investigationLog,
    QQ_NEWSPAPER_INVESTIGATOR_PROMPT: join(root, "prompts/services/newspaper-investigator.md"),
    QQ_NEWSPAPER_PI_BIN: fakePi,
    QQ_NEWSPAPER_MODEL: "qwen-token-plan/deepseek-v4-flash-0731",
    QQ_NEWSPAPER_WEB_EXTENSION: "/web-tools/index.ts",
    QQ_NEWSPAPER_REPOSITORIES: `one: ${repo}`,
  },
  exec: async (_command, args) => {
    assert.ok(args.includes("/web-tools/index.ts"));
    assert.ok(args.includes("read,bash,grep,find,ls,web_search,web_fetch"));
    return { code: 0, stdout: "The evidence supports the claim.\n", stderr: "" };
  },
});
assert.equal(tool.name, "investigate");
const finding = await tool.execute("call", { request: "Settle this fact." });
assert.equal(finding.details.status, "complete");
assert.match(await readFile(investigationLog, "utf8"), /Settle this fact[\s\S]*evidence supports/);

console.log("newspaper tests passed");
