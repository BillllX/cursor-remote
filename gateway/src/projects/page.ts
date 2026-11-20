/** 控制项目单个响应的体积，下一页从最后一项继续。 */
export function projectPage<T>(items: T[], budget = 48000) {
  let bytes = 2;
  const page: T[] = [];
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > budget) break;
    page.push(item);
    bytes += size;
  }
  return page;
}
