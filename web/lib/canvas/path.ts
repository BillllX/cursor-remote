export function isCanvasPath(path: string) {
  return /\.canvas\.tsx$/i.test(path.replace(/\\/g, "/"));
}
