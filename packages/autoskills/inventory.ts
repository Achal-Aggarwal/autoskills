import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { AGENT_FOLDER_MAP } from "./skills-map.ts";

export type SkillScope = "project" | "system";
export type SkillKind = "folder" | "file" | "symlink";

export interface InstalledSkill {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  drawer: string;
  agent: string;
  path: string;
  kind: SkillKind;
  linkTarget: string | null;
  broken: boolean;
  managed: boolean;
  files: string[];
  frontmatter: Record<string, string>;
}

export interface SkillDetail extends InstalledSkill {
  body: string;
}

export interface InventoryOptions {
  projectDir: string;
  homeDir?: string;
}

export interface DrawerCount {
  id: string;
  label: string;
  scope: SkillScope;
  count: number;
}

export interface Inventory {
  projectDir: string;
  homeDir: string;
  skills: InstalledSkill[];
  drawers: DrawerCount[];
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".cache",
]);

const SKIP_HOME_DOTDIRS = new Set([
  ".cache",
  ".npm",
  ".pnpm",
  ".yarn",
  ".local",
  ".Trash",
  ".docker",
  ".rustup",
  ".cargo",
  ".nvm",
  ".volta",
  ".sdkman",
  ".gradle",
  ".m2",
  ".bun",
  ".vscode",
]);

const PLUGIN_WALK_ROOTS = [".cursor/plugins", ".cursor/extensions", ".claude/plugins"];

const DRAWER_AGENTS: Record<string, string> = {
  ".agents": "universal",
  ".cursor": "cursor",
  ".codex": "codex",
  ".gemini": "gemini",
  ".windsurf": "windsurf",
  ".opencode": "opencode",
  ".github": "copilot",
  ".agent": "agent",
};

const MAX_BODY_CHARS = 400_000;
const MAX_SKILL_FILES = 80;
const MAX_PLUGIN_DEPTH = 6;

function drawerAgents(): Record<string, string> {
  return { ...DRAWER_AGENTS, ...AGENT_FOLDER_MAP };
}

export function skillIdForPath(skillPath: string): string {
  return createHash("sha256").update(resolve(skillPath)).digest("hex").slice(0, 20);
}

export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: content };

  const raw = content.slice(4, end).replace(/^\r?\n/, "");
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  const frontmatter: Record<string, string> = {};

  let currentKey: string | null = null;
  let currentValue: string[] = [];
  let folding = false;

  function commit(): void {
    if (!currentKey) return;
    const value = currentValue.join(folding ? " " : "\n").trim();
    frontmatter[currentKey] = value;
    currentKey = null;
    currentValue = [];
    folding = false;
  }

  for (const line of raw.split(/\r?\n/)) {
    const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (keyMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      commit();
      currentKey = keyMatch[1];
      const rest = keyMatch[2];
      if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-") {
        folding = rest.startsWith(">");
        currentValue = [];
      } else {
        currentValue = [rest];
      }
      continue;
    }

    if (currentKey && (line.startsWith(" ") || line.startsWith("\t"))) {
      currentValue.push(line.trim());
      continue;
    }

    commit();
  }
  commit();

  return { frontmatter, body };
}

function safeReaddir(dir: string): import("node:fs").Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function agentForDrawer(drawer: string): string {
  const agents = drawerAgents();
  if (agents[drawer]) return agents[drawer];
  const top = drawer.split("/")[0];
  if (agents[top]) return agents[top];
  if (drawer.includes("/plugins")) return `${agents[top] || top.slice(1)}-plugin`;
  return top.replace(/^\./, "") || "unknown";
}

function drawerLabel(drawer: string): string {
  const agents = drawerAgents();
  const mapped = agents[drawer];
  if (mapped === "universal") return "Universal";
  if (mapped) return mapped;
  if (drawer.includes("/plugins") || drawer.includes("/extensions")) {
    const parts = drawer.split("/").filter(Boolean);
    const tool = (parts[0] || "").replace(/^\./, "") || "plugin";
    const name = parts.slice(1).find((part) => !["plugins", "cache", "extensions"].includes(part));
    return name ? `${tool} · ${name}` : `${tool} plugin`;
  }
  return drawer.replace(/^\./, "") || drawer;
}

function readSkillMarkdown(skillPath: string, kind: SkillKind): string {
  const filePath = kind === "file" ? skillPath : join(skillPath, "SKILL.md");
  try {
    return readFileSync(filePath, "utf-8").slice(0, MAX_BODY_CHARS);
  } catch {
    return "";
  }
}

function listSkillFiles(skillPath: string, kind: SkillKind): string[] {
  if (kind === "file") return [skillPath.split(/[\\/]/).pop() || "SKILL.md"];

  const files: string[] = [];

  function walk(dir: string, rel: string, depth: number): void {
    if (files.length >= MAX_SKILL_FILES || depth > 4) return;
    for (const entry of safeReaddir(dir)) {
      if (files.length >= MAX_SKILL_FILES) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, nextRel, depth + 1);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(nextRel);
      }
    }
  }

  walk(skillPath, "", 0);
  return files.sort();
}

function classifyEntry(abs: string): {
  kind: SkillKind;
  linkTarget: string | null;
  broken: boolean;
  isDir: boolean;
  isFile: boolean;
} | null {
  let lst;
  try {
    lst = lstatSync(abs);
  } catch {
    return null;
  }

  if (lst.isSymbolicLink()) {
    let target: string | null = null;
    let broken = false;
    let isDir = false;
    let isFile = false;
    try {
      target = readlinkSync(abs);
    } catch {
      target = null;
    }
    try {
      const st = statSync(abs);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      broken = true;
    }
    return { kind: "symlink", linkTarget: target, broken, isDir, isFile };
  }

  if (lst.isDirectory()) {
    return { kind: "folder", linkTarget: null, broken: false, isDir: true, isFile: false };
  }

  if (lst.isFile()) {
    return { kind: "file", linkTarget: null, broken: false, isDir: false, isFile: true };
  }

  return null;
}

function looksLikeSkillDir(abs: string): boolean {
  return existsSync(join(abs, "SKILL.md"));
}

function skillNameFrom(abs: string, frontmatter: Record<string, string>, fallback: string): string {
  return (frontmatter.name || fallback || abs.split(/[\\/]/).pop() || "skill").trim();
}

function buildSkill(
  abs: string,
  scope: SkillScope,
  drawer: string,
  managedNames: Set<string>,
): InstalledSkill | null {
  const info = classifyEntry(abs);
  if (!info) return null;

  if (info.kind === "file" || (info.kind === "symlink" && info.isFile)) {
    if (extname(abs).toLowerCase() !== ".md") return null;
  } else if (info.kind === "folder" || info.isDir) {
    if (!looksLikeSkillDir(abs)) return null;
  } else if (info.broken) {
    // keep broken links that live in a skills drawer
  } else {
    return null;
  }

  const kind: SkillKind = info.kind;
  const content = info.broken
    ? ""
    : readSkillMarkdown(abs, kind === "symlink" ? (info.isFile ? "file" : "folder") : kind);
  const { frontmatter } = parseFrontmatter(content);
  const fallback = abs.split(/[\\/]/).pop() || "skill";
  const name = skillNameFrom(abs, frontmatter, fallback.replace(/\.md$/i, ""));
  const readKind: SkillKind = kind === "symlink" ? (info.isFile ? "file" : "folder") : kind;

  return {
    id: skillIdForPath(abs),
    name,
    description: (frontmatter.description || "").trim(),
    scope,
    drawer,
    agent: agentForDrawer(drawer),
    path: abs,
    kind,
    linkTarget: info.linkTarget,
    broken: info.broken,
    managed: managedNames.has(name) || managedNames.has(fallback),
    files: info.broken ? [] : listSkillFiles(abs, readKind),
    frontmatter,
  };
}

function scanSkillsDir(
  skillsDir: string,
  scope: SkillScope,
  drawer: string,
  managedNames: Set<string>,
  into: InstalledSkill[],
  seen: Set<string>,
): void {
  if (!existsSync(skillsDir)) return;

  for (const entry of safeReaddir(skillsDir)) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const abs = resolve(skillsDir, entry.name);
    if (seen.has(abs)) continue;
    const skill = buildSkill(abs, scope, drawer, managedNames);
    if (!skill) continue;
    seen.add(abs);
    into.push(skill);
  }
}

function walkPluginTree(
  absRoot: string,
  relBase: string,
  scope: SkillScope,
  managedNames: Set<string>,
  into: InstalledSkill[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > MAX_PLUGIN_DEPTH) return;

  for (const entry of safeReaddir(absRoot)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;

    const abs = join(absRoot, entry.name);
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;

    if (entry.name === "skills") {
      const drawer = relBase || rel;
      scanSkillsDir(
        abs,
        scope,
        drawer.startsWith(".") ? drawer : `.${drawer}`,
        managedNames,
        into,
        seen,
      );
      continue;
    }

    walkPluginTree(abs, rel, scope, managedNames, into, seen, depth + 1);
  }
}

function loadManagedNames(projectDir: string): Set<string> {
  try {
    const lock = JSON.parse(readFileSync(join(projectDir, "skills-lock.json"), "utf-8"));
    if (lock?.skills && typeof lock.skills === "object") {
      return new Set(Object.keys(lock.skills));
    }
  } catch {}
  return new Set();
}

function knownDrawers(): string[] {
  return [...new Set([".agents", ...Object.keys(drawerAgents())])];
}

function scanRoot(
  root: string,
  scope: SkillScope,
  managedNames: Set<string>,
  into: InstalledSkill[],
  seen: Set<string>,
): void {
  const scannedSkillsDirs = new Set<string>();

  for (const drawer of knownDrawers()) {
    const skillsDir = join(root, drawer, "skills");
    scannedSkillsDirs.add(resolve(skillsDir));
    scanSkillsDir(skillsDir, scope, drawer, managedNames, into, seen);
  }

  for (const rel of PLUGIN_WALK_ROOTS) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    walkPluginTree(abs, rel, scope, managedNames, into, seen, 0);
  }

  for (const entry of safeReaddir(root)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!entry.name.startsWith(".")) continue;
    if (scope === "system" && SKIP_HOME_DOTDIRS.has(entry.name)) continue;
    const skillsDir = resolve(root, entry.name, "skills");
    if (scannedSkillsDirs.has(skillsDir)) continue;
    if (!existsSync(skillsDir)) continue;
    scanSkillsDir(skillsDir, scope, entry.name, managedNames, into, seen);
  }
}

export function scanInstalledSkills(opts: InventoryOptions): Inventory {
  const projectDir = resolve(opts.projectDir);
  const homeDir = resolve(opts.homeDir || homedir());
  const managedNames = loadManagedNames(projectDir);
  const skills: InstalledSkill[] = [];
  const seen = new Set<string>();

  scanRoot(projectDir, "project", managedNames, skills, seen);
  if (resolve(homeDir) !== projectDir) {
    scanRoot(homeDir, "system", managedNames, skills, seen);
  }

  skills.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
    if (a.drawer !== b.drawer) return a.drawer.localeCompare(b.drawer);
    return a.name.localeCompare(b.name);
  });

  const drawerMap = new Map<string, DrawerCount>();
  for (const skill of skills) {
    const key = `${skill.scope}:${skill.drawer}`;
    const existing = drawerMap.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      drawerMap.set(key, {
        id: key,
        label: drawerLabel(skill.drawer),
        scope: skill.scope,
        count: 1,
      });
    }
  }

  return {
    projectDir,
    homeDir,
    skills,
    drawers: [...drawerMap.values()],
  };
}

export function findInstalledSkill(id: string, opts: InventoryOptions): InstalledSkill | null {
  return scanInstalledSkills(opts).skills.find((skill) => skill.id === id) || null;
}

export function readSkillDetail(id: string, opts: InventoryOptions): SkillDetail | null {
  const skill = findInstalledSkill(id, opts);
  if (!skill) return null;
  const readKind: SkillKind =
    skill.kind === "file" || (skill.kind === "symlink" && skill.path.toLowerCase().endsWith(".md"))
      ? "file"
      : "folder";
  const content = skill.broken ? "" : readSkillMarkdown(skill.path, readKind);
  const { body } = parseFrontmatter(content);
  return { ...skill, body };
}

export function readSkillFile(
  id: string,
  relPath: string,
  opts: InventoryOptions,
): { path: string; content: string } | null {
  const skill = findInstalledSkill(id, opts);
  if (!skill || skill.kind === "file") return null;

  const normalized = relPath.split("\\").join("/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "")) {
    return null;
  }

  const abs = resolve(skill.path, ...normalized.split("/"));
  if (!isInside(skill.path, abs)) return null;
  if (!existsSync(abs)) return null;

  try {
    if (!statSync(abs).isFile()) return null;
    return { path: normalized, content: readFileSync(abs, "utf-8").slice(0, MAX_BODY_CHARS) };
  } catch {
    return null;
  }
}

export function isSafeSkillPath(skillPath: string, opts: InventoryOptions): boolean {
  const projectDir = resolve(opts.projectDir);
  const homeDir = resolve(opts.homeDir || homedir());
  const abs = resolve(skillPath);
  const roots = [projectDir, homeDir].filter((root, i, all) => all.indexOf(root) === i);
  const underRoot = roots.some((root) => isInside(root, abs));
  if (!underRoot) return false;

  const parts = abs.split(sep);
  const skillsIndex = parts.lastIndexOf("skills");
  if (skillsIndex === -1 || skillsIndex === parts.length - 1) return false;
  return parts.length > skillsIndex + 1;
}

function removeLockEntry(projectDir: string, skillName: string): void {
  const lockPath = join(projectDir, "skills-lock.json");
  let lock: { version: number; skills: Record<string, unknown> };
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf-8"));
    if (!lock?.skills || typeof lock.skills !== "object") return;
  } catch {
    return;
  }
  if (!(skillName in lock.skills)) return;
  delete lock.skills[skillName];
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
}

function removeProjectAgentLinks(
  projectDir: string,
  skillName: string,
  canonicalPath: string,
): void {
  const drawers = knownDrawers().filter((drawer) => drawer !== ".agents");
  for (const drawer of drawers) {
    const linkPath = join(projectDir, drawer, "skills", skillName);
    if (!existsSync(linkPath)) continue;
    try {
      const lst = lstatSync(linkPath);
      if (lst.isSymbolicLink()) {
        rmSync(linkPath, { force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (resolve(linkPath) === resolve(canonicalPath)) continue;
    try {
      rmSync(linkPath, { recursive: true, force: true });
    } catch {}
  }
}

export interface RemoveResult {
  removed: string[];
  errors: { id: string; error: string }[];
}

export function removeInstalledSkills(ids: string[], opts: InventoryOptions): RemoveResult {
  const inventory = scanInstalledSkills(opts);
  const byId = new Map(inventory.skills.map((skill) => [skill.id, skill]));
  const removed: string[] = [];
  const errors: { id: string; error: string }[] = [];

  for (const id of ids) {
    const skill = byId.get(id);
    if (!skill) {
      errors.push({ id, error: "skill not found" });
      continue;
    }
    if (!isSafeSkillPath(skill.path, opts)) {
      errors.push({ id, error: "refusing to delete path outside a skills drawer" });
      continue;
    }

    try {
      rmSync(skill.path, { recursive: true, force: true });
      if (skill.scope === "project" && skill.drawer === ".agents") {
        removeLockEntry(opts.projectDir, skill.name);
        removeProjectAgentLinks(opts.projectDir, skill.name, skill.path);
      } else if (skill.scope === "project" && skill.managed) {
        const canonical = join(opts.projectDir, ".agents", "skills", skill.name);
        if (!existsSync(canonical)) removeLockEntry(opts.projectDir, skill.name);
      }
      removed.push(id);
    } catch (err) {
      errors.push({ id, error: (err as Error).message });
    }
  }

  return { removed, errors };
}

export function resolveHomeDir(homeDir?: string): string {
  return resolve(homeDir || homedir());
}

/** @internal */
export function _isInside(parent: string, child: string): boolean {
  return isInside(parent, child);
}
