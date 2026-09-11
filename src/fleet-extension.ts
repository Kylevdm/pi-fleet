/**
 * Fleet-shipped Pi extension (ticket 25).
 *
 * Loaded by Pi at runtime via `pi --mode rpc -e <path-to-this-file>`. It
 * provides the per-role terminating `submit_*` tools (TypeBox schemas),
 * the `tool_call` command gate that returns a legible block reason, and
 * `raise_risk`.
 *
 * The driver runs `pi --mode rpc` with a per-stage tool allowlist; this
 * extension supplies the `submit_*` and `raise_risk` tools whose names
 * start with `submit_` so the driver classifies them as seal candidates.
 *
 * The extension is a default-exported function taking Pi's ExtensionAPI,
 * which is the spike's settled shape: a small surface that registers
 * tools and listens for events.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * The four-field payload every submit_* tool returns. The driver uses
 * the same shape for schema validation; the extension is the canonical
 * source so an out-of-band tool with a divergent schema never seals a
 * stage.
 */
const SubmitPayload = Type.Object({
  summary: Type.String({ description: "One paragraph on what changed and why" }),
  filesTouched: Type.Array(Type.String(), { description: "Repo-relative paths modified" }),
  commandsRun: Type.Array(Type.String(), { description: "Shell commands actually executed" }),
  contractMet: Type.Boolean({ description: "Whether the acceptance criteria were fully met" }),
});

const submitWrite = defineTool({
  name: "submit_write",
  label: "Submit Write",
  description: "Return the final structured result of this writing work unit. Your last action.",
  promptGuidelines: [
    "Call submit_write as your final action once the change is made and committed.",
    "After calling submit_write, do not emit another assistant response.",
  ],
  parameters: SubmitPayload,
  async execute(_id, params) {
    return {
      content: [{ type: "text", text: `submit_write accepted: ${params.filesTouched.length} file(s)` }],
      details: params,
      terminate: true,
    };
  },
});

const submitReview = defineTool({
  name: "submit_review",
  label: "Submit Review",
  description: "Return the final structured result of this reviewing work unit. Your last action.",
  promptGuidelines: [
    "Call submit_review as your final action once the review is complete.",
    "After calling submit_review, do not emit another assistant response.",
  ],
  parameters: SubmitPayload,
  async execute(_id, params) {
    return {
      content: [{ type: "text", text: `submit_review accepted: ${params.filesTouched.length} file(s) reviewed` }],
      details: params,
      terminate: true,
    };
  },
});

const submitScout = defineTool({
  name: "submit_scout",
  label: "Submit Scout",
  description: "Return the final structured result of this scouting work unit. Your last action.",
  promptGuidelines: [
    "Call submit_scout as your final action once the investigation is complete.",
    "After calling submit_scout, do not emit another assistant response.",
  ],
  parameters: SubmitPayload,
  async execute(_id, params) {
    return {
      content: [{ type: "text", text: `submit_scout accepted` }],
      details: params,
      terminate: true,
    };
  },
});

const submitPlan = defineTool({
  name: "submit_plan",
  label: "Submit Plan",
  description: "Return the final structured result of this planning work unit. Your last action.",
  promptGuidelines: [
    "Call submit_plan as your final action once the plan is laid out.",
    "After calling submit_plan, do not emit another assistant response.",
  ],
  parameters: SubmitPayload,
  async execute(_id, params) {
    return {
      content: [{ type: "text", text: `submit_plan accepted` }],
      details: params,
      terminate: true,
    };
  },
});

const raiseRisk = defineTool({
  name: "raise_risk",
  label: "Raise Risk",
  description:
    "Escalate the work's risk class when the work turns out riskier than the ticket classified.",
  promptGuidelines: [
    "Call raise_risk as soon as you observe production-touching work the ticket under-classified.",
  ],
  parameters: Type.Object({
    from: Type.String({ description: "The risk class you were assigned (low or medium)" }),
    to: Type.String({ description: "The risk class you believe is correct (medium or high)" }),
    reason: Type.String({ description: "One paragraph explaining the escalation" }),
  }),
  async execute(_id, params) {
    return {
      content: [{ type: "text", text: `raise_risk: ${params.from} -> ${params.to}` }],
      details: params,
    };
  },
});

/**
 * Conservative default allowlist of command heads. Per-repository overlays
 * extend (never shrink) this list. The driver wraps every bash-holding
 * stage with a whole-repository ref snapshot, so the gate is a guardrail,
 * not the invariant.
 */
const DEFAULT_ALLOWED_HEADS: ReadonlySet<string> = new Set([
  "git",
  "node",
  "npm",
  "pnpm",
  "python3",
  "make",
  "rg",
  "ls",
  "cat",
]);

/**
 * Placeholder for the overlay that Fleet reads per-repo at admit time.
 * The real overlay arrives with ticket 35 (command and git gate). The
 * extension consults it via the closed Pi event surface; for the cutover
 * commit it uses the conservative shipped default.
 */
function getAllowedHeads(): ReadonlySet<string> {
  return DEFAULT_ALLOWED_HEADS;
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool(submitWrite);
  pi.registerTool(submitReview);
  pi.registerTool(submitScout);
  pi.registerTool(submitPlan);
  pi.registerTool(raiseRisk);

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return undefined;
    const input = event.input as { command?: string };
    const command = typeof input.command === "string" ? input.command : "";
    const head = command.trim().split(/\s+/)[0]?.replace(/^.*\//, "") ?? "";
    const allowed = getAllowedHeads();
    if (!allowed.has(head)) {
      return {
        block: true,
        reason: `fleet: command '${head}' is not on the accepted-command allowlist`,
      };
    }
    return undefined;
  });
}
