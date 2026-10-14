import { describe, it } from "node:test";
import { equal, match, ok } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import {
  isSafeSkillPath,
  parseFrontmatter,
  removeInstalledSkills,
  scanInstalledSkills,
  skillIdForPath,
} from "../inventory.ts";
import { useTmpDir, writeFile, writeJson } from "./helpers.ts";

function writeSkill(
  root: string,
  relDir: string,
  name: string,
  description = "A test skill",
): string {
  const dir = join(root, relDir, name);
  writeFile(dir, "SKILL.md", `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  writeFile(dir, "references/notes.md", "notes");
  return dir;
}

describe("parseFrontmatter", () => {
  it("reads name, description, and body", () => {
    const { frontmatter, body } = parseFrontmatter(
      "---\nname: zod\ndescription: Schema validation\n---\n\n# Body\n",
    );
    equal(frontmatter.name, "zod");
    equal(frontmatter.description, "Schema validation");
    match(body, /# Body/);
  });

  it("folds block descriptions", () => {
    const { frontmatter } = parseFrontmatter(
      "---\nname: x\ndescription: >\n  hello\n  world\n---\n",
    );
    equal(frontmatter.description, "hello world");
  });

  it("returns the raw document when frontmatter is missing", () => {
    const { frontmatter, body } = parseFrontmatter("# just markdown");
    equal(Object.keys(frontmatter).length, 0);
    equal(body, "# just markdown");
  });
});

describe("scanInstalledSkills", () => {
  const tmp = useTmpDir();

  it("finds project folder, file, and symlink skills", () => {
    const project = join(tmp.path, "project");
    const home = join(tmp.path, "home");
    mkdirSync(project, { recursive: true });
    mkdirSync(home, { recursive: true });

    writeSkill(project, ".agents/skills", "folder-skill", "Folder copy");
    writeFile(
      project,
      ".agents/skills/file-skill.md",
      "---\nname: file-skill\ndescription: File copy\n---\n",
    );
    mkdirSync(join(project, ".claude", "skills"), { recursive: true });
    symlinkSync(
      join(project, ".agents", "skills", "folder-skill"),
      join(project, ".claude", "skills", "folder-skill"),
    );
    writeJson(project, "skills-lock.json", {
      version: 1,
      skills: { "folder-skill": { sourceType: "autoskills-registry" } },
    });

    const inventory = scanInstalledSkills({ projectDir: project, homeDir: home });
    const names = inventory.skills.map((skill) => skill.name).sort();
    ok(names.includes("folder-skill"));
    ok(names.includes("file-skill"));

    const folder = inventory.skills.find((skill) =>
      skill.path.endsWith(`${join(".agents", "skills", "folder-skill")}`),
    );
    ok(folder);
    equal(folder?.scope, "project");
    equal(folder?.kind, "folder");
    equal(folder?.managed, true);
    ok(folder?.files.includes("references/notes.md"));

    const file = inventory.skills.find((skill) => skill.name === "file-skill");
    equal(file?.kind, "file");

    const link = inventory.skills.find((skill) => skill.drawer === ".claude");
    equal(link?.kind, "symlink");
    ok(link?.linkTarget);
  });

  it("finds system drawers and plugin skills", () => {
    const project = join(tmp.path, "empty-project");
    const home = join(tmp.path, "home");
    mkdirSync(project, { recursive: true });

    writeSkill(home, ".claude/skills", "user-claude");
    writeSkill(home, ".warp/skills", "warp-skill");
    writeSkill(home, ".cursor/plugins/demo/skills", "plugin-skill");

    const inventory = scanInstalledSkills({ projectDir: project, homeDir: home });
    equal(
      inventory.skills.every((skill) => skill.scope === "system"),
      true,
    );

    const names = new Set(inventory.skills.map((skill) => skill.name));
    ok(names.has("user-claude"));
    ok(names.has("warp-skill"));
    ok(names.has("plugin-skill"));

    const plugin = inventory.skills.find((skill) => skill.name === "plugin-skill");
    equal(plugin?.drawer, ".cursor/plugins/demo");
    ok(inventory.drawers.some((drawer) => drawer.label === "cursor · demo"));
  });
});

describe("isSafeSkillPath", () => {
  const tmp = useTmpDir();

  it("only allows children of a skills drawer under project or home", () => {
    const project = join(tmp.path, "project");
    const home = join(tmp.path, "home");
    const skill = writeSkill(project, ".agents/skills", "safe");

    ok(isSafeSkillPath(skill, { projectDir: project, homeDir: home }));
    equal(
      isSafeSkillPath(join(project, ".agents", "skills"), { projectDir: project, homeDir: home }),
      false,
    );
    equal(
      isSafeSkillPath(join(project, "src", "index.ts"), { projectDir: project, homeDir: home }),
      false,
    );
    equal(isSafeSkillPath("/etc/passwd", { projectDir: project, homeDir: home }), false);
  });
});

describe("removeInstalledSkills", () => {
  const tmp = useTmpDir();

  it("deletes a project skill, its agent link, and the lock entry", () => {
    const project = join(tmp.path, "project");
    const home = join(tmp.path, "home");
    const skillDir = writeSkill(project, ".agents/skills", "gone");
    mkdirSync(join(project, ".claude", "skills"), { recursive: true });
    symlinkSync(skillDir, join(project, ".claude", "skills", "gone"));
    writeJson(project, "skills-lock.json", {
      version: 1,
      skills: { gone: { sourceType: "autoskills-registry" } },
    });

    const id = skillIdForPath(skillDir);
    const result = removeInstalledSkills([id], { projectDir: project, homeDir: home });
    equal(result.removed.length, 1);
    equal(existsSync(skillDir), false);
    equal(existsSync(join(project, ".claude", "skills", "gone")), false);

    const lock = JSON.parse(readFileSync(join(project, "skills-lock.json"), "utf-8"));
    equal(lock.skills.gone, undefined);
  });

  it("returns an error for unknown ids and leaves files in place", () => {
    const project = join(tmp.path, "project");
    const home = join(tmp.path, "home");
    const skillDir = writeSkill(project, ".agents/skills", "stays");
    const result = removeInstalledSkills(["missing"], { projectDir: project, homeDir: home });
    equal(result.removed.length, 0);
    equal(result.errors[0].error, "skill not found");
    ok(existsSync(skillDir));
  });
});
