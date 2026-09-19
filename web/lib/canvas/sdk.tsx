"use client";

import {
  createContext,
  useContext,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useEffect, useMemo, useRef } from "react";
import {
  canvasPaletteDark,
  canvasPaletteLight,
  canvasTokens,
  canvasTokensLight,
  categoryPaletteDark,
  categoryPaletteLight,
  colorPalette,
  usageColorSequence,
  type Color,
} from "./tokens";
import {
  useCanvasAction,
  useCanvasState,
  useHostTheme,
  type CanvasAction,
  type CanvasHostTheme,
  type SetCanvasState,
} from "./host";
import { BarChart, LineChart, PieChart } from "./charts";

export type { CSSProperties, RefObject } from "react";
export { useEffect, useMemo, useRef, useState } from "react";
export {
  canvasPaletteDark,
  canvasPaletteLight,
  canvasTokens,
  canvasTokensLight,
  categoryPaletteDark,
  categoryPaletteLight,
  colorPalette,
  usageColorSequence,
};
export type { Color, CategoryPalette, CanvasPalette, CanvasTokens } from "./tokens";
export { BarChart, LineChart, PieChart };
export type {
  BarChartProps,
  ChartDataPoint,
  ChartReferenceLine,
  ChartSeries,
  ChartTone,
  LineChartProps,
  PieChartProps,
} from "./charts";
export { useCanvasAction, useCanvasState, useHostTheme };
export type { CanvasAction, CanvasHostTheme, SetCanvasState };

export function mergeStyle(base: CSSProperties, override?: CSSProperties): CSSProperties {
  return override ? { ...base, ...override } : { ...base };
}

export type StackProps = {
  children?: ReactNode;
  gap?: number;
  style?: CSSProperties;
};

export function Stack({ children, gap = 12, style }: StackProps) {
  return (
    <div style={mergeStyle({ display: "flex", flexDirection: "column", gap }, style)}>
      {children}
    </div>
  );
}

export type RowProps = {
  children?: ReactNode;
  gap?: number;
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "space-between";
  wrap?: boolean;
  style?: CSSProperties;
};

export function Row({ children, gap = 8, align = "center", justify = "start", wrap, style }: RowProps) {
  return (
    <div
      style={mergeStyle(
        {
          display: "flex",
          flexDirection: "row",
          gap,
          alignItems: align,
          justifyContent: justify,
          flexWrap: wrap ? "wrap" : "nowrap",
        },
        style,
      )}
    >
      {children}
    </div>
  );
}

export type GridProps = {
  children?: ReactNode;
  columns: number | string;
  gap?: number;
  align?: "start" | "center" | "end" | "stretch";
  style?: CSSProperties;
};

export function Grid({ children, columns, gap = 12, align, style }: GridProps) {
  return (
    <div
      style={mergeStyle(
        {
          display: "grid",
          gridTemplateColumns: typeof columns === "number" ? `repeat(${columns}, minmax(0, 1fr))` : columns,
          gap,
          alignItems: align,
        },
        style,
      )}
    >
      {children}
    </div>
  );
}

export type DividerProps = { style?: CSSProperties };

export function Divider({ style }: DividerProps) {
  const theme = useHostTheme();
  return (
    <div
      style={mergeStyle(
        { height: 1, background: theme.stroke.tertiary, width: "100%" },
        style,
      )}
    />
  );
}

export function Spacer() {
  return <div style={{ flex: 1, minWidth: 0 }} />;
}

export type TableColumnAlign = "left" | "center" | "right";
export type TableRowTone = "success" | "danger" | "warning" | "info" | "neutral";
export type TableProps = {
  headers: ReactNode[];
  rows: ReactNode[][];
  columnAlign?: Array<TableColumnAlign | undefined>;
  rowTone?: Array<TableRowTone | undefined>;
  framed?: boolean;
  striped?: boolean;
  stickyHeader?: boolean;
  style?: CSSProperties;
  emptyMessage?: ReactNode;
};

function toneDot(tone: TableRowTone | undefined, theme: ReturnType<typeof useHostTheme>) {
  if (!tone) return null;
  const color =
    tone === "success"
      ? theme.category.green
      : tone === "danger"
        ? theme.category.red
        : tone === "warning"
          ? theme.category.yellow
          : tone === "info"
            ? theme.category.blue
            : theme.category.gray;
  return (
    <span
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: 99,
        background: color,
        marginRight: 8,
        verticalAlign: "middle",
      }}
    />
  );
}

export function Table({
  headers,
  rows,
  columnAlign,
  rowTone,
  framed = true,
  striped,
  stickyHeader,
  style,
  emptyMessage,
}: TableProps) {
  const theme = useHostTheme();
  const body =
    rows.length === 0 ? (
      <tr>
        <td colSpan={Math.max(1, headers.length)} style={{ padding: 12, color: theme.text.tertiary }}>
          {emptyMessage || ""}
        </td>
      </tr>
    ) : (
      rows.map((row, i) => (
        <tr key={i} style={striped && i % 2 === 1 ? { background: theme.fill.quaternary } : undefined}>
          {headers.map((_, c) => (
            <td
              key={c}
              style={{
                padding: "8px 10px",
                textAlign: columnAlign?.[c] || "left",
                borderTop: `1px solid ${theme.stroke.tertiary}`,
                color: theme.text.primary,
                fontSize: 13,
                verticalAlign: "top",
              }}
            >
              {c === 0 ? toneDot(rowTone?.[i], theme) : null}
              {row[c] ?? ""}
            </td>
          ))}
        </tr>
      ))
    );
  return (
    <div
      style={mergeStyle(
        framed
          ? {
              border: `1px solid ${theme.stroke.primary}`,
              borderRadius: 8,
              overflow: "auto",
              background: theme.bg.elevated,
            }
          : { overflow: "auto" },
        style,
      )}
    >
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {headers.map((header, i) => (
              <th
                key={i}
                style={{
                  textAlign: columnAlign?.[i] || "left",
                  padding: "8px 10px",
                  fontSize: 12,
                  fontWeight: 590,
                  color: theme.text.secondary,
                  background: theme.bg.elevated,
                  position: stickyHeader ? "sticky" : undefined,
                  top: stickyHeader ? 0 : undefined,
                }}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>
    </div>
  );
}

const TextDepth = createContext(0);
export type TextWeight = "normal" | "medium" | "semibold" | "bold";
export type TextProps = {
  children?: ReactNode;
  tone?: "primary" | "secondary" | "tertiary" | "quaternary";
  size?: "body" | "small";
  as?: "p" | "span";
  weight?: TextWeight;
  italic?: boolean;
  truncate?: boolean | "start" | "end";
  style?: CSSProperties;
};

export function Text({
  children,
  tone = "primary",
  size = "body",
  as,
  weight = "normal",
  italic,
  truncate,
  style,
}: TextProps) {
  const theme = useHostTheme();
  const depth = useContext(TextDepth);
  const Tag = as || (depth > 0 ? "span" : "p");
  const color =
    tone === "secondary"
      ? theme.text.secondary
      : tone === "tertiary"
        ? theme.text.tertiary
        : tone === "quaternary"
          ? theme.text.quaternary
          : theme.text.primary;
  return (
    <TextDepth.Provider value={depth + 1}>
      <Tag
        style={mergeStyle(
          {
            margin: 0,
            color,
            fontSize: size === "small" ? 12 : 14,
            lineHeight: size === "small" ? "16px" : "20px",
            fontWeight: weight === "bold" ? 700 : weight === "semibold" ? 590 : weight === "medium" ? 500 : 400,
            fontStyle: italic ? "italic" : undefined,
            overflow: truncate ? "hidden" : undefined,
            textOverflow: truncate ? "ellipsis" : undefined,
            whiteSpace: truncate ? "nowrap" : undefined,
            direction: truncate === "start" ? "rtl" : undefined,
            textAlign: truncate === "start" ? "left" : undefined,
          },
          style,
        )}
      >
        {children}
      </Tag>
    </TextDepth.Provider>
  );
}

export type H1Props = { children?: ReactNode; style?: CSSProperties };
export type H2Props = { children?: ReactNode; style?: CSSProperties };
export type H3Props = { children?: ReactNode; style?: CSSProperties };

export function H1({ children, style }: H1Props) {
  const theme = useHostTheme();
  return (
    <h1
      style={mergeStyle(
        { margin: 0, fontSize: 24, lineHeight: "30px", fontWeight: 590, color: theme.text.primary },
        style,
      )}
    >
      {children}
    </h1>
  );
}

export function H2({ children, style }: H2Props) {
  const theme = useHostTheme();
  return (
    <h2
      style={mergeStyle(
        { margin: 0, fontSize: 18, lineHeight: "24px", fontWeight: 590, color: theme.text.primary },
        style,
      )}
    >
      {children}
    </h2>
  );
}

export function H3({ children, style }: H3Props) {
  const theme = useHostTheme();
  return (
    <h3
      style={mergeStyle(
        { margin: 0, fontSize: 16, lineHeight: "22px", fontWeight: 590, color: theme.text.primary },
        style,
      )}
    >
      {children}
    </h3>
  );
}

export type CodeProps = { children?: ReactNode; style?: CSSProperties };
export function Code({ children, style }: CodeProps) {
  const theme = useHostTheme();
  return (
    <code
      style={mergeStyle(
        {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "0.92em",
          background: theme.fill.secondary,
          padding: "1px 5px",
          borderRadius: 4,
        },
        style,
      )}
    >
      {children}
    </code>
  );
}

export type LinkProps = { children?: ReactNode; href: string; style?: CSSProperties };
export function Link({ children, href, style }: LinkProps) {
  const theme = useHostTheme();
  return (
    <a href={href} target="_blank" rel="noreferrer" style={mergeStyle({ color: theme.text.link }, style)}>
      {children}
    </a>
  );
}

export function CanvasChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d={expanded ? "M2.5 4.5 6 8l3.5-3.5" : "M4.5 2.5 8 6 4.5 9.5"}
        stroke="currentColor"
        strokeWidth={1.4}
      />
    </svg>
  );
}

type CardCtxValue = {
  size: "base" | "lg";
  open: boolean;
  collapsible: boolean;
  stickyHeader: boolean;
  toggle: () => void;
};
const CardCtx = createContext<CardCtxValue | null>(null);

export type CardSize = "base" | "lg";
export type CardVariant = "default" | "borderless";
export type CardProps = {
  children?: ReactNode;
  variant?: CardVariant;
  size?: CardSize;
  stickyHeader?: boolean;
  collapsible?: boolean;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  style?: CSSProperties;
};

export function Card({
  children,
  variant = "default",
  size = "base",
  stickyHeader,
  collapsible,
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  style,
}: CardProps) {
  const theme = useHostTheme();
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const open = openProp ?? uncontrolled;
  const toggle = () => {
    const next = !open;
    if (openProp == null) setUncontrolled(next);
    onOpenChange?.(next);
  };
  return (
    <CardCtx.Provider
      value={{
        size,
        open,
        collapsible: Boolean(collapsible),
        stickyHeader: Boolean(stickyHeader),
        toggle,
      }}
    >
      <div
        style={mergeStyle(
          {
            background: variant === "borderless" ? "transparent" : theme.bg.elevated,
            border: variant === "borderless" ? "none" : `1px solid ${theme.stroke.primary}`,
            borderRadius: variant === "borderless" ? 0 : 8,
            overflow: "hidden",
          },
          style,
        )}
      >
        {children}
      </div>
    </CardCtx.Provider>
  );
}

export type CardHeaderProps = {
  children?: ReactNode;
  trailing?: ReactNode;
  style?: CSSProperties;
};

export function CardHeader({ children, trailing, style }: CardHeaderProps) {
  const theme = useHostTheme();
  const card = useContext(CardCtx);
  const height = card?.size === "lg" ? 32 : 28;
  const inner = (
    <>
      {card?.collapsible ? (
        <span style={{ display: "inline-flex", marginRight: 6, color: theme.text.tertiary }}>
          <CanvasChevron expanded={card.open} />
        </span>
      ) : null}
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {children}
      </span>
      {trailing ? <span style={{ flex: "none", marginLeft: 8 }}>{trailing}</span> : null}
    </>
  );
  const chrome: CSSProperties = {
    display: "flex",
    alignItems: "center",
    height,
    padding: "0 10px",
    fontSize: 12,
    color: theme.text.secondary,
    borderBottom: card?.open === false ? "none" : `1px solid ${theme.stroke.tertiary}`,
    background: theme.bg.elevated,
    position: card?.stickyHeader ? "sticky" : undefined,
    top: card?.stickyHeader ? 0 : undefined,
    width: "100%",
  };
  if (card?.collapsible) {
    return (
      <button type="button" onClick={card.toggle} style={mergeStyle({ ...chrome, border: 0 }, style)}>
        {inner}
      </button>
    );
  }
  return <div style={mergeStyle(chrome, style)}>{inner}</div>;
}

export type CardBodyProps = { children?: ReactNode; style?: CSSProperties };
export function CardBody({ children, style }: CardBodyProps) {
  const card = useContext(CardCtx);
  if (card && !card.open) return null;
  return <div style={mergeStyle({ padding: 12 }, style)}>{children}</div>;
}

export type ButtonProps = {
  children?: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  style?: CSSProperties;
  onClick?: () => void;
};

export function Button({ children, variant = "secondary", disabled, type = "button", style, onClick }: ButtonProps) {
  const theme = useHostTheme();
  const palette =
    variant === "primary"
      ? { bg: theme.accent.control, color: theme.text.onAccent, border: "transparent" }
      : variant === "ghost"
        ? { bg: "transparent", color: theme.text.primary, border: "transparent" }
        : { bg: theme.fill.secondary, color: theme.text.primary, border: theme.stroke.primary };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={mergeStyle(
        {
          height: 24,
          padding: "0 10px",
          borderRadius: 6,
          border: `1px solid ${palette.border}`,
          background: palette.bg,
          color: palette.color,
          fontSize: 12,
          opacity: disabled ? 0.5 : 1,
          width: "auto",
        },
        style,
      )}
    >
      {children}
    </button>
  );
}

export type PillTone = "neutral" | "added" | "deleted" | "renamed" | "success" | "warning" | "info";
export type PillSize = "sm" | "md";
export type PillProps = {
  children?: ReactNode;
  active?: boolean;
  tone?: PillTone;
  size?: PillSize;
  leadingContent?: ReactNode;
  keyboardHint?: string;
  disabled?: boolean;
  title?: string;
  style?: CSSProperties;
  onClick?: () => void;
};

export function Pill({
  children,
  active,
  size = "md",
  leadingContent,
  keyboardHint,
  disabled,
  title,
  style,
  onClick,
}: PillProps) {
  const theme = useHostTheme();
  const sm = size === "sm";
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={mergeStyle(
        {
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: sm ? 20 : 24,
          padding: sm ? "0 6px" : "0 10px",
          borderRadius: 999,
          border: sm ? 0 : `1px solid ${theme.stroke.primary}`,
          background: active ? theme.fill.primary : "transparent",
          color: theme.text.primary,
          fontSize: sm ? 11 : 12,
          opacity: disabled ? 0.5 : 1,
        },
        style,
      )}
    >
      {leadingContent}
      {children}
      {keyboardHint ? <span style={{ color: theme.text.tertiary, fontSize: 11 }}>{keyboardHint}</span> : null}
    </button>
  );
}

export type StatTone = "success" | "danger" | "warning" | "info";
export type StatProps = {
  value: ReactNode;
  label: string;
  tone?: StatTone;
  style?: CSSProperties;
};

export function Stat({ value, label, tone, style }: StatProps) {
  const theme = useHostTheme();
  const color =
    tone === "success"
      ? theme.category.green
      : tone === "danger"
        ? theme.category.red
        : tone === "warning"
          ? theme.category.yellow
          : tone === "info"
            ? theme.category.blue
            : theme.text.primary;
  return (
    <div style={mergeStyle({ display: "flex", flexDirection: "column", gap: 2 }, style)}>
      <div style={{ fontSize: 22, lineHeight: "28px", fontWeight: 590, color }}>{value}</div>
      <div style={{ fontSize: 12, color: theme.text.tertiary }}>{label}</div>
    </div>
  );
}

export type CalloutTone = "info" | "success" | "warning" | "danger" | "neutral";
export type CalloutProps = {
  children?: ReactNode;
  tone?: CalloutTone;
  title?: ReactNode;
  icon?: ReactNode;
  style?: CSSProperties;
};

export function Callout({ children, tone = "neutral", title, icon, style }: CalloutProps) {
  const theme = useHostTheme();
  const accent =
    tone === "success"
      ? theme.category.green
      : tone === "danger"
        ? theme.category.red
        : tone === "warning"
          ? theme.category.yellow
          : tone === "info"
            ? theme.category.blue
            : theme.stroke.primary;
  return (
    <div
      style={mergeStyle(
        {
          display: "flex",
          gap: 10,
          padding: 10,
          borderRadius: 8,
          border: `1px solid ${theme.stroke.primary}`,
          background: theme.fill.quaternary,
        },
        style,
      )}
    >
      <span style={{ color: accent, flex: "none", width: 14 }}>{icon ?? "•"}</span>
      <div style={{ minWidth: 0 }}>
        {title ? <div style={{ fontWeight: 590, fontSize: 13, marginBottom: 4, color: theme.text.primary }}>{title}</div> : null}
        <div style={{ fontSize: 13, color: theme.text.secondary }}>{children}</div>
      </div>
    </div>
  );
}

const fieldStyle = (theme: ReturnType<typeof useHostTheme>): CSSProperties => ({
  height: 28,
  padding: "0 8px",
  borderRadius: 6,
  border: `1px solid ${theme.stroke.primary}`,
  background: theme.bg.editor,
  color: theme.text.primary,
  fontSize: 13,
  width: "100%",
});

export type TextInputProps = {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  type?: "text" | "email" | "password" | "number" | "url" | "search";
  style?: CSSProperties;
};

export function TextInput({ value, onChange, placeholder, disabled, type = "text", style }: TextInputProps) {
  const theme = useHostTheme();
  return (
    <input
      type={type}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => onChange?.(event.target.value)}
      style={mergeStyle(fieldStyle(theme), style)}
    />
  );
}

export type TextAreaProps = {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  style?: CSSProperties;
};

export function TextArea({ value, onChange, placeholder, disabled, rows = 3, style }: TextAreaProps) {
  const theme = useHostTheme();
  return (
    <textarea
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      rows={rows}
      onChange={(event) => onChange?.(event.target.value)}
      style={mergeStyle({ ...fieldStyle(theme), height: "auto", padding: 8, resize: "vertical" }, style)}
    />
  );
}

export type CheckboxProps = {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  style?: CSSProperties;
};

export function Checkbox({ checked, onChange, disabled, label, style }: CheckboxProps) {
  const theme = useHostTheme();
  return (
    <label style={mergeStyle({ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13 }, style)}>
      <input
        type="checkbox"
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.checked)}
        style={{ accentColor: theme.accent.primary }}
      />
      {label}
    </label>
  );
}

export type ToggleProps = {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  style?: CSSProperties;
};

export function Toggle({ checked, onChange, disabled, size = "sm", style }: ToggleProps) {
  const theme = useHostTheme();
  const w = size === "md" ? 36 : 28;
  const h = size === "md" ? 20 : 16;
  const knob = h - 4;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={Boolean(checked)}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      style={mergeStyle(
        {
          width: w,
          height: h,
          borderRadius: 99,
          border: 0,
          padding: 0,
          background: checked ? theme.accent.control : theme.fill.primary,
          position: "relative",
          opacity: disabled ? 0.5 : 1,
        },
        style,
      )}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? w - knob - 2 : 2,
          width: knob,
          height: knob,
          borderRadius: 99,
          background: checked ? theme.text.onAccent : theme.text.primary,
        }}
      />
    </button>
  );
}

export type SelectOption = { value: string; label: string; disabled?: boolean };
export type SelectProps = {
  value?: string;
  onChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  style?: CSSProperties;
};

export function Select({ value, onChange, options, placeholder, disabled, style }: SelectProps) {
  const theme = useHostTheme();
  return (
    <select
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => onChange?.(event.target.value)}
      style={mergeStyle({ ...fieldStyle(theme), colorScheme: "dark" }, style)}
    >
      {placeholder ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export type IconButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  variant?: "default" | "circle";
  size?: "sm" | "md";
  style?: CSSProperties;
};

export function IconButton({
  children,
  onClick,
  disabled,
  title,
  variant = "default",
  size = "md",
  style,
}: IconButtonProps) {
  const theme = useHostTheme();
  const box = size === "sm" ? 16 : 20;
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={mergeStyle(
        {
          width: box,
          height: box,
          borderRadius: variant === "circle" ? 99 : 4,
          border: 0,
          background: variant === "circle" ? theme.fill.secondary : "transparent",
          color: theme.text.secondary,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
        },
        style,
      )}
    >
      {children}
    </button>
  );
}

export type SwatchProps = { color: Color; style?: CSSProperties };
export function Swatch({ color, style }: SwatchProps) {
  const theme = useHostTheme();
  return (
    <span
      style={mergeStyle(
        { display: "inline-block", width: 24, height: 24, borderRadius: 6, background: theme.category[color] },
        style,
      )}
    />
  );
}

export type UsageBarSegment = {
  readonly id: string;
  readonly value: number;
  readonly color?: Color;
};
export type UsageBarProps = {
  readonly segments: readonly UsageBarSegment[];
  readonly total: number;
  readonly topLeftLabel?: ReactNode;
  readonly topRightLabel?: ReactNode;
  readonly style?: CSSProperties;
};

export function UsageBar({ segments, total, topLeftLabel, topRightLabel, style }: UsageBarProps) {
  const theme = useHostTheme();
  const sum = segments.reduce((acc, item) => acc + Math.max(0, item.value || 0), 0);
  const rest = Math.max(0, total - sum);
  return (
    <div style={style}>
      {topLeftLabel || topRightLabel ? (
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: theme.text.tertiary, marginBottom: 6 }}>
          <span>{topLeftLabel}</span>
          <span>{topRightLabel}</span>
        </div>
      ) : null}
      <div style={{ display: "flex", height: 8, borderRadius: 99, overflow: "hidden", background: theme.fill.tertiary, gap: 2 }}>
        {segments.map((item, index) => {
          const color = item.color || usageColorSequence[index % usageColorSequence.length];
          const width = total > 0 ? (Math.max(0, item.value) / total) * 100 : 0;
          if (width <= 0) return null;
          return <span key={item.id} style={{ width: `${width}%`, background: theme.category[color] }} />;
        })}
        {rest > 0 ? <span style={{ width: `${(rest / total) * 100}%`, background: theme.fill.primary }} /> : null}
      </div>
    </div>
  );
}

export type CollapsibleSectionProps = {
  title: string;
  leading?: ReactNode;
  count?: number;
  trailing?: ReactNode;
  children?: ReactNode;
  defaultOpen?: boolean;
  style?: CSSProperties;
};

export function CollapsibleSection({
  title,
  leading,
  count,
  trailing,
  children,
  defaultOpen,
  style,
}: CollapsibleSectionProps) {
  const theme = useHostTheme();
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <div style={style}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          border: 0,
          background: "transparent",
          color: theme.text.primary,
          padding: "6px 0",
          fontSize: 13,
        }}
      >
        <span style={{ color: theme.text.tertiary }}>
          <CanvasChevron expanded={open} />
        </span>
        {leading}
        <span style={{ flex: 1, textAlign: "left" }}>{title}</span>
        {count != null ? <span style={{ color: theme.text.tertiary }}>{count}</span> : null}
        {trailing ? <span style={{ color: theme.text.tertiary }}>{trailing}</span> : null}
      </button>
      {open ? <div style={{ paddingLeft: 20 }}>{children}</div> : null}
    </div>
  );
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
}
export type TodoListProps = {
  todos: readonly TodoItem[];
  dimmedTodoIds?: ReadonlySet<string>;
  onTodoClick?: (todo: TodoItem) => void;
  style?: CSSProperties;
};

function todoMark(status: TodoStatus) {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "●";
  if (status === "cancelled") return "×";
  return "○";
}

export function TodoList({ todos, dimmedTodoIds, onTodoClick, style }: TodoListProps) {
  const theme = useHostTheme();
  if (!todos.length) return null;
  return (
    <div style={mergeStyle({ display: "flex", flexDirection: "column", gap: 2 }, style)}>
      {todos.map((todo) => (
        <button
          key={todo.id}
          type="button"
          onClick={() => onTodoClick?.(todo)}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            border: 0,
            background: "transparent",
            color: theme.text.primary,
            textAlign: "left",
            padding: "6px 0",
            fontSize: 13,
            opacity: dimmedTodoIds?.has(todo.id) || todo.status === "cancelled" ? 0.5 : 1,
            textDecoration: todo.status === "completed" ? "line-through" : undefined,
          }}
        >
          <span style={{ color: theme.text.tertiary, width: 14 }}>{todoMark(todo.status)}</span>
          <span>{todo.content}</span>
        </button>
      ))}
    </div>
  );
}

export type TodoListCardProps = TodoListProps & { defaultExpanded?: boolean };

export function TodoListCard({ todos, dimmedTodoIds, defaultExpanded, onTodoClick, style }: TodoListCardProps) {
  const done = todos.filter((item) => item.status === "completed").length;
  return (
    <Card collapsible defaultOpen={defaultExpanded} style={style}>
      <CardHeader trailing={`${done} of ${todos.length} Done`}>Todos</CardHeader>
      <CardBody>
        <TodoList todos={todos} dimmedTodoIds={dimmedTodoIds} onTodoClick={onTodoClick} />
      </CardBody>
    </Card>
  );
}

export type DiffStatsProps = {
  additions?: number;
  deletions?: number;
  style?: CSSProperties;
};

export function DiffStats({ additions = 0, deletions = 0, style }: DiffStatsProps) {
  const theme = useHostTheme();
  if (!additions && !deletions) return null;
  return (
    <span style={mergeStyle({ fontVariantNumeric: "tabular-nums", fontSize: 12 }, style)}>
      {additions ? <span style={{ color: theme.diff.stripAdded }}>+{additions}</span> : null}
      {additions && deletions ? " " : null}
      {deletions ? <span style={{ color: theme.diff.stripRemoved }}>-{deletions}</span> : null}
    </span>
  );
}

export type DiffLineType = "added" | "removed" | "unchanged";
export type DiffLineData = { type: DiffLineType; content: string; lineNumber?: number };
export type DiffViewProps = {
  lines: DiffLineData[];
  path?: string;
  language?: string;
  showLineNumbers?: boolean;
  coloredLineNumbers?: boolean;
  showAccentStrip?: boolean;
  style?: CSSProperties;
};

export function DiffView({
  lines,
  showLineNumbers = true,
  coloredLineNumbers = true,
  showAccentStrip = true,
  style,
}: DiffViewProps) {
  const theme = useHostTheme();
  return (
    <pre
      style={mergeStyle(
        {
          margin: 0,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          lineHeight: "18px",
          overflow: "auto",
        },
        style,
      )}
    >
      {lines.map((line, index) => {
        const bg =
          line.type === "added"
            ? theme.diff.insertedLine
            : line.type === "removed"
              ? theme.diff.removedLine
              : "transparent";
        const strip =
          line.type === "added"
            ? theme.diff.stripAdded
            : line.type === "removed"
              ? theme.diff.stripRemoved
              : "transparent";
        const numColor =
          coloredLineNumbers && line.type === "added"
            ? theme.diff.stripAdded
            : coloredLineNumbers && line.type === "removed"
              ? theme.diff.stripRemoved
              : theme.text.quaternary;
        return (
          <div key={index} style={{ display: "flex", background: bg }}>
            {showAccentStrip ? <span style={{ width: 3, background: strip, flex: "none" }} /> : null}
            {showLineNumbers ? (
              <span style={{ width: 36, textAlign: "right", paddingRight: 8, color: numColor, flex: "none" }}>
                {line.lineNumber ?? ""}
              </span>
            ) : null}
            <span style={{ whiteSpace: "pre", paddingRight: 12 }}>{line.content}</span>
          </div>
        );
      })}
    </pre>
  );
}

export type DAGLayoutOptions = {
  nodes: Array<{ id: string }>;
  edges: Array<{ from: string; to: string }>;
  direction?: "vertical" | "horizontal";
  nodeWidth?: number;
  nodeHeight?: number;
  rankGap?: number;
  nodeGap?: number;
  padding?: number;
};
export type DAGLayoutNode = {
  id: string;
  x: number;
  y: number;
  rank: number;
  order: number;
};
export type DAGLayoutEdge = {
  from: string;
  to: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  isBackEdge: boolean;
};
export type DAGLayoutRank = {
  rank: number;
  x: number;
  y: number;
  width: number;
  height: number;
  nodeIds: string[];
};
export type DAGLayoutResult = {
  nodes: DAGLayoutNode[];
  edges: DAGLayoutEdge[];
  ranks: DAGLayoutRank[];
  direction: "vertical" | "horizontal";
  width: number;
  height: number;
};

export function computeDAGLayout(options: DAGLayoutOptions): DAGLayoutResult {
  const {
    nodes,
    edges,
    direction = "vertical",
    nodeWidth = 160,
    nodeHeight = 40,
    rankGap = 64,
    nodeGap = 48,
    padding = 24,
  } = options;
  const ids = nodes.map((node) => node.id);
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const id of ids) {
    outgoing.set(id, []);
    incoming.set(id, 0);
  }
  const seen = new Set<string>();
  const back = new Set<string>();
  const stack = new Set<string>();
  function visit(id: string) {
    seen.add(id);
    stack.add(id);
    for (const next of outgoing.get(id) || []) {
      const key = `${id}->${next}`;
      if (!seen.has(next)) visit(next);
      else if (stack.has(next)) back.add(key);
    }
    stack.delete(id);
  }
  for (const edge of edges) {
    if (!outgoing.has(edge.from) || !outgoing.has(edge.to)) continue;
    outgoing.get(edge.from)!.push(edge.to);
  }
  for (const id of ids) if (!seen.has(id)) visit(id);
  for (const edge of edges) {
    if (back.has(`${edge.from}->${edge.to}`)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
  }
  const rank = new Map<string, number>();
  const queue = ids.filter((id) => (incoming.get(id) || 0) === 0);
  for (const id of queue) rank.set(id, 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of outgoing.get(id) || []) {
      if (back.has(`${id}->${next}`)) continue;
      rank.set(next, Math.max(rank.get(next) || 0, (rank.get(id) || 0) + 1));
      incoming.set(next, (incoming.get(next) || 0) - 1);
      if ((incoming.get(next) || 0) === 0) queue.push(next);
    }
  }
  for (const id of ids) if (!rank.has(id)) rank.set(id, 0);
  const groups = new Map<number, string[]>();
  for (const id of ids) {
    const r = rank.get(id) || 0;
    const list = groups.get(r) || [];
    list.push(id);
    groups.set(r, list);
  }
  const ranks: DAGLayoutRank[] = [];
  const placed: DAGLayoutNode[] = [];
  const vertical = direction === "vertical";
  const maxRank = Math.max(0, ...rank.values());
  for (let r = 0; r <= maxRank; r++) {
    const nodeIds = groups.get(r) || [];
    nodeIds.forEach((id, order) => {
      const x = vertical ? padding + order * (nodeWidth + nodeGap) : padding + r * (nodeWidth + rankGap);
      const y = vertical ? padding + r * (nodeHeight + rankGap) : padding + order * (nodeHeight + nodeGap);
      placed.push({ id, x, y, rank: r, order });
    });
    const xs = placed.filter((node) => node.rank === r).map((node) => node.x);
    const ys = placed.filter((node) => node.rank === r).map((node) => node.y);
    ranks.push({
      rank: r,
      x: Math.min(...xs, padding),
      y: Math.min(...ys, padding),
      width: (xs.length ? Math.max(...xs) - Math.min(...xs) : 0) + nodeWidth,
      height: (ys.length ? Math.max(...ys) - Math.min(...ys) : 0) + nodeHeight,
      nodeIds,
    });
  }
  const byId = new Map(placed.map((node) => [node.id, node]));
  const laidEdges: DAGLayoutEdge[] = edges.map((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    const isBackEdge = back.has(`${edge.from}->${edge.to}`);
    if (!from || !to) {
      return { ...edge, sourceX: 0, sourceY: 0, targetX: 0, targetY: 0, isBackEdge };
    }
    if (vertical) {
      return {
        ...edge,
        sourceX: from.x + nodeWidth / 2,
        sourceY: from.y + nodeHeight,
        targetX: to.x + nodeWidth / 2,
        targetY: to.y,
        isBackEdge,
      };
    }
    return {
      ...edge,
      sourceX: from.x + nodeWidth,
      sourceY: from.y + nodeHeight / 2,
      targetX: to.x,
      targetY: to.y + nodeHeight / 2,
      isBackEdge,
    };
  });
  const width = Math.max(...placed.map((node) => node.x + nodeWidth), nodeWidth) + padding;
  const height = Math.max(...placed.map((node) => node.y + nodeHeight), nodeHeight) + padding;
  return { nodes: placed, edges: laidEdges, ranks, direction, width, height };
}

const SDK_EXPORTS = {
  useEffect,
  useMemo,
  useRef,
  useState,
  categoryPaletteDark,
  categoryPaletteLight,
  colorPalette,
  usageColorSequence,
  BarChart,
  LineChart,
  PieChart,
  CollapsibleSection,
  computeDAGLayout,
  DiffStats,
  DiffView,
  Checkbox,
  IconButton,
  Select,
  TextArea,
  TextInput,
  Toggle,
  useCanvasAction,
  useCanvasState,
  useHostTheme,
  Swatch,
  canvasPaletteDark,
  canvasPaletteLight,
  canvasTokens,
  canvasTokensLight,
  TodoList,
  TodoListCard,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Code,
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Link,
  mergeStyle,
  Pill,
  Row,
  Spacer,
  Stack,
  Stat,
  Table,
  Text,
  UsageBar,
};

export function createCanvasSdk() {
  return new Proxy(SDK_EXPORTS, {
    get(target, prop) {
      if (typeof prop === "symbol") return Reflect.get(target, prop);
      if (prop in target) return target[prop as keyof typeof target];
      throw new Error(`cursor/canvas 没有导出 "${String(prop)}"`);
    },
  });
}
