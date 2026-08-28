# ChatGPT To Codex for Windows

Beginner install:

1. Download `chatgpt2codex-0.2.0-windows-setup.exe` from the official GitHub release:
   <https://github.com/ezBuilder/chatgpt2codex/releases/tag/v0.2.0>
2. Double-click the installer.
3. If Windows SmartScreen appears, choose **More info** -> **Run anyway** only
   when the file came from the official release page.
4. Open **ChatGPT To Codex**.
5. Confirm the tray icon appears near the clock.
6. Open **Settings...**, choose a project folder, enable the ChatGPT web
   connector if needed, then click **Start MCP**.
7. Copy the `/mcp` Connector URL and approve it in ChatGPT with the Owner Token.

Keep the Owner Token private. Treat it like a password.

Portable/source install:

- From a packaged folder, double-click `ChatGPT To Codex.exe`.
- If the exe has not been built yet, run `windows\Build-ChatGPTToCodexExe.ps1`
  once on Windows.
- Fallback launcher: `windows\Start-ChatGPTToCodexTray.cmd`.

The app uses `winget` to install Node.js LTS and `cloudflared` only when they
are missing, then opens a tray controller. Starting MCP is loopback-only by
default. For ChatGPT web, prefer your own stable hostname; use temporary Quick
Tunnel URLs only for short tests because they change after restart.

The tray menu stays deliberately small:

- Start/Stop/Restart MCP.
- Open Settings.
- Quit.

Settings contains the busy stuff: MCP instance name, project folder, ChatGPT web
connector, owned fixed domain, port, launch-at-login, start-on-open, update
checks, language override, connector URL, health links, logs, releases, and the
copyright footer.
GitHub is a direct button, not a text setting.

First prompt to try in ChatGPT:

```text
Use ChatGPT To Codex. Select my project, read the README and package scripts,
run the safest available check, then summarize the result with exact evidence.
```

E2E screenshot prompt:

```text
Use ChatGPT To Codex to run E2E, open the app, capture screenshots, and show them inline.
```

Troubleshooting:

- If SmartScreen appears, verify the installer came from the official GitHub
  release before running it.
- If the connector URL is empty, open Settings, enable ChatGPT web connector,
  click **Start MCP**, then copy the URL again.
- If port 7676 is busy, use **Restart MCP** from the tray menu. The launcher
  cleans up stale runtime processes before restart.
- If a screenshot is blank, keep the browser or app window visible on screen and
  retry the E2E action.
- If ChatGPT asks for approval, paste the Owner Token from the Windows app.
- If more than one computer is connected, give each installation a different
  MCP instance name in Settings. The `/healthz` response and tool results show
  the name and stable instance id, which makes the active computer explicit.
- Before any remote edit, command, E2E, image save, queued task, or Computer Use
  call, invoke `device_identity` and pass that exact `instanceId` as
  `targetInstanceId`; a missing or different id is rejected before execution.
- Remote MCP connections keep their project/lease selection separate. If two
  workflows share one connection, pass an explicit `projectId` in each call.
- Container workspaces are scanned two levels deep by default, so layouts such
  as `codes/100_xxx/projectname` are discoverable. Pass `depth` (up to 5) to
  `workspace_refresh_index` for deeper layouts; traversal stops at project
  markers to avoid dependency/build trees.

The tray UI follows the Windows display language by default and can be changed
in Settings. Supported UI languages: English, Korean, Japanese, Simplified
Chinese, Traditional Chinese, Spanish, French, German, Brazilian Portuguese,
Italian, Dutch, Polish, Russian, Turkish, Vietnamese, Indonesian, Thai, Arabic,
Hindi, and Ukrainian.

For first-time machine setup from a source checkout:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -RepoUrl https://github.com/ezBuilder/chatgpt2codex.git -Launch
```

For source-free users, ship the Windows zip from `npm run windows:package`.
They only need to unzip it and double-click `ChatGPT To Codex.exe`.

Copyright 2026 ezBuilder. All rights reserved.
