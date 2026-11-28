/**
 * Plan 006: capability discovery that reflects the runtime, not a label.
 *
 * A declared capability is only `available` when the enforced role policy
 * and the machine agree: a writer needs a writable role and a mounted
 * workspace, shell work needs a shell-capable role and an allowlisted binary,
 * browser QA needs Chromium. Everything the runtime does not bind is
 * `unknown` — never silently promoted to `available`.
 */
import { CAPABILITY, type AgentDefinition } from "@/types";
import { capabilitiesOf, normalizeCapability } from "@/utils/agentCapabilities";
import { canWriteAny, permissionsForAgent } from "@/utils/rolePolicy";

export type CapabilityAvailability = "available" | "unavailable" | "unknown";

/** What the worker machine actually offers, probed once per run. */
export interface CapabilityProbe {
  workspaceMounted: boolean;
  shell: CapabilityAvailability;
  browser: CapabilityAvailability;
  nativeRuntime: CapabilityAvailability;
  webReach: CapabilityAvailability;
}

export interface CapabilityState {
  capability: string;
  status: CapabilityAvailability;
  reason: string;
}

const WRITE_CAPABILITIES = new Set<string>([
  CAPABILITY.FRONTEND,
  CAPABILITY.BACKEND,
  CAPABILITY.DEVOPS,
]);

const SHELL_CAPABILITIES = new Set<string>([
  CAPABILITY.SHELL_EXECUTION,
  "test-run",
  "build-verify",
]);

const READ_CAPABILITIES = new Set<string>([
  CAPABILITY.RESEARCH,
  CAPABILITY.SECURITY,
  CAPABILITY.CODE_REVIEW,
  CAPABILITY.ARCHITECTURE,
  CAPABILITY.PROJECT_CONTEXT,
  CAPABILITY.DOCUMENTATION,
  // A design spec is read-only work; it never needs write permission.
  CAPABILITY.DESIGN,
]);

const BROWSER_REASON: Record<CapabilityAvailability, string> = {
  available: "Chromium is installed",
  unavailable: "Chromium is not installed",
  unknown: "the browser probe has not run",
};

const SHELL_REASON: Record<CapabilityAvailability, string> = {
  available: "an allowlisted shell binary is available",
  unavailable: "no allowlisted shell binary is available",
  unknown: "the shell probe has not run",
};

export function discoverCapability(
  capability: string,
  agent: AgentDefinition,
  probe: CapabilityProbe
): CapabilityState {
  const normalized = normalizeCapability(capability);
  const permissions = permissionsForAgent(agent);

  if (WRITE_CAPABILITIES.has(normalized)) {
    if (!canWriteAny(permissions)) {
      return { capability: normalized, status: "unavailable", reason: "the role may not write files" };
    }
    if (!probe.workspaceMounted) {
      return { capability: normalized, status: "unavailable", reason: "no workspace is mounted on the worker" };
    }
    return { capability: normalized, status: "available", reason: "role may write and a workspace is mounted" };
  }

  if (SHELL_CAPABILITIES.has(normalized)) {
    if (permissions.shell === "none") {
      return { capability: normalized, status: "unavailable", reason: "the role may not run commands" };
    }
    if (normalized === CAPABILITY.SHELL_EXECUTION && permissions.shell !== "allowlist") {
      return { capability: normalized, status: "unavailable", reason: "the role may only run verification commands" };
    }
    return { capability: normalized, status: probe.shell, reason: SHELL_REASON[probe.shell] };
  }

  if (normalized === CAPABILITY.BROWSER_TESTING) {
    return { capability: normalized, status: probe.browser, reason: BROWSER_REASON[probe.browser] };
  }

  if (normalized === CAPABILITY.WEB_BROWSING) {
    const hasTool = permissions.web || (agent.supportedTools ?? []).includes("web_reach");
    if (!hasTool) {
      return { capability: normalized, status: "unavailable", reason: "no web tool is enabled for this agent" };
    }
    return { capability: normalized, status: probe.webReach, reason: "web tool availability" };
  }

  if (READ_CAPABILITIES.has(normalized)) {
    return probe.workspaceMounted
      ? { capability: normalized, status: "available", reason: "read-only work with a mounted workspace" }
      : { capability: normalized, status: "unavailable", reason: "no workspace is mounted on the worker" };
  }

  return { capability: normalized, status: "unknown", reason: "no runtime binding for this capability" };
}

/** Every capability the agent declares or holds, plus the task's required ones. */
export function discoverCapabilities(
  agent: AgentDefinition,
  probe: CapabilityProbe,
  required: readonly string[] = []
): CapabilityState[] {
  const all = new Set<string>([...capabilitiesOf(agent), ...required]);
  return [...all].map((capability) => discoverCapability(capability, agent, probe));
}

/** Worst status of a report: a required capability that is unavailable blocks the work. */
export function reportOutcome(states: readonly CapabilityState[]): CapabilityAvailability {
  if (states.some((state) => state.status === "unavailable")) return "unavailable";
  if (states.some((state) => state.status === "unknown")) return "unknown";
  return "available";
}
