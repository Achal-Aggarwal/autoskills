import { afterEach, describe, it } from "node:test";
import { equal, match, ok } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { createDeskServer } from "../desk.ts";
import { skillIdForPath } from "../inventory.ts";
import { _setRegistryDir } from "../installer.ts";
import type { RegistryEntry } from "../installer.ts";
import { useTmpDir, writeFile } from "./helpers.ts";

function sha256(buf: string | Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function listen(server: ReturnType<typeof createDeskServer>): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function httpJson(
  url: string,
  opts: { method?: string; body?: unknown; host?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
    const req = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: opts.method || "GET",
        headers: {
          Host: opts.host || target.host,
          Accept: "application/json",
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf-8") }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function buildRegistry(dir: string, name: string, content: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), content);
  const hash = sha256(content);
  const entry: RegistryEntry = {
    source: "owner/repo",
    skillPath: `owner/repo/${name}`,
    commitSha: "deadbeef",
    files: ["SKILL.md"],
    sha256: { "SKILL.md": hash },
    bundleHash: sha256(`SKILL.md:${hash}`),
    review: {
      status: "approved",
      flags: [],
      summary: "test",
      model: "test-model",
      promptVersion: "1.0.0",
      reviewedAt: new Date().toISOString(),
    },
  };
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        reviewer: { model: "test-model", promptVersion: "1.0.0" },
        skills: { [name]: entry },
      },
      null,
      2,
    ),
  );
}

describe("desk server", () => {
  const tmp = useTmpDir();

  afterEach(() => {
    _setRegistryDir(null);
  });

  async function startDesk(project: string, home: string) {
    const server = createDeskServer({
      projectDir: project,
      homeDir: home,
      open: false,
    });
    const url = await listen(server);
    return {
      url,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    };
  }

  it("serves the desk page and a snapshot of installed skills", async () => {
    const project = join(tmp.path, "project");
    const home = join(tmp.path, "home");
    writeFile(
      project,
      ".agents/skills/desk-skill/SKILL.md",
      "---\nname: desk-skill\ndescription: Visible in the desk\n---\n\nHello.\n",
    );
    writeFile(project, "package.json", JSON.stringify({ dependencies: { react: "19.0.0" } }));

    const desk = await startDesk(project, home);
    try {
      const page = await httpJson(`${desk.url}/`);
      equal(page.status, 200);
      match(page.body, /autoskills desk/);

      const snap = await httpJson(`${desk.url}/api/snapshot`);
      equal(snap.status, 200);
      const data = JSON.parse(snap.body);
      equal(data.projectDir, project);
      ok(data.installed.some((skill: { name: string }) => skill.name === "desk-skill"));
      ok(Array.isArray(data.recommended));

      const skill = data.installed.find((item: { name: string }) => item.name === "desk-skill");
      const detail = await httpJson(`${desk.url}/api/skills/${skill.id}`);
      equal(detail.status, 200);
      match(JSON.parse(detail.body).body, /Hello/);
    } finally {
      await desk.close();
    }
  });

  it("rejects non-localhost hosts", async () => {
    const project = join(tmp.path, "project");
    const home = join(tmp.path, "home");
    mkdirSync(project, { recursive: true });
    mkdirSync(home, { recursive: true });
    const desk = await startDesk(project, home);
    try {
      const res = await httpJson(`${desk.url}/api/snapshot`, { host: "example.com" });
      equal(res.status, 403);
    } finally {
      await desk.close();
    }
  });

  it("removes an installed skill through the API", async () => {
    const project = join(tmp.path, "project");
    const home = join(tmp.path, "home");
    const skillDir = join(project, ".agents", "skills", "remove-me");
    writeFile(skillDir, "SKILL.md", "---\nname: remove-me\n---\n");
    const id = skillIdForPath(skillDir);

    const desk = await startDesk(project, home);
    try {
      const res = await httpJson(`${desk.url}/api/remove`, { method: "POST", body: { ids: [id] } });
      equal(res.status, 200);
      equal(JSON.parse(res.body).removed[0], id);
      equal(existsSync(skillDir), false);
    } finally {
      await desk.close();
    }
  });

  it("installs a registry skill through the API", async () => {
    const project = join(tmp.path, "project");
    const home = join(tmp.path, "home");
    const regDir = join(tmp.path, "registry");
    mkdirSync(project, { recursive: true });
    mkdirSync(home, { recursive: true });
    buildRegistry(regDir, "desk-install", "---\nname: desk-install\n---\n# hi\n");
    _setRegistryDir(regDir);

    const desk = await startDesk(project, home);
    try {
      const res = await httpJson(`${desk.url}/api/install`, {
        method: "POST",
        body: { skills: ["owner/repo/desk-install"], agents: ["universal"] },
      });
      equal(res.status, 200, res.body);
      const result = JSON.parse(res.body);
      equal(result.installed, 1);
      ok(existsSync(join(project, ".agents", "skills", "desk-install", "SKILL.md")));
    } finally {
      await desk.close();
    }
  });

  it("does not serve files outside the studio directory", async () => {
    const project = join(tmp.path, "project");
    const home = join(tmp.path, "home");
    mkdirSync(project, { recursive: true });
    const desk = await startDesk(project, home);
    try {
      const res = await httpJson(`${desk.url}/../package.json`);
      equal(res.status, 404);
    } finally {
      await desk.close();
    }
  });
});
