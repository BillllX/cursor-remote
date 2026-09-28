"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { chartColorSequence } from "./tokens";
import { useHostTheme } from "./host";

export type ChartTone = "success" | "danger" | "warning" | "info" | "neutral";

export type ChartDataPoint = {
  label: string;
  value: number;
};

export type ChartSeries = {
  name: string;
  data: number[];
  tone?: ChartTone;
};

export type ChartReferenceLine = {
  value: number;
  label?: string;
  tone?: ChartTone;
};

type ValueAxisProps = {
  beginAtZero?: boolean;
  yMin?: number;
  yMax?: number;
  referenceLines?: ChartReferenceLine[];
};

export type BarChartProps = ValueAxisProps & {
  categories: string[];
  series: ChartSeries[];
  height?: number;
  stacked?: boolean;
  horizontal?: boolean;
  normalized?: boolean;
  valueSuffix?: string;
  valuePrefix?: string;
  showValues?: boolean;
  style?: CSSProperties;
};

export type LineChartProps = ValueAxisProps & {
  categories: string[];
  series: ChartSeries[];
  height?: number;
  fill?: boolean;
  valueSuffix?: string;
  valuePrefix?: string;
  showValues?: boolean;
  showHoverGuide?: boolean;
  style?: CSSProperties;
};

export type PieChartProps = {
  data: Array<ChartDataPoint & { tone?: ChartTone }>;
  size?: number;
  donut?: boolean;
  style?: CSSProperties;
};

function toneColor(tone: ChartTone | undefined, index: number, theme: ReturnType<typeof useHostTheme>) {
  if (tone === "success") return theme.category.green;
  if (tone === "danger") return theme.category.red;
  if (tone === "warning") return theme.category.yellow;
  if (tone === "info") return theme.category.blue;
  if (tone === "neutral") return theme.category.gray;
  if (index === 0) return theme.accent.primary;
  return chartColorSequence[(index - 1) % chartColorSequence.length];
}

function formatVal(value: number, prefix = "", suffix = "") {
  const abs = Math.abs(value);
  const text =
    abs >= 1000 && abs % 1 === 0
      ? value.toLocaleString()
      : abs >= 10
        ? String(Math.round(value * 10) / 10)
        : String(Math.round(value * 100) / 100);
  return `${prefix}${text}${suffix}`;
}

function domain(series: ChartSeries[], beginAtZero = true, yMin?: number, yMax?: number, stacked = false) {
  let min = 0;
  let max = 0;
  if (stacked) {
    const len = Math.max(0, ...series.map((item) => item.data.length));
    for (let i = 0; i < len; i++) {
      const sum = series.reduce((acc, item) => acc + (item.data[i] || 0), 0);
      max = Math.max(max, sum);
      min = Math.min(min, sum);
    }
  } else {
    for (const item of series) {
      for (const value of item.data) {
        max = Math.max(max, value);
        min = Math.min(min, value);
      }
    }
  }
  if (beginAtZero) min = Math.min(0, min);
  if (yMin != null) min = yMin;
  if (yMax != null) max = yMax;
  if (max === min) max = min + 1;
  return { min, max };
}

function Legend({
  items,
}: {
  items: Array<{ name: string; color: string }>;
}) {
  const theme = useHostTheme();
  if (items.length < 2) return null;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        marginTop: 8,
        fontSize: 12,
        color: theme.text.secondary,
      }}
    >
      {items.map((item) => (
        <span key={item.name} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: item.color }} />
          {item.name}
        </span>
      ))}
    </div>
  );
}

export function BarChart({
  categories,
  series,
  height = 220,
  stacked,
  horizontal,
  normalized,
  valueSuffix = "",
  valuePrefix = "",
  showValues,
  beginAtZero = true,
  yMin,
  yMax,
  referenceLines,
  style,
}: BarChartProps) {
  const theme = useHostTheme();
  const [hover, setHover] = useState<number | null>(null);
  const stack = Boolean(stacked || normalized);
  const autoValues = showValues ?? (series.length === 1 && categories.length <= 8 && !stack);
  const colors = series.map((item, index) => toneColor(item.tone, index, theme));
  const { min, max } = useMemo(() => {
    if (normalized) return { min: 0, max: 1 };
    return domain(series, stack ? true : beginAtZero, yMin, yMax, stack);
  }, [series, beginAtZero, yMin, yMax, stack, normalized]);
  const pad = { l: horizontal ? 88 : 36, r: 12, t: 12, b: horizontal ? 20 : 36 };
  const width = 480;
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const n = Math.max(categories.length, 1);
  const groupW = plotW / n;

  return (
    <div style={style}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img">
        {categories.map((label, i) => {
          const x = pad.l + i * groupW;
          if (horizontal) {
            const y = pad.t + i * (plotH / n);
            return (
              <text
                key={label}
                x={pad.l - 8}
                y={y + plotH / n / 2}
                textAnchor="end"
                dominantBaseline="middle"
                fill={theme.text.tertiary}
                fontSize={11}
              >
                {label}
              </text>
            );
          }
          return (
            <text
              key={label}
              x={x + groupW / 2}
              y={height - 10}
              textAnchor="middle"
              fill={theme.text.tertiary}
              fontSize={11}
            >
              {label}
            </text>
          );
        })}
        {series[0] && !horizontal ? (
          <>
            <text x={4} y={pad.t + 4} fill={theme.text.quaternary} fontSize={10}>
              {formatVal(max, valuePrefix, normalized ? "%" : valueSuffix)}
            </text>
            <text x={4} y={pad.t + plotH} fill={theme.text.quaternary} fontSize={10}>
              {formatVal(min, valuePrefix, normalized ? "%" : valueSuffix)}
            </text>
          </>
        ) : null}
        {categories.map((_, i) => {
          const totals = series.reduce((acc, item) => acc + Math.max(0, item.data[i] || 0), 0) || 1;
          let offset = 0;
          const barCount = stack ? 1 : series.length;
          const gap = 4;
          const unit = Math.max(4, (horizontal ? plotH / n : groupW) - 12);
          return (
            <g
              key={i}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {series.map((item, s) => {
                const raw = item.data[i] || 0;
                const value = normalized ? raw / totals : raw;
                const color =
                  series.length === 1 && !item.tone
                    ? toneColor(undefined, i, theme)
                    : colors[s];
                if (horizontal) {
                  const rowH = plotH / n;
                  const y = pad.t + i * rowH + 4;
                  const h = Math.max(6, rowH - 8);
                  const w = ((value - min) / (max - min)) * plotW;
                  const x = pad.l + (stack ? offset : 0);
                  const barX = stack ? x : pad.l + s * (unit / barCount + gap / barCount);
                  if (stack) offset += w;
                  return (
                    <rect
                      key={item.name}
                      x={barX}
                      y={y}
                      width={Math.max(0, stack ? w : Math.max(0, ((value - min) / (max - min)) * plotW))}
                      height={stack ? h : Math.min(h, unit / barCount)}
                      fill={color}
                      rx={2}
                    />
                  );
                }
                const colW = Math.max(6, (groupW - 16) / barCount);
                const x =
                  pad.l +
                  i * groupW +
                  8 +
                  (stack ? 0 : s * (colW + gap / 2)) +
                  (stack ? (groupW - 16 - colW) / 2 : 0);
                const h = ((value - min) / (max - min)) * plotH;
                const y = pad.t + plotH - (stack ? offset + h : h);
                if (stack) offset += h;
                return (
                  <g key={item.name}>
                    <rect x={x} y={y} width={stack ? groupW - 16 : colW} height={Math.max(0, h)} fill={color} rx={2} />
                    {autoValues && !stack ? (
                      <text
                        x={x + colW / 2}
                        y={y - 4}
                        textAnchor="middle"
                        fill={theme.text.secondary}
                        fontSize={10}
                      >
                        {formatVal(raw, valuePrefix, valueSuffix)}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
          );
        })}
        {referenceLines?.map((line) => {
          const color = toneColor(line.tone, 0, theme);
          if (horizontal) {
            const x = pad.l + ((line.value - min) / (max - min)) * plotW;
            return (
              <g key={`${line.value}-${line.label || ""}`}>
                <line x1={x} x2={x} y1={pad.t} y2={pad.t + plotH} stroke={color} strokeDasharray="4 3" />
                {line.label ? (
                  <text x={x + 4} y={pad.t + 10} fill={color} fontSize={10}>
                    {line.label}
                  </text>
                ) : null}
              </g>
            );
          }
          const y = pad.t + plotH - ((line.value - min) / (max - min)) * plotH;
          return (
            <g key={`${line.value}-${line.label || ""}`}>
              <line x1={pad.l} x2={width - pad.r} y1={y} y2={y} stroke={color} strokeDasharray="4 3" />
              {line.label ? (
                <text x={width - pad.r} y={y - 4} textAnchor="end" fill={color} fontSize={10}>
                  {line.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {hover != null ? (
        <div style={{ fontSize: 12, color: theme.text.secondary, marginTop: 4 }}>
          {categories[hover]}{" "}
          {series.map((item) => `${item.name} ${formatVal(item.data[hover] || 0, valuePrefix, valueSuffix)}`).join(" · ")}
        </div>
      ) : null}
      <Legend items={series.map((item, index) => ({ name: item.name, color: colors[index] }))} />
    </div>
  );
}

export function LineChart({
  categories,
  series,
  height = 220,
  fill,
  valueSuffix = "",
  valuePrefix = "",
  showValues,
  showHoverGuide = true,
  beginAtZero = true,
  yMin,
  yMax,
  referenceLines,
  style,
}: LineChartProps) {
  const theme = useHostTheme();
  const [hover, setHover] = useState<number | null>(null);
  const colors = series.map((item, index) => toneColor(item.tone, index, theme));
  const { min, max } = domain(series, beginAtZero, yMin, yMax);
  const pad = { l: 36, r: 12, t: 16, b: 36 };
  const width = 480;
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const n = Math.max(categories.length, 1);
  const xAt = (i: number) => pad.l + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v: number) => pad.t + plotH - ((v - min) / (max - min)) * plotH;

  return (
    <div style={style}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img">
        {categories.map((label, i) => (
          <text key={label} x={xAt(i)} y={height - 10} textAnchor="middle" fill={theme.text.tertiary} fontSize={11}>
            {label}
          </text>
        ))}
        {showHoverGuide && hover != null ? (
          <line x1={xAt(hover)} x2={xAt(hover)} y1={pad.t} y2={pad.t + plotH} stroke={theme.stroke.secondary} />
        ) : null}
        {series.map((item, s) => {
          const pts = item.data.map((value, i) => `${xAt(i)},${yAt(value)}`).join(" ");
          const area = `${xAt(0)},${yAt(min)} ${pts} ${xAt(item.data.length - 1)},${yAt(min)}`;
          return (
            <g key={item.name}>
              {fill ? <polygon points={area} fill={colors[s]} opacity={0.16} /> : null}
              <polyline points={pts} fill="none" stroke={colors[s]} strokeWidth={2} />
              {item.data.map((value, i) => (
                <circle
                  key={i}
                  cx={xAt(i)}
                  cy={yAt(value)}
                  r={hover === i ? 4 : 3}
                  fill={colors[s]}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              ))}
              {showValues && categories.length <= 20
                ? item.data.map((value, i) => (
                    <text key={`v-${i}`} x={xAt(i)} y={yAt(value) - 8} textAnchor="middle" fill={theme.text.secondary} fontSize={10}>
                      {formatVal(value, valuePrefix, valueSuffix)}
                    </text>
                  ))
                : null}
            </g>
          );
        })}
        {referenceLines?.map((line) => {
          const color = toneColor(line.tone, 0, theme);
          const y = yAt(line.value);
          return (
            <g key={`${line.value}-${line.label || ""}`}>
              <line x1={pad.l} x2={width - pad.r} y1={y} y2={y} stroke={color} strokeDasharray="4 3" />
              {line.label ? (
                <text x={width - pad.r} y={y - 4} textAnchor="end" fill={color} fontSize={10}>
                  {line.label}
                </text>
              ) : null}
            </g>
          );
        })}
        {categories.map((_, i) => (
          <rect
            key={i}
            x={xAt(i) - plotW / n / 2}
            y={pad.t}
            width={Math.max(8, plotW / n)}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>
      {hover != null ? (
        <div style={{ fontSize: 12, color: theme.text.secondary, marginTop: 4 }}>
          {categories[hover]}{" "}
          {series.map((item) => `${item.name} ${formatVal(item.data[hover] || 0, valuePrefix, valueSuffix)}`).join(" · ")}
        </div>
      ) : null}
      <Legend items={series.map((item, index) => ({ name: item.name, color: colors[index] }))} />
    </div>
  );
}

export function PieChart({ data, size = 200, donut, style }: PieChartProps) {
  const theme = useHostTheme();
  const [hover, setHover] = useState<number | null>(null);
  const total = data.reduce((acc, item) => acc + Math.max(0, item.value), 0) || 1;
  const r = size / 2 - 8;
  const inner = donut ? r * 0.58 : 0;
  const cx = size / 2;
  const cy = size / 2;
  let angle = -Math.PI / 2;

  function slicePath(start: number, frac: number, explode: boolean) {
    const sweep = frac * Math.PI * 2;
    const end = start + sweep;
    const mid = start + sweep / 2;
    const bump = explode ? 8 : 0;
    const ox = Math.cos(mid) * bump;
    const oy = Math.sin(mid) * bump;
    const x1 = cx + ox + Math.cos(start) * r;
    const y1 = cy + oy + Math.sin(start) * r;
    const x2 = cx + ox + Math.cos(end) * r;
    const y2 = cy + oy + Math.sin(end) * r;
    const large = sweep > Math.PI ? 1 : 0;
    if (!donut) {
      return `M ${cx + ox} ${cy + oy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
    }
    const ix1 = cx + ox + Math.cos(start) * inner;
    const iy1 = cy + oy + Math.sin(start) * inner;
    const ix2 = cx + ox + Math.cos(end) * inner;
    const iy2 = cy + oy + Math.sin(end) * inner;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${inner} ${inner} 0 ${large} 0 ${ix1} ${iy1} Z`;
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, ...style }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
        {data.map((item, index) => {
          const frac = Math.max(0, item.value) / total;
          const start = angle;
          angle += frac * Math.PI * 2;
          const color = toneColor(item.tone, index, theme);
          return (
            <path
              key={item.label}
              d={slicePath(start, frac, hover === index)}
              fill={color}
              opacity={hover == null || hover === index ? 1 : 0.45}
              onMouseEnter={() => setHover(index)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
        {donut ? (
          <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" fill={theme.text.primary} fontSize={14} fontWeight={590}>
            {Math.round(total)}
          </text>
        ) : null}
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: theme.text.secondary }}>
        {data.map((item, index) => (
          <span
            key={item.label}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, opacity: hover == null || hover === index ? 1 : 0.5 }}
            onMouseEnter={() => setHover(index)}
            onMouseLeave={() => setHover(null)}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: toneColor(item.tone, index, theme) }} />
            {item.label} {Math.round((item.value / total) * 100)}%
          </span>
        ))}
      </div>
    </div>
  );
}
