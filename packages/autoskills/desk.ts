import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import {
  detectAgents,
  detectTechnologies,
  collectSkills,
  getInstalledSkillNames,
  parseSkillPath,
} from "./lib.ts";
import {
  readSkillDetail,
  readSkillFile,
  removeInstalledSkills,
  scanInstalledSkills,
} from "./inventory.ts";
import type { InventoryOptions } from "./inventory.ts";
import { installSkill, securityCheckForSkillPath } from "./installer.ts";
import type { InstallSecurityCheck } from "./installer.ts";
import { dim, green, log, yellow } from "./colors.ts";

const DEFAULT_PORT = 4317;

function resolveDeskPort(port?: number): number {
  if (port) return port;
  const fromEnv = Number(process.env.PORT || DEFAULT_PORT);
  return fromEnv > 0 ? fromEnv : DEFAULT_PORT;
}
const MAX_BODY_BYTES = 1_000_000;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

export interface DeskOptions {
  projectDir: string;
  homeDir?: string;
  port?: number;
  open?: boolean;
  studioDir?: string;
}

function inventoryOpts(opts: DeskOptions): InventoryOptions {
  return { projectDir: opts.projectDir, homeDir: opts.homeDir };
}

export function resolveStudioDir(
  fromDir: string = dirname(fileURLToPath(import.meta.url)),
): string {
  const candidates = [join(fromDir, "studio"), join(fromDir, "..", "studio")];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  throw new Error("studio assets not found");
}

function isLocalHost(hostHeader: string | undefined): boolean {
  const host = (hostHeader || "").split(":")[0].toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

function text(
  res: ServerResponse,
  status: number,
  body: string,
  type = "text/plain; charset=utf-8",
): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function snapshot(opts: DeskOptions) {
  const projectDir = resolve(opts.projectDir);
  const inventory = scanInstalledSkills(inventoryOpts(opts));
  const { detected, isFrontend, combos } = detectTechnologies(projectDir);
  const installedNames = getInstalledSkillNames(projectDir);
  const recommended = collectSkills({ detected, isFrontend, combos, installedNames }).map(
    (entry) => {
      const { skillName } = parseSkillPath(entry.skill);
      const security = securityCheckForSkillPath(entry.skill);
      return {
        skill: entry.skill,
        name: skillName || entry.skill,
        sources: entry.sources,
        installed: entry.installed,
        security: security
          ? { status: security.status, summary: security.summary, findings: security.findings }
          : null,
      };
    },
  );

  return {
    projectDir: inventory.projectDir,
    homeDir: inventory.homeDir,
    agents: detectAgents(inventory.homeDir),
    drawers: inventory.drawers,
    installed: inventory.skills,
    recommended,
    detected: detected.map((tech) => tech.name),
    combos: combos.map((combo) => combo.name),
    isFrontend,
  };
}

function serveStatic(studioDir: string, urlPath: string, res: ServerResponse): void {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const abs = resolve(studioDir, rel);
  if (relative(studioDir, abs).startsWith("..") || !existsSync(abs)) {
    text(res, 404, "not found");
    return;
  }
  try {
    if (!statSync(abs).isFile()) {
      text(res, 404, "not found");
      return;
    }
  } catch {
    text(res, 404, "not found");
    return;
  }
  const type = MIME[extname(abs).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": rel === "index.html" ? "no-store" : "public, max-age=60",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(readFileSync(abs));
}

export function createDeskRequestListener(opts: DeskOptions) {
  const studioDir = opts.studioDir || resolveStudioDir();
  const projectDir = resolve(opts.projectDir);

  return async function listener(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLocalHost(req.headers.host)) {
      text(res, 403, "bound to localhost only");
      return;
    }

    const method = req.method || "GET";
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = url.pathname;

    try {
      if (method === "GET" && path === "/api/snapshot") {
        json(res, 200, snapshot(opts));
        return;
      }

      if (method === "GET" && path.startsWith("/api/skills/")) {
        const rest = path.slice("/api/skills/".length);
        const [id, fileToken] = rest.split("/");
        if (!id) {
          json(res, 400, { error: "missing skill id" });
          return;
        }
        if (fileToken === "file") {
          const rel = url.searchParams.get("path") || "";
          const file = readSkillFile(id, rel, inventoryOpts(opts));
          if (!file) {
            json(res, 404, { error: "file not found" });
            return;
          }
          json(res, 200, file);
          return;
        }
        const detail = readSkillDetail(id, inventoryOpts(opts));
        if (!detail) {
          json(res, 404, { error: "skill not found" });
          return;
        }
        json(res, 200, detail);
        return;
      }

      if (method === "POST" && path === "/api/remove") {
        const body = (await parseJsonBody(req)) as { ids?: unknown };
        const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string") : [];
        if (ids.length === 0) {
          json(res, 400, { error: "ids required" });
          return;
        }
        json(res, 200, removeInstalledSkills(ids, inventoryOpts(opts)));
        return;
      }

      if (method === "POST" && path === "/api/install") {
        const body = (await parseJsonBody(req)) as { skills?: unknown; agents?: unknown };
        const skills = Array.isArray(body.skills)
          ? body.skills.filter(
              (skill): skill is string => typeof skill === "string" && skill.length > 0,
            )
          : [];
        if (skills.length === 0) {
          json(res, 400, { error: "skills required" });
          return;
        }
        const agents = Array.isArray(body.agents)
          ? body.agents.filter((agent): agent is string => typeof agent === "string")
          : detectAgents(opts.homeDir);
        let installed = 0;
        let failed = 0;
        const errors: {
          name: string;
          output: string;
          stderr: string;
          exitCode: number | null;
          command: string;
        }[] = [];
        const securityChecks: InstallSecurityCheck[] = [];
        for (const skill of skills) {
          const result = await installSkill(skill, agents, { projectDir });
          if (result.success) {
            installed += 1;
            if (result.securityCheck) securityChecks.push(result.securityCheck);
          } else {
            failed += 1;
            errors.push({
              name: skill,
              output: result.output,
              stderr: result.stderr,
              exitCode: result.exitCode,
              command: result.command,
            });
          }
        }
        json(res, 200, { installed, failed, errors, securityChecks });
        return;
      }

      if (method === "GET" && !path.startsWith("/api/")) {
        serveStatic(studioDir, path, res);
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: (err as Error).message || "internal error" });
    }
  };
}

export function createDeskServer(opts: DeskOptions) {
  return createServer(createDeskRequestListener(opts));
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export async function startDesk(opts: DeskOptions): Promise<{
  url: string;
  port: number;
  close: () => Promise<void>;
}> {
  const requested = resolveDeskPort(opts.port);
  const server = createDeskServer(opts);

  const listen = (port: number): Promise<number> =>
    new Promise((resolveListen, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("error", onError);
        reject(err);
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolveListen((server.address() as AddressInfo).port);
      });
    });

  let port = requested;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      port = await listen(requested + attempt);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" || attempt === 11) throw err;
    }
  }

  const url = `http://127.0.0.1:${port}`;
  const shouldOpen = opts.open !== false && process.env.AUTOSKILLS_UI_NO_OPEN !== "1";
  if (shouldOpen) {
    try {
      openBrowser(url);
    } catch {}
  }

  return {
    url,
    port,
    close: () =>
      new Promise((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      }),
  };
}

export async function runDesk(opts: DeskOptions): Promise<void> {
  const { url, port } = await startDesk(opts);
  log();
  log(green("   ◆ ") + "Local skills desk");
  log(dim(`   ${url}`));
  if (port !== resolveDeskPort(opts.port)) {
    log(yellow("   Port was busy; bound to the next free one."));
  }
  log(dim("   Listening on 127.0.0.1 only. Press Ctrl+C to stop."));
  log();
  await new Promise(() => {});
}
