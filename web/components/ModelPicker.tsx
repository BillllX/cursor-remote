"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { groupModels, modelLabel, withCurrentModel } from "../lib/models";

type MenuPos = {
  top?: number;
  bottom?: number;
  left: number;
  maxHeight: number;
};

export default function ModelPicker({
  model,
  models,
  onChange,
  dismiss,
  onOpen,
}: {
  model: string;
  models: string[];
  onChange: (id: string) => void;
  dismiss?: boolean;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const groups = useMemo(
    () => groupModels(withCurrentModel(models, model)),
    [models, model],
  );
  const label = modelLabel(model);

  function placeMenu() {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const gap = 6;
    const width = Math.min(320, Math.max(228, rect.width));
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const below = window.innerHeight - rect.bottom - gap - 8;
    const above = rect.top - gap - 8;
    const openDown = below >= 220 || below >= above;
    const maxHeight = Math.min(360, Math.max(160, openDown ? below : above));
    setPos(
      openDown
        ? { top: rect.bottom + gap, left, maxHeight }
        : { bottom: window.innerHeight - rect.top + gap, left, maxHeight },
    );
  }

  useEffect(() => {
    if (dismiss) setOpen(false);
  }, [dismiss]);

  useLayoutEffect(() => {
    if (!open) return;
    placeMenu();
  }, [open, groups.length]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    const onReposition = () => placeMenu();
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open]);

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className={`model-picker-btn${open ? " open" : ""}`}
        title={`下一条用 ${label}`}
        aria-label="选择模型"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen((prev) => {
            const next = !prev;
            if (next) onOpen?.();
            return next;
          });
        }}
      >
        <span className="model-picker-label">{label}</span>
      </button>
      {open && pos ? (
        <div
          ref={menuRef}
          className="model-menu"
          role="listbox"
          aria-label="模型厂商"
          style={{
            top: pos.top,
            bottom: pos.bottom,
            left: pos.left,
            maxHeight: pos.maxHeight,
          }}
        >
          {groups.map((group) => (
            <div className="model-menu-group" key={group.vendor}>
              <div className="model-menu-vendor">{group.label}</div>
              {group.models.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={item.id === model}
                  className={item.id === model ? "on" : ""}
                  title={item.id}
                  onClick={() => {
                    onChange(item.id);
                    setOpen(false);
                  }}
                >
                  {item.name}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
