// IM 业务错误：处理函数抛出，分发层转成 im_error
import type { ImErrorCode } from "../../../shared/protocol.ts";

export class ImError extends Error {
  readonly code: ImErrorCode;
  constructor(code: ImErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
