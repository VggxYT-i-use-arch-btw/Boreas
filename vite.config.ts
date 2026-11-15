import { defineConfig } from "vite";
import ts from "typescript";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";

function classicGlobalBridge() {
  return {
    name: "boreas-classic-global-bridge",
    enforce: "pre" as const,
    transform(source: string, id: string) {
      if (!id.includes("/src/legacy/") || !id.endsWith(".ts")) return null;
      const file = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true);
      const names = new Set<string>();
      const declaredVars = new Set<string>();
      for (const statement of file.statements) {
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name &&
            !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) names.add(statement.name.text);
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              const isAmbient = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword) ?? false;
              if (isAmbient) {
                if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) declaredVars.add(declaration.name.text);
              } else {
                names.add(declaration.name.text);
              }
            }
          }
        }
      }
      if (!names.size) return null;
      const properties = [...names].map(name => `${JSON.stringify(name)}: ${name}`).join(",");
      const initialize = [...declaredVars].map(name => `globalThis[${JSON.stringify(name)}] ??= undefined;`).join("\n");
      return `${initialize}\n${source}\nObject.assign(globalThis, {${properties}});`;
    },
  };
}

function serviceWorkerAsset() {
  async function compileWorker(): Promise<string> {
    const sourcePath = path.resolve("sw.ts");
    const [workerSource, configSource] = await Promise.all([
      readFile(sourcePath, "utf8"),
      readFile(path.resolve("src/config/backend.ts"), "utf8"),
    ]);
    const backendUrl = configSource.match(/backendBaseUrl\s*=\s*["']([^"']+)["']/)?.[1];
    if (!backendUrl) throw new Error("backendBaseUrl não definido em src/config/backend.ts");
    const source = workerSource.replace("__BOREAS_BACKEND_URL__", backendUrl);
    const result = await build({
      stdin: { contents: source, resolveDir: path.resolve("."), sourcefile: sourcePath, loader: "ts" },
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      write: false,
    });
    const output = result.outputFiles[0]?.text;
    if (!output) throw new Error("Falha ao gerar service worker");
    return output;
  }

  return {
    name: "boreas-service-worker",
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: "sw.js", source: await compileWorker() });
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.split("?")[0]?.endsWith("/sw.js")) return next();
        try {
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.end(await compileWorker());
        } catch (error) {
          next(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [classicGlobalBridge(), serviceWorkerAsset()],
  root: ".",
  // GitHub Pages serves this project under its repository path.
  base: "/Boreas/",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
});
