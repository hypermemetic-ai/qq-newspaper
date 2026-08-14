// @ts-nocheck
import { appendFile } from "node:fs/promises";
function text(message, details = {}) {
  return { content: [{ type: "text", text: message }], details };
}

export default function registerNewspaperInvestigator(pi, deps = {}) {
  const env = deps.env ?? process.env;
  const run = deps.exec ?? ((command, args, options) => pi.exec(command, args, options));

  pi.registerTool({
    name: "investigate",
    label: "Send an investigator",
    description: "Send an investigator to pursue a question for the writer. The investigator can examine every qq-linked project, inspect Git history, and search or fetch the public internet through Brave or Exa. It returns findings with supporting evidence.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["request"],
      properties: {
        request: { type: "string", minLength: 1, maxLength: 8000 },
      },
    },
    async execute(_id, params, signal) {
      const request = params?.request?.trim();
      if (!request) return text("The investigator needs a request.", { status: "refused" });
      const root = env.QQ_NEWSPAPER_ROOT;
      const source = env.QQ_NEWSPAPER_SOURCE;
      const log = env.QQ_NEWSPAPER_INVESTIGATIONS;
      const systemPrompt = env.QQ_NEWSPAPER_INVESTIGATOR_PROMPT;
      const piBin = env.QQ_NEWSPAPER_PI_BIN || "pi";
      if (!root || !source || !log || !systemPrompt) return text("The investigator's newsroom context is unavailable.", { status: "failed" });

      const args = [
        "--model", env.QQ_NEWSPAPER_MODEL || "qwen-token-plan/deepseek-v4-flash-0731",
        "--thinking", env.QQ_NEWSPAPER_THINKING || "high",
        "--system-prompt", systemPrompt,
        "--no-extensions",
      ];
      if (env.QQ_NEWSPAPER_WEB_EXTENSION) args.push("--extension", env.QQ_NEWSPAPER_WEB_EXTENSION);
      args.push(
        "--tools", "read,bash,grep,find,ls,web_search,web_fetch",
        "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session",
        "--mode", "text", "-p",
        `@${source}`,
        `The reporting period is ${env.QQ_NEWSPAPER_PERIOD || "given in the source material"}.\n\nLinked projects:\n${env.QQ_NEWSPAPER_REPOSITORIES || "See the source material."}\n\nThe writer asks:\n${request}`,
      );

      let result;
      try { result = await run(piBin, args, { cwd: root, env, signal }); }
      catch (error) { return text(`The investigator failed: ${error instanceof Error ? error.message : String(error)}`, { status: "failed" }); }
      if (result?.code !== 0) {
        const reason = result?.stderr?.trim() || result?.stdout?.trim() || "unknown failure";
        return text(`The investigator failed: ${reason}`, { status: "failed" });
      }
      const findings = result?.stdout?.trim();
      if (!findings) return text("The investigator returned without findings.", { status: "failed" });
      await appendFile(log, `## Request\n\n${request}\n\n## Findings\n\n${findings}\n\n`, { mode: 0o600 });
      return text(findings, { status: "complete" });
    },
  });
}
