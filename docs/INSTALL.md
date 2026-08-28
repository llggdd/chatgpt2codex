# ChatGPT To Codex Installation Guide

Current release: [v0.2.0](https://github.com/ezBuilder/chatgpt2codex/releases/tag/v0.2.0)

Download:

- macOS: `chatgpt2codex-0.2.0.pkg`
- Windows: `chatgpt2codex-0.2.0-windows-setup.exe`

Only download installers from the official GitHub release page. Keep the Owner
Token private; treat it like a password.

## Korean

### 이 앱은 무엇인가요?

ChatGPT To Codex는 내 Mac 또는 Windows PC에서 실행되는 로컬 코딩 연결 앱입니다. ChatGPT가 내 전체 컴퓨터를 가져가는 것이 아니라, 내가 선택한 프로젝트 폴더 안에서만 파일 읽기, 코드 수정, 테스트 실행, E2E 스크린샷 캡처 같은 작업을 하게 해줍니다.

### PKG가 DMG보다 나은가요?

이번 릴리스는 PKG가 낫습니다. DMG는 드래그 앤 드롭 앱에는 예쁘지만, 이 앱은 Applications에 메뉴 막대 앱을 설치하고, 번들 런타임을 넣고, 설치 후 Doctor 점검을 돌리는 흐름이 필요합니다. 초보자에게는 PKG가 더 덜 헷갈립니다.

### macOS 설치

1. 릴리스 페이지에서 `chatgpt2codex-0.2.0.pkg`를 다운로드합니다.
2. Finder에서 `.pkg` 파일을 엽니다.
3. macOS가 "확인할 수 없는 개발자" 또는 "악성 소프트웨어를 확인할 수 없음"이라고 막으면:
   - 파일을 Control-클릭 또는 오른쪽 클릭합니다.
   - **열기**를 누릅니다.
   - 그래도 막히면 **시스템 설정** -> **개인정보 보호 및 보안**에서 **그래도 열기**를 누릅니다.
4. 설치가 끝나면 **응용 프로그램**에서 **ChatGPT To Codex**를 실행합니다.
5. 화면 위 메뉴 막대에 아이콘이 보이면 실행된 것입니다.

### Windows 설치

1. 릴리스 페이지에서 `chatgpt2codex-0.2.0-windows-setup.exe`를 다운로드합니다.
2. 파일을 더블클릭합니다.
3. Windows SmartScreen이 경고하면 **추가 정보** -> **실행**을 누릅니다. 단, 반드시 이 GitHub 릴리스에서 받은 파일일 때만 진행하세요.
4. 설치가 끝나면 **ChatGPT To Codex**를 실행합니다.
5. 오른쪽 아래 시스템 트레이에 아이콘이 보이면 실행된 것입니다.
6. 설치 중 Node.js LTS 또는 cloudflared가 없으면 앱이 설치를 안내할 수 있습니다.

### 첫 설정

1. macOS는 메뉴 막대 아이콘, Windows는 시스템 트레이 아이콘을 누릅니다.
2. **Settings...**를 엽니다.
3. **Project folder**에서 ChatGPT가 도와줄 프로젝트 폴더를 고릅니다.
4. 여러 컴퓨터를 연결한다면 **MCP instance name**에 `Office Mac`, `Home PC`처럼 서로 다른 이름을 입력합니다.
5. ChatGPT 웹에서 연결하려면 **ChatGPT web connector**를 켭니다.
6. 고정 도메인이 없다면 도메인 칸은 비워둡니다. 그러면 임시 `trycloudflare.com` 주소가 만들어질 수 있습니다.
7. **Start MCP**를 누릅니다. 이름을 바꾼 경우 실행 중인 MCP가 자동으로 재시작됩니다.
8. 상태가 켜질 때까지 기다립니다.
9. **Copy Connector URL**을 누릅니다. 주소는 `/mcp`로 끝나야 합니다.
10. ChatGPT의 Apps, Apps & Connectors, 또는 Connectors 설정에서 새 앱/커넥터를 만듭니다.
11. 복사한 `/mcp` 주소를 붙여넣습니다.
12. 승인 화면이 나오면 ChatGPT To Codex 앱에서 Owner Token을 복사해 입력합니다.

### E2E 스크린샷 사용

ChatGPT에 이렇게 말할 수 있습니다.

```text
ChatGPT To Codex로 앱을 실행하고 E2E 테스트를 돌린 뒤 스크린샷을 캡처해서 보여줘.
```

macOS 권한이 필요할 수 있습니다.

- **Screen Recording**: 화면 캡처용
- **Accessibility**: 특정 앱 창 위치를 잡고 캡처할 때 필요

막히면 **System Settings** -> **Privacy & Security**에서 ChatGPT To Codex 권한을 켜고 다시 실행하세요.

Windows에서는 브라우저 또는 앱 창 캡처 권한 경고가 뜨면 허용하세요. 캡처가 비어 있으면 앱을 관리자 권한 없이 일반 실행으로 다시 켜고, 캡처 대상 창이 실제 화면에 보이는지 확인하세요.

### 주의

- Owner Token은 비밀번호처럼 다루세요.
- 임시 `trycloudflare.com` 주소는 앱이나 터널을 재시작하면 바뀔 수 있습니다.
- 이름을 바꾼 뒤 ChatGPT에 예전 이름이 남아 있으면 커넥터를 새로고침하거나 다시 연결하고, URL이 원하는 컴퓨터의 도메인인지 확인하세요.
- 동시 작업 분리는 원격 MCP 연결별로 적용됩니다. 같은 연결에서 여러 프로젝트를 동시에 다룰 때는 각 호출에 `projectId`를 명시하세요.
- 여러 작업을 동시에 실행하려면 `task_start`를 호출하고 `task_status`/`task_result`로 확인하세요. 목표 설명까지 함께 보존하는 단일 진입점이 필요하면 `task_execute`를 사용하세요. 목표만 보내면 안전한 다음 단계가 반환되고, 목표와 명시적인 command/shell/E2E 실행 명세를 함께 보내면 바로 큐에 들어갑니다. 읽기 작업은 같은 프로젝트에서 병렬 실행할 수 있고, 쓰기 작업은 프로젝트별로 자동 직렬화됩니다. 기본 최대 동시 실행 수는 2개이며 `CHATGPT2CODEX_MAX_CONCURRENT_TASKS=1..8`로 조정할 수 있습니다.
- 반복 탐색을 줄이려면 `project_bootstrap`을 먼저 호출하고, 패치와 변경 파일 기반 검증을 한 번에 처리하려면 `change_and_verify`를 사용하세요. 이 도구들은 패치 전 lease와 해시 조건을 그대로 검사합니다. `maxRetries`는 최대 3회까지이며 allowlist verify 명령에만 적용되고, shell/E2E/쓰기 작업은 부작용 중복을 막기 위해 자동 재실행하지 않습니다.
- Windows SmartScreen 경고는 아직 널리 알려지지 않은 새 설치파일에서 보일 수 있습니다. 공식 릴리스 파일인지 확인한 뒤 진행하세요.

### Cloudflare 터널 끄기 및 로컬 모드로 전환

로컬 모드에서는 Cloudflare가 필요하지 않습니다. 앱에서 **ChatGPT web connector**를 끄고 **Stop MCP** 또는 **Restart MCP**를 누르면 MCP 주소가 `http://127.0.0.1:7979/mcp`로 돌아갑니다. 터미널에서 `start-chatgpt.sh`를 직접 실행했다면 `Ctrl+C`로 종료하면 앱이 시작한 터널도 함께 종료됩니다.

이전에 `cloudflared service install`을 실행해 시스템 서비스까지 등록했다면, 앱을 먼저 종료한 뒤 macOS 터미널에서 다음을 실행합니다.

```bash
sudo cloudflared service uninstall
sudo launchctl bootout system/com.cloudflare.cloudflared 2>/dev/null || true
pgrep -af cloudflared || true
```

`pgrep`에 남은 프로세스가 있으면 해당 PID가 이 앱의 터널인지 확인한 뒤 종료합니다. 이 명령은 이 컴퓨터의 시스템 서비스 등록만 제거하며 Cloudflare 대시보드의 Tunnel을 삭제하지는 않습니다. 다른 Cloudflare 터널을 같은 컴퓨터에서 사용 중이면 PID를 확인하지 않고 전체 `cloudflared`를 종료하지 마세요.

Windows에서 서비스를 등록했다면 관리자 PowerShell에서 `cloudflared service uninstall`을 실행한 뒤 트레이 앱을 종료합니다. 다른 터널이 있으면 모든 `cloudflared` 프로세스를 일괄 종료하지 말고 해당 PID만 확인해 종료하세요.

다시 공개 연결을 만들 때는 컴퓨터마다 서로 다른 Named Tunnel과 Cloudflare Tunnel credentials/token을 사용하세요. **Owner Token은 Cloudflare credentials가 아닙니다.** 새 터널의 토큰은 `PUBLIC_HOSTNAME`과 함께 앱에 전달합니다.

```bash
export PUBLIC_HOSTNAME=mcp2.example.com
export CLOUDFLARED_TUNNEL_TOKEN='새 Named Tunnel의 Cloudflare 토큰'
export CHATGPT2CODEX_EXPOSE_WEB=1
./start-chatgpt.sh
```

앱이 관리하는 터널과 launchd 시스템 서비스를 동시에 실행하지 마세요. 확인할 때는 각 컴퓨터의 `/healthz`에서 `instanceId`와 `serverName`이 서로 다른지 확인합니다.

## English

### What is it?

ChatGPT To Codex is a local macOS and Windows app that lets ChatGPT work inside a project folder you choose. It can read files, apply patches, run checks, launch E2E flows, and send screenshot proof back to the chat.

### Why PKG instead of DMG?

PKG is better for this release. A DMG is great for drag-and-drop apps, but this app installs a menu bar runtime into Applications, bundles helper binaries, and runs a post-install Doctor. PKG gives beginners the clearest install path.

### Install on macOS

1. Download `chatgpt2codex-0.2.0.pkg` from the release page.
2. Open the package in Finder.
3. If macOS blocks it because it is unsigned, Control-click the file, choose **Open**, then confirm. If needed, open **System Settings** -> **Privacy & Security** -> **Open Anyway**.
4. Open **ChatGPT To Codex** from **Applications**.
5. Click the menu bar icon to confirm it is running.

### Install on Windows

1. Download `chatgpt2codex-0.2.0-windows-setup.exe` from the release page.
2. Double-click the installer.
3. If Windows SmartScreen appears, choose **More info** -> **Run anyway** only if the file came from this GitHub release.
4. Open **ChatGPT To Codex**.
5. Confirm the tray icon appears near the clock.
6. If Node.js LTS or cloudflared is missing, follow the app's setup prompt.

### First setup

1. Open **Settings...** from the macOS menu bar icon or Windows tray icon.
2. Choose your **Project folder**.
3. Enable **ChatGPT web connector** if ChatGPT in the browser needs to reach this computer.
4. Click **Start MCP**.
5. Click **Copy Connector URL**. It should end with `/mcp`.
6. Add that URL in ChatGPT under Apps, Apps & Connectors, or Connectors.
7. Approve the connection with the Owner Token from the app.

If you use more than one computer, set a unique **MCP instance name** in
**Settings...** on each computer (for example, `Office Mac` and `Home PC`).
Saving settings restarts a running MCP process so the new identity is active.
The runtime also creates a stable `instanceId` automatically. Both values are
visible in `/healthz`, the Actions health endpoint, the `device_identity` tool,
and tool-call proofs.
Remote MCP connections keep their active project and lease state isolated, so
multiple simultaneous ChatGPT tasks can select different projects safely.
If ChatGPT keeps showing the old metadata after a rename, refresh or reconnect
that app registration and verify the connector URL points to the intended host.
Isolation is per remote MCP connection; concurrent workflows sharing one
connection should pass an explicit `projectId`.

For faster workflows, call `project_bootstrap` once to collect rules, status,
commands, and key files. Use `change_and_verify` to apply a hash-guarded patch,
create a checkpoint, and run up to three safe tests selected from the changed
files. Use `task_execute` when a goal should travel with an explicit guarded
command/shell/E2E execution spec (a goal-only call returns a safe plan), or
`task_start` for a lower-level job. Poll
with `task_status` / `task_result`; read jobs may share a project while writes
are serialized per project. The default concurrency is 2; set
`CHATGPT2CODEX_MAX_CONCURRENT_TASKS=1..8` before starting the runtime to tune it.

### E2E screenshots

Try:

```text
Use ChatGPT To Codex to run E2E, open the app, capture screenshots, and show them inline.
```

macOS may ask for Screen Recording and Accessibility permissions. Enable them in **System Settings** -> **Privacy & Security**.

On Windows, allow the browser or app window to be visible while capturing. If a screenshot is blank, restart ChatGPT To Codex normally, keep the target window on screen, and retry.

### Notes

- Keep the Owner Token private.
- Temporary `trycloudflare.com` URLs can change after restart.
- Windows SmartScreen can warn on new unsigned installers. Continue only when the file came from the official GitHub release.

### Turn off Cloudflare and return to local mode

Cloudflare is not needed for local-only use. In the app, turn off **ChatGPT web connector** and click **Stop MCP** or **Restart MCP**; the connector returns to `http://127.0.0.1:7979/mcp`. If you started `start-chatgpt.sh` in a terminal, press `Ctrl+C` to stop the app-managed tunnel as well.

If you previously ran `cloudflared service install`, quit the app first and remove the macOS system service:

```bash
sudo cloudflared service uninstall
sudo launchctl bootout system/com.cloudflare.cloudflared 2>/dev/null || true
pgrep -af cloudflared || true
```

If `pgrep` still shows a process, verify its PID belongs to this app before stopping it. This removes only the local service registration; it does not delete the Tunnel from the Cloudflare dashboard. Do not stop every `cloudflared` process blindly if this computer hosts another tunnel.

On Windows, run `cloudflared service uninstall` from an elevated PowerShell, then quit the tray app. If another tunnel is in use, stop only the verified process for this app.

When enabling public access again, use a different Named Tunnel and Cloudflare Tunnel credentials/token for each computer. The **Owner Token is not a Cloudflare credential**.

```bash
export PUBLIC_HOSTNAME=mcp2.example.com
export CLOUDFLARED_TUNNEL_TOKEN='token for the new Named Tunnel'
export CHATGPT2CODEX_EXPOSE_WEB=1
./start-chatgpt.sh
```

Run either the app-managed tunnel or the launchd system service, never both. Verify that each computer's `/healthz` reports a different `instanceId` and `serverName`.

## Japanese

### 概要

ChatGPT To Codex は、Mac または Windows PC 上で動くローカル開発接続アプリです。選択したプロジェクトフォルダ内で、ChatGPT がファイル確認、パッチ適用、テスト実行、E2E スクリーンショット取得を行えるようにします。

### なぜ DMG ではなく PKG ですか?

今回のリリースでは PKG の方が適しています。メニューバーアプリを Applications に入れ、補助ランタイムを同梱し、インストール後の Doctor チェックを実行するため、初心者には PKG の方がわかりやすいです。

### macOS インストール

1. リリースページから `chatgpt2codex-0.2.0.pkg` をダウンロードします。
2. Finder で `.pkg` を開きます。
3. macOS にブロックされた場合は、ファイルを Control-クリックして **Open** を選びます。必要なら **System Settings** -> **Privacy & Security** -> **Open Anyway** を選びます。
4. **Applications** から **ChatGPT To Codex** を起動します。
5. メニューバーアイコンが表示されれば起動完了です。

### Windows インストール

1. リリースページから `chatgpt2codex-0.2.0-windows-setup.exe` をダウンロードします。
2. インストーラをダブルクリックします。
3. Windows SmartScreen が表示された場合は、公式 GitHub リリースから取得したファイルであることを確認してから **More info** -> **Run anyway** を選びます。
4. **ChatGPT To Codex** を起動します。
5. 時計の近くにトレイアイコンが表示されれば起動完了です。

### 初期設定

1. macOS はメニューバーアイコン、Windows はトレイアイコンから **Settings...** を開きます。
2. **Project folder** を選びます。
3. ブラウザ版 ChatGPT と接続する場合は **ChatGPT web connector** を有効にします。
4. **Start MCP** を押します。
5. **Copy Connector URL** で `/mcp` で終わる URL をコピーします。
6. ChatGPT の Apps / Connectors 設定に登録します。
7. 承認画面ではアプリの Owner Token を入力します。

### E2E スクリーンショット

```text
ChatGPT To Codex で E2E を実行し、アプリを開いてスクリーンショットを表示して。
```

Screen Recording と Accessibility 権限が必要になる場合があります。

### 注意

- Owner Token は公開しないでください。
- 一時的な `trycloudflare.com` URL は再起動後に変わることがあります。
- Windows SmartScreen が表示される場合があります。公式リリースから取得したファイルだけ実行してください。

## Simplified Chinese

### 简介

ChatGPT To Codex 是一个在 Mac 或 Windows PC 本机运行的开发连接应用。它只连接你选择的项目文件夹，让 ChatGPT 可以读取文件、应用补丁、运行检查、执行 E2E，并把截图证据发回聊天。

### 为什么用 PKG 而不是 DMG?

当前版本更适合使用 PKG。DMG 适合拖拽式应用，但这个应用需要安装菜单栏运行时、打包辅助二进制文件，并在安装后运行 Doctor 检查。PKG 对初学者更清楚。

### macOS 安装

1. 从发布页面下载 `chatgpt2codex-0.2.0.pkg`。
2. 在 Finder 中打开 `.pkg` 文件。
3. 如果 macOS 因未签名而阻止安装，请 Control-点击文件，选择 **Open**。必要时到 **System Settings** -> **Privacy & Security** -> **Open Anyway**。
4. 从 **Applications** 打开 **ChatGPT To Codex**。
5. 看到菜单栏图标即表示已启动。

### Windows 安装

1. 从发布页面下载 `chatgpt2codex-0.2.0-windows-setup.exe`。
2. 双击安装程序。
3. 如果 Windows SmartScreen 出现警告，请确认文件来自官方 GitHub Release，然后选择 **More info** -> **Run anyway**。
4. 打开 **ChatGPT To Codex**。
5. 看到系统托盘图标即表示已启动。

### 首次设置

1. macOS 点击菜单栏图标，Windows 点击系统托盘图标，然后打开 **Settings...**。
2. 选择 **Project folder**。
3. 如果要让网页版 ChatGPT 连接这台电脑，请启用 **ChatGPT web connector**。
4. 点击 **Start MCP**。
5. 点击 **Copy Connector URL**，确认地址以 `/mcp` 结尾。
6. 在 ChatGPT 的 Apps 或 Connectors 设置里添加该地址。
7. 授权时输入应用里的 Owner Token。

### E2E 截图

可以这样要求 ChatGPT:

```text
Use ChatGPT To Codex to run E2E, open the app, capture screenshots, and show them inline.
```

macOS 可能需要 Screen Recording 和 Accessibility 权限。

### 注意

- 请不要公开 Owner Token。
- 临时 `trycloudflare.com` 地址重启后可能变化。
- Windows SmartScreen 可能会提示新安装包风险。只运行来自官方 GitHub Release 的文件。
