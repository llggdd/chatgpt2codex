import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { DomainError, ErrorCode, makeResult, type ToolContext, type ToolResult } from "../types.js";
import { requireProjectLease } from "../workspace/lease-guard.js";
import { resolveActiveProject } from "../workspace/active.js";
import { captureE2eAppScreenshot, captureE2eScreenshot } from "../e2e/local-e2e.js";
import { redact } from "../policy/secrets.js";
import { assertTargetInstance, instanceIdForContext } from "../instance-target.js";
import { assertAllowedTarget, controlAllowlist, isAppAllowed, isControlChatGptExposed, isControlEnabled } from "./policy.js";
import { assertScreenshotTargetAllowed, maskSensitiveRegions } from "./screenshot-mask.js";
import { executeApprovedAction } from "./executor.js";
import { authorizeControlGrant, consumeControlGrant, readControlGrant, type ControlGrant, type ControlGrantKind } from "./grant.js";
import {
  finishComputerTask,
  getComputerTask,
  linkComputerTaskAction,
  recordComputerObservation,
  startComputerTask,
} from "./task.js";
import * as macInput from "./mac-input.js";
import {
  approveAction,
  enqueue,
  getAction,
  isKilled,
  listActions,
  rejectAction,
  setKill,
  toSummary,
  type ControlActionKind,
  type ControlActionTarget,
  type ResolvedTargetPreview,
} from "./queue.js";

/**
 * Handlers for the 4 Option B desktop-control MCP tools. Registered
 * conditionally by src/server/tools.ts (only when isControlEnabled()), and
 * kept intentionally free of any dependency on src/server/tools.ts /
 * src/server/actions.ts to avoid a module cycle — both of those import
 * *from* here, never the reverse.
 */

interface CallToolResultLike {
  content: ToolResult["content"];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

function redactControlInput(input: unknown): unknown {
  try {
    return JSON.parse(redact(JSON.stringify(input)));
  } catch {
    return undefined;
  }
}

// Success-path structuredContent already goes through toSummary()/redact()
// (e.g. computer_action_status text summary). The error path must too: a
// raw thrown error message (or its `details`) can otherwise reach both the
// permanent ledger `error` field and the untrusted-model-facing tool result
// unredacted — mirrors src/server/tools.ts mapError, which has the
// identical DomainError/non-DomainError branches redact()ed. redactControlInput
// already JSON-round-trips through redact(), so it doubles as the `details`
// redactor here.
function mapControlError(err: unknown): ToolResult<{ error: string; code: string; details?: unknown }> {
  if (err instanceof DomainError) {
    const safeMessage = redact(err.message);
    return makeResult(
      { error: safeMessage, code: err.code, details: redactControlInput(err.details) },
      `Error [${err.code}]: ${safeMessage}`,
      true,
    );
  }
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = redact(rawMessage);
  return makeResult({ error: message, code: ErrorCode.NOT_IMPLEMENTED }, `Error: ${message}`, true);
}

async function withControlErrorMapping<T extends Record<string, unknown>>(
  ctx: ToolContext,
  toolName: string,
  input: unknown,
  fn: () => Promise<ToolResult<T> | CallToolResultLike>,
): Promise<CallToolResultLike> {
  try {
    assertTargetInstance(ctx, toolName, input);
    const result = await fn();
    await ctx.ledger.append({
      type: "tool.call.completed",
      tool: toolName,
      input: redactControlInput(input),
      isError: result.isError === true,
    });
    return { content: result.content, structuredContent: result.structuredContent, ...(result.isError ? { isError: true } : {}) };
  } catch (err) {
    const mapped = mapControlError(err);
    await ctx.ledger.append({
      type: "tool.call.failed",
      tool: toolName,
      input: redactControlInput(input),
      code: mapped.structuredContent.code,
      error: mapped.structuredContent.error,
    });
    return { content: mapped.content, structuredContent: mapped.structuredContent, isError: true };
  }
}

interface ControlAccess {
  projectId: string;
  root: string;
  source: "session-lease" | "local-grant";
  grant?: ControlGrant;
}

/**
 * A local stdio/status-bar session may use its normal control lease. Remote
 * MCP/Actions sessions cannot self-grant that lease, so they may instead
 * consume a short-lived, instance/project/app-scoped grant created locally
 * on the Mac. The grant is never writable through MCP or HTTP.
 */
async function requireControlAccess(
  ctx: ToolContext,
  scope: { appName?: string; kind?: ControlGrantKind } = {},
): Promise<ControlAccess> {
  const active = await resolveActiveProject(ctx);
  let localLeaseError: unknown;
  if (active) {
    try {
      await requireProjectLease(ctx, active.projectId, "control");
      return { projectId: active.projectId, root: active.root, source: "session-lease" };
    } catch (err) {
      localLeaseError = err;
      // A non-control/expired/mismatched session lease does not widen access;
      // continue only if a separately local-issued grant validates below.
    }
  }
  const instanceId = instanceIdForContext(ctx);
  let grant: ControlGrant;
  try {
    grant = await authorizeControlGrant(ctx.stateDir, {
      instanceId,
      appName: scope.appName,
      kind: scope.kind,
    });
  } catch (grantError) {
    if (!ctx.remote) {
      if (localLeaseError) throw localLeaseError;
      throw new DomainError(
        ErrorCode.PROJECT_NOT_SELECTED,
        "Computer Use requires an authorized project. Select one with project_select preset=control, or issue a local Control Grant from the Mac status bar/CLI; call computer_access_status for diagnostics.",
        { nextTool: "computer_access_status", localOnly: true },
      );
    }
    throw grantError;
  }
  let entries = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
  let entry = entries.find((candidate) => candidate.projectId === grant.projectId);
  // A local grant may be issued while the long-lived HTTP process still has
  // an older in-memory registry (for example immediately after discovering a
  // nested project). Reload once before declaring the grant stale.
  if (!entry) {
    const loaded = await ctx.store.loadProjects();
    ctx.registry.splice(0, ctx.registry.length, ...loaded);
    entries = ctx.registry;
    entry = entries.find((candidate) => candidate.projectId === grant.projectId);
  }
  if (!entry) {
    throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Control Grant project not found: ${grant.projectId}`);
  }
  // A remote session can carry a normal read/write lease for one project
  // while the owner-issued desktop grant belongs to another. Do not silently
  // let Computer Use fall back to the grant's project in that case: the chat
  // would edit/inspect one project and drive the desktop under another.
  // Requiring an explicit re-selection or local re-grant makes the boundary
  // visible and prevents a stale grant from surprising the caller.
  if (active && active.projectId !== grant.projectId) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, "The active project does not match the local Computer Use grant", {
      activeProjectId: active.projectId,
      grantProjectId: grant.projectId,
      nextTool: "computer_access_status",
    });
  }
  return { projectId: entry.projectId, root: entry.root, source: "local-grant", grant };
}

export interface ComputerScreenshotInput {
  appName?: string;
  label?: string;
  waitMs?: number;
  targetInstanceId?: string;
}

/**
 * Explain the two independent Computer Use gates without requiring a caller
 * to deliberately trigger a screenshot or input action. This is intentionally
 * read-only and remains visible even when the control surface is disabled so
 * the owner can see exactly which local setting/lease is missing.
 */
export async function handleComputerAccessStatus(ctx: ToolContext): Promise<CallToolResultLike> {
  return withControlErrorMapping(ctx, "computer_access_status", {}, async () => {
    const identity = ctx.identity;
    const instanceId = instanceIdForContext(ctx);
    const allowlist = controlAllowlist();
    const grant = await readControlGrant(ctx.stateDir);
    const grantMatchesInstance = grant?.instanceId === instanceId;
    const controlEnabled = isControlEnabled();

    let active: Awaited<ReturnType<typeof resolveActiveProject>> = null;
    let activeError: string | undefined;
    try {
      active = await resolveActiveProject(ctx);
    } catch (err) {
      activeError = err instanceof Error ? err.message : String(err);
    }

    let entries = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
    if (grant && !entries.some((entry) => entry.projectId === grant.projectId)) {
      const loaded = await ctx.store.loadProjects();
      if (loaded.some((entry) => entry.projectId === grant.projectId)) {
        ctx.registry.splice(0, ctx.registry.length, ...loaded);
        entries = ctx.registry;
      }
    }
    const grantProjectRegistered = Boolean(grant && entries.some((entry) => entry.projectId === grant.projectId));
    const grantMatchesActiveProject = Boolean(!grant || !active || grant.projectId === active.projectId);
    const controlLease = active?.lease?.preset === "control" && Date.now() <= (active.lease.expiresAt ?? 0);
    const usableGrant = Boolean(grant && grantMatchesInstance && grantProjectRegistered && grantMatchesActiveProject);
    const ready = controlEnabled && (controlLease || usableGrant);
    const nextActions: string[] = [];
    if (!controlEnabled) {
      nextActions.push("Enable CHATGPT2CODEX_CONTROL and restart the MCP runtime.");
    }
    if (activeError && !usableGrant) {
      nextActions.push("Refresh the workspace index, then select the intended project again.");
    } else if (!active && !usableGrant) {
      nextActions.push("Call workspace_list_projects, then project_select for the intended project.");
    }
    if (grant && !grantMatchesInstance) {
      nextActions.push("Reissue the Control Grant on this computer; the existing grant belongs to another MCP instance.");
    }
    if (grant && grantMatchesInstance && !grantProjectRegistered) {
      nextActions.push("Refresh the workspace index so the grant's project is registered in this runtime.");
    }
    if (grant && grantMatchesInstance && grantProjectRegistered && !grantMatchesActiveProject) {
      nextActions.push("Select the project named by the local Computer Use Grant, or issue a new grant for the active project.");
    }
    if (!controlLease && !grantMatchesInstance) {
      nextActions.push(
        "For remote Computer Use, issue a local Control Grant from the Mac status bar or `chatgpt2codex control grant on`; a remote caller cannot grant itself control.",
      );
    }
    if (allowlist.length === 0) {
      nextActions.push("Configure at least one non-sensitive app in the Computer Use allowlist.");
    }
    if (nextActions.length === 0) nextActions.push("Computer Use is ready for the configured project and allowlisted apps.");

    const projectOptions = entries.slice(0, 50).map((entry) => ({
      projectId: entry.projectId,
      name: entry.name,
      root: entry.root,
    }));
    const localGrant = grant
      ? {
          grantId: grant.grantId,
          instanceId: grant.instanceId,
          projectId: grant.projectId,
          apps: grant.apps,
          kinds: grant.kinds,
          expiresAt: grant.expiresAt,
          maxActions: grant.maxActions,
          usedActions: grant.usedActions,
          matchesThisInstance: grantMatchesInstance,
          projectRegistered: grantProjectRegistered,
          matchesActiveProject: grantMatchesActiveProject,
        }
      : null;

    return makeResult(
      {
        controlEnabled,
        chatGptExposed: isControlChatGptExposed(),
        instance: {
          instanceId,
          displayName: identity?.displayName,
        },
        workspaceRoot: ctx.workspaceRoot,
        activeProject: active
          ? {
              projectId: active.projectId,
              root: active.root,
              leasePreset: active.lease?.preset ?? null,
              leaseExpiresAt: active.lease?.expiresAt ?? null,
            }
          : null,
        activeProjectError: activeError,
        localGrant,
        allowlist,
        ready,
        projectOptions,
        nextActions,
      },
      ready ? "Computer Use access is ready." : "Computer Use access needs local project/control authorization.",
    );
  });
}

export async function handleComputerScreenshot(ctx: ToolContext, input: ComputerScreenshotInput): Promise<CallToolResultLike> {
  return withControlErrorMapping(ctx, "computer_screenshot", input, async () => {
    const { projectId, root, source, grant } = await requireControlAccess(ctx, {
      appName: input.appName,
      kind: "screenshot",
    });
    // Full-screen capture (no appName) shows whatever is frontmost, so the
    // sensitive-app gate must check the *live* frontmost app in that case —
    // an app-targeted capture is already covered by the appName check below.
    const frontmostApp =
      input.appName === undefined && process.platform === "darwin"
        ? await macInput.resolveFrontmostApp().catch(() => undefined)
        : undefined;
    assertScreenshotTargetAllowed(input.appName, frontmostApp);

    // Screenshot capture must pass the same allowlist gate as synthetic
    // input (click/type/key): the denylist check above only refuses known
    // sensitive apps, it does not require the target to be explicitly
    // opted in. Without this, any non-denylisted, non-allowlisted app
    // (Mail, Messages, a private editor, ...) could be captured even
    // though it could never be clicked/typed into.
    const allowlist = controlAllowlist();
    if (input.appName !== undefined) {
      if (!isAppAllowed(input.appName, allowlist)) {
        throw new DomainError(ErrorCode.SENSITIVE_TARGET_BLOCKED, `App is not on the control allowlist: ${input.appName}`, {
          appName: input.appName,
        });
      }
    } else if (isControlChatGptExposed()) {
      // A full-screen capture (`screencapture -x`) captures every visible
      // window on the display, not just the frontmost one — checking only
      // the live frontmost app's denylist/allowlist status (as an earlier
      // version of this branch did, by allowing capture whenever the
      // frontmost app itself was allowlisted) cannot see a *background*
      // sensitive-app window (e.g. a password manager open behind the
      // frontmost app, or visible on a second display/Space) that would
      // still be captured and returned to ChatGPT. Rather than enumerate
      // every on-screen window's owning process, the ChatGPT-exposed
      // (remotely reachable) mode simply refuses full-screen capture
      // outright and requires an explicit, allowlisted appName instead —
      // captureE2eAppScreenshot only ever captures that single app's own
      // window region, so it cannot leak a background window by
      // construction.
      throw new DomainError(
        ErrorCode.SENSITIVE_TARGET_BLOCKED,
        "Full-screen capture is not available when exposed to ChatGPT (it can show background sensitive windows the allowlist can't see); pass an allowlisted appName to capture a specific window",
        { appName: frontmostApp },
      );
    }

    const result = input.appName
      ? await captureE2eAppScreenshot(root, { appName: input.appName, label: input.label, waitMs: input.waitMs })
      : await captureE2eScreenshot(root, { label: input.label, waitMs: input.waitMs });
    const masked = await maskSensitiveRegions({ pngPath: result.path, appName: input.appName });

    await ctx.ledger.append({
      type: "control.screenshot.captured",
      projectId,
      appName: input.appName ?? "screen",
      masked: masked.masked,
      authorization: source,
      grantId: grant?.grantId,
    });

    const base64 = await fs.readFile(masked.pngPath).then((buf) => buf.toString("base64"));
    return {
      structuredContent: { path: masked.pngPath, bytes: result.bytes, appName: input.appName ?? null },
      content: [
        { type: "text", text: `Captured control screenshot: ${masked.pngPath}` },
        { type: "image", data: base64, mimeType: "image/png" },
      ],
    } satisfies CallToolResultLike;
  });
}

export interface ComputerRequestActionInput {
  appName: string;
  kind: ControlActionKind;
  target: ControlActionTarget;
  text?: string;
  keyCode?: number;
  reason: string;
  taskId?: string;
  targetInstanceId?: string;
}

// Defense in depth for the ChatGPT-exposed immediate-execution branch below:
// the server has no way to verify that a client's Confirm/Deny prompt was a
// distinct, deliberate human tap rather than an "always allow"/auto-approve
// client setting or a prompt-injected loop re-issuing the same request. This
// bounds how many approvedVia:"chatgpt" actions can auto-execute inside a
// rolling window; once the cap is hit, further requests fall back to the
// normal queue+local-approval path below (never hard-fail the request), so a
// runaway burst surfaces to the local operator (via `control status`/the
// status bar) instead of continuing to run unattended. This does not replace
// or weaken any existing gate (sensitive-app denylist, control allowlist,
// kill switch, 2nd live-frontmost re-check) — it only caps how many actions
// can skip the local-approval step in a given window.
const CHATGPT_EXPOSED_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const CHATGPT_EXPOSED_RATE_LIMIT_MAX = 20;

async function isChatGptExposedRateLimited(stateDir: string, now = Date.now()): Promise<boolean> {
  const actions = await listActions(stateDir);
  const recentAutoExecuted = actions.filter(
    (a) =>
      a.approvedVia === "chatgpt" &&
      a.result?.executedAt !== undefined &&
      now - a.result.executedAt < CHATGPT_EXPOSED_RATE_LIMIT_WINDOW_MS,
  );
  return recentAutoExecuted.length >= CHATGPT_EXPOSED_RATE_LIMIT_MAX;
}

export async function handleComputerRequestAction(ctx: ToolContext, input: ComputerRequestActionInput): Promise<CallToolResultLike> {
  const redactedInput = { ...input, text: input.text ? "[redacted]" : undefined };
  return withControlErrorMapping(ctx, "computer_request_action", redactedInput, async () => {
    const access = await requireControlAccess(ctx, { appName: input.appName, kind: input.kind });
    const { projectId } = access;
    if (input.taskId) {
      const task = await getComputerTask(ctx.stateDir, input.taskId);
      if (task.instanceId !== instanceIdForContext(ctx) || task.projectId !== projectId || task.appName !== input.appName) {
        throw new DomainError(ErrorCode.PERMISSION_DENIED, "Computer action does not match its Computer Use task scope");
      }
      if (task.status !== "active") {
        throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Computer Use task is ${task.status}: ${task.taskId}`);
      }
    }

    if (await isKilled(ctx.stateDir)) {
      throw new DomainError(ErrorCode.CONTROL_KILLED, "Control session is killed; grant a new control lease to resume");
    }

    const frontmostApp = process.platform === "darwin" ? await macInput.resolveFrontmostApp().catch(() => undefined) : undefined;
    try {
      assertAllowedTarget({ appName: input.appName, frontmostAppName: frontmostApp, allowlist: controlAllowlist() });
    } catch (err) {
      await ctx.ledger.append({
        type: "control.action.blocked",
        projectId,
        appName: input.appName,
        frontmostApp,
        reason: err instanceof DomainError ? err.code : "blocked",
      });
      throw err;
    }

    // Dry-run preview: resolve the AX target read-only (no activate/click) so
    // the local approver can see role/title/frame/app/window/matchCount
    // before anything executes. Never blocks the request: a resolve failure
    // (e.g. an Electron/Chromium app with an empty AX tree) is surfaced as
    // resolved.found=false rather than an error, so the approver knows to
    // expect an executor-time windowPoint fallback.
    let resolved: ResolvedTargetPreview | undefined;
    if (input.target.ax && process.platform === "darwin") {
      resolved = await macInput.resolveAxElement(input.appName, input.target.ax).catch((err) => ({
        found: false,
        reason: err instanceof Error ? err.message : String(err),
      }));
    }

    if (access.source === "local-grant") {
      const consumed = await consumeControlGrant(ctx.stateDir, {
        instanceId: instanceIdForContext(ctx),
        projectId,
        appName: input.appName,
        kind: input.kind,
      });
      await ctx.ledger.append({
        type: "control.grant.consumed",
        projectId,
        grantId: consumed.grantId,
        usedActions: consumed.usedActions,
        maxActions: consumed.maxActions,
      });
    }

    const record = await enqueue(ctx.stateDir, {
      appName: input.appName,
      kind: input.kind,
      target: input.target,
      text: input.text,
      keyCode: input.keyCode,
      reason: input.reason,
      resolved,
    });
    if (input.taskId) await linkComputerTaskAction(ctx.stateDir, input.taskId, record.actionId);

    await ctx.ledger.append({
      type: "control.action.requested",
      projectId,
      actionId: record.actionId,
      appName: record.appName,
      kind: record.kind,
      target: record.target,
      reason: record.reason,
      resolved: record.resolved,
      computerTaskId: input.taskId,
    });

    if (isControlChatGptExposed() && !(await isChatGptExposedRateLimited(ctx.stateDir))) {
      // Reaching this call at all means the owner's ChatGPT client already
      // showed its Confirm/Deny prompt (driven by this tool's non-read-only
      // annotations) and the owner confirmed on their phone — that is the
      // human approval gate in this mode. Approve and execute immediately
      // through the exact same executor.ts path a local `control approve`
      // would take (kill re-check, darwin preflight, 2nd live-frontmost
      // sensitive-app/allowlist check, before/after evidence, audit), just
      // tagged approvedVia:"chatgpt" for the trail.
      const approved = await approveAction(ctx.stateDir, record.actionId, { approvedVia: "chatgpt" });
      await executeApprovedAction(ctx, approved);
      const done = (await getAction(ctx.stateDir, record.actionId)) ?? approved;
      const summary = toSummary(done);
      const errorSuffix = done.result?.ok === false && done.result.error ? `, error=${done.result.error}` : "";
      return {
        structuredContent: { ...summary },
        content: [
          {
            type: "text",
            text: `Control action ${done.actionId} was confirmed and executed (status=${done.status}${errorSuffix}).`,
          },
        ],
      } satisfies CallToolResultLike;
    }

    if (isControlChatGptExposed()) {
      await ctx.ledger.append({
        type: "control.action.rate_limited",
        projectId,
        actionId: record.actionId,
        appName: record.appName,
      });
    }

    const summary = toSummary(record);
    return {
      structuredContent: { ...summary },
      content: [
        {
          type: "text",
          text: `Control action ${record.actionId} is queued and requires local human approval before it executes (status=${record.status}).`,
        },
      ],
    } satisfies CallToolResultLike;
  });
}

export interface ComputerTaskExecuteInput {
  goal?: string;
  taskId?: string;
  appName?: string;
  maxSteps?: number;
  lastActionId?: string;
  done?: boolean;
  cancel?: boolean;
  outcome?: string;
  targetInstanceId?: string;
}

/**
 * Persistent observe -> act -> observe Computer Use loop. The caller model
 * still chooses each action through computer_request_action; this tool owns
 * scope, step budget, repeated-frame detection, evidence, and completion.
 */
export async function handleComputerTaskExecute(
  ctx: ToolContext,
  input: ComputerTaskExecuteInput,
): Promise<CallToolResultLike> {
  const safeInput = { ...input, goal: input.goal ? "[goal redacted]" : undefined, outcome: input.outcome ? "[outcome redacted]" : undefined };
  return withControlErrorMapping(ctx, "computer_task_execute", safeInput, async () => {
    const instanceId = instanceIdForContext(ctx);
    let task;
    if (input.taskId) {
      task = await getComputerTask(ctx.stateDir, input.taskId);
      if (task.instanceId !== instanceId) {
        throw new DomainError(ErrorCode.TARGET_INSTANCE_MISMATCH, "Computer Use task belongs to another MCP instance");
      }
      if (input.appName && input.appName !== task.appName) {
        throw new DomainError(ErrorCode.PERMISSION_DENIED, "appName does not match the existing Computer Use task");
      }
    } else {
      const goal = input.goal?.trim();
      const appName = input.appName?.trim();
      if (!goal || !appName) {
        throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "A new Computer Use task requires goal and appName");
      }
      const access = await requireControlAccess(ctx, { appName, kind: "screenshot" });
      task = await startComputerTask(ctx.stateDir, {
        instanceId,
        projectId: access.projectId,
        appName,
        goalPreview: redact(goal).slice(0, 2000),
        maxSteps: input.maxSteps,
      });
      await ctx.ledger.append({
        type: "computer.task.started",
        taskId: task.taskId,
        projectId: task.projectId,
        appName: task.appName,
        maxSteps: task.maxSteps,
      });
    }

    const taskAccess = await requireControlAccess(ctx, { appName: task.appName, kind: "screenshot" });
    if (taskAccess.projectId !== task.projectId) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Computer Use task belongs to another active control project");
    }
    if (input.cancel) {
      task = await finishComputerTask(ctx.stateDir, task.taskId, "canceled", redact(input.outcome ?? "canceled by caller"));
      return makeResult({ task, readyForNextAction: false }, `Computer Use task ${task.taskId} canceled.`);
    }
    if (input.done) {
      task = await finishComputerTask(ctx.stateDir, task.taskId, "succeeded", redact(input.outcome ?? "goal completed"));
      await ctx.ledger.append({ type: "computer.task.finished", taskId: task.taskId, projectId: task.projectId, status: task.status });
      return makeResult({ task, readyForNextAction: false }, `Computer Use task ${task.taskId} completed.`);
    }
    if (task.status !== "active") {
      return makeResult({ task, readyForNextAction: false }, `Computer Use task ${task.taskId} is ${task.status}.`);
    }

    const actionId = input.lastActionId ?? task.lastActionId;
    let action = actionId ? await getAction(ctx.stateDir, actionId) : null;
    if (action && action.appName !== task.appName) {
      throw new DomainError(ErrorCode.PERMISSION_DENIED, "Linked control action targets another app");
    }
    if (action && action.status !== "done" && action.status !== "rejected") {
      return makeResult(
        { task, action: toSummary(action), readyForNextAction: false },
        `Control action ${action.actionId} is ${action.status}; wait for approval/execution before observing again.`,
      );
    }

    const captured = await captureE2eAppScreenshot(taskAccess.root, {
      appName: task.appName,
      label: `computer-${task.taskId}-step-${task.step + 1}`,
      waitMs: 250,
    });
    const masked = await maskSensitiveRegions({ pngPath: captured.path, appName: task.appName });
    const png = await fs.readFile(masked.pngPath);
    const screenshotHash = createHash("sha256").update(png).digest("hex").slice(0, 16);
    task = await recordComputerObservation(ctx.stateDir, task.taskId, screenshotHash);
    const stalled = task.repeatedObservationCount >= 2;
    const actionFailed = Boolean(action && (action.status === "rejected" || action.result?.ok === false));
    await ctx.ledger.append({
      type: "computer.task.observed",
      taskId: task.taskId,
      projectId: task.projectId,
      appName: task.appName,
      step: task.step,
      screenshotHash,
      stalled,
      actionId: action?.actionId,
      actionOk: action?.result?.ok,
    });

    return {
      structuredContent: {
        task,
        ...(action ? { action: toSummary(action) } : {}),
        screenshot: { path: masked.pngPath, bytes: captured.bytes, sha16: screenshotHash, masked: masked.masked },
        readyForNextAction: task.status === "active",
        stalled,
        actionFailed,
        nextActions:
          task.status !== "active"
            ? ["The task reached its step limit. Report the blocker or start a new explicitly scoped task."]
            : stalled
              ? ["The screen has not changed across three observations. Do not repeat the same action; inspect the target or report a blocker."]
              : [
                  `Call computer_request_action with taskId=${task.taskId}, appName=${task.appName}, one explicit action, and the narrowest AX target available.`,
                  `After the action finishes, call computer_task_execute with taskId=${task.taskId} to verify the next screen.`,
                  `When the goal is visibly complete, call computer_task_execute with taskId=${task.taskId}, done=true, and a short outcome.`,
                ],
      },
      content: [
        { type: "text", text: `Computer Use task ${task.taskId} observation ${task.step}/${task.maxSteps}${stalled ? " (stalled)" : ""}.` },
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      ],
    } satisfies CallToolResultLike;
  });
}

export interface ComputerActionStatusInput {
  actionId?: string;
  targetInstanceId?: string;
}

export async function handleComputerActionStatus(ctx: ToolContext, input: ComputerActionStatusInput): Promise<CallToolResultLike> {
  return withControlErrorMapping(ctx, "computer_action_status", input, async () => {
    const access = await requireControlAccess(ctx);

    if (input.actionId) {
      const record = await getAction(ctx.stateDir, input.actionId);
      if (!record) {
        throw new DomainError(ErrorCode.NOT_IMPLEMENTED, `Control action not found: ${input.actionId}`);
      }
      if (access.grant && !access.grant.apps.includes(record.appName.trim().toLowerCase())) {
        throw new DomainError(ErrorCode.PERMISSION_DENIED, "Control action is outside the active local grant");
      }
      const summary = toSummary(record);
      return {
        structuredContent: { action: summary },
        content: [{ type: "text", text: `Action ${record.actionId}: ${record.status}` }],
      } satisfies CallToolResultLike;
    }

    const actions = (await listActions(ctx.stateDir))
      .filter((record) => !access.grant || access.grant.apps.includes(record.appName.trim().toLowerCase()))
      .map(toSummary);
    return {
      structuredContent: { actions },
      content: [{ type: "text", text: `${actions.length} control action(s) in the queue.` }],
    } satisfies CallToolResultLike;
  });
}

export interface ComputerKillSwitchInput {
  reason?: string;
  targetInstanceId?: string;
}

export async function handleComputerKillSwitch(ctx: ToolContext, input: ComputerKillSwitchInput): Promise<CallToolResultLike> {
  return withControlErrorMapping(ctx, "computer_kill_switch", input, async () => {
    const { projectId } = await requireControlAccess(ctx);
    await setKill(ctx.stateDir);
    await ctx.ledger.append({ type: "control.kill", projectId, reason: input.reason });
    return {
      structuredContent: { killed: true },
      content: [{ type: "text", text: "Control session killed. All pending actions were rejected." }],
    } satisfies CallToolResultLike;
  });
}

// approveAction/rejectAction/CLI helpers are re-exported from queue.ts by
// src/cli.ts directly; nothing else in this module needs them.
export { approveAction, rejectAction };
