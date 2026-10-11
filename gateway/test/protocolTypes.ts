// 用 TypeScript 编译器读 shared/protocol.ts：
// - loadProtocolTypes 取 ServerMessage / ClientMessage 联合里每个成员的 type 字面量。
//   走 TypeChecker 而不是扫语法树，交叉类型（& ToolMeta）、别名都能展开。
// - typecheckMessages 把一批 JSON 消息写成临时 .mts（每条 `satisfies ClientMessage` 之类），
//   做完整类型诊断：嵌套字段名、类型、字面量取值、必填字段、多余属性都查。
// 协议测试和 scripts/check-ios-client.mts 共用。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const PROTOCOL_PATH = fileURLToPath(new URL("../../shared/protocol.ts", import.meta.url));

export type ProtocolTypes = { server: Set<string>; client: Set<string> };

const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  types: [],
};

function unionTypes(checker: ts.TypeChecker, file: ts.SourceFile, name: string): Set<string> {
  const fileSymbol = checker.getSymbolAtLocation(file);
  const alias = fileSymbol && checker.getExportsOfModule(fileSymbol).find((s) => s.name === name);
  if (!alias) throw new Error(`shared/protocol.ts 里找不到导出类型 ${name}`);
  const union = checker.getDeclaredTypeOfSymbol(alias);
  const out = new Set<string>();
  for (const member of union.isUnion() ? union.types : [union]) {
    const typeProp = checker.getPropertyOfType(member, "type");
    if (!typeProp) throw new Error(`${name} 有成员没有 type 属性：${checker.typeToString(member)}`);
    const typeType = checker.getTypeOfSymbol(typeProp);
    if (!typeType.isStringLiteral()) {
      throw new Error(`${name} 成员的 type 不是字符串字面量：${checker.typeToString(typeType)}`);
    }
    if (out.has(typeType.value)) throw new Error(`${name} 里 type "${typeType.value}" 重复`);
    out.add(typeType.value);
  }
  return out;
}

export function loadProtocolTypes(): ProtocolTypes {
  const program = ts.createProgram([PROTOCOL_PATH], COMPILER_OPTIONS);
  const file = program.getSourceFile(PROTOCOL_PATH);
  if (!file) throw new Error(`读不到 ${PROTOCOL_PATH}`);
  const checker = program.getTypeChecker();
  return { server: unionTypes(checker, file, "ServerMessage"), client: unionTypes(checker, file, "ClientMessage") };
}

export type MessageEntry = { label: string; message: unknown };
export type MessageProblem = { label: string; problem: string };

/** 每条消息按 `satisfies <typeName>` 做完整类型诊断；返回的问题按 label 归属 */
export function typecheckMessages(
  typeName: "ServerMessage" | "ClientMessage",
  entries: MessageEntry[],
): MessageProblem[] {
  const dir = mkdtempSync(join(tmpdir(), "jiebo-protocol-check-"));
  try {
    const file = join(dir, "samples.mts");
    let text = `import type { ${typeName} } from ${JSON.stringify(PROTOCOL_PATH)};\n\n`;
    const ranges: { start: number; end: number; label: string }[] = [];
    entries.forEach((entry, i) => {
      const start = text.length;
      text += `// ${entry.label}\nexport const s${i} = ${JSON.stringify(entry.message, null, 2)} satisfies ${typeName};\n\n`;
      ranges.push({ start, end: text.length, label: entry.label });
    });
    writeFileSync(file, text);

    const program = ts.createProgram([file], COMPILER_OPTIONS);
    const global = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
    if (global.length) {
      throw new Error(ts.formatDiagnostics(global, ts.createCompilerHost(COMPILER_OPTIONS)));
    }
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`读不到临时文件 ${file}`);
    const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
    return diagnostics.map((diagnostic) => {
      const at = diagnostic.start ?? 0;
      const label = ranges.find((r) => at >= r.start && at < r.end)?.label ?? "（文件头）";
      const line = text.slice(text.lastIndexOf("\n", at - 1) + 1, text.indexOf("\n", at)).trim();
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n    ");
      return { label, problem: `${message}\n    位置：${line}` };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
