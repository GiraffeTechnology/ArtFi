/** Emit only the source-module closure. This is not a package or installation. */
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const builtin = (name) =>
  name.startsWith("node:") || builtinModules.includes(name);
const packageName = (name) =>
  name.startsWith("@")
    ? name.split("/").slice(0, 2).join("/")
    : name.split("/")[0];
/** The full builder supplies its locked compiler and dependency declarations
 * after its unchanged TypeScript/Next/lock checks. Standalone source output
 * does not satisfy those checks or replace dependency closure/pack verification. */
export async function emitTaskRuntimeSources({
  root,
  destination,
  typescript: ts,
  dependencies,
}) {
  root = await realpath(root);
  destination = resolve(destination);
  const template = { dependencies };
  // A fresh directory keeps source-only output separate and never overwrites
  // an operator-supplied package or earlier emission.
  await mkdir(destination, { recursive: false });
  const sourceFiles = {},
    external = new Set(),
    visited = new Set();
  async function visit(path) {
    path = await realpath(path);
    const sourcePath = relative(root, path);
    if (sourcePath.startsWith("..") || sourcePath.includes("node_modules"))
      throw Error("Runtime source escapes the application.");
    if (visited.has(path)) return;
    visited.add(path);
    const body = await readFile(path, "utf8");
    sourceFiles[sourcePath] = digest(body);
    let output = body;
    if (extname(path) === ".ts") {
      const result = ts.transpileModule(body, {
        fileName: path,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          esModuleInterop: true,
          isolatedModules: true,
          sourceMap: false,
          declaration: false,
        },
      });
      if (
        result.diagnostics?.some(
          (item) => item.category === ts.DiagnosticCategory.Error,
        )
      )
        throw Error(`Task runtime compilation failed: ${sourcePath}`);
      output = result.outputText;
    } else if (extname(path) !== ".mjs")
      throw Error(`Unsupported runtime module: ${sourcePath}`);
    const syntax = ts.createSourceFile(
      path,
      output,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const imports = [];
    function scan(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) imports.push(node.moduleSpecifier);
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        if (
          node.arguments.length !== 1 ||
          !ts.isStringLiteralLike(node.arguments[0])
        )
          throw Error(`Computed runtime imports are prohibited: ${sourcePath}`);
        imports.push(node.arguments[0]);
      }
      ts.forEachChild(node, scan);
    }
    scan(syntax);
    const replacements = [];
    for (const specifier of imports) {
      const name = specifier.text;
      if (builtin(name)) continue;
      if (!name.startsWith(".")) {
        if (!Object.hasOwn(template.dependencies, packageName(name)))
          throw Error(`Undeclared runtime dependency: ${name}`);
        external.add(packageName(name));
        continue;
      }
      const base = resolve(dirname(path), name);
      let target;
      for (const candidate of [base, `${base}.ts`, `${base}.mjs`]) {
        try {
          if ((await lstat(candidate)).isFile()) {
            target = candidate;
            break;
          }
        } catch {}
      }
      if (!target)
        throw Error(`Runtime module missing: ${sourcePath} -> ${name}`);
      await visit(target);
      if (name.endsWith(".ts"))
        replacements.push([
          specifier.getStart(syntax),
          specifier.getEnd(),
          JSON.stringify(name.replace(/\.ts$/, ".js")),
        ]);
    }
    for (const [start, end, replacement] of replacements.sort(
      (a, b) => b[0] - a[0],
    ))
      output = output.slice(0, start) + replacement + output.slice(end);
    const target = join(destination, sourcePath.replace(/\.ts$/, ".js"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, output, { flag: "wx" });
  }
  await visit(join(root, "scripts/task-runtime/server.mjs"));
  return {
    sourceFiles,
    external,
    sourceOnly: true,
    installationAcceptance: "NOT_ESTABLISHED",
  };
}
