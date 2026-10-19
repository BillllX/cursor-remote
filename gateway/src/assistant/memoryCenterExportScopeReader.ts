import * as scopedRead from "./scopedRead.ts";

/** 可测试注入；默认走 scopedRead.readFileAtScope。 */
export let scopeFileReader: typeof scopedRead.readFileAtScope = scopedRead.readFileAtScope;

export function setMemoryCenterExportScopeReaderForTest(reader: typeof scopedRead.readFileAtScope | null) {
  scopeFileReader = reader ?? scopedRead.readFileAtScope;
}
