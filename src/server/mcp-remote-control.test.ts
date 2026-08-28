import { createServer as createNodeServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { storeOwnerToken } from "../auth/owner-token.js";
import type { DeviceIdentity } from "../identity/device.js";
import type { ToolContext } from "../types.js";
import { createHttpServer, defaultHttpServerConfig } from "./http.js";

/**
 * End-to-end proof (real MCP-over-HTTP client, real OAuth token) that
 * src/server/http.ts marks a `/mcp` session `remote: true`
 * (createMcpServer({ ...ctx, remote: true })) and that
 * src/server/tools.ts's project_select handler refuses preset=control for a
 * remote session — i.e. lease arming (and kill-switch resumption, which only
 * a fresh control grant can do) stays local-only (stdio) even once the
 * desktop-control tools are exposed to ChatGPT.
 */

const OWNER_TOKEN = "unit-test-owner-token-mcp-remote";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomPkceVerifier(): string {
  return base64Url(randomBytes(32));
}

function pkceChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

async function getFreePort(): Promise<number> {
  const server = createNodeServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

function makeCtx(
  stateDir: string,
  projectRoot: string,
  additionalProjects: Array<{ projectId: string; name: string; root: string; aliases: string[] }> = [],
): ToolContext {
  const registry = [{ projectId: "proj", name: "proj", root: projectRoot, aliases: [] }, ...additionalProjects];
  let currentSession: unknown = { activeProjectId: null, mode: "observe", lease: null };
  const identity: DeviceIdentity = {
    version: 1,
    instanceId: "inst_remote-test-instance",
    displayName: "Remote Test Instance",
    createdAt: 0,
    updatedAt: 0,
  };
  return {
    workspaceRoot: path.dirname(projectRoot),
    stateDir,
    identity,
    registry,
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => currentSession,
      setSession: async (next) => {
        currentSession = next;
      },
    },
    config: {
      workspaceRoot: path.dirname(projectRoot),
      stateDir,
      maxReadBytes: 10 * 1024 * 1024,
      maxPatchBytes: 10 * 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

async function startApp(ctx: ToolContext): Promise<{ baseUrl: string; stop(): Promise<void> }> {
  const port = await getFreePort();
  const running = createHttpServer(ctx, defaultHttpServerConfig({ host: "127.0.0.1", port, publicUrl: `http://127.0.0.1:${port}` }));
  const server: Server = running.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      running.close();
    },
  };
}

async function registerOAuthClient(baseUrl: string): Promise<{ clientId: string; redirectUri: string }> {
  const redirectUri = "https://chatgpt.com/aip/gpt/oauth/callback";
  const res = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "ChatGPT",
    }),
  });
  const body = (await res.json()) as { client_id?: string };
  return { clientId: String(body.client_id), redirectUri };
}

async function getMcpAccessToken(baseUrl: string): Promise<string> {
  const client = await registerOAuthClient(baseUrl);
  const verifier = randomPkceVerifier();
  const url = new URL("/authorize", baseUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("code_challenge", pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "chatgpt2codex");
  url.searchParams.set("state", "unit-test-state");
  url.searchParams.set("resource", `${baseUrl}/mcp`);

  const pageRes = await fetch(url, { headers: { origin: "https://chatgpt.com" } });
  const page = await pageRes.text();
  const csrfToken = page.match(/name="csrf_token" value="([^"]+)"/u)?.[1];

  const body = new URLSearchParams(url.searchParams);
  body.set("csrf_token", String(csrfToken));
  body.set("owner_token", OWNER_TOKEN);

  const authRes = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    headers: { origin: "https://chatgpt.com", "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
  });
  const redirectUrl = new URL(String(authRes.headers.get("location")));
  const code = String(redirectUrl.searchParams.get("code"));

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    code,
    code_verifier: verifier,
    resource: `${baseUrl}/mcp`,
  });
  const tokenRes = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tokenJson)}`);
  return tokenJson.access_token;
}

async function connectMcpClient(baseUrl: string, accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "unit-test-remote-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("remote MCP session (/mcp, how ChatGPT connects) marks ctx.remote", () => {
  let stateDir: string;
  let projectRoot: string;
  let stop: (() => Promise<void>) | undefined;
  let client: Client | undefined;
  let secondClient: Client | undefined;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-mcp-remote-"));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-mcp-remote-project-"));
    await storeOwnerToken(stateDir, OWNER_TOKEN);
  });

  afterEach(async () => {
    delete process.env.CHATGPT2CODEX_CONTROL_CHATGPT;
    await client?.close().catch(() => undefined);
    await secondClient?.close().catch(() => undefined);
    client = undefined;
    secondClient = undefined;
    await stop?.();
    stop = undefined;
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
  }, 15_000);

  it("requires and validates an explicit instance target before remote mutations", async () => {
    const ctx = makeCtx(stateDir, projectRoot);
    const app = await startApp(ctx);
    stop = app.stop;

    const token = await getMcpAccessToken(app.baseUrl);
    client = await connectMcpClient(app.baseUrl, token);

    const missing = (await client.callTool({
      name: "project_select",
      arguments: { projectId: "proj", reason: "missing instance target", preset: "full-write" },
    })) as { isError?: boolean; structuredContent?: { code?: string; details?: { actual?: string } } };
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent?.code).toBe("TARGET_INSTANCE_REQUIRED");
    expect(missing.structuredContent?.details?.actual).toBe("inst_remote-test-instance");

    const wrong = (await client.callTool({
      name: "project_select",
      arguments: { projectId: "proj", reason: "wrong instance target", preset: "full-write", targetInstanceId: "inst_other-computer-000000" },
    })) as { isError?: boolean; structuredContent?: { code?: string } };
    expect(wrong.isError).toBe(true);
    expect(wrong.structuredContent?.code).toBe("TARGET_INSTANCE_MISMATCH");
  }, 20_000);

  it("rejects project_select preset=control over /mcp, even with the ChatGPT-confirm exposure flag on", async () => {
    process.env.CHATGPT2CODEX_CONTROL_CHATGPT = "1";
    const ctx = makeCtx(stateDir, projectRoot);
    const app = await startApp(ctx);
    stop = app.stop;

    const token = await getMcpAccessToken(app.baseUrl);
    client = await connectMcpClient(app.baseUrl, token);

    const result = (await client.callTool({
      name: "project_select",
      arguments: { projectId: "proj", reason: "remote self-grant attempt", preset: "control", targetInstanceId: "inst_remote-test-instance" },
    })) as { isError?: boolean; structuredContent?: { code?: string } };

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("PERMISSION_DENIED");

    const session = (await ctx.store.getSession()) as { lease?: { preset?: string } | null } | null;
    expect(session?.lease?.preset ?? null).not.toBe("control");
  }, 20_000);

  it("still allows a normal preset (full-write) over the same /mcp session", async () => {
    const ctx = makeCtx(stateDir, projectRoot);
    const app = await startApp(ctx);
    stop = app.stop;

    const token = await getMcpAccessToken(app.baseUrl);
    client = await connectMcpClient(app.baseUrl, token);

    const result = (await client.callTool({
      name: "project_select",
      arguments: { projectId: "proj", reason: "remote normal select", preset: "full-write", targetInstanceId: "inst_remote-test-instance" },
    })) as { isError?: boolean; structuredContent?: { lease?: { preset?: string } } };

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.lease?.preset).toBe("full-write");
  }, 20_000);

  it("keeps active project and lease state isolated across simultaneous MCP clients", async () => {
    const secondProjectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-mcp-remote-second-project-"));
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-mcp-remote-source-"));
    const sourcePath = path.join(sourceDir, "fixture.png");
    await fs.writeFile(sourcePath, PNG_BYTES);

    try {
      const ctx = makeCtx(stateDir, projectRoot, [
        { projectId: "home", name: "home", root: secondProjectRoot, aliases: [] },
      ]);
      const app = await startApp(ctx);
      stop = app.stop;

      const token = await getMcpAccessToken(app.baseUrl);
      client = await connectMcpClient(app.baseUrl, token);
      secondClient = await connectMcpClient(app.baseUrl, token);

      const [officeSelection, homeSelection] = await Promise.all([
        client.callTool({
          name: "project_select",
          arguments: { projectId: "proj", reason: "office task", preset: "full-write", targetInstanceId: "inst_remote-test-instance" },
        }),
        secondClient.callTool({
          name: "project_select",
          arguments: { projectId: "home", reason: "home task", preset: "full-write", targetInstanceId: "inst_remote-test-instance" },
        }),
      ]);
      expect((officeSelection as { structuredContent?: { lease?: { projectId?: string } } }).structuredContent?.lease?.projectId).toBe("proj");
      expect((homeSelection as { structuredContent?: { lease?: { projectId?: string } } }).structuredContent?.lease?.projectId).toBe("home");

      const [officeSave, homeSave] = await Promise.all([
        client.callTool({
          name: "save_chatgpt_image",
          arguments: { source: "path", sourcePath, destPath: ".chatgpt2codex/images/office.png", targetInstanceId: "inst_remote-test-instance" },
        }),
        secondClient.callTool({
          name: "save_chatgpt_image",
          arguments: { source: "path", sourcePath, destPath: ".chatgpt2codex/images/home.png", targetInstanceId: "inst_remote-test-instance" },
        }),
      ]);
      expect((officeSave as { structuredContent?: { project?: string } }).structuredContent?.project).toBe("proj");
      expect((homeSave as { structuredContent?: { project?: string } }).structuredContent?.project).toBe("home");
      await expect(fs.readFile(path.join(projectRoot, ".chatgpt2codex/images/office.png"))).resolves.toEqual(PNG_BYTES);
      await expect(fs.readFile(path.join(secondProjectRoot, ".chatgpt2codex/images/home.png"))).resolves.toEqual(PNG_BYTES);
    } finally {
      await fs.rm(secondProjectRoot, { recursive: true, force: true });
      await fs.rm(sourceDir, { recursive: true, force: true });
    }
  }, 30_000);
});
