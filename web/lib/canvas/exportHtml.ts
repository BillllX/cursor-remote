// 把已经渲染好的 Canvas 画布（iframe 里的文档）导出成一份独立的 HTML 快照。
// 做法：克隆 DOM，把所有样式表（含 CSSOM 里动态插入的规则）合并成一个 <style>，
// 去掉脚本。导出的是当前所见的静态画面（主题、图表、展开状态都保留），不含交互逻辑。

function collectCss(doc: Document): string {
  const chunks: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    if (sheet.disabled) continue;
    try {
      const rules = Array.from(sheet.cssRules).map((rule) => rule.cssText);
      if (rules.length) chunks.push(rules.join("\n"));
    } catch {
      // 跨域样式表读不到规则，跳过
    }
  }
  return chunks.join("\n");
}

// 表单控件的当前值不会反映到属性上，克隆前后按顺序把它写回去
function syncFormState(source: Element, clone: Element) {
  const from = Array.from(source.querySelectorAll("input, textarea, select"));
  const to = Array.from(clone.querySelectorAll("input, textarea, select"));
  from.forEach((el, index) => {
    const copy = to[index];
    if (!copy) return;
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.checked) copy.setAttribute("checked", "");
        else copy.removeAttribute("checked");
      } else {
        copy.setAttribute("value", el.value);
      }
    } else if (el instanceof HTMLTextAreaElement) {
      copy.textContent = el.value;
    } else if (el instanceof HTMLSelectElement) {
      Array.from(copy.querySelectorAll("option")).forEach((opt, i) => {
        if (i === el.selectedIndex) opt.setAttribute("selected", "");
        else opt.removeAttribute("selected");
      });
    }
  });
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function canvasExportName(path: string) {
  const base = path.replace(/\\/g, "/").split("/").pop() || "canvas";
  return `${base.replace(/\.canvas\.tsx$/i, "") || "canvas"}.html`;
}

export function buildCanvasExportHtml(doc: Document, title: string): string {
  const root = doc.documentElement.cloneNode(true) as HTMLElement;
  syncFormState(doc.documentElement, root);

  root
    .querySelectorAll(
      "script, noscript, style, link[rel=stylesheet], link[rel=preload], link[rel=prefetch], link[rel=modulepreload], meta[charset], meta[name=viewport], title, nextjs-portal",
    )
    .forEach((node) => node.remove());

  let head = root.querySelector("head");
  if (!head) {
    head = doc.createElement("head");
    root.insertBefore(head, root.firstChild);
  }
  const css = collectCss(doc).replace(/<\/style/gi, "<\\/style");
  head.insertAdjacentHTML(
    "afterbegin",
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${css}</style>`,
  );

  return `<!DOCTYPE html>\n${root.outerHTML}\n`;
}

// 点击时从画布 iframe 里取文档并触发下载；画布还没渲染好时返回 false
export function exportCanvasFrame(frame: HTMLIFrameElement | null, path: string): boolean {
  let doc: Document | null | undefined;
  try {
    doc = frame?.contentDocument;
  } catch {
    doc = null;
  }
  if (!doc || !doc.querySelector(".canvas-runtime-page")) return false;
  // 还在「正在打开画布…」占位时不导出
  if (!doc.querySelector(".canvas-runtime-page > *") || doc.querySelector(".canvas-runtime-page .tree-empty")) {
    return false;
  }
  const name = canvasExportName(path);
  const html = buildCanvasExportHtml(doc, name.replace(/\.html$/i, ""));
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
