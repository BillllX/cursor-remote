"use client";

import { useMemo, useState } from "react";
import CodeBlock from "./CodeBlock";
import { parseCsv, parseNotebook } from "../lib/previewFormats";

function JsonNode({ name, value, depth = 0 }: { name?: string; value: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  if (value == null || typeof value !== "object") {
    return (
      <div className="json-leaf">
        {name != null ? <span className="json-key">{name}: </span> : null}
        <span className={`json-${typeof value}`}>{JSON.stringify(value)}</span>
      </div>
    );
  }
  const rows = Object.entries(value as Record<string, unknown>);
  return (
    <details className="json-node" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {name != null ? `${name}: ` : ""}
        <span>{Array.isArray(value) ? `Array(${rows.length})` : `{${rows.length}}`}</span>
      </summary>
      {rows.map(([key, child]) => (
        <JsonNode key={key} name={key} value={child} depth={depth + 1} />
      ))}
    </details>
  );
}

export default function DataPreview({ path, content }: { path: string; content: string }) {
  const ext = path.split(".").pop()?.toLowerCase();
  const csv = useMemo(() => (ext === "csv" ? parseCsv(content) : []), [content, ext]);
  const notebook = useMemo(() => (ext === "ipynb" ? parseNotebook(content) : null), [content, ext]);
  const json = useMemo(() => {
    if (ext !== "json") return undefined;
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return undefined;
    }
  }, [content, ext]);

  if (ext === "csv") {
    if (!csv.length) return <div className="tree-empty">CSV 没有数据</div>;
    const width = Math.max(...csv.map((row) => row.length));
    return (
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {Array.from({ length: width }, (_, i) => (
                <th key={i}>{csv[0][i] || `列 ${i + 1}`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {csv.slice(1).map((row, r) => (
              <tr key={r}>
                {Array.from({ length: width }, (_, c) => (
                  <td key={c}>{row[c] || ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (ext === "json" && json !== undefined)
    return (
      <div className="json-tree">
        <JsonNode value={json} />
      </div>
    );
  if (ext === "json") return <div className="tree-empty">JSON 格式错误，请切换到源码查看。</div>;

  if (notebook) {
    if (notebook.error) return <div className="tree-empty">{notebook.error}</div>;
    return (
      <div className="notebook">
        {notebook.cells.map((cell, index) => {
          const source = Array.isArray(cell.source) ? cell.source.join("") : cell.source || "";
          return (
            <section className={`notebook-cell ${cell.cell_type || "raw"}`} key={index}>
              <div className="notebook-gutter">
                {cell.cell_type === "code" ? `In [${index + 1}]` : cell.cell_type || "raw"}
              </div>
              <div className="notebook-body">
                {cell.cell_type === "code" ? <CodeBlock code={source} language="python" /> : <pre>{source}</pre>}
                {cell.outputs?.length ? (
                  <pre className="notebook-output">{JSON.stringify(cell.outputs, null, 2)}</pre>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    );
  }

  return null;
}
