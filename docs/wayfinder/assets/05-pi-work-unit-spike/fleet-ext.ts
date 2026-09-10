/**
 * Spike of the Fleet Pi extension: terminating submit tool + tool_call command gate.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ALLOWED_HEADS = new Set(["git", "node", "npm", "pnpm", "python3", "make", "rg", "ls", "cat"]);

const submitWrite = defineTool({
	name: "submit_write",
	label: "Submit Write",
	description: "Return the final structured result of this writing work unit. Your last action.",
	promptGuidelines: [
		"Call submit_write as your final action once the change is made and committed.",
		"After calling submit_write, do not emit another assistant response.",
	],
	parameters: Type.Object({
		summary: Type.String({ description: "One paragraph on what changed and why" }),
		filesTouched: Type.Array(Type.String(), { description: "Repo-relative paths modified" }),
		commandsRun: Type.Array(Type.String(), { description: "Shell commands actually executed" }),
		contractMet: Type.Boolean({ description: "Whether the acceptance criteria were fully met" }),
	}),
	async execute(_id, params) {
		return {
			content: [{ type: "text", text: `submit_write accepted: ${params.filesTouched.length} file(s)` }],
			details: params,
			terminate: true,
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(submitWrite);

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return undefined;
		const command = String((event.input as { command?: string }).command ?? "");
		const head = command.trim().split(/\s+/)[0]?.replace(/^.*\//, "") ?? "";
		if (!ALLOWED_HEADS.has(head)) {
			return { block: true, reason: `fleet: command '${head}' is not on the accepted-command allowlist` };
		}
		return undefined;
	});
}
