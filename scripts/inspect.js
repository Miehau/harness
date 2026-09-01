import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function pathFromRegex(body) {
  return body
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replaceAll("\\/", "/")
    .replaceAll("([^/]+)", ":id")
    .replace("(accept|changes)", ":decision")
    .replace("(?:accept|changes)", ":decision");
}

function regexLiteralAt(source, slashIndex) {
  let escaped = false;
  let charset = false;
  for (let index = slashIndex + 1; index < source.length; index++) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") charset = true;
    else if (character === "]" && charset) charset = false;
    else if (character === "/" && !charset) return source.slice(slashIndex, index + 1);
  }
  return "";
}

function matchAssignments(source) {
  const vars = new Map();
  const needle = "url.pathname.match(";
  let from = 0;
  while (from < source.length) {
    const call = source.indexOf(needle, from);
    if (call < 0) break;
    const slash = source.indexOf("/", call + needle.length);
    const assign = source.slice(Math.max(0, call - 80), call).match(/(?:const|let) (\w+) =\s*$/);
    const literal = slash >= 0 ? regexLiteralAt(source, slash) : "";
    if (assign && literal) vars.set(assign[1], pathFromRegex(literal.slice(1, -1)));
    from = call + needle.length;
  }
  return vars;
}

export function parseRoutes(source) {
  const vars = matchAssignments(source);
  const routes = [];
  const seen = new Set();
  const add = (method, path) => {
    const key = `${method} ${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({ method, path });
  };
  for (const match of source.matchAll(/if \(request\.method === "(GET|POST)" && url\.pathname === "(\/api\/[^"]+)"\)/g)) {
    add(match[1], match[2]);
  }
  for (const match of source.matchAll(/if \(request\.method === "(GET|POST)" && (\w+)\)/g)) {
    const path = vars.get(match[2]);
    if (path) add(match[1], path);
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export function parseUi(html) {
  const attr = (name) => [...html.matchAll(new RegExp(`${name}="([^"]+)"`, "g"))].map((match) => match[1]);
  const dialogs = [...html.matchAll(/<dialog id="([^"]+)"/g)].map((match) => match[1]);
  const forms = [...html.matchAll(/<form id="([^"]+)"/g)].map((match) => match[1]);
  const regions = ["ticket-pane", "ticket-list", "ticket-header", "plan-tree", "inspector"].filter((id) => html.includes(`id="${id}"`));
  return {
    title: html.match(/<title>([^<]+)</)?.[1] || "",
    dialogs,
    forms,
    regions,
    actions: attr("id").filter((id) => !dialogs.includes(id) && !forms.includes(id) && !regions.includes(id))
  };
}

export function parseCli(source) {
  return [...source.matchAll(/if \(command === "([a-z]+)"\)/g)].map((match) => match[1]);
}

export async function inspectApp(root = repoRoot) {
  const [server, html, cli, pkg, execution] = await Promise.all([
    readFile(join(root, "src/server.js"), "utf8"),
    readFile(join(root, "public/index.html"), "utf8"),
    readFile(join(root, "src/cli.js"), "utf8"),
    readFile(join(root, "package.json"), "utf8"),
    readFile(join(root, "src/execution.js"), "utf8")
  ]);
  const srcFiles = (await readdir(join(root, "src"))).filter((name) => name.endsWith(".js")).sort();
  const testFiles = (await readdir(join(root, "test"))).filter((name) => name.endsWith(".test.js")).sort();
  const publicFiles = (await readdir(join(root, "public"))).filter((name) => !name.startsWith(".")).sort();
  const stageBlock = execution.match(/export const runStageDefs = \[([\s\S]*?)\];/)?.[1] || "";
  const stageIds = [...stageBlock.matchAll(/\["([a-z]+)"/g)].map((match) => match[1]);
  return {
    package: JSON.parse(pkg),
    routes: parseRoutes(server),
    ui: parseUi(html),
    cli: parseCli(cli),
    stages: stageIds,
    modules: {
      src: srcFiles,
      public: publicFiles,
      tests: testFiles,
      untested: srcFiles.filter((name) => !testFiles.includes(`${basename(name, ".js")}.test.js`))
    }
  };
}
