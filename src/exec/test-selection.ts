import { DomainError, ErrorCode } from "../types.js";
import { listCommands } from "./command-runner.js";

export interface VerificationCommand {
  commandId: string;
  display: string;
  riskTier: string;
  reason: string;
}
function commandName(commandId: string): string {
  return commandId.replace(/^(npm|make|flutter):/i, "").toLowerCase();
}

function scoreCommand(name: string, changedFiles: string[]): { score: number; reason: string } {
  const files = changedFiles.map((file) => file.toLowerCase());
  const hasE2e = files.some((file) => /(^|[/\\])(e2e|playwright|cypress)([/\\]|\.|$)/.test(file));
  const hasTest = files.some((file) => /(?:\.test|\.spec)\.[a-z0-9]+$/.test(file));
  const hasTypedSource = files.some((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file));
  const hasBuildConfig = files.some((file) => /(?:tsconfig|vite|webpack|rollup|eslint|prettier|package\.json|lock)/.test(file));
  if (hasE2e && /e2e|playwright|cypress|ui|browser/.test(name)) return { score: 100, reason: "changed E2E/browser surface" };
  if (hasTest && /test|spec|check|verify/.test(name)) return { score: 95, reason: "changed test/spec file" };
  if (hasTypedSource && /type.?check|check|compile|analy[sz]e/.test(name)) return { score: 90, reason: "changed typed source" };
  if (hasBuildConfig && /build|compile|bundle/.test(name)) return { score: 85, reason: "changed build/config file" };
  if (/test|verify|check|type.?check|lint|analy[sz]e/.test(name)) return { score: 70, reason: "standard verification command" };
  if (/build|compile|bundle/.test(name)) return { score: 60, reason: "build verification fallback" };
  return { score: 0, reason: "not a verification command" };
}

/**
 * Select a small, safe verification batch from commands already discovered by
 * command-runner. It never promotes network/destructive scripts into a test
 * plan and never invents an arbitrary shell command.
 */
export async function selectVerificationCommands(
  root: string,
  changedFiles: string[],
  explicitIds?: string[],
  maxCommands = 3,
): Promise<VerificationCommand[]> {
  const commands = await listCommands(root);
  const safe = commands.filter((command) => command.riskTier === "verify");
  const byId = new Map(safe.map((command) => [command.commandId, command]));
  const limit = Math.min(3, Math.max(1, Math.floor(maxCommands)));

  if (explicitIds?.length) {
    const selected: VerificationCommand[] = [];
    for (const id of [...new Set(explicitIds)].slice(0, limit)) {
      const command = byId.get(id);
      if (!command) {
        throw new DomainError(
          ErrorCode.COMMAND_NOT_ALLOWED,
          `Verification command "${id}" is not a discovered safe command`,
          { commandId: id },
        );
      }
      selected.push({ ...command, reason: "explicitly requested" });
    }
    return selected;
  }

  return safe
    .map((command) => {
      const scored = scoreCommand(commandName(command.commandId), changedFiles);
      return { ...command, ...scored };
    })
    .filter((command) => command.score > 0)
    .sort((a, b) => b.score - a.score || a.commandId.localeCompare(b.commandId))
    .slice(0, limit)
    .map(({ commandId, display, riskTier, reason }) => ({ commandId, display, riskTier, reason }));
}
