"use client";

import React from "react";
import { Calculations, type EquationsComponent, type EquationRow } from "@/lib/calculations";

// Base type used throughout calculations: a single unified component shape
// (node or edge) with optional geometry.
export type CalcComponent = EquationsComponent & {
  x?: number;
  y?: number;
};

// Shared helper: compute EquationRow[] from a components array in the same way
// the Calculation dialog does.
export function computeRowsFromComponents(components: CalcComponent[]): EquationRow[][] {
  if (!components.length) return [];
  try {
    // Assign a stable draw_index based on the incoming order. The canvas layer
    // guarantees that existing components keep their relative order and new
    // components are appended, so this index matches the on‑canvas numbering
    // and will not change for already‑drawn pipes/nodes.
    const withDrawIndex: CalcComponent[] = components.map((comp, idx) => ({
      ...(comp as CalcComponent),
      draw_index:
        typeof (comp as any).draw_index === "number" &&
        !Number.isNaN((comp as any).draw_index)
          ? (comp as any).draw_index
          : idx + 1,
    }));

    const calc = new Calculations({ components: withDrawIndex });
    return calc.toRows();
  } catch (err) {
    console.error("Error computing rows in computeRowsFromComponents", err);
    return [];
  }
}

export interface CalculateProps {
  // We keep this generic to avoid tight coupling; IsometricCanvas passes
  // its CanvasJson value here.
  canvas: any;
}
