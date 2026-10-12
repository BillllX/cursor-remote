#!/usr/bin/env node
// 环境变量护栏（用 TypeScript 编译器 API 做 AST 检查，注释和字符串里的文字不算）：
// 1. gateway/src 里（不含 test 目录）除 config.ts 外，不许按具名键读 process.env，改走 config.ts 的访问器。
//    具名读取包括：process.env.X、process.env?.X、process.env["X"]、const { X } = process.env、"X" in process.env，
//    以及同文件内把 process.env 赋给变量 / 参数默认值 / 传给本文件函数的参数后，对该变量的具名访问。
//    整份展开 { ...process.env }、Object.entries(process.env) 允许；动态键 process.env[key] 只允许白名单文件。
// 2. config.ts 的 ENV_SPECS 里声明的每个变量，scripts/gateway.env.example 都要有一行（可以是注释行 `# NAME=`）。
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export type EnvFinding = {
  file: string;
  line: number;
  /** 具名键；动态键为 null */
  name: string | null;
  kind: "named" | "dynamic";
};

/** 相对 gateway/src 的路径 → 允许具名读取的变量。都是只转给子进程或系统层面的变量 */
export const ALLOW_NAMED: Record<string, string[]> = {
  // MCP 子进程只拿这几个系统变量
  "native/mcp.ts": ["PATH", "HOME", "LANG"],
  // 在 PATH 里找 rg
  "native/tools/fs.ts": ["PATH"],
  // sandboxMasks 遮住 HOME 目录
  "native/tools/shell.ts": ["HOME"],
};

/** 允许动态键读取 process.env 的文件 */
export const ALLOW_DYNAMIC: Record<string, string> = {
  "providers.ts": "按 providers.json 里的 apiKeyEnv 取键",
  "native/tools/shell.ts": "shellEnv 按 ENV_ALLOW 白名单把系统变量转给子进程",
};

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function literalKey(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isComputedPropertyName(node)) {
    const inner = unwrap(node.expression);
    return ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ? inner.text : null;
  }
  return null;
}

/** 元素访问 / in 左侧：只有字符串字面量算具名键，变量当动态键 */
function stringKey(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  const expr = unwrap(node);
  return ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) ? expr.text : null;
}

/** 扫一组源码，返回所有按键读取 process.env 的位置（不应用白名单） */
export function scanEnvReads(files: { fileName: string; text: string }[]): EnvFinding[] {
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    allowJs: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    types: [],
  };
  const byName = new Map(files.map((file) => [resolve(file.fileName), file.text]));
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (fileName, languageVersion) => {
    const text = byName.get(resolve(fileName));
    return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  host.fileExists = (fileName) => byName.has(resolve(fileName));
  host.readFile = (fileName) => byName.get(resolve(fileName));
  const program = ts.createProgram([...byName.keys()], options, host);
  const checker = program.getTypeChecker();
  const findings: EnvFinding[] = [];

  for (const [fileName] of byName) {
    const source = program.getSourceFile(fileName);
    if (!source) continue;
    const aliases = new Set<ts.Symbol>();
    const symbolOf = (node: ts.Node) => checker.getSymbolAtLocation(node);
    const declaredHere = (symbol: ts.Symbol | undefined) =>
      Boolean(symbol?.declarations?.some((decl) => decl.getSourceFile() === source));

    const isProcess = (node: ts.Expression): boolean => {
      const expr = unwrap(node);
      if (ts.isIdentifier(expr)) return expr.text === "process" && !declaredHere(symbolOf(expr));
      // globalThis.process
      return (
        ts.isPropertyAccessExpression(expr) &&
        expr.name.text === "process" &&
        ts.isIdentifier(unwrap(expr.expression)) &&
        (unwrap(expr.expression) as ts.Identifier).text === "globalThis"
      );
    };

    const isEnv = (node: ts.Expression): boolean => {
      const expr = unwrap(node);
      if (ts.isPropertyAccessExpression(expr)) return expr.name.text === "env" && isProcess(expr.expression);
      if (ts.isElementAccessExpression(expr)) {
        return stringKey(expr.argumentExpression) === "env" && isProcess(expr.expression);
      }
      if (ts.isIdentifier(expr)) {
        const symbol = symbolOf(expr);
        return Boolean(symbol && aliases.has(symbol));
      }
      return false;
    };

    const report = (node: ts.Node, name: string | null) => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      findings.push({ file: fileName, line, name, kind: name === null ? "dynamic" : "named" });
    };

    const addAlias = (name: ts.Node) => {
      const symbol = symbolOf(name);
      if (!symbol || aliases.has(symbol)) return false;
      aliases.add(symbol);
      return true;
    };

    /** 对 process.env 的解构：具名元素报出，...rest 当作别名（第二轮再报对它的读取） */
    const visitBinding = (pattern: ts.ObjectBindingPattern, collectOnly: boolean) => {
      let grew = false;
      for (const element of pattern.elements) {
        if (element.dotDotDotToken) {
          if (ts.isIdentifier(element.name)) grew = addAlias(element.name) || grew;
          continue;
        }
        if (!collectOnly) report(element, literalKey(element.propertyName ?? element.name));
      }
      return grew;
    };

    const visitAssignmentPattern = (pattern: ts.ObjectLiteralExpression, collectOnly: boolean) => {
      let grew = false;
      for (const prop of pattern.properties) {
        if (ts.isSpreadAssignment(prop)) {
          if (ts.isIdentifier(prop.expression)) grew = addAlias(prop.expression) || grew;
          continue;
        }
        if (!collectOnly) report(prop, literalKey(prop.name));
      }
      return grew;
    };

    /** 本文件里定义的函数：把 process.env 传进去时，对应参数当作别名 */
    const localParams = (callee: ts.Expression): ts.NodeArray<ts.ParameterDeclaration> | null => {
      const symbol = symbolOf(unwrap(callee));
      for (const decl of symbol?.declarations ?? []) {
        if (decl.getSourceFile() !== source) continue;
        if (ts.isFunctionDeclaration(decl)) return decl.parameters;
        if (ts.isVariableDeclaration(decl) && decl.initializer) {
          const init = unwrap(decl.initializer);
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init.parameters;
        }
      }
      return null;
    };

    // 第一轮：收集别名，直到不再增加（别名的别名）
    const collect = (node: ts.Node): boolean => {
      let grew = false;
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer && isEnv(node.initializer)) {
        if (ts.isIdentifier(node.name)) grew = addAlias(node.name) || grew;
        else if (ts.isObjectBindingPattern(node.name)) grew = visitBinding(node.name, true) || grew;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isEnv(node.right) &&
        ts.isIdentifier(unwrap(node.left))
      ) {
        grew = addAlias(unwrap(node.left)) || grew;
      }
      if (ts.isCallExpression(node)) {
        const params = localParams(node.expression);
        node.arguments.forEach((arg, index) => {
          const param = params?.[index];
          if (param && isEnv(arg) && ts.isIdentifier(param.name)) grew = addAlias(param.name) || grew;
        });
      }
      ts.forEachChild(node, (child) => {
        grew = collect(child) || grew;
      });
      return grew;
    };
    while (collect(source)) {
      // 继续收集
    }

    // 第二轮：报出读取
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && isEnv(node.expression)) {
        report(node, node.name.text);
      } else if (ts.isElementAccessExpression(node) && isEnv(node.expression)) {
        report(node, stringKey(node.argumentExpression));
      } else if (
        (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
        node.initializer &&
        isEnv(node.initializer) &&
        ts.isObjectBindingPattern(node.name)
      ) {
        visitBinding(node.name, false);
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isEnv(node.right) &&
        ts.isObjectLiteralExpression(unwrap(node.left))
      ) {
        visitAssignmentPattern(unwrap(node.left) as ts.ObjectLiteralExpression, false);
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        isEnv(node.right)
      ) {
        report(node, stringKey(node.left));
      } else if (ts.isCallExpression(node)) {
        const params = localParams(node.expression);
        node.arguments.forEach((arg, index) => {
          const param = params?.[index];
          if (param && isEnv(arg) && ts.isObjectBindingPattern(param.name)) visitBinding(param.name, false);
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** 应用白名单，返回违规说明 */
export function envViolations(findings: EnvFinding[], srcDir: string): string[] {
  const problems: string[] = [];
  for (const item of findings) {
    const rel = relative(srcDir, item.file).split("\\").join("/");
    const where = `gateway/src/${rel}:${item.line}`;
    if (item.kind === "dynamic") {
      if (!(rel in ALLOW_DYNAMIC)) problems.push(`${where} 用动态键读 process.env，只有白名单文件可以`);
    } else if (!(ALLOW_NAMED[rel] ?? []).includes(item.name ?? "")) {
      problems.push(`${where} 直接读了 process.env.${item.name}，请改用 config.ts 的访问器`);
    }
  }
  return problems;
}

/** 从 config.ts 的 ENV_SPECS 数组字面量里取出 name 字段 */
export function declaredEnvNames(configText: string): string[] {
  const source = ts.createSourceFile("config.ts", configText, ts.ScriptTarget.ES2022, true);
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "ENV_SPECS") {
      const init = node.initializer ? unwrap(node.initializer) : undefined;
      if (init && ts.isArrayLiteralExpression(init)) {
        for (const item of init.elements) {
          if (!ts.isObjectLiteralExpression(item)) continue;
          for (const prop of item.properties) {
            if (ts.isPropertyAssignment(prop) && literalKey(prop.name) === "name") {
              const value = unwrap(prop.initializer);
              if (ts.isStringLiteral(value)) names.push(value.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** dotenv 模板里出现过的变量名（含注释行 `# NAME=`） */
export function exampleEnvNames(exampleText: string): Set<string> {
  const names = new Set<string>();
  for (const line of exampleText.split("\n")) {
    const name = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (name) names.add(name);
  }
  return names;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test" || entry.name === "node_modules") continue;
      walk(full, acc);
    } else if (/\.(ts|mts|js|mjs)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

export function checkRepo(root: string): string[] {
  const srcDir = resolve(root, "gateway/src");
  const configFile = resolve(srcDir, "config.ts");
  const files = walk(srcDir)
    .filter((file) => file !== configFile)
    .map((fileName) => ({ fileName, text: readFileSync(fileName, "utf8") }));
  const problems = envViolations(scanEnvReads(files), srcDir);

  const declared = declaredEnvNames(readFileSync(configFile, "utf8"));
  if (!declared.length) problems.push("gateway/src/config.ts 的 ENV_SPECS 里没解析出任何变量名");
  const seen = new Set<string>();
  for (const name of declared) {
    if (seen.has(name)) problems.push(`gateway/src/config.ts 的 ENV_SPECS 重复声明了 ${name}`);
    seen.add(name);
  }
  const listed = exampleEnvNames(readFileSync(resolve(root, "scripts/gateway.env.example"), "utf8"));
  for (const name of declared) {
    if (!listed.has(name)) problems.push(`scripts/gateway.env.example 缺少 ${name}（可以写成注释行 \`# ${name}=\`）`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const problems = checkRepo(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  if (problems.length) {
    console.error(`环境变量检查失败（${problems.length} 处）：`);
    for (const item of problems) console.error(`  ${item}`);
    process.exit(1);
  }
  console.log("环境变量检查通过");
}
