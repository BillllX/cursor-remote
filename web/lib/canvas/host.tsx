"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { paletteSurfaces } from "../theme";
import {
  buildHostTokens,
  type CanvasPalette,
  type CanvasTokens,
} from "./tokens";

export type CanvasAction =
  | { type: "openAgent"; agentId: string }
  | { type: "newComposerChat"; userPrompt?: string }
  | {
      type: "openFile";
      path: string;
      selection?: { startLineNumber?: number; endLineNumber?: number };
    };

export type SetCanvasState<T> = (action: T | ((prev: T) => T)) => void;

export interface CanvasHostTheme extends CanvasTokens {
  readonly kind: string;
  readonly tokens: CanvasTokens;
  readonly palette: CanvasPalette;
}

type HostValue = {
  theme: CanvasHostTheme;
  storagePrefix: string;
  dispatch: (action: CanvasAction) => void;
};

const HostCtx = createContext<HostValue | null>(null);

export function buildHostTheme(
  kind = "dark",
  options?: { primary?: string; palette?: string | null },
): CanvasHostTheme {
  const light = kind === "light" || kind === "hc-light";
  const { tokens, palette } = buildHostTokens(light ? "light" : "dark", {
    primary: options?.primary,
    surfaces: paletteSurfaces(options?.palette, light ? "light" : "dark"),
  });
  return { ...tokens, kind: light ? "light" : "dark", tokens, palette };
}

export function CanvasRuntimeProvider({
  theme,
  storagePrefix,
  dispatch,
  children,
}: {
  theme: CanvasHostTheme;
  storagePrefix: string;
  dispatch: (action: CanvasAction) => void;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ theme, storagePrefix, dispatch }),
    [theme, storagePrefix, dispatch],
  );
  return <HostCtx.Provider value={value}>{children}</HostCtx.Provider>;
}

export function useHostTheme(): CanvasHostTheme {
  const host = useContext(HostCtx);
  if (host) return host.theme;
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    const kind = root.dataset.theme === "light" ? "light" : "dark";
    return buildHostTheme(kind, { palette: root.dataset.palette || "neutral" });
  }
  return buildHostTheme("dark", { palette: "neutral" });
}

export function useCanvasState<T>(key: string, defaultValue: T): [T, SetCanvasState<T>] {
  const host = useContext(HostCtx);
  const storageKey = `cursor-remote-canvas:${host?.storagePrefix || "local"}:${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(storageKey) : null;
      return raw != null ? (JSON.parse(raw) as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  });
  const set = useCallback<SetCanvasState<T>>(
    (action) => {
      setValue((prev) => {
        const next = typeof action === "function" ? (action as (prev: T) => T)(prev) : action;
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // quota
        }
        return next;
      });
    },
    [storageKey],
  );
  return [value, set];
}

export function useCanvasAction(): (action: CanvasAction) => void {
  const host = useContext(HostCtx);
  return host?.dispatch || (() => {});
}
