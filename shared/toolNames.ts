// 按工具名判断「改文件 / 写文件」：网关的本轮文件清单和网页的工具卡片分类共用，iOS 端有一份同样的规则

/** 驼峰拆成下划线再小写：MultiEdit → multi_edit；按单词匹配，credit 里的 edit 不算 */
export function toolWords(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

const EDIT_WORD =
  /(?:^|[^a-z])(?:edit|replace|patch|multiedit|strreplace|editnotebook|applypatch|searchreplace|editfile)(?:[^a-z]|$)/;
const WRITE_WORD = /(?:^|[^a-z])(?:write|writefile|createfile)(?:[^a-z]|$)/;
const CREATE_FILE = /(?:^|[^a-z])create[^a-z]+files?(?:[^a-z]|$)/;
const IMAGE_WORD = /(?:^|[^a-z])(?:generateimage|imagegen|generate[^a-z]+image|image[^a-z]+gen)(?:[^a-z]|$)/;
const PLAN_OR_TODO = /todo|create_?plan/;
const DELETE_WORD = /delete|unlink|remove/;

/** 改已有文件的工具：edit、StrReplace、MultiEdit、apply_patch、EditNotebook…… */
export function isEditToolName(name: string): boolean {
  const n = toolWords(name);
  return !PLAN_OR_TODO.test(n) && EDIT_WORD.test(n);
}

/** 新建或整体写入文件的工具：write、createFile、write_file…… */
export function isWriteToolName(name: string): boolean {
  const n = toolWords(name);
  return !PLAN_OR_TODO.test(n) && (WRITE_WORD.test(n) || CREATE_FILE.test(n));
}

/** 删文件的工具：delete_file、unlink（按子串） */
export function isDeleteToolName(name: string): boolean {
  return /delete|unlink/.test(toolWords(name));
}

/** 调用后会在工作区留下文件内容的工具：改、写、生成图片；删除、todo、计划不算 */
export function toolWritesFiles(name: string): boolean {
  const n = toolWords(name);
  if (PLAN_OR_TODO.test(n) || DELETE_WORD.test(n)) return false;
  return EDIT_WORD.test(n) || WRITE_WORD.test(n) || CREATE_FILE.test(n) || IMAGE_WORD.test(n);
}
