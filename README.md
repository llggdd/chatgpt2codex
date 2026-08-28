<p align="center">
  <img src="assets/readme-hero.png" alt="ChatGPT To Codex local coding runtime" width="100%" />
</p>

# ChatGPT To Codex

**Give ChatGPT real local coding hands.**

ChatGPT To Codex is a local MCP and Actions runtime for macOS and Windows that lets ChatGPT
work inside the project folder you choose: read files, search code, apply
patches, run tests, launch E2E checks, and send back screenshot proof.

Your source stays on your machine. ChatGPT connects to the local app you run.
You choose the workspace, approve the token, and keep control of what gets
edited.

[Download v0.2.0](https://github.com/ezBuilder/chatgpt2codex/releases/tag/v0.2.0) ·
[Beginner installation guide](docs/INSTALL.md)

> Help us get this in front of more builders: star the repo if you want
> ChatGPT to stop talking about code and start safely doing the repo loop.

## Why It Exists

ChatGPT is great at reasoning, but web chat alone cannot reliably inspect your
local repo, run your local tests, or prove what the UI actually looked like.
ChatGPT To Codex fills that gap:

- local project selection instead of uploading a source tree
- guarded file reads and hash-checked patching
- allowlisted local commands for tests and checks
- macOS/Windows app, window, and browser screenshot capture for visual E2E proof
- temporary or fixed HTTPS connector URL for ChatGPT web
- OAuth-style owner-token approval so random clients cannot just attach
- multilingual menu bar app for non-English users

The mental model is simple:

```text
ChatGPT thinks. Your computer acts. You review the result.
```

## Current Release

| Platform | Status | Package |
| --- | --- | --- |
| macOS | Public release | `chatgpt2codex-0.2.0.pkg` |
| Windows | Public release | `chatgpt2codex-0.2.0-windows-setup.exe` |
| Linux | Developer path only | Not published |

### Why PKG Instead Of DMG?

For this release, **PKG is the better fit**. A DMG is nicer for drag-and-drop
apps, but this app needs to install a menu bar runtime under Applications,
bundle Node/cloudflared helpers, and run a non-blocking post-install Doctor.
PKG gives beginners a clearer "install and open" path. A signed/notarized DMG
can still be added later for a more consumer-style download.

Current macOS package SHA-256:

```text
317193f796ee0bdeb09dac0164d01b4ff930372116bdc91aeb4378b56cd2df44  chatgpt2codex-0.2.0.pkg
```

## What ChatGPT Can Do With It

Once connected, ChatGPT can operate like a practical coding agent over a trusted
project:

- list local projects and select the active one
- read repo rules before editing
- search code and read exact line slices
- create files and apply patches
- run project commands and tests
- start a dev server and wait for a URL
- open a browser URL or installed desktop app
- capture macOS/Windows E2E screenshots
- return inline screenshot previews through Actions
- save generated image assets into the repo
- summarize diffs, blockers, and verification evidence

The standout workflow is:

```text
Run the E2E test, open the app, capture screenshots, and show me proof.
```

For web apps, ChatGPT To Codex can capture browser regions. For desktop apps
such as Tauri apps, it can open the built app window and capture top/middle/bottom
views. The one-shot `e2e_test_and_show_screenshot` action returns inline
`imageMarkdown` results so you can inspect the screen without digging through
local folders.

For faster coding loops, use `project_bootstrap` to collect project rules,
status, commands, and key files in one read-only call. Use
`change_and_verify` for a hash-guarded patch plus automatic changed-file test
selection. For a single orchestrated job, `task_execute` stores a goal and can
queue it with an explicit guarded command/shell/E2E spec; a goal-only call
returns the next safe planning steps. Lower-level jobs can use
`task_start`. Poll either with `task_status` / `task_result`; reads may run in
parallel while writes are serialized per project. Set
`CHATGPT2CODEX_MAX_CONCURRENT_TASKS=1..8` before starting the runtime to tune
the default concurrency of 2.

On macOS, optional Computer Use can carry a bounded task through an
observe → one explicit action → verify loop. In **Settings...**, enable
**Allow bounded Computer Use from ChatGPT**, enter only the apps the task may
touch, and choose a 1–60 minute lifetime plus a 1–100 action budget. Saving
issues a local, instance-and-project-scoped Control Grant; disabling the
setting, using the kill switch, expiration, or exhausting the budget revokes
it. After configuration, the pending-control submenu shows remaining time and
usage and can reissue or revoke the grant without reopening Settings. Remote
MCP calls cannot create or expand this grant. Password managers,
Terminal, System Settings, banking, and 2FA apps remain blocked even if named.
The runtime exposes `computer_task_execute` for the persistent observation
loop and `computer_request_action` for each individually confirmed action.
If the configured workspace is a container (for example `~/codes`), choose
the actual project folder for **Computer Use project** in Settings; the grant
is intentionally scoped to one registered project. `computer_access_status`
reports the selected project, grant, instance binding, allowlist, and the next
required step when ChatGPT says that a project with permission must be opened.

Workspace discovery searches two directory levels by default, so layouts such
as `codes/100_xxx/projectname` are included. Call `workspace_refresh_index` with
`depth: 3` (up to 5) when a project is deeper; project-marker directories stop
further traversal so dependency/build trees are not scanned.

The equivalent local CLI is:

```bash
CHATGPT2CODEX_CONTROL_ALLOWLIST="Safari,TextEdit" \
  chatgpt2codex control grant on --project-root /path/to/project \
  --apps "Safari,TextEdit" --minutes 10 --max 20
chatgpt2codex control grant status
chatgpt2codex control grant off
```

Verification retries are bounded to at most three and are only enabled for
allowlisted verify-tier commands. Shell, E2E, and write tasks are never replayed
automatically because repeating them could duplicate side effects. `change_and_verify`
returns diagnostics, retry attempts, and a stable repeated-failure fingerprint;
it does not invent a patch when a test fails.

## Install In 5 Minutes

Full beginner guide: [docs/INSTALL.md](docs/INSTALL.md)

macOS short version:

1. Download `chatgpt2codex-0.2.0.pkg` from the [latest release](https://github.com/ezBuilder/chatgpt2codex/releases/tag/v0.2.0).
2. Open the installer.
3. If macOS blocks the unsigned package, Control-click it, choose **Open**, and
   confirm in **System Settings** -> **Privacy & Security** if needed.
4. Open **ChatGPT To Codex** from Applications.
5. Open **Settings...** from the menu bar icon.
6. Choose a project folder.
7. Enable **ChatGPT web connector** if you want ChatGPT in the browser to connect.
8. Click **Start MCP**.
9. Click **Copy Connector URL**.
10. Register that `/mcp` URL in ChatGPT Apps / Connectors and approve with the
    Owner Token shown by the app.

If you connect more than one computer, open **Settings...** on each one and set
an unmistakable **MCP instance name** (for example, `Office Mac` and `Home PC`).
Saving settings restarts the local MCP process when it is running. Each install
also gets a stable `instanceId`; the name and id are returned by `/healthz`, the
Actions health endpoint, the `device_identity` tool, and every tool-call proof.
Call `device_identity` first and pass its exact `instanceId` as
`targetInstanceId` on every remote side-effecting call (project selection,
edits, commands, E2E launches, image saves, task creation/cancel, and desktop
control). New clients should send it explicitly; a bound HTTP/MCP endpoint
also infers its own instance for legacy clients whose cached schema does not
yet expose `device_identity` or `targetInstanceId`. An explicitly supplied
different computer's ID is still rejected before any local state or project
file is touched. Refresh or reconnect the `code-x` registration after an
upgrade so it loads the current tool schema.
Separate remote MCP connections also keep their active project/lease state
separate, so simultaneous tasks do not switch each other's selected project.
After changing a name, refresh or reconnect the ChatGPT app if it has cached
the previous MCP metadata; the connector URL still must point to that machine.
This isolation is per remote MCP connection; workflows sharing one connection
should still pass an explicit `projectId` when they run concurrently.

Windows short version:

1. Download `chatgpt2codex-0.2.0-windows-setup.exe` from the [latest release](https://github.com/ezBuilder/chatgpt2codex/releases/tag/v0.2.0).
2. Double-click the installer.
3. If Windows SmartScreen warns, choose **More info** -> **Run anyway** only if
   the file came from this GitHub release.
4. Launch **ChatGPT To Codex**.
5. Open the tray icon settings, choose your project folder, enable the ChatGPT
   web connector if needed, then click **Start MCP**.
6. Copy the `/mcp` Connector URL and approve it in ChatGPT with the Owner Token.

Set a different **MCP instance name** on every Windows computer before copying
its connector URL. The name is persisted locally and is included with health
checks and tool results, so you can confirm which machine ChatGPT reached.

Keep the Owner Token private. Treat it like a password.

For terminal-only setup, inspect or rename the current installation with:

```bash
chatgpt2codex device
chatgpt2codex device --set-name "Office Mac"
```

## First Prompt To Try

```text
Use ChatGPT To Codex. Select my project, read the README and package scripts,
run the safest available check, then summarize the result with exact evidence.
```

Then try a visual proof flow:

```text
Use ChatGPT To Codex to run the app E2E, capture screenshots, and show the
passing screenshot set inline before you say it is done.
```

## Safety Model

ChatGPT To Codex is designed for trusted local development, not arbitrary public
automation.

- It runs locally on your computer.
- It defaults to loopback-only networking.
- ChatGPT web requires an explicit connector/tunnel mode.
- File operations are scoped to the selected project.
- Patch application uses line/hash context.
- Owner Token approval is required for remote Actions access.
- Secret-looking values are redacted from tool output.
- Destructive, network, and sensitive operations remain approval-gated.

Do not expose the connector URL publicly unless you understand the tunnel and
token model. Do not paste Owner Tokens into issues, screenshots, or shared logs.

## Supported Languages

The desktop app can follow the system language and currently includes UI strings
for English, Korean, Japanese, Simplified Chinese, Traditional Chinese, Spanish,
French, German, Brazilian Portuguese, Italian, Dutch, Polish, Russian, Turkish,
Vietnamese, Indonesian, Thai, Arabic, Hindi, and Ukrainian.

The install guide currently includes Korean, English, Japanese, and Simplified
Chinese. More documentation languages are welcome.

## Windows Status

Windows now has a public beginner installer. It includes the tray launcher,
owner-token setup flow, ChatGPT web connector settings, stale runtime cleanup,
and Windows E2E screenshot proof. See [docs/INSTALL.md](docs/INSTALL.md) and
[windows/README.md](windows/README.md) for the full Windows guide.

## Repository Contents

This public repository is intended to contain only the product source, public
documentation, assets, scripts, and published installer artifacts. Local agent
state, personal automation rules, generated memory, hooks, private MCP config,
build output, and machine-local logs are ignored.

If you see local-only files in a clone, they came from your machine, not from
the public repo.

## Build From Source

For developers:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Build the macOS package:

```bash
npm run macos:package
```

The packaging script creates a `.pkg` under `build/macos/`. Published packages
are copied to `installers/macos/`.

## Star Pitch

If this saves you one "copy this patch, paste it in terminal, now run tests,
now send me a screenshot" loop, give it a star. The goal is simple: make
ChatGPT useful for real local development without turning your project into a
cloud upload.

Built by **ezBuilder**.
