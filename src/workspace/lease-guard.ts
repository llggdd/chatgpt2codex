import { DomainError, ErrorCode, type Lease, type LeasePreset, type ToolContext } from "../types.js";
import { requireLease } from "./project-select.js";

/**
 * Capability ceiling checked against the active project lease's preset.
 * Shared by src/server/tools.ts (file/command/git tools) and
 * src/control/tools.ts (desktop-control tools) so both enforce the same
 * preset -> capability table from a single source of truth.
 */
export type LeaseCapability = "read" | "verify" | "write" | "image" | "remote" | "control";

const ALLOWED_CAPABILITIES: Record<LeasePreset, ReadonlySet<LeaseCapability>> = {
  "read-only": new Set(["read"]),
  "tests-only": new Set(["read", "verify"]),
  "full-write": new Set(["read", "verify", "write", "image", "remote"]),
  "image-only": new Set(["read", "image"]),
  control: new Set(["read", "control"]),
};

function sessionHasLease(session: unknown): boolean {
  if (typeof session !== "object" || session === null) return false;
  const candidate = session as { lease?: unknown; activeLease?: unknown };
  return candidate.lease !== undefined && candidate.lease !== null
    ? true
    : candidate.activeLease !== undefined && candidate.activeLease !== null;
}

function assertLeaseCapability(lease: Lease, projectId: string, capability: LeaseCapability): void {
  if (!ALLOWED_CAPABILITIES[lease.preset].has(capability)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Lease preset ${lease.preset} does not allow ${capability}`, {
      projectId,
      preset: lease.preset,
      capability,
    });
  }
}

/**
 * Require an unexpired lease for `projectId` that permits `capability`.
 * Throws LEASE_REQUIRED (no/expired/mismatched lease) or PERMISSION_DENIED
 * (lease exists but its preset does not grant the requested capability).
 */
export async function requireProjectLease(
  ctx: ToolContext,
  projectId: string,
  capability: LeaseCapability = "read",
): Promise<Lease> {
  const session = await (ctx.sessionStore?.getSession() ?? ctx.store.getSession());
  let lease: Lease;
  try {
    lease = requireLease(session, projectId);
  } catch (error) {
    // A normal MCP session must remain isolated: never borrow another
    // project's lease when this session already has one (even if it is
    // expired). The fallback is only for legacy remote clients whose next
    // request arrived on a fresh, empty connection.
    if (!ctx.remoteLeaseLookup || sessionHasLease(session)) throw error;
    const handoff = await ctx.remoteLeaseLookup(projectId);
    if (!handoff) throw error;
    try {
      lease = requireLease({ lease: handoff }, projectId);
    } catch {
      throw error;
    }
  }
  assertLeaseCapability(lease, projectId, capability);
  return lease;
}
