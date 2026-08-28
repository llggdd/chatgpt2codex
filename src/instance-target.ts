import { fallbackDeviceIdentity } from "./identity/device.js";
import { DomainError, ErrorCode, type ToolContext } from "./types.js";

/**
 * Tools whose side effects or local-session state must be pinned to one
 * concrete ChatGPT To Codex installation. Keep this list and its validator in
 * one module so MCP schemas, runtime validation, and the Actions OpenAPI
 * document cannot drift apart.
 */
export const TARGET_INSTANCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "goal_intake",
  "goal_loop",
  "workspace_refresh_index",
  "project_select",
  "file_apply_patch",
  "file_create",
  "change_and_verify",
  "command_run",
  "local_shell_run",
  "e2e_start_server",
  "e2e_open_target",
  "e2e_run_command",
  "e2e_test_and_show_screenshot",
  "e2e_screenshot",
  "e2e_open_url_screenshot",
  "git_commit",
  "git_push",
  "checkpoint_restore",
  "save_image",
  "save_image_from_clipboard",
  "save_image_from_download",
  "save_image_from_path",
  "save_chatgpt_image",
  "save_chatgpt_image_from_url",
  "save_image_from_url",
  "open_chatgpt_images_app",
  "task_start",
  "task_execute",
  "task_cancel",
  "computer_screenshot",
  "computer_request_action",
  "computer_task_execute",
  "computer_action_status",
  "computer_kill_switch",
]);

export function isTargetInstanceTool(toolName: string): boolean {
  return TARGET_INSTANCE_TOOL_NAMES.has(toolName);
}

/** Return the immutable identity captured for a remote transport, if present. */
export function instanceIdForContext(ctx: ToolContext): string {
  return ctx.boundInstanceId ?? (ctx.identity ?? fallbackDeviceIdentity()).instanceId;
}

/**
 * Validate the instance selected by a caller before any side effect runs.
 * Local stdio callers may omit the field for backwards compatibility; every
 * remote transport must pin mutations to the identity captured at connect
 * time. The bound ID prevents a later context replacement from retargeting a
 * live remote session.
 */
export function assertTargetInstance(ctx: ToolContext, toolName: string, input: unknown): void {
  if (!isTargetInstanceTool(toolName)) return;
  const requested =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).targetInstanceId
      : undefined;
  const identity = ctx.identity ?? fallbackDeviceIdentity();
  const expected = instanceIdForContext(ctx);
  if (ctx.remote && (requested === undefined || requested === "")) {
    throw new DomainError(
      ErrorCode.TARGET_INSTANCE_REQUIRED,
      `targetInstanceId is required for remote ${toolName}; call device_identity first and target this instance explicitly`,
      { required: true, actual: expected, instanceName: identity.displayName, tool: toolName },
    );
  }
  if (requested === undefined || requested === "") return;
  if (typeof requested !== "string") {
    throw new DomainError(ErrorCode.TARGET_INSTANCE_MISMATCH, "targetInstanceId must be a string");
  }
  if (requested !== expected) {
    throw new DomainError(
      ErrorCode.TARGET_INSTANCE_MISMATCH,
      `This MCP instance is ${expected}; targetInstanceId was ${requested}`,
      { requested, actual: expected, instanceName: identity.displayName, tool: toolName },
    );
  }
}
