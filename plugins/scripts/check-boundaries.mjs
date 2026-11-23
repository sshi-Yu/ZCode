import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";
import { parse } from "@babel/parser";
import { parse as parseYaml } from "yaml";

const scope = "@zcode-plugins/";
const ui = `${scope}ui`;
const uis = `${scope}uis`;
const theme = `${scope}theme`;
const dependencyGroups = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const ignored = new Set(["node_modules", "dist", ".git", "coverage"]);
const extensions = /\.(?:[mc]?[jt]s|[jt]sx)$/u;

function isWithin(parent, child) {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

export function checkManifest(manifest, catalog, { applicationNames = new Set() } = {}) {
  const dependencies = new Set();
  for (const group of dependencyGroups) {
    for (const [name, version] of Object.entries(manifest[group] ?? {})) {
      // workspace:* 只约束解析方式；用实际 apps 成员名单拦截公共层反向依赖。
      if (applicationNames.has(name) && !applicationNames.has(manifest.name)) {
        throw new Error(`${manifest.name}: cannot depend on workspace application ${name}`);
      }
      dependencies.add(name);
      if (name.startsWith(scope)) {
        if (version !== "workspace:*")
          throw new Error(`${manifest.name}: ${name} must use workspace:*`);
        if ((name === ui || name === theme) && manifest.name !== uis) {
          throw new Error(`${manifest.name}: only uis may depend on ${name}`);
        }
      } else if (version !== "catalog:" || !/^\d+\.\d+\.\d+$/u.test(catalog[name] ?? "")) {
        throw new Error(`${manifest.name}: ${name} must use catalog: with an exact stable version`);
      }
    }
  }
  return dependencies;
}

function packageName(value) {
  const parts = value.split("/");
  return parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function checkSource({ root, member, file, code, dependencies, manifestName = "" }) {
  const deny = (value) => {
    throw new Error(`${relative(root, file)}: import boundary does not allow ${value}`);
  };
  function check(value) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\\")) return deny(value);
    if (value.startsWith(".")) {
      const target = resolve(dirname(file), value);
      // An app build may invoke the shared packaging helper, but runtime code cannot leave its app.
      if (
        resolve(root, "scripts/package-market.mjs") === target &&
        isWithin(join(member, "scripts"), file) &&
        isWithin(join(root, "apps"), member)
      )
        return;
      if (!isWithin(member, target) || relative(member, target).split(sep).includes("node_modules"))
        deny(value);
      return;
    }
    if (isBuiltin(value)) return;
    if (
      manifestName === ui &&
      /^#(?:components|lib)\/[\w/.-]+$/u.test(value) &&
      !value.split("/").includes("..")
    )
      return;
    const name = packageName(value);
    if (!dependencies.has(name) && name !== manifestName) return deny(value);
    if ((name === ui || name === theme) && manifestName !== uis && name !== manifestName)
      deny(value);
    if (
      name.startsWith(scope) &&
      value !== name &&
      !(name === uis && value === `${uis}/styles.css`)
    )
      deny(value);
  }

  const plugins = /\.[cm]?tsx?$/u.test(file) ? ["typescript"] : [];
  if (/\.[jt]sx$/u.test(file)) plugins.push("jsx");
  const ast = parse(code, { sourceType: "unambiguous", plugins, createImportExpressions: true });
  const stack = [ast.program];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (
      [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
        "ImportExpression",
      ].includes(node.type) &&
      node.source
    ) {
      if (
        node.type === "ImportExpression" &&
        node.source.type !== "StringLiteral" &&
        isWithin(join(root, "apps"), member) &&
        isWithin(join(member, "test"), file)
      ) {
        // 安装产物测试必须从临时安装目录加载运行入口；此例外不适用于应用源码。
      } else {
        check(node.source.type === "StringLiteral" ? node.source.value : undefined);
      }
    }
    if (node.type === "TSImportType") {
      const argument = node.argument ?? node.source;
      const literal = argument?.literal ?? argument;
      check(literal?.type === "StringLiteral" ? literal.value : undefined);
    }
    if (node.type === "TSExternalModuleReference") check(node.expression?.value);
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      const first = node.arguments?.[0];
      check(first?.type === "StringLiteral" ? first.value : undefined);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === "object" && "type" in value) stack.push(value);
    }
  }
}

async function walk(root, visit) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected source link: ${path}`);
    if (entry.isDirectory()) await walk(path, visit);
    else await visit(path);
  }
}

async function checkWorkspace(root) {
  const readManifest = async (path) =>
    JSON.parse(await readFile(join(path, "package.json"), "utf8"));
  const workspace = parseYaml(await readFile(join(root, "pnpm-workspace.yaml"), "utf8"));
  if (
    workspace.catalogMode !== "strict" ||
    JSON.stringify(workspace.packages) !== '["apps/*","packages/*"]'
  ) {
    throw new Error(
      "Plugin workspace must use strict catalog mode and only apps/*, packages/* members",
    );
  }
  const members = [];
  const applicationNames = new Set();
  for (const group of ["apps", "packages"]) {
    for (const entry of await readdir(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const member = join(root, group, entry.name);
      const manifest = await readManifest(member);
      if (group === "apps") applicationNames.add(manifest.name);
      members.push({ member, manifest });
    }
  }
  const options = { applicationNames };
  checkManifest(await readManifest(root), workspace.catalog, options);
  for (const { member, manifest } of members) {
    const dependencies = checkManifest(manifest, workspace.catalog, options);
    await walk(member, async (file) => {
      if (!extensions.test(file)) return;
      const code = await readFile(file, "utf8");
      checkSource({ root, member, file, code, dependencies, manifestName: manifest.name });
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await checkWorkspace(fileURLToPath(new URL("../", import.meta.url)));
  console.log("Plugin catalog and import boundaries verified");
}
