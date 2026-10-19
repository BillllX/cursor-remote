import { authorityDurableWrite } from "./memoryCenterImportAuthorityWrite.ts";

/** 记忆中心导入路径上的 durable 写（触发 failAfterFileWrite 注入）。 */
export type ImportDurableWriter = (path: string, data: string | Buffer, mode?: number) => void;

export function importAuthorityWriter(): ImportDurableWriter {
  return (path, data, mode) => {
    authorityDurableWrite(path, data, mode ?? 0o600);
  };
}
