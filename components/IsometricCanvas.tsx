"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { computeRowsFromComponents } from "@/components/calculate";
import { supabase } from "@/lib/supabaseClient";
import { type EquationRow } from "@/lib/calculations";
import { utils as XLSXUtils, writeFile as writeXLSXFile } from "xlsx";

// Grid / geometry constants (match the visual grid)
const GRID_SIZE = 40; // distance between grid intersections in world space
const GRID_COUNT = 60; // half-extent of the isometric grid in logical steps (extended graph)
const DOT_RADIUS = 2;
const DISCHARGE_COLOR = "#2563eb"; // blue for discharge nodes

const ISO_ANGLE = Math.PI / 6; // 30° isometric projection angle
const COS_ANGLE = Math.cos(ISO_ANGLE);
const SIN_ANGLE = Math.sin(ISO_ANGLE);

const BG_COLOR = "#f7f7f5";
const GRID_COLOR = "#e5e7eb"; // lighter grey grid
const PIPE_COLOR = "#000000"; // lines in black
const SELECT_COLOR = "#000000"; // selected dots in black

// WebGL RGB triplets (0-1 range) matching the CSS hex colors above
const BG_COLOR_VEC: [number, number, number] = [0xf7 / 255, 0xf7 / 255, 0xf5 / 255];
const GRID_COLOR_VEC: [number, number, number] = [0xe5 / 255, 0xe7 / 255, 0xeb / 255];
const PIPE_COLOR_VEC: [number, number, number] = [0, 0, 0];
const DISCHARGE_COLOR_VEC: [number, number, number] = [0x25 / 255, 0x63 / 255, 0xeb / 255];
// Soft green highlight for pipes with complete input (diameter + length)
// Slightly lighter green so the band reads as subtle/translucent against the background.
const PIPE_HIGHLIGHT_COLOR_VEC: [number, number, number] = [0x4a / 255, 0xde / 255, 0x80 / 255]; // approx. green-400
// Translucent-ish blue highlight for selected components
const SELECT_HIGHLIGHT_COLOR_VEC: [number, number, number] = [0x60 / 255, 0xa5 / 255, 0xfa / 255]; // approx. blue-400
// Translucent-ish red highlight for components with extreme pressure
const PRESSURE_HIGHLIGHT_COLOR_VEC: [number, number, number] = [0xf9 / 255, 0x4c / 255, 0x66 / 255]; // approx. red-400

// Supported semantic types for nodes/edges
const ELEMENT_TYPES = [
  "pipe",
  "outlet",
  "discharge",
  "elbow45",
  "elbow90",
  "reducer",
  "tee",
] as const;

export type ElementType = (typeof ELEMENT_TYPES)[number];
export type ComponentKind = "node" | "edge";

export const NODE_ELEMENT_TYPES: ElementType[] = ELEMENT_TYPES.filter(
  (t) => t !== "pipe"
) as ElementType[];

export interface Point {
  x: number;
  y: number;
}

export interface Node {
  id: number;
  x: number; // world coordinates (after iso projection, before pan/zoom)
  y: number;
  type?: ElementType; // semantic type for this node
  capacity?: number;  // only meaningful when type === "outlet"
}

export interface Edge {
  id: number;
  fromId: number;
  toId: number;
  type?: ElementType; // semantic type for this segment (always "pipe" for edges)
  diameter?: number; // user-specified diameter for the pipe
  length?: number;   // user-specified length for the pipe
}


interface LabelDef {
  key: string;
  kind: ComponentKind;
  id: number;
  index: number;
  anchor: Point;
  position: Point;
}

function makeLabelKey(kind: ComponentKind, id: number): string {
  return `${kind}-${id}`;
}


function computeLabelDefs(
  nodes: Node[],
  edges: Edge[],
  zoom: number,
  componentOrder: { component: ComponentKind; id: number }[]
): LabelDef[] {
  // Build indices purely from drawing order: walk the canonical component
  // sequence and assign 1-based indices in that order.
  const nodeIndex = new Map<number, number>();
  const edgeIndex = new Map<number, number>();

  componentOrder.forEach((entry, idx) => {
    const index = idx + 1;
    if (entry.component === "node") {
      if (!nodeIndex.has(entry.id)) {
        nodeIndex.set(entry.id, index);
      }
    } else {
      if (!edgeIndex.has(entry.id)) {
        edgeIndex.set(entry.id, index);
      }
    }
  });

  const labels: LabelDef[] = [];

  const defaultNodeOffsetPx = 14;

  for (const node of nodes) {
    const idx = nodeIndex.get(node.id);
    if (!idx) continue;
    const anchor: Point = { x: node.x, y: node.y };
    const key = makeLabelKey("node", node.id);

    const position: Point = {
      x: anchor.x,
      y: anchor.y - defaultNodeOffsetPx / zoom,
    };

    labels.push({
      key,
      kind: "node",
      id: node.id,
      index: idx,
      anchor,
      position,
    });
  }

  const defaultEdgeOffsetPx = 16;

  for (const edge of edges) {
    const idx = edgeIndex.get(edge.id);
    if (!idx) continue;
    const from = nodes.find((n) => n.id === edge.fromId);
    const to = nodes.find((n) => n.id === edge.toId);
    if (!from || !to) continue;

    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const anchor: Point = { x: mx, y: my };

    const key = makeLabelKey("edge", edge.id);

    // Offset the default label along the normal in world units so it sits a
    // bit off the pipe centerline.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const segLen = Math.hypot(dx, dy) || 1;
    const nx = -dy / segLen;
    const ny = dx / segLen;
    const offsetWorld = defaultEdgeOffsetPx / zoom;
    const position: Point = {
      x: mx + nx * offsetWorld,
      y: my + ny * offsetWorld,
    };

    labels.push({
      key,
      kind: "edge",
      id: edge.id,
      index: idx,
      anchor,
      position,
    });
  }

  return labels;
}

function getDefaultNodeType(existingNodes: Node[]): ElementType {
  // The very first node on an empty canvas is treated as the discharge by
  // default. Subsequent nodes default to elbow90 unless explicitly changed.
  if (existingNodes.length === 0) {
    return "discharge";
  }
  return "elbow90";
}

// One canonical list, preserving creation order
export type CanvasComponent =
  | ({ component: "node" } & Node)
  | ({ component: "edge" } & Edge);

// Canonical JSON-serializable shape for the entire canvas
export interface CanvasJson {
  components: CanvasComponent[];
}

// Single-step snapshot of the logical canvas state used for Ctrl+Z/Ctrl+Y
// undo/redo.
interface CanvasSnapshot {
  nodes: Node[];
  edges: Edge[];
  componentOrder: { component: ComponentKind; id: number }[];
}

function worldToScreen(p: Point, canvas: HTMLCanvasElement, offset: Point, zoom: number): Point {
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2 + offset.x;
  const cy = h / 2 + offset.y;
  return {
    x: cx + p.x * zoom,
    y: cy + p.y * zoom,
  };
}

function screenToWorld(
  sx: number,
  sy: number,
  canvas: HTMLCanvasElement,
  offset: Point,
  zoom: number
): Point {
  const rect = canvas.getBoundingClientRect();
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2 + offset.x;
  const cy = h / 2 + offset.y;
  const x = (sx - rect.left - cx) / zoom;
  const y = (sy - rect.top - cy) / zoom;
  return { x, y };
}

// Given a world-space point, snap it to the nearest isometric grid intersection
// in world space. (Kept for reference; drawing now uses a screen-aware variant
// below to better match what the user sees.)
function snapWorldToIsoGrid(x: number, y: number): Point {
  // Guard against degenerate configuration (not expected in practice)
  if (!GRID_SIZE || !COS_ANGLE || !SIN_ANGLE) {
    return { x, y };
  }

  const u = x / (GRID_SIZE * COS_ANGLE); // i - j
  const v = y / (GRID_SIZE * SIN_ANGLE); // i + j

  const i = Math.round((u + v) / 2);
  const j = Math.round((v - u) / 2);

  const snappedX = (i - j) * GRID_SIZE * COS_ANGLE;
  const snappedY = (i + j) * GRID_SIZE * SIN_ANGLE;

  return { x: snappedX, y: snappedY };
}

// Snap directly from screen space to the nearest isometric grid intersection,
// choosing the dot that is closest *in screen pixels* so it matches the cursor
// visually (avoids the feeling that the click grabs a dot "above" the cursor).
function snapScreenToIsoGrid(
  sx: number,
  sy: number,
  canvas: HTMLCanvasElement,
  offset: Point,
  zoom: number
): Point {
  if (!GRID_SIZE || !COS_ANGLE || !SIN_ANGLE) {
    // Fallback: just convert to world coords without snapping
    return screenToWorld(sx, sy, canvas, offset, zoom);
  }

  // Start from the analytic world-space point
  const rawWorld = screenToWorld(sx, sy, canvas, offset, zoom);

  // Compute the fractional grid coordinates (i, j) in isometric space
  const u = rawWorld.x / (GRID_SIZE * COS_ANGLE); // i - j
  const v = rawWorld.y / (GRID_SIZE * SIN_ANGLE); // i + j

  const iApprox = (u + v) / 2;
  const jApprox = (v - u) / 2;

  const iCenter = Math.round(iApprox);
  const jCenter = Math.round(jApprox);

  let bestWorld: Point | null = null;
  let bestDist = Number.POSITIVE_INFINITY;

  // Check a small neighborhood of grid intersections around the analytic
  // solution and pick the one that is closest *in screen space*.
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const i = iCenter + di;
      const j = jCenter + dj;

      const worldCandidate: Point = {
        x: (i - j) * GRID_SIZE * COS_ANGLE,
        y: (i + j) * GRID_SIZE * SIN_ANGLE,
      };

      const screenCandidate = worldToScreen(
        worldCandidate,
        canvas,
        offset,
        zoom
      );

      const dx = sx - screenCandidate.x;
      const dy = sy - screenCandidate.y;
      const d = Math.hypot(dx, dy);

      if (d < bestDist) {
        bestDist = d;
        bestWorld = worldCandidate;
      }
    }
  }

  return bestWorld ?? rawWorld;
}

// Helpers for working with the underlying isometric grid coordinates.
interface IsoGridCoords {
  i: number;
  j: number;
}

function worldToIsoIndices(x: number, y: number): IsoGridCoords {
  const u = x / (GRID_SIZE * COS_ANGLE); // i - j
  const v = y / (GRID_SIZE * SIN_ANGLE); // i + j
  const i = Math.round((u + v) / 2);
  const j = Math.round((v - u) / 2);
  return { i, j };
}

function isoIndicesToWorld(i: number, j: number): Point {
  return {
    x: (i - j) * GRID_SIZE * COS_ANGLE,
    y: (i + j) * GRID_SIZE * SIN_ANGLE,
  };
}

// Given a starting world-space point that lies on the isometric grid,
// constrain the target so the segment runs only along one of the three
// isometric axes (x, y, z) or their negatives. Here:
// - x axis: along +/−(1, 0) in (i, j) space
// - y axis: along +/−(0, 1) in (i, j) space
// - z axis: along +/−(1, 1) in (i, j) space, which appears vertical onscreen.
function snapFromStartToAxis(
  start: Point,
  sx: number,
  sy: number,
  canvas: HTMLCanvasElement,
  offset: Point,
  zoom: number
): Point {
  if (!GRID_SIZE || !COS_ANGLE || !SIN_ANGLE) {
    return screenToWorld(sx, sy, canvas, offset, zoom);
  }

  const rawWorld = screenToWorld(sx, sy, canvas, offset, zoom);

  // Iso indices for start and approximate target
  const { i: i0, j: j0 } = worldToIsoIndices(start.x, start.y);

  const u = rawWorld.x / (GRID_SIZE * COS_ANGLE); // i - j
  const v = rawWorld.y / (GRID_SIZE * SIN_ANGLE); // i + j

  const iApprox = (u + v) / 2;
  const jApprox = (v - u) / 2;

  // Candidate 1: move only along ±x (Δi ≠ 0, Δj = 0)
  const iAxisX = Math.round(iApprox);
  const jAxisX = j0;
  const worldX = isoIndicesToWorld(iAxisX, jAxisX);

  // Candidate 2: move only along ±y (Δi = 0, Δj ≠ 0)
  const iAxisY = i0;
  const jAxisY = Math.round(jApprox);
  const worldY = isoIndicesToWorld(iAxisY, jAxisY);

  // Candidate 3: move only along ±z (vertical grid direction: Δi = Δj)
  const di = iApprox - i0;
  const dj = jApprox - j0;
  const nApprox = (di + dj) / 2;
  const n = Math.round(nApprox);
  const iAxisZ = i0 + n;
  const jAxisZ = j0 + n;
  const worldZ = isoIndicesToWorld(iAxisZ, jAxisZ);

  // Pick whichever candidate is closest to the cursor in screen space
  const candidates: Point[] = [worldX, worldY, worldZ];
  let best = candidates[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const w of candidates) {
    const s = worldToScreen(w, canvas, offset, zoom);
    const dx = sx - s.x;
    const dy = sy - s.y;
    const d = Math.hypot(dx, dy);
    if (d < bestDist) {
      bestDist = d;
      best = w;
    }
  }

  return best;
}

function distancePointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))
  );
  const closestX = a.x + t * dx;
  const closestY = a.y + t * dy;
  return Math.hypot(p.x - closestX, p.y - closestY);
}

// WebGL types and helpers
interface GLResources {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  attribLocationPosition: number;
  attribLocationColor: number;
  bufferLines: WebGLBuffer;
  bufferTriangles: WebGLBuffer;
}

// Convert world-space coordinates to clip space (-1..1) using the same
// pan/zoom convention as worldToScreen.
function worldToClip(
  p: Point,
  canvas: HTMLCanvasElement,
  offset: Point,
  zoom: number
): { x: number; y: number } {
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2 + offset.x;
  const cy = h / 2 + offset.y;

  const sx = cx + p.x * zoom;
  const sy = cy + p.y * zoom;

  const ndcX = (sx / w) * 2 - 1;
  const ndcY = 1 - (sy / h) * 2; // flip Y

  return { x: ndcX, y: ndcY };
}

function initWebGL(canvas: HTMLCanvasElement): GLResources | null {
  const gl =
    (canvas.getContext("webgl", { preserveDrawingBuffer: true }) as
      | WebGLRenderingContext
      | null) ??
    (canvas.getContext("experimental-webgl", { preserveDrawingBuffer: true }) as
      | WebGLRenderingContext
      | null);
  if (!gl) return null;

  const vertSrc = `
    attribute vec2 a_position;
    attribute vec4 a_color;
    varying vec4 v_color;
    void main() {
      v_color = a_color;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const fragSrc = `
    precision mediump float;
    varying vec4 v_color;
    void main() {
      gl_FragColor = v_color;
    }
  `;

  const compile = (type: number, src: string): WebGLShader => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "shader compile failed");
    }
    return shader;
  };

  const vs = compile(gl.VERTEX_SHADER, vertSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fragSrc);

  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "program link failed");
  }

  gl.useProgram(program);

  const attribLocationPosition = gl.getAttribLocation(program, "a_position");
  const attribLocationColor = gl.getAttribLocation(program, "a_color");

  gl.enableVertexAttribArray(attribLocationPosition);
  gl.enableVertexAttribArray(attribLocationColor);

  const bufferLines = gl.createBuffer()!;
  const bufferTriangles = gl.createBuffer()!;

  return {
    gl,
    program,
    attribLocationPosition,
    attribLocationColor,
    bufferLines,
    bufferTriangles,
  };
}

export default function IsometricCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();

  const projectId = searchParams.get("projectId");
  const fileId = searchParams.get("fileId");
  const exportAction = searchParams.get("export");
  const hasProjectContext = !!projectId;

  const handleBack = () => {
    const orgIdFromQuery = searchParams.get("orgId");
    let targetOrgId: string | null = orgIdFromQuery;

    if (!targetOrgId && typeof window !== "undefined") {
      const stored = window.localStorage.getItem("currentOrgId");
      targetOrgId = stored ?? null;
    }

    if (targetOrgId && projectId) {
      router.push(`/orgs/${targetOrgId}/projects/${projectId}`);
    } else {
      // Fallback if we don't know the org or project context
      router.push("/");
    }
  };

  const [fileName, setFileName] = useState<string>("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [loadedFileId, setLoadedFileId] = useState<string | null>(null);

  // Pan/zoom state (original infinite canvas behavior)
  const [zoom, setZoom] = useState(0.7);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPos, setLastPanPos] = useState<Point>({ x: 0, y: 0 });

  // Drawing state
  const [drawingEnabled, setDrawingEnabled] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  // Calculate popover state
  const [calculateOpen, setCalculateOpen] = useState(false);
  const [calculateError, setCalculateError] = useState<string | null>(null);

  // Export dropdown state
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);

  // Nodes created by clicking on an existing line while in drawing mode
  // start as tees and are automatically converted to reducers if drawing
  // mode is turned off without branching from them.
  const [pendingReducerIds, setPendingReducerIds] = useState<number[]>([]);

  // Track a single ordered list of components by kind + id
  const [componentOrder, setComponentOrder] = useState<
    { component: ComponentKind; id: number }[]
  >([]);

  // WebGL state
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const glResourcesRef = useRef<GLResources | null>(null);

  // Combined JSON-friendly representation of the canvas as a single ordered list
  // in drawing order. We deliberately **deduplicate** by (component kind, id)
  // so that helper entries used only for ordering (e.g., trailing tee nodes)
  // do not appear as extra hydraulic components.
  const canvasJson: CanvasJson = {
    components: (() => {
      const seen = new Set<string>();
      const list: CanvasComponent[] = [];

      for (const entry of componentOrder) {
        const key = `${entry.component}:${entry.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (entry.component === "node") {
          const node = nodes.find((n) => n.id === entry.id);
          if (node) {
            list.push({ component: "node", ...node });
          }
        } else {
          const edge = edges.find((e) => e.id === entry.id);
          if (edge) {
            list.push({ component: "edge", ...edge });
          }
        }
      }

      return list;
    })(),
  };

  // Canonical order used for all indexing (labels, tables, popovers): this is
  // exactly the sequence given to the Equations solver.
  const canonicalOrder = useMemo<{
    component: ComponentKind;
    id: number;
  }[]>(
    () =>
      canvasJson.components.map((c) => ({
        component: c.component,
        id: c.id,
      })),
    [canvasJson]
  );

  // Precompute hydraulic rows for the current canvas so we can surface
  // velocity/pressure in the popovers. Reuse the same logic as the
  // Calculation dialog so everything stays in sync.
  // We now have multiple EquationRow[] groups (e.g. one per outlet path).
  const equationRowGroups = useMemo<EquationRow[][]>(() => {
    if (!canvasJson.components.length) return [];
    return computeRowsFromComponents(canvasJson.components as any[]);
  }, [canvasJson]);

  // For UI elements (popovers, labels) that expect a single sequence, we
  // flatten all groups into one array while preserving each group's order.
  const flatEquationRows = useMemo<EquationRow[]>(() => {
    return equationRowGroups.flat();
  }, [equationRowGroups]);

  // Global pressure stats (over all components) and per-outlet summaries used
  // in the Calculate dialog.
  const pressureStats = useMemo(() => {
    if (!flatEquationRows.length) {
      return {
        maxP: 0,
        minP: 0,
        outletSummaries: [] as {
          outletIndex: number;
          maxP: number;
          minP: number;
          deltaP: number;
          sumH: number;
        }[],
      };
    }

    let globalMaxP = -Infinity;
    let globalMinP = Infinity;

    for (const row of flatEquationRows) {
      const p = typeof row.delta_P === "number" ? row.delta_P : 0;
      if (p > globalMaxP) globalMaxP = p;
      if (p < globalMinP) globalMinP = p;
    }

    const outletSummaries = equationRowGroups.map((rows, idx) => {
      if (!rows.length) {
        return {
          outletIndex: idx + 1,
          maxP: 0,
          minP: 0,
          deltaP: 0,
          sumH: 0,
        };
      }

      let maxP = -Infinity;
      let minP = Infinity;
      let sumH = 0;

      for (const row of rows) {
        const p = typeof row.delta_P === "number" ? row.delta_P : 0;
        const h = typeof row.delta_H === "number" ? row.delta_H : 0;
        if (p > maxP) maxP = p;
        if (p < minP) maxP = p;
        sumH += h;
      }

      const firstRow = rows[0];
      const lastRow = rows[rows.length - 1];

      const dischargeP =
        firstRow && typeof firstRow.delta_P === "number" ? firstRow.delta_P : 0;

      const outletP =
        lastRow && typeof lastRow.delta_P === "number" ? lastRow.delta_P : 0;

      return {
        outletIndex: idx + 1,
        maxP,
        minP,
        deltaP: dischargeP - outletP,
        sumH,
      };
    });

    return {
      maxP: Number.isFinite(globalMaxP) ? globalMaxP : 0,
      minP: Number.isFinite(globalMinP) ? globalMinP : 0,
      outletSummaries,
    };
  }, [flatEquationRows, equationRowGroups]);

  // Map from (component kind, id) to its 1-based index in the **canonical**
  // order used by the Equations solver. This keeps graph labels, popovers, and
  // the calculation table perfectly in sync.
  const componentIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    canonicalOrder.forEach((entry, idx) => {
      map.set(`${entry.component}:${entry.id}`, idx + 1);
    });
    return map;
  }, [canonicalOrder]);

  const [currentNodeId, setCurrentNodeId] = useState<number | null>(null);
  const [ghostEnd, setGhostEnd] = useState<Point | null>(null);
  const nextIdRef = useRef(1);

  // Load an existing canvas from the database when a fileId is present in the URL.
  useEffect(() => {
    if (!fileId || fileId === loadedFileId) return;

    const load = async () => {
      try {
        const { data, error } = await supabase
          .from("project_files")
          .select("name, data")
          .eq("id", fileId)
          .single();

        if (error) {
          console.error("Error loading canvas file", error);
          return;
        }

        const canvas = data?.data as CanvasJson | null;
        if (!canvas || !Array.isArray(canvas.components)) return;

        const loadedNodes: Node[] = [];
        const loadedEdges: Edge[] = [];
        const newOrder: { component: ComponentKind; id: number }[] = [];

        for (const comp of canvas.components as CanvasComponent[]) {
          if (comp.component === "node") {
            const { component, ...node } = comp;
            loadedNodes.push(node as Node);
          } else if (comp.component === "edge") {
            const { component, ...edge } = comp;
            loadedEdges.push(edge as Edge);
          }
          newOrder.push({ component: comp.component, id: comp.id });
        }

        setNodes(loadedNodes);
        setEdges(loadedEdges);
        setComponentOrder(newOrder);

        const maxNodeId = loadedNodes.reduce((max, n) => Math.max(max, n.id), 0);
        const maxEdgeId = loadedEdges.reduce((max, e) => Math.max(max, e.id), 0);
        nextIdRef.current = Math.max(maxNodeId, maxEdgeId, 0) + 1;

        setFileName(data?.name ?? "");
        setLoadedFileId(fileId);
      } catch (err) {
        console.error("Unexpected error loading canvas file", err);
      }
    };

    load();
  }, [fileId, loadedFileId]);

  // We no longer maintain a separate trailing tee entry in componentOrder.
  // When splitting a pipe, we only insert the new node between the two new
  // pipes. When continuing from a node, we simply append the new pipe (and
  // possibly a new node) to the end of the list.

  // Selection popover state (when drawing is disabled)
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<number | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<Point | null>(null);
  // Multi-selection state for nodes and edges (used with Ctrl/Cmd-click).
  const [multiSelectedNodeIds, setMultiSelectedNodeIds] = useState<number[]>([]);
  const [multiSelectedEdgeIds, setMultiSelectedEdgeIds] = useState<number[]>([]);
  const suppressNextClickRef = useRef(false);
  const [selectionRect, setSelectionRect] = useState<
    | {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
      }
    | null
  >(null);

  // Single-step undo/redo snapshots: the most recent *previous* state and the
  // state that was undone (for Ctrl+Y).
  const undoSnapshotRef = useRef<CanvasSnapshot | null>(null);
  const redoSnapshotRef = useRef<CanvasSnapshot | null>(null);

  const saveSnapshotForUndo = useCallback(() => {
    undoSnapshotRef.current = {
      nodes: nodes.map((n) => ({ ...n })),
      edges: edges.map((e) => ({ ...e })),
      componentOrder: componentOrder.map((e) => ({ ...e })),
    };
    // Once a new change happens, the old redo target is no longer valid.
    redoSnapshotRef.current = null;
  }, [nodes, edges, componentOrder]);

  // Delete handler (single or multi-selected components).
  const handleDeleteSelected = useCallback(() => {
    // Determine which components to delete: prefer multi-selection if present,
    // otherwise fall back to the single selected component.
    const edgeIdsToDelete =
      multiSelectedEdgeIds.length > 0
        ? multiSelectedEdgeIds
        : selectedEdgeId != null
        ? [selectedEdgeId]
        : [];

    const nodeIdsToDelete =
      multiSelectedNodeIds.length > 0
        ? multiSelectedNodeIds
        : selectedNodeId != null
        ? [selectedNodeId]
        : [];

    if (edgeIdsToDelete.length === 0 && nodeIdsToDelete.length === 0) {
      return;
    }

    // Snapshot current state so Ctrl+Z can restore it.
    saveSnapshotForUndo();

    // When deleting nodes, also delete any incident edges.
    const incidentEdgeIdsFromNodes = edges
      .filter((e) =>
        nodeIdsToDelete.some((nid) => e.fromId === nid || e.toId === nid)
      )
      .map((e) => e.id);

    const allEdgeIdsToDelete = Array.from(
      new Set([...edgeIdsToDelete, ...incidentEdgeIdsFromNodes])
    );

    if (nodeIdsToDelete.length > 0) {
      setNodes((prevNodes) =>
        prevNodes.filter((n) => !nodeIdsToDelete.includes(n.id))
      );
    }

    if (allEdgeIdsToDelete.length > 0) {
      setEdges((prevEdges) =>
        prevEdges.filter((e) => !allEdgeIdsToDelete.includes(e.id))
      );
    }

    if (nodeIdsToDelete.length > 0 || allEdgeIdsToDelete.length > 0) {
      setComponentOrder((prev) =>
        prev.filter((entry) => {
          if (
            entry.component === "node" &&
            nodeIdsToDelete.includes(entry.id)
          )
            return false;
          if (
            entry.component === "edge" &&
            allEdgeIdsToDelete.includes(entry.id)
          )
            return false;
          return true;
        })
      );
    }

    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setMultiSelectedNodeIds([]);
    setMultiSelectedEdgeIds([]);
    setPopoverOpen(false);
  }, [selectedEdgeId, selectedNodeId, multiSelectedEdgeIds, multiSelectedNodeIds, edges]);

  // Resize canvas to fill its container / viewport
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      const width = parent?.clientWidth ?? window.innerWidth;
      const height = parent?.clientHeight ?? window.innerHeight;
      canvas.width = width;
      canvas.height = height;
    };

    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // Keyboard shortcuts: 'd' toggles drawing mode, Esc cancels drawing,
  // Delete removes the currently selected component, Ctrl+Z/Cmd+Z undoes last
  // segment, Ctrl+Y/Cmd+Y redoes that undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // If there is a *multi*-selection and the user presses Delete/Backspace,
      // delete the selected components. Do not intercept Backspace/Delete when
      // the event target is an editable element (inputs, textareas, etc.), so
      // users can freely edit capacity/length/diameter fields.
      if (e.key === "Delete" || e.key === "Backspace") {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        const isEditable =
          (tag === "INPUT" || tag === "TEXTAREA") ||
          (target as any)?.isContentEditable;
        const hasMultiSelection =
          multiSelectedEdgeIds.length > 0 || multiSelectedNodeIds.length > 0;

        if (!isEditable && hasMultiSelection) {
          e.preventDefault();
          handleDeleteSelected();
          return;
        }
        // Otherwise, let the key press behave normally (e.g. editing text).
      }

      if (e.key === "d" || e.key === "D") {
        setDrawingEnabled((prev) => !prev);
        setCurrentNodeId(null);
        setGhostEnd(null);
      } else if (e.key === "Escape") {
        setDrawingEnabled(false);
        setCurrentNodeId(null);
        setGhostEnd(null);
      } else if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey)) {
        // Ctrl+Z / Cmd+Z: undo the most recent change (draw, delete, or edit).
        e.preventDefault();
        const snap = undoSnapshotRef.current;
        if (!snap) {
          return;
        }

        // Save current state so Ctrl+Y can reapply it.
        redoSnapshotRef.current = {
          nodes: nodes.map((n) => ({ ...n })),
          edges: edges.map((e) => ({ ...e })),
          componentOrder: componentOrder.map((e) => ({ ...e })),
        };

        // Restore the snapshot and clear it so a second Ctrl+Z does nothing.
        setNodes(snap.nodes.map((n) => ({ ...n })));
        setEdges(snap.edges.map((e) => ({ ...e })));
        setComponentOrder(snap.componentOrder.map((e) => ({ ...e })));
        undoSnapshotRef.current = null;

        // Clear selection/popover after undo.
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
        setMultiSelectedNodeIds([]);
        setMultiSelectedEdgeIds([]);
        setPopoverOpen(false);
      } else if ((e.key === "y" || e.key === "Y") && (e.ctrlKey || e.metaKey)) {
        // Ctrl+Y / Cmd+Y: redo the last undo (if any).
        e.preventDefault();
        const snap = redoSnapshotRef.current;
        if (!snap) {
          return;
        }

        // Save current state so another Ctrl+Z can undo this redo.
        undoSnapshotRef.current = {
          nodes: nodes.map((n) => ({ ...n })),
          edges: edges.map((e) => ({ ...e })),
          componentOrder: componentOrder.map((e) => ({ ...e })),
        };

        setNodes(snap.nodes.map((n) => ({ ...n })));
        setEdges(snap.edges.map((e) => ({ ...e })));
        setComponentOrder(snap.componentOrder.map((e) => ({ ...e })));
        redoSnapshotRef.current = null;

        setSelectedNodeId(null);
        setSelectedEdgeId(null);
        setMultiSelectedNodeIds([]);
        setMultiSelectedEdgeIds([]);
        setPopoverOpen(false);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nodes, edges, componentOrder, popoverOpen, selectedEdgeId, selectedNodeId, multiSelectedEdgeIds, multiSelectedNodeIds, handleDeleteSelected]);

  // Mouse wheel: zoom around the cursor (no clamping beyond basic limits)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomIntensity = 0.1;
      const delta = (-e.deltaY * zoomIntensity) / 100;
      const minZoom = 0.2;
      const maxZoom = 5;
      const newZoom = Math.min(Math.max(zoom + delta, minZoom), maxZoom);

      // Zoom around cursor: adjust offset so the point under cursor stays fixed
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const before = screenToWorld(mouseX, mouseY, canvas, offset, zoom);
      const after = screenToWorld(mouseX, mouseY, canvas, offset, newZoom);

      setOffset((o) => ({
        x: o.x + (after.x - before.x) * newZoom,
        y: o.y + (after.y - before.y) * newZoom,
      }));

      setZoom(newZoom);
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [zoom, offset]);

  // Mouse drag: pan the canvas when not drawing, or begin a Shift-drag
  // marquee selection.
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (drawingEnabled || e.button !== 0) return;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (e.shiftKey) {
        // Begin selection rectangle in canvas-space coordinates.
        setSelectionRect({ x1: sx, y1: sy, x2: sx, y2: sy });
        setIsPanning(false);
      } else {
        setIsPanning(true);
        setLastPanPos({ x: e.clientX, y: e.clientY });
      }
    },
    [drawingEnabled]
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);

    // Finalise Shift-drag selection (if active).
    if (selectionRect) {
      const canvas = canvasRef.current;
      if (canvas) {
        const { x1, y1, x2, y2 } = selectionRect;
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);

        const selectedNodeIds: number[] = [];
        const selectedEdgeIds: number[] = [];

        // Nodes inside the rectangle (using canvas-space coordinates).
        for (const n of nodes) {
          const screen = worldToScreen({ x: n.x, y: n.y }, canvas, offset, zoom);
          if (
            screen.x >= minX &&
            screen.x <= maxX &&
            screen.y >= minY &&
            screen.y <= maxY
          ) {
            selectedNodeIds.push(n.id);
          }
        }

        // Edges whose midpoints fall inside the rectangle.
        for (const edge of edges) {
          const fromNode = nodes.find((n) => n.id === edge.fromId);
          const toNode = nodes.find((n) => n.id === edge.toId);
          if (!fromNode || !toNode) continue;
          const fromScreen = worldToScreen(
            { x: fromNode.x, y: fromNode.y },
            canvas,
            offset,
            zoom
          );
          const toScreen = worldToScreen(
            { x: toNode.x, y: toNode.y },
            canvas,
            offset,
            zoom
          );
          const midX = (fromScreen.x + toScreen.x) / 2;
          const midY = (fromScreen.y + toScreen.y) / 2;
          if (midX >= minX && midX <= maxX && midY >= minY && midY <= maxY) {
            selectedEdgeIds.push(edge.id);
          }
        }

        setMultiSelectedNodeIds(selectedNodeIds);
        setMultiSelectedEdgeIds(selectedEdgeIds);

        // Clear primary selection; user can click again to open a popover for
        // one of the selected components if needed.
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
        setPopoverOpen(false);
      }

      setSelectionRect(null);
      // Avoid treating the mouseup at the end of a drag as a normal click that
      // would clear the multi-selection.
      suppressNextClickRef.current = true;
    }
  }, [selectionRect, nodes, edges, offset, zoom]);

  const handleMouseMovePan = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      // If a selection rectangle is active, update its far corner in canvas
      // coordinates instead of panning.
      if (selectionRect) {
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        setSelectionRect((prev) => (prev ? { ...prev, x2: sx, y2: sy } : prev));
        return;
      }

      if (!isPanning) return;
      const dx = e.clientX - lastPanPos.x;
      const dy = e.clientY - lastPanPos.y;
      setOffset((o) => ({ x: o.x + dx, y: o.y + dy }));
      setLastPanPos({ x: e.clientX, y: e.clientY });
    },
    [isPanning, lastPanPos, selectionRect]
  );

  // Helper: find an existing node near a world point
  const findNearbyNode = (world: Point, tol: number): Node | null => {
    let best: Node | null = null;
    let bestDist = tol;
    for (const n of nodes) {
      const d = Math.hypot(world.x - n.x, world.y - n.y);
      if (d <= bestDist) {
        bestDist = d;
        best = n;
      }
    }
    return best;
  };

  // Click to start/end segments when drawing is enabled
  const handleClickDraw = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // Raw world point under the mouse (used for edge splitting only)
      const rawWorld = screenToWorld(sx, sy, canvas, offset, zoom);

      // If we are starting a new drawing (no current node), distinguish between
      // resuming from an existing node vs. splitting an existing pipe:
      //
      // - Click near a node       → resume drawing from that node (no split)
      // - Click on a pipe segment → split that pipe and start from the new node
      if (currentNodeId == null) {
        // Snapshot before potentially adding/splitting components.
        saveSnapshotForUndo();

        // 1) First, try to resume from an existing node (no splitting).
        const NODE_TOL = GRID_SIZE * 0.4;
        const nearbyNode = findNearbyNode(rawWorld, NODE_TOL);
        if (nearbyNode) {
          // Simply move the drawing cursor to this node so the next click will
          // create a new pipe starting here. We do NOT modify edges or
          // componentOrder in this case, so existing numbering remains stable.
          setCurrentNodeId(nearbyNode.id);
          setGhostEnd(null);
          return;
        }

        // 2) If no node is nearby, allow splitting an existing edge when
        // clicking on a line segment.
        const HIT_TOL = GRID_SIZE * 0.4;
        let bestEdgeIndex = -1;
        let bestSplitPoint: Point | null = null;
        let bestDist = HIT_TOL;

        edges.forEach((edge, index) => {
          const from = nodes.find((n) => n.id === edge.fromId);
          const to = nodes.find((n) => n.id === edge.toId);
          if (!from || !to) return;

          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const denom = dx * dx + dy * dy;
          if (denom === 0) return;

          let t = ((rawWorld.x - from.x) * dx + (rawWorld.y - from.y) * dy) / denom;
          t = Math.max(0, Math.min(1, t));

          // Point on the segment closest to the click in world space
          const projX = from.x + t * dx;
          const projY = from.y + t * dy;

          // Snap that point to the nearest isometric grid intersection so that
          // newly created nodes always live on grid dots, even when created by
          // clicking directly on a line.
          const snapped = snapWorldToIsoGrid(projX, projY);

          const dist = Math.hypot(rawWorld.x - snapped.x, rawWorld.y - snapped.y);

          if (dist <= bestDist) {
            bestDist = dist;
            bestEdgeIndex = index;
            bestSplitPoint = snapped;
          }
        });

        if (bestEdgeIndex !== -1 && bestSplitPoint) {
          const splitPoint: Point = bestSplitPoint;
          // Create a new node at the split point. While drawing, this behaves
          // as a tee so the user can continue to draw from it; if drawing mode
          // is ended without branching, it will be converted to a reducer.
          const newNode: Node = {
            id: nextIdRef.current++,
            x: splitPoint.x,
            y: splitPoint.y,
            // Default to elbow90 (via helper) instead of tee; the node will
            // still be promoted to a tee later if multiple pipes meet here.
            type: getDefaultNodeType(nodes),
          };
          setNodes((prev) => [...prev, newNode]);
          setPendingReducerIds((prev) => [...prev, newNode.id]);

          // Split the hit edge into two edges, preserving existing geometry
          const hitEdge = edges[bestEdgeIndex];
          setEdges((prev) => {
            const updated = [...prev];
            // Remove the original edge
            updated.splice(bestEdgeIndex, 1);
            // Add two new edges, both pipes
            const firstId = nextIdRef.current++;
            const secondId = nextIdRef.current++;
            updated.push({
              id: firstId,
              fromId: hitEdge.fromId,
              toId: newNode.id,
              type: "pipe",
            });
            updated.push({
              id: secondId,
              fromId: newNode.id,
              toId: hitEdge.toId,
              type: "pipe",
            });

            // Update component order so the new node appears between the two
            // new pipe segments in the JSON-friendly components list.
            setComponentOrder((prev) => {
              const result: { component: ComponentKind; id: number }[] = [];
              let replaced = false;
              for (const entry of prev) {
                if (!replaced && entry.component === "edge" && entry.id === hitEdge.id) {
                  // Replace the original edge with: first pipe, node, second pipe.
                  // This ensures the following components shift their indices:
                  // discharge → pipe → elbow → pipe → outlet
                  // becomes
                  // discharge → pipe → elbow(new) → pipe → elbow(orig) → pipe → outlet
                  result.push({ component: "edge", id: firstId });
                  result.push({ component: "node", id: newNode.id });
                  result.push({ component: "edge", id: secondId });
                  replaced = true;
                } else {
                  result.push(entry);
                }
              }
              if (!replaced) {
                // Fallback: if the original edge was not found in componentOrder,
                // insert the new sequence immediately after the "from" node of
                // the split edge (if it exists); otherwise append at the end.
                const insertAfterIndex = result.findIndex(
                  (entry) => entry.component === "node" && entry.id === hitEdge.fromId
                );

                const insertion = [
                  { component: "edge" as ComponentKind, id: firstId },
                  { component: "node" as ComponentKind, id: newNode.id },
                  { component: "edge" as ComponentKind, id: secondId },
                ];

                if (insertAfterIndex !== -1) {
                  result.splice(insertAfterIndex + 1, 0, ...insertion);
                } else {
                  result.push(...insertion);
                }
              }

              return result;
            });

            return updated;
          });

          // Move the drawing cursor to this node so the user can continue
          // drawing from it if they choose.
          setCurrentNodeId(newNode.id);
          setGhostEnd(null);

          // Start drawing from this new node. Splitting a pipe should only
          // insert the new elbow node between the two new pipe segments; we do
          // not add any extra phantom components to the ordering here.

          return;
        }
      }

      // Otherwise, normal dot-to-dot drawing flow.
      // When there is an active starting node, constrain the new segment so it
      // runs only along one of the three isometric axes (x, y, or vertical z).
      // For the very first node we still just pick the nearest grid dot.
      let startNode: Node | null = null;
      if (currentNodeId != null) {
        startNode = nodes.find((n) => n.id === currentNodeId) ?? null;
      }

      let finalWorld: Point;
      if (startNode) {
        finalWorld = snapFromStartToAxis(
          { x: startNode.x, y: startNode.y },
          sx,
          sy,
          canvas,
          offset,
          zoom
        );
      } else {
        finalWorld = snapScreenToIsoGrid(
          sx,
          sy,
          canvas,
          offset,
          zoom
        );
      }

      const NEAR_TOL = GRID_SIZE * 0.4;
      const existing = findNearbyNode(finalWorld, NEAR_TOL);

      // Reuse nearby node or create new one on the grid
      let targetNode: Node;
      let createdNewNode = false;
      if (existing) {
        targetNode = existing;
      } else {
        targetNode = {
          id: nextIdRef.current++,
          x: finalWorld.x,
          y: finalWorld.y,
          type: getDefaultNodeType(nodes),
        };
        setNodes((prev) => [...prev, targetNode]);
        createdNewNode = true;
      }

      if (currentNodeId == null) {
        // (Snapshot is already taken above when entering this branch.)
        // First click: create a starting node in the sequence.
        if (createdNewNode) {
          setComponentOrder((prev) => [
            ...prev,
            { component: "node", id: targetNode.id },
          ]);
        }
        setCurrentNodeId(targetNode.id);
      } else if (startNode && startNode.id !== targetNode.id) {
        // Snapshot before adding a new edge (and possibly a new node).
        saveSnapshotForUndo();

        // Second (or subsequent) click: add edge from current node to target
        // node.

        // No special reordering when continuing from a node: we do not touch
        // existing components here. The new edge (and any new node) will be
        // appended to the end of componentOrder below.

        // Compute how many pipes (edges) are currently connected to the
        // starting node before we add this new segment.
        const degreeBefore = edges.reduce((count, e) => {
          return (
            count +
            (e.fromId === startNode.id || e.toId === startNode.id ? 1 : 0)
          );
        }, 0);
        const degreeAfter = degreeBefore + 1;

        const newEdgeId = nextIdRef.current++;
        const newEdge: Edge = {
          id: newEdgeId,
          fromId: startNode.id,
          toId: targetNode.id,
          type: "pipe",
        };

        // Update node semantics based on how many pipes meet at the start
        // node after this draw:
        // - If only one pipe is connected (degreeAfter === 1), keep it as a
        //   simple endpoint (no tee needed) and ensure it at least has a
        //   default elbow/discharge type.
        // - If three or more pipes are connected (degreeAfter >= 3), promote the
        //   node to a tee (unless it is explicitly a discharge or outlet).
        setNodes((prev) =>
          prev.map((n) => {
            if (n.id !== startNode.id) return n;

            let type = n.type;

            if (degreeAfter === 1) {
              // Single-pipe endpoint: use the default node type if none is set.
              type = type ?? getDefaultNodeType(prev);
            } else if (degreeAfter >= 3) {
              // Branching: turning an existing node into a junction. Represent
              // that junction as a tee symbol in the UI.
              if (type !== "discharge" && type !== "outlet") {
                type = "tee";
              }
            }

            return { ...n, type };
          })
        );

        setEdges((prev) => [...prev, newEdge]);
        // Insert the new edge (and any new node) immediately after the start
        // node in the ordered list when that node is not already last. This
        // keeps reconnection segments (e.g. replacing a deleted pipe between
        // discharge and an elbow) appearing before downstream components like
        // elbow90 → pipe → outlet.
        setComponentOrder((prev) => {
          const insertionEdge = {
            component: "edge" as ComponentKind,
            id: newEdgeId,
          };
          const insertionNode = createdNewNode
            ? ({
                component: "node" as ComponentKind,
                id: targetNode.id,
              } as const)
            : null;

          const startIndex = prev.findIndex(
            (entry) => entry.component === "node" && entry.id === startNode!.id
          );
          // If the start node is not found or is already the last entry, just
          // append as before.
          if (startIndex === -1 || startIndex === prev.length - 1) {
            const next: { component: ComponentKind; id: number }[] = [
              ...prev,
              insertionEdge,
            ];
            if (insertionNode) next.push(insertionNode);
            return next;
          }

          const next = [...prev];
          const toInsert = insertionNode
            ? [insertionEdge, insertionNode]
            : [insertionEdge];
          next.splice(startIndex + 1, 0, ...toInsert);
          return next;
        });

        // Once we branch from a pending reducer candidate, keep it as a tee
        // (do not auto-convert it to a reducer when drawing ends).
        setPendingReducerIds((prev) => prev.filter((id) => id !== startNode.id));
        setCurrentNodeId(targetNode.id); // Continue drawing from this node

        // No trailing tee bookkeeping: continuing from a node only appends new
        // components; it does not alter existing ordering.
      }

      setGhostEnd(null);
    },
    [currentNodeId, nodes, offset, zoom, edges, componentOrder]
  );

  const handleMouseMoveDraw = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!drawingEnabled || currentNodeId == null) {
        if (ghostEnd) setGhostEnd(null);
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      const startNode = nodes.find((n) => n.id === currentNodeId);
      if (!startNode) return;

      const snappedWorld = snapFromStartToAxis(
        { x: startNode.x, y: startNode.y },
        sx,
        sy,
        canvas,
        offset,
        zoom
      );
      // Preview line directly from the start node to the snapped grid dot,
      // constrained to one of the isometric axes.
      setGhostEnd(snappedWorld);
    },
    [currentNodeId, drawingEnabled, ghostEnd, nodes, offset, zoom]
  );

  // Master mouse handlers (pan vs draw)
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!drawingEnabled) {
        handleMouseMovePan(e);
      } else {
        handleMouseMoveDraw(e);
      }
    },
    [drawingEnabled, handleMouseMoveDraw, handleMouseMovePan]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      // If we just finished a Shift-drag selection, ignore the click event that
      // follows so it doesn't immediately clear the selection.
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left; // canvas-space X
      const sy = e.clientY - rect.top;  // canvas-space Y

      if (!drawingEnabled) {
        // Hit-test in SCREEN space so selection visually matches the cursor,
        // regardless of zoom/pan.

        const isMulti = e.ctrlKey || e.metaKey;

        // First, try nodes (dots)
        const NODE_TOL_PX = 10; // hit radius in screen pixels
        let hitNode: Node | null = null;
        let bestNodeDist = NODE_TOL_PX;
        for (const n of nodes) {
          const screen = worldToScreen({ x: n.x, y: n.y }, canvas, offset, zoom);
          const dx = sx - screen.x;
          const dy = sy - screen.y;
          const d = Math.hypot(dx, dy);
          if (d <= bestNodeDist) {
            bestNodeDist = d;
            hitNode = n;
          }
        }

        if (hitNode) {
          if (isMulti) {
            // Ctrl/Cmd-click: toggle membership in the multi-selection only,
            // do not open the popover yet.
            setMultiSelectedNodeIds((prev) =>
              prev.includes(hitNode.id)
                ? prev.filter((id) => id !== hitNode.id)
                : [...prev, hitNode.id]
            );
            setSelectedNodeId(hitNode.id);
            setSelectedEdgeId(null);
            setPopoverOpen(false);
          } else {
            const isInExistingMultiSelection =
              multiSelectedNodeIds.length > 0 &&
              multiSelectedNodeIds.includes(hitNode.id);

            if (isInExistingMultiSelection) {
              // Clicking one of the already-selected nodes opens the popover
              // but keeps the multi-selection for bulk actions like delete.
              setSelectedNodeId(hitNode.id);
              setSelectedEdgeId(null);
              setPopoverOpen(true);
            } else {
              // Single click on a node: do not clear any existing multi-selection;
              // just make this the active node for the popover.
              setSelectedNodeId(hitNode.id);
              setSelectedEdgeId(null);
              setPopoverOpen(true);
            }
          }

          setPopoverPosition({ x: e.clientX, y: e.clientY });
          return;
        }

        // If no node, try edges (lines)
        const EDGE_TOL_PX = 8; // distance to line in screen pixels
        let hitEdge: Edge | null = null;
        for (const edge of edges) {
          const fromNode = nodes.find((n) => n.id === edge.fromId);
          const toNode = nodes.find((n) => n.id === edge.toId);
          if (!fromNode || !toNode) continue;

          const fromScreen = worldToScreen(
            { x: fromNode.x, y: fromNode.y },
            canvas,
            offset,
            zoom
          );
          const toScreen = worldToScreen(
            { x: toNode.x, y: toNode.y },
            canvas,
            offset,
            zoom
          );

          const dist = distancePointToSegment(
            { x: sx, y: sy },
            { x: fromScreen.x, y: fromScreen.y },
            { x: toScreen.x, y: toScreen.y }
          );
          if (dist <= EDGE_TOL_PX) {
            hitEdge = edge;
            break;
          }
        }

        if (hitEdge) {
          if (isMulti) {
            // Ctrl/Cmd-click: toggle membership in the multi-selection only,
            // do not open the popover yet.
            setMultiSelectedEdgeIds((prev) =>
              prev.includes(hitEdge.id)
                ? prev.filter((id) => id !== hitEdge.id)
                : [...prev, hitEdge.id]
            );
            setSelectedEdgeId(hitEdge.id);
            setSelectedNodeId(null);
            setPopoverOpen(false);
          } else {
            const isInExistingPipeMultiSelection =
              multiSelectedEdgeIds.length > 0 &&
              multiSelectedEdgeIds.includes(hitEdge.id);

            if (isInExistingPipeMultiSelection) {
              // Clicking one of the already-selected pipes opens the popover
              // and shows all selected pipes together.
              setSelectedEdgeId(hitEdge.id);
              setSelectedNodeId(null);
              setPopoverOpen(true);
            } else {
              // Single click on a pipe: do not clear any existing multi-selection;
              // just make this the active edge for the popover.
              setSelectedEdgeId(hitEdge.id);
              setSelectedNodeId(null);
              setPopoverOpen(true);
            }
          }

          setPopoverPosition({ x: e.clientX, y: e.clientY });
          return;
        }

        // Clicked empty space: close popover and clear selection
        setPopoverOpen(false);
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
        setMultiSelectedNodeIds([]);
        setMultiSelectedEdgeIds([]);
        return;
      }

      // Drawing mode: delegate to drawing handler
      handleClickDraw(e);
    },
    [drawingEnabled, handleClickDraw, offset, zoom, nodes, edges]
  );

  // When drawing is disabled, automatically remove any nodes that are not
  // connected to at least one edge. Also, by default, treat the last node in
  // the drawing order as an outlet if it is not explicitly typed.
  const prevDrawingEnabledRef = useRef(drawingEnabled);
  useEffect(() => {
    const wasDrawingEnabled = prevDrawingEnabledRef.current;
    prevDrawingEnabledRef.current = drawingEnabled;

    // Only run when drawing transitions from ON -> OFF.
    if (!(wasDrawingEnabled && !drawingEnabled)) {
      return;
    }

    const connectedIds = new Set<number>();
    for (const edge of edges) {
      connectedIds.add(edge.fromId);
      connectedIds.add(edge.toId);
    }

    setNodes((prevNodes) => {
      const filtered = prevNodes.filter((n) => connectedIds.has(n.id));
      const validNodeIds = new Set(filtered.map((n) => n.id));

      // Drop any node entries from the ordered list that are no longer present
      // in the filtered node set.
      setComponentOrder((prev) =>
        prev.filter(
          (entry) =>
            entry.component !== "node" || validNodeIds.has(entry.id)
        )
      );

      // Any pending reducer candidates that were not branched from become
      // reducers when drawing mode is turned off.
      const pendingSet = new Set(pendingReducerIds);
      let converted: Node[] = filtered.map((n) =>
        pendingSet.has(n.id)
          ? { ...n, type: "reducer" as ElementType }
          : n
      );

      // Make the last node in the current drawing order an outlet by default,
      // unless it is already explicitly typed as discharge or outlet.
      const orderedNodeIds = componentOrder
        .filter((entry) => entry.component === "node" && validNodeIds.has(entry.id))
        .map((entry) => entry.id);

      const lastNodeId = orderedNodeIds[orderedNodeIds.length - 1];
      if (lastNodeId != null) {
        converted = converted.map((n) => {
          if (n.id !== lastNodeId) return n;
          // Do not override explicit discharge or outlet types.
          if (n.type === "discharge" || n.type === "outlet") return n;
          return { ...n, type: "outlet" as ElementType };
        });
      }

      return converted;
    });

    // Clear pending reducer candidates after applying conversion (if any).
    if (pendingReducerIds.length > 0) {
      setPendingReducerIds([]);
    }
  }, [drawingEnabled, edges, pendingReducerIds, componentOrder]);

  // Initialise WebGL once on mount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resources = initWebGL(canvas);
    if (!resources) return;
    glRef.current = resources.gl;
    glResourcesRef.current = resources;
  }, []);

  // Redraw everything with WebGL when state changes
  useEffect(() => {
    const canvas = canvasRef.current;
    const resources = glResourcesRef.current;
    if (!canvas || !resources) return;

    // Map component keys ("node:id" / "edge:id") to delta_P values for
    // pressure-based highlighting.
    const pByComponent = new Map<string, number>();
    for (const row of flatEquationRows) {
      if (typeof row.delta_P !== "number") continue;
      const idx = row.index;
      const comp = canonicalOrder[idx - 1];
      if (!comp) continue;
      const key = `${comp.component}:${comp.id}`;
      pByComponent.set(key, row.delta_P);
    }

    // Detect implicit reducers in the *canvas* graph: any node where two or more
    // connected pipes have different diameters should visually show a reducer
    // symbol, even if the reducer was only auto-inserted on the calculations
    // side.
    const autoReducerNodeIds = new Set<number>();
    const pendingReducerSet = new Set(pendingReducerIds);
    for (const node of nodes) {
      // Do not place automatic reducers at outlets or tees; any reducers there
      // should be explicit in the drawing.
      if (node.type === "outlet" || (node.type && node.type.startsWith("tee"))) {
        continue;
      }

      // While drawing, nodes created by splitting a pipe are tracked in
      // pendingReducerIds and should visually show a reducer symbol immediately
      // so the user understands this is a potential reducer location.
      if (pendingReducerSet.has(node.id)) {
        autoReducerNodeIds.add(node.id);
        continue;
      }

      const diameters = new Set<number>();
      for (const edge of edges) {
        if (edge.type !== "pipe") continue;
        if (edge.fromId !== node.id && edge.toId !== node.id) continue;
        if (typeof edge.diameter === "number" && edge.diameter > 0) {
          diameters.add(edge.diameter);
        }
      }
      if (diameters.size >= 2) {
        autoReducerNodeIds.add(node.id);
      }
    }

    const canvasSelectedNodeId = selectedNodeId;
    const canvasSelectedEdgeId = selectedEdgeId;

    const {
      gl,
      bufferLines,
      bufferTriangles,
      attribLocationPosition,
      attribLocationColor,
    } = resources;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(BG_COLOR_VEC[0], BG_COLOR_VEC[1], BG_COLOR_VEC[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const lineData: number[] = [];
    const triData: number[] = [];

    // 1) Grid lines
    const gridCount = GRID_COUNT;
    const [gr, gg, gb] = GRID_COLOR_VEC;
    const gridAlpha = 1.0;
    for (let i = -gridCount; i <= gridCount; i++) {
      for (let j = -gridCount; j <= gridCount; j++) {
        const x = (i - j) * GRID_SIZE * COS_ANGLE;
        const y = (i + j) * GRID_SIZE * SIN_ANGLE;

        if (i < gridCount) {
          const x2 = (i + 1 - j) * GRID_SIZE * COS_ANGLE;
          const y2 = (i + 1 + j) * GRID_SIZE * SIN_ANGLE;
          const p1 = worldToClip({ x, y }, canvas, offset, zoom);
          const p2 = worldToClip({ x: x2, y: y2 }, canvas, offset, zoom);
          lineData.push(p1.x, p1.y, gr, gg, gb, gridAlpha, p2.x, p2.y, gr, gg, gb, gridAlpha);
        }

        if (j < gridCount) {
          const x3 = (i - (j + 1)) * GRID_SIZE * COS_ANGLE;
          const y3 = (i + (j + 1)) * GRID_SIZE * SIN_ANGLE;
          const p1 = worldToClip({ x, y }, canvas, offset, zoom);
          const p2 = worldToClip({ x: x3, y: y3 }, canvas, offset, zoom);
          lineData.push(p1.x, p1.y, gr, gg, gb, gridAlpha, p2.x, p2.y, gr, gg, gb, gridAlpha);
        }

        if (i < gridCount && j < gridCount) {
          const x4 = (i + 1 - (j + 1)) * GRID_SIZE * COS_ANGLE;
          const y4 = (i + 1 + (j + 1)) * GRID_SIZE * SIN_ANGLE;
          const p1 = worldToClip({ x, y }, canvas, offset, zoom);
          const p2 = worldToClip({ x: x4, y: y4 }, canvas, offset, zoom);
          lineData.push(p1.x, p1.y, gr, gg, gb, gridAlpha, p2.x, p2.y, gr, gg, gb, gridAlpha);
        }
      }
    }

    // 2) Edges (pipes) in black, with a soft green highlight band for
    // pipes that have both diameter and length defined, plus blue/red
    // overlays for selection and extreme pressure.
    const [pr, pg, pb] = PIPE_COLOR_VEC;
    const pipeAlpha = 1.0;
    const [grh, ggh, gbh] = PIPE_HIGHLIGHT_COLOR_VEC;
    const [srh, sgh, sbh] = SELECT_HIGHLIGHT_COLOR_VEC;
    const [rrh, rgh, rbh] = PRESSURE_HIGHLIGHT_COLOR_VEC;
    const highlightThickness = 0.006; // thick halo for higher visual weight
    const highlightAlpha = 1.0; // fully opaque highlight; black line is drawn on top

    for (const edge of edges) {
      const from = nodes.find((n) => n.id === edge.fromId);
      const to = nodes.find((n) => n.id === edge.toId);
      if (!from || !to) continue;

      const p1 = worldToClip({ x: from.x, y: from.y }, canvas, offset, zoom);
      const p2 = worldToClip({ x: to.x, y: to.y }, canvas, offset, zoom);

      // Base pipe line (always drawn in neutral pipe color)
      lineData.push(p1.x, p1.y, pr, pg, pb, pipeAlpha, p2.x, p2.y, pr, pg, pb, pipeAlpha);

      const isComplete =
        typeof edge.diameter === "number" && typeof edge.length === "number";

      const compKey = `edge:${edge.id}`;
      const pVal = pByComponent.get(compKey);
      const isPressureExtreme =
        typeof pVal === "number" && (pVal < -9 || pVal > 9);
      const isMultiSelectedEdge = multiSelectedEdgeIds.includes(edge.id);
      const isSelectedEdge =
        canvasSelectedEdgeId === edge.id || isMultiSelectedEdge;

      if (isComplete || isPressureExtreme || isSelectedEdge) {
        // Build a thin quad around the *middle* portion of the segment in
        // clip space as a highlight band, leaving the ends unhighlighted so it
        // looks shorter/subtle.
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const h = highlightThickness;

        // Only highlight the central 70% of the segment (15% margin at each end).
        const margin = 0.15;
        const t1 = margin;
        const t2 = 1 - margin;
        const hx1 = p1.x + dx * t1;
        const hy1 = p1.y + dy * t1;
        const hx2 = p1.x + dx * t2;
        const hy2 = p1.y + dy * t2;

        const x1a = hx1 + nx * h;
        const y1a = hy1 + ny * h;
        const x1b = hx1 - nx * h;
        const y1b = hy1 - ny * h;
        const x2a = hx2 + nx * h;
        const y2a = hy2 + ny * h;
        const x2b = hx2 - nx * h;
        const y2b = hy2 - ny * h;

        // Two triangles: (1a, 1b, 2a) and (2a, 1b, 2b)
        const [cr, cg, cb] = isSelectedEdge
          ? [srh, sgh, sbh]
          : isPressureExtreme
          ? [rrh, rgh, rbh]
          : [grh, ggh, gbh];

        triData.push(
          x1a, y1a, cr, cg, cb, highlightAlpha,
          x1b, y1b, cr, cg, cb, highlightAlpha,
          x2a, y2a, cr, cg, cb, highlightAlpha,

          x2a, y2a, cr, cg, cb, highlightAlpha,
          x1b, y1b, cr, cg, cb, highlightAlpha,
          x2b, y2b, cr, cg, cb, highlightAlpha,
        );
      }
    }

    // 3) Ghost line while drawing: a semi‑transparent preview from the
    // current node to the snapped cursor position.
    if (drawingEnabled && ghostEnd && currentNodeId != null) {
      const start = nodes.find((n) => n.id === currentNodeId);
      if (start) {
        const p1 = worldToClip(start, canvas, offset, zoom);
        const p2 = worldToClip(ghostEnd, canvas, offset, zoom);
        const ghostAlpha = 0.4;
        lineData.push(
          p1.x, p1.y, pr, pg, pb, ghostAlpha,
          p2.x, p2.y, pr, pg, pb, ghostAlpha,
        );
      }
    }

    // 4) Nodes – draw distinct, monochrome symbols per component type.
    // Use a fixed symbol size in screen pixels so they stay readable at any zoom.
    const symbolPx = 14; // overall half-size in pixels (thicker, more legible symbols)
    const rx = (symbolPx * 2) / canvas.width;
    const ry = (symbolPx * 2) / canvas.height;
    const baseR = Math.min(rx, ry);
    const [nr, ng, nb] = PIPE_COLOR_VEC; // all symbols in the same neutral color
    const [srn, sgn, sbn] = SELECT_HIGHLIGHT_COLOR_VEC;
    const [rrn, rgn, rbn] = PRESSURE_HIGHLIGHT_COLOR_VEC;
    const nodeSymbolAlpha = 1.0;
    const nodeHaloAlpha = 1.0; // opaque halo; node symbol strokes are drawn on top

    const pushLine = (x1: number, y1: number, x2: number, y2: number) => {
      lineData.push(x1, y1, nr, ng, nb, nodeSymbolAlpha, x2, y2, nr, ng, nb, nodeSymbolAlpha);
    };

    const drawReducerSymbol = (
      cx: number,
      cy: number,
      rLocal: number,
      dirX?: number,
      dirY?: number
    ) => {
      // Default direction: point "down" in clip space if none is provided.
      let tx = dirX ?? 0;
      let ty = dirY ?? -1;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;
      const nx = -ty;
      const ny = tx;

      const tipOffset = rLocal * 1.4;
      const baseOffset = rLocal * 0.6;
      const halfWidth = rLocal * 0.9;

      const tipX = cx + tx * tipOffset;
      const tipY = cy + ty * tipOffset;

      const baseCx = cx - tx * baseOffset;
      const baseCy = cy - ty * baseOffset;

      const baseLx = baseCx + nx * halfWidth;
      const baseLy = baseCy + ny * halfWidth;
      const baseRx = baseCx - nx * halfWidth;
      const baseRy = baseCy - ny * halfWidth;

      pushLine(tipX, tipY, baseLx, baseLy);
      pushLine(baseLx, baseLy, baseRx, baseRy);
      pushLine(baseRx, baseRy, tipX, tipY);
    };

    const findReducerPlacementForNode = (
      node: Node,
      centerClip: { x: number; y: number },
      rLocal: number,
      placeAfterElbow: boolean
    ): { cx: number; cy: number; r: number; dirX: number; dirY: number } | null => {
      const connected: { edge: Edge; diam: number; other: Node }[] = [];
      for (const edge of edges) {
        if (edge.type !== "pipe") continue;
        if (edge.fromId === node.id || edge.toId === node.id) {
          const diam = typeof edge.diameter === "number" ? edge.diameter : 0;
          const otherId = edge.fromId === node.id ? edge.toId : edge.fromId;
          const otherNode = nodes.find((n) => n.id === otherId);
          if (!otherNode) continue;
          if (diam > 0) {
            connected.push({ edge, diam, other: otherNode });
          }
        }
      }
      if (connected.length < 2) return null;
      const uniqueDs = new Set(connected.map((c) => c.diam));
      if (uniqueDs.size < 2) return null;

      // Choose downstream pipe as the one with the smallest diameter.
      let downstream = connected[0];
      for (const c of connected) {
        if (c.diam < downstream.diam) {
          downstream = c;
        }
      }

      const otherClip = worldToClip(
        { x: downstream.other.x, y: downstream.other.y },
        canvas,
        offset,
        zoom
      );
      let dx = otherClip.x - centerClip.x;
      let dy = otherClip.y - centerClip.y;
      const len = Math.hypot(dx, dy);
      if (!len) return null;
      dx /= len;
      dy /= len;

      let cx = centerClip.x;
      let cy = centerClip.y;
      let rOut = rLocal;

      if (placeAfterElbow) {
        const offsetAlong = rLocal * 3.0;
        cx += dx * offsetAlong;
        cy += dy * offsetAlong;
        rOut = rLocal * 0.9;
      }

      return { cx, cy, r: rOut, dirX: dx, dirY: dy };
    };

    for (const node of nodes) {
      const center = worldToClip({ x: node.x, y: node.y }, canvas, offset, zoom);
      const cx = center.x;
      const cy = center.y;
      const r = baseR;

      const hasAutoReducer = autoReducerNodeIds.has(node.id);

      const compKey = `node:${node.id}`;
      const pVal = pByComponent.get(compKey);
      const isPressureExtreme =
        typeof pVal === "number" && (pVal < -9 || pVal > 9);
      const isMultiSelectedNode = multiSelectedNodeIds.includes(node.id);
      const isSelectedNode =
        canvasSelectedNodeId === node.id || isMultiSelectedNode;

      // Node highlight ring (blue for selected, red for extreme pressure)
      if (isSelectedNode || isPressureExtreme) {
        const [hr, hg, hb] = isSelectedNode
          ? [srn, sgn, sbn]
          : [rrn, rgn, rbn];
        const haloR1 = r * 2.0;
        const haloR2 = r * 2.6;
        const haloSeg = 18;
        for (let ring = 0; ring < 2; ring++) {
          const haloR = ring === 0 ? haloR1 : haloR2;
          for (let i = 0; i < haloSeg; i++) {
            const a0 = (2 * Math.PI * i) / haloSeg;
            const a1 = (2 * Math.PI * (i + 1)) / haloSeg;
            const x0 = cx + haloR * Math.cos(a0);
            const y0 = cy + haloR * Math.sin(a0);
            const x1 = cx + haloR * Math.cos(a1);
            const y1 = cy + haloR * Math.sin(a1);
            lineData.push(x0, y0, hr, hg, hb, nodeHaloAlpha, x1, y1, hr, hg, hb, nodeHaloAlpha);
          }
        }
      }

      switch (node.type) {
        case "discharge": {
          // Double circle (approximated with polygons)
          const segments = 12;
          const rOuter = r * 1.1;
          const rInner = r * 0.65;
          for (let i = 0; i < segments; i++) {
            const a0 = (2 * Math.PI * i) / segments;
            const a1 = (2 * Math.PI * (i + 1)) / segments;
            const x0o = cx + rOuter * Math.cos(a0);
            const y0o = cy + rOuter * Math.sin(a0);
            const x1o = cx + rOuter * Math.cos(a1);
            const y1o = cy + rOuter * Math.sin(a1);
            const x0i = cx + rInner * Math.cos(a0);
            const y0i = cy + rInner * Math.sin(a0);
            const x1i = cx + rInner * Math.cos(a1);
            const y1i = cy + rInner * Math.sin(a1);
            pushLine(x0o, y0o, x1o, y1o);
            pushLine(x0i, y0i, x1i, y1i);
          }
          break;
        }
        case "outlet": {
          // Outlet: small circle inside a diamond shape whose TOP tip sits
          // exactly on the node position (cx, cy).
          const diamondR = r * 0.9;
          const centerY = cy + diamondR; // shift diamond down so top tip is at cy
          const topX = cx;
          const topY = centerY - diamondR; // == cy
          const rightX = cx + diamondR;
          const rightY = centerY;
          const bottomX = cx;
          const bottomY = centerY + diamondR;
          const leftX = cx - diamondR;
          const leftY = centerY;

          // Diamond (rhombus) outline
          pushLine(topX, topY, rightX, rightY);
          pushLine(rightX, rightY, bottomX, bottomY);
          pushLine(bottomX, bottomY, leftX, leftY);
          pushLine(leftX, leftY, topX, topY);

          // Inner circle, centered in the diamond
          const segments = 12;
          const rOut = r * 0.5;
          for (let i = 0; i < segments; i++) {
            const a0 = (2 * Math.PI * i) / segments;
            const a1 = (2 * Math.PI * (i + 1)) / segments;
            const x0 = cx + rOut * Math.cos(a0);
            const y0 = centerY + rOut * Math.sin(a0);
            const x1 = cx + rOut * Math.cos(a1);
            const y1 = centerY + rOut * Math.sin(a1);
            pushLine(x0, y0, x1, y1);
          }

          break;
        }
        case "reducer": {
          // Explicit reducer node: orient along the smaller-diameter pipe.
          const placement = findReducerPlacementForNode(
            node,
            { x: cx, y: cy },
            r,
            false
          );
          if (placement) {
            drawReducerSymbol(
              placement.cx,
              placement.cy,
              placement.r,
              placement.dirX,
              placement.dirY
            );
          } else {
            drawReducerSymbol(cx, cy, r);
          }
          break;
        }
        case "tee": {
          // T-shape: main horizontal with a vertical stem down
          const mainLen = r * 1.6;
          const stemLen = r * 1.0;
          // horizontal main
          pushLine(cx - mainLen, cy, cx + mainLen, cy);
          // vertical stem
          pushLine(cx, cy, cx, cy + stemLen);
          break;
        }
        case "elbow45":
        case "elbow90": {
          // Quarter-circle hint plus a small dot at the junction
          const segments = 6;
          const rElbow = r * 1.2;
          const startAngle = node.type === "elbow90" ? 0 : Math.PI / 4;
          const sweep = Math.PI / 2; // 90° arc
          for (let i = 0; i < segments; i++) {
            const a0 = startAngle + (sweep * i) / segments;
            const a1 = startAngle + (sweep * (i + 1)) / segments;
            const x0 = cx + rElbow * Math.cos(a0);
            const y0 = cy + rElbow * Math.sin(a0);
            const x1 = cx + rElbow * Math.cos(a1);
            const y1 = cy + rElbow * Math.sin(a1);
            pushLine(x0, y0, x1, y1);
          }
          // small junction dot (cross)
          const jr = r * 0.5;
          pushLine(cx - jr, cy, cx + jr, cy);
          pushLine(cx, cy - jr, cx, cy + jr);
          break;
        }
        case "pipe":
        default: {
          // Simple ring (single circle)
          const segments = 10;
          for (let i = 0; i < segments; i++) {
            const a0 = (2 * Math.PI * i) / segments;
            const a1 = (2 * Math.PI * (i + 1)) / segments;
            const x0 = cx + r * Math.cos(a0);
            const y0 = cy + r * Math.sin(a0);
            const x1 = cx + r * Math.cos(a1);
            const y1 = cy + r * Math.sin(a1);
            pushLine(x0, y0, x1, y1);
          }
          break;
        }
      }

      // If this node sits between pipes of different diameters (detected from
      // the canvas graph), overlay a reducer symbol so the auto-inserted
      // reducers in the calculations layer are also visible in the isometric
      // view.
      if (hasAutoReducer && node.type !== "reducer") {
        const placement = findReducerPlacementForNode(
          node,
          { x: cx, y: cy },
          r * 0.9,
          node.type === "elbow90"
        );
        if (placement) {
          drawReducerSymbol(
            placement.cx,
            placement.cy,
            placement.r,
            placement.dirX,
            placement.dirY
          );
        } else {
          drawReducerSymbol(cx, cy, r * 0.9);
        }
      }
    }

    // Draw highlight triangles (bands) first so black lines render on top
    if (triData.length > 0) {
      const triArray = new Float32Array(triData);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufferTriangles);
      gl.bufferData(gl.ARRAY_BUFFER, triArray, gl.STREAM_DRAW);
      const stride = 6 * 4; // x, y, r, g, b, a
      gl.vertexAttribPointer(
        attribLocationPosition,
        2,
        gl.FLOAT,
        false,
        stride,
        0
      );
      gl.vertexAttribPointer(
        attribLocationColor,
        4,
        gl.FLOAT,
        false,
        stride,
        2 * 4
      );
      const count = triArray.length / 6;
      gl.drawArrays(gl.TRIANGLES, 0, count);
    }

    // Then draw all lines (grid, pipes, halos, node symbols, ghost)
    if (lineData.length > 0) {
      const lineArray = new Float32Array(lineData);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufferLines);
      gl.bufferData(gl.ARRAY_BUFFER, lineArray, gl.STREAM_DRAW);
      const stride = 6 * 4; // x, y, r, g, b, a
      gl.vertexAttribPointer(
        attribLocationPosition,
        2,
        gl.FLOAT,
        false,
        stride,
        0
      );
      gl.vertexAttribPointer(
        attribLocationColor,
        4,
        gl.FLOAT,
        false,
        stride,
        2 * 4
      );
      const count = lineArray.length / 6;
      gl.drawArrays(gl.LINES, 0, count);
    }
    }, [currentNodeId, drawingEnabled, edges, ghostEnd, nodes, offset, zoom, flatEquationRows, canonicalOrder, selectedNodeId, selectedEdgeId, pendingReducerIds, multiSelectedNodeIds, multiSelectedEdgeIds]);

  const cursorClass = drawingEnabled
    ? "cursor-crosshair"
    : "cursor-grab active:cursor-grabbing";

  // Position for the popover trigger (in viewport coordinates)
  const popoverAnchorStyle: CSSProperties = popoverOpen
    ? {
        position: "fixed",
        left: "50%",
        top: "58%", // slightly lower than true center
        transform: "translate(-50%, -50%)",
        width: 1,
        height: 1,
        pointerEvents: "none",
      }
    : {
        position: "fixed",
        left: -9999,
        top: -9999,
        width: 1,
        height: 1,
        pointerEvents: "none",
      };

  const selectedNode = selectedNodeId != null
    ? nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;
  const selectedEdge = selectedEdgeId != null
    ? edges.find((e) => e.id === selectedEdgeId) ?? null
    : null;

  const selectedNodeIndex = selectedNode
    ? componentIndexMap.get(`node:${selectedNode.id}`)
    : undefined;
  const selectedEdgeIndex = selectedEdge
    ? componentIndexMap.get(`edge:${selectedEdge.id}`)
    : undefined;

  const selectedNodeRow: EquationRow | undefined =
    selectedNodeIndex != null
      ? flatEquationRows.find((r) => r.index === selectedNodeIndex)
      : undefined;
  const selectedEdgeRow: EquationRow | undefined =
    selectedEdgeIndex != null
      ? flatEquationRows.find((r) => r.index === selectedEdgeIndex)
      : undefined;

  const getEdgeRow = (edge: Edge): EquationRow | undefined => {
    const idx = componentIndexMap.get(`edge:${edge.id}`);
    if (idx == null) return undefined;
    return flatEquationRows.find((r) => r.index === idx);
  };

  const isPurePipeMultiSelection =
    !!selectedEdge &&
    multiSelectedEdgeIds.length > 0 &&
    multiSelectedNodeIds.length === 0 &&
    multiSelectedEdgeIds.includes(selectedEdge.id);

  const multiPipeIds: number[] | null = isPurePipeMultiSelection
    ? Array.from(new Set([...multiSelectedEdgeIds, selectedEdge.id]))
    : null;

  const isPureNodeMultiSelection =
    !!selectedNode &&
    multiSelectedNodeIds.length > 0 &&
    multiSelectedEdgeIds.length === 0 &&
    multiSelectedNodeIds.includes(selectedNode.id);

  const multiNodeIds: number[] | null = isPureNodeMultiSelection
    ? Array.from(new Set([...multiSelectedNodeIds, selectedNode.id]))
    : null;

  // Mixed multi-selection (nodes and/or edges, not pure pipes): collect
  // canonical indices and expand them into detailed hydraulic rows so we can
  // list pipe → tee_main → elbow90 → pipe etc.
  const mixedSelectedIndices: number[] = useMemo(() => {
    const ids: number[] = [];
    if (multiPipeIds) return ids; // handled separately

    const indices = new Set<number>();

    for (const nodeId of multiSelectedNodeIds) {
      const idx = componentIndexMap.get(`node:${nodeId}`);
      if (idx != null) indices.add(idx);
    }
    for (const edgeId of multiSelectedEdgeIds) {
      const idx = componentIndexMap.get(`edge:${edgeId}`);
      if (idx != null) indices.add(idx);
    }

    return Array.from(indices).sort((a, b) => a - b);
  }, [multiPipeIds, multiSelectedNodeIds, multiSelectedEdgeIds, componentIndexMap]);

  const mixedDetailByOutlet: { outletIndex: number; rows: EquationRow[] }[] = useMemo(() => {
    if (!mixedSelectedIndices.length) return [];
    const indexSet = new Set(mixedSelectedIndices);
    const result: { outletIndex: number; rows: EquationRow[] }[] = [];

    equationRowGroups.forEach((group, groupIndex) => {
      const rowsForOutlet: EquationRow[] = [];
      for (const row of group) {
        if (indexSet.has(row.index)) {
          rowsForOutlet.push(row);
        }
      }
      if (rowsForOutlet.length) {
        result.push({ outletIndex: groupIndex + 1, rows: rowsForOutlet });
      }
    });

    return result;
  }, [mixedSelectedIndices, equationRowGroups]);

  const isVerticalEdge = (edge: Edge): boolean => {
    const fromNode = nodes.find((n) => n.id === edge.fromId);
    const toNode = nodes.find((n) => n.id === edge.toId);
    if (!fromNode || !toNode) return false;

    const { x: x1, y: y1 } = fromNode;
    const { x: x2, y: y2 } = toNode;
    const TOL = 0.001;
    return Math.abs(x1 - x2) <= TOL && Math.abs(y1 - y2) > TOL;
  };

  const handleExportExcel = () => {
    if (!canvasJson.components.length) {
      alert("Nothing to export: draw some components first.");
      return;
    }

    if (!equationRowGroups.length) {
      alert("No rows to export.");
      return;
    }

    // Column definitions shared by all sheets. Headers are what the user sees;
    // keys are properties on EquationRow.
    const columns = [
      { header: "Index",      key: "index"    },
      { header: "Item",       key: "item"     },
      { header: "Q[L/s]",     key: "Q"        },
      { header: "d[mm]",      key: "d"        },
      { header: "L[m]",       key: "L"        },
      { header: "Vertical",   key: "vertical" },
      { header: "Elbow",      key: "elbow"    },
      { header: "Reducer",    key: "reducer"  },
      { header: "T90",        key: "t90"      },
      { header: "d90",        key: "d90"      },
      { header: "q90",        key: "q90"      },
      { header: "di",         key: "di"       },
      { header: "V[m/s]",     key: "V"        },
      { header: "h[m]",       key: "h"        },
      { header: "Re",         key: "Re"       },
      { header: "f",          key: "f"        },
      { header: "A_out/A_in", key: "a"        },
      { header: "Kred",       key: "kred"     },
      { header: "Ktee",       key: "ktee"     },
      { header: "Ktotal",     key: "ktotal"   },
      { header: "m",          key: "vp"       },
      { header: "Delta_H",    key: "delta_H"  },
      { header: "Delta_P",    key: "delta_P"  },
    ] as const;

    const workbook = XLSXUtils.book_new();

    equationRowGroups.forEach((rows, groupIndex) => {
      if (!rows || rows.length === 0) return;

      // Build a 2D array of values: first the header row, then one row per
      // EquationRow in this group.
      const sheetData: (string | number | boolean)[][] = [];
      sheetData.push(columns.map((c) => c.header));

      for (const row of rows) {
        sheetData.push(
          columns.map((c) => {
            const value = (row as any)[c.key];
            return value == null ? "" : (value as any);
          })
        );
      }

      const worksheet = XLSXUtils.aoa_to_sheet(sheetData);

      // Derive a sheet name; keep it within Excel's 31-character limit.
      const baseName = fileName || "Path";
      const sheetName =
        equationRowGroups.length === 1
          ? baseName
          : `${baseName}-${groupIndex + 1}`;

      XLSXUtils.book_append_sheet(
        workbook,
        worksheet,
        sheetName.slice(0, 31)
      );
    });

    const baseName = fileName || "canvas";
    writeXLSXFile(workbook, `${baseName}-equations.xlsx`);
  };

  const handleExportExcelReverse = () => {
    if (!canvasJson.components.length) {
      alert("Nothing to export: draw some components first.");
      return;
    }

    if (!equationRowGroups.length) {
      alert("No rows to export.");
      return;
    }

    const columns = [
      { header: "Index",      key: "index"    },
      { header: "Item",       key: "item"     },
      { header: "Q[L/s]",     key: "Q"        },
      { header: "d[mm]",      key: "d"        },
      { header: "L[m]",       key: "L"        },
      { header: "Vertical",   key: "vertical" },
      { header: "Elbow",      key: "elbow"    },
      { header: "Reducer",    key: "reducer"  },
      { header: "T90",        key: "t90"      },
      { header: "d90",        key: "d90"      },
      { header: "q90",        key: "q90"      },
      { header: "di",         key: "di"       },
      { header: "V[m/s]",     key: "V"        },
      { header: "h[m]",       key: "h"        },
      { header: "Re",         key: "Re"       },
      { header: "f",          key: "f"        },
      { header: "A_out/A_in", key: "a"        },
      { header: "Kred",       key: "kred"     },
      { header: "Ktee",       key: "ktee"     },
      { header: "Ktotal",     key: "ktotal"   },
      { header: "m",          key: "vp"       },
      { header: "Delta_H",    key: "delta_H"  },
      { header: "Delta_P",    key: "delta_P"  },
    ] as const;

    const workbook = XLSXUtils.book_new();

    equationRowGroups.forEach((rows, groupIndex) => {
      if (!rows || rows.length === 0) return;

      const sheetData: (string | number | boolean)[][] = [];
      sheetData.push(columns.map((c) => c.header));

      // Reverse the order for this outlet path: last component (outlet)
      // appears first, then back toward the discharge.
      const reversed = [...rows].reverse();

      for (const row of reversed) {
        sheetData.push(
          columns.map((c) => {
            const value = (row as any)[c.key];
            return value == null ? "" : (value as any);
          })
        );
      }

      const worksheet = XLSXUtils.aoa_to_sheet(sheetData);

      const baseName = fileName || "Path";
      const sheetName =
        equationRowGroups.length === 1
          ? `${baseName}-rev`
          : `${baseName}-rev-${groupIndex + 1}`;

      XLSXUtils.book_append_sheet(
        workbook,
        worksheet,
        sheetName.slice(0, 31)
      );
    });

    const baseName = fileName || "canvas";
    writeXLSXFile(workbook, `${baseName}-equations-reverse.xlsx`);
  };

  const handleExportGoogleSheets = () => {
    if (!canvasJson.components.length) {
      alert("Nothing to export: draw some components first.");
      return;
    }

    if (!equationRowGroups.length) {
      alert("No rows to export.");
      return;
    }

    // Reuse the same workbook structure as Excel export; the resulting .xlsx
    // file can be uploaded or imported directly into Google Sheets.
    const columns = [
      { header: "Index",      key: "index"    },
      { header: "Item",       key: "item"     },
      { header: "Q[L/s]",     key: "Q"        },
      { header: "d[mm]",      key: "d"        },
      { header: "L[m]",       key: "L"        },
      { header: "Vertical",   key: "vertical" },
      { header: "Elbow",      key: "elbow"    },
      { header: "Reducer",    key: "reducer"  },
      { header: "T90",        key: "t90"      },
      { header: "d90",        key: "d90"      },
      { header: "q90",        key: "q90"      },
      { header: "di",         key: "di"       },
      { header: "V[m/s]",     key: "V"        },
      { header: "h[m]",       key: "h"        },
      { header: "Re",         key: "Re"       },
      { header: "f",          key: "f"        },
      { header: "A_out/A_in", key: "a"        },
      { header: "Kred",       key: "kred"     },
      { header: "Ktee",       key: "ktee"     },
      { header: "Ktotal",     key: "ktotal"   },
      { header: "m",          key: "vp"       },
      { header: "Delta_H",    key: "delta_H"  },
      { header: "Delta_P",    key: "delta_P"  },
    ] as const;

    const workbook = XLSXUtils.book_new();

    equationRowGroups.forEach((rows, groupIndex) => {
      if (!rows || rows.length === 0) return;

      const sheetData: (string | number | boolean)[][] = [];
      sheetData.push(columns.map((c) => c.header));

      for (const row of rows) {
        sheetData.push(
          columns.map((c) => {
            const value = (row as any)[c.key];
            return value == null ? "" : (value as any);
          })
        );
      }

      const worksheet = XLSXUtils.aoa_to_sheet(sheetData);

      const baseName = fileName || "Path";
      const sheetName =
        equationRowGroups.length === 1
          ? baseName
          : `${baseName}-${groupIndex + 1}`;

      XLSXUtils.book_append_sheet(
        workbook,
        worksheet,
        sheetName.slice(0, 31)
      );
    });

    const baseName = fileName || "canvas";
    writeXLSXFile(workbook, `${baseName}-equations-google-sheets.xlsx`);
  };

  const handleExportQuantities = () => {
    if (!canvasJson.components.length) {
      alert("Nothing to export: draw some components first.");
      return;
    }

    if (!equationRowGroups.length) {
      alert("No rows to export.");
      return;
    }

    // Build a single quantities sheet with aggregated take‑offs by component
    // type and diameter. The default d[mm] value is treated as the *exit*
    // diameter in discharge → outlet order.
    const sheetData: (string | number | boolean)[][] = [];

    // --- Pipes: total length per exit diameter ---
    const pipeTotals = new Map<number, number>();
    for (const path of equationRowGroups) {
      for (const row of path) {
        if (row.item !== "pipe") continue;
        const d = typeof row.d === "number" ? row.d : 0;
        const L = typeof row.L === "number" ? row.L : 0;
        if (!d || !L) continue;
        pipeTotals.set(d, (pipeTotals.get(d) ?? 0) + L);
      }
    }
    if (pipeTotals.size > 0) {
      sheetData.push(["Pipes"]);
      sheetData.push(["d[mm]", "L[m]"]);
      Array.from(pipeTotals.entries())
        .sort(([d1], [d2]) => d1 - d2)
        .forEach(([d, L]) => {
          sheetData.push([d, L]);
        });
      sheetData.push([]);
    }

    // --- Reducers: count per (start_d, end_d) pair ---
    type ReducerSummary = { startD: number; endD: number; count: number };
    const reducerTotals = new Map<string, ReducerSummary>();

    for (const path of equationRowGroups) {
      for (let i = 0; i < path.length; i++) {
        const row = path[i];
        if (row.item !== "reducer") continue;

        // Start diameter: upstream exit diameter (previous row in the path)
        let startD = typeof path[i - 1]?.d === "number" ? path[i - 1]!.d! : 0;
        // End diameter: exit diameter of the reducer row itself by default
        let endD = typeof row.d === "number" ? row.d : 0;

        // Fallbacks if either side is missing: search outward along the path.
        if (!startD) {
          for (let j = i - 1; j >= 0; j--) {
            const d = path[j].d;
            if (typeof d === "number" && d > 0) {
              startD = d;
              break;
            }
          }
        }
        if (!endD) {
          for (let j = i + 1; j < path.length; j++) {
            const d = path[j].d;
            if (typeof d === "number" && d > 0) {
              endD = d;
              break;
            }
          }
        }

        if (!startD || !endD) continue;

        const key = `${startD}|${endD}`;
        const existing = reducerTotals.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          reducerTotals.set(key, { startD, endD, count: 1 });
        }
      }
    }

    if (reducerTotals.size > 0) {
      sheetData.push(["Reducers"]);
      sheetData.push(["Start d[mm]", "End d[mm]", "Qty"]);
      Array.from(reducerTotals.values())
        .sort((a, b) => (a.startD - b.startD) || (a.endD - b.endD))
        .forEach(({ startD, endD, count }) => {
          sheetData.push([startD, endD, count]);
        });
      sheetData.push([]);
    }

    // --- Elbows: count per item & diameter ---
    type ElbowSummary = { item: string; d: number; count: number };
    const elbowTotals = new Map<string, ElbowSummary>();

    for (const path of equationRowGroups) {
      for (const row of path) {
        if (row.item !== "elbow45" && row.item !== "elbow90") continue;
        const d = typeof row.d === "number" ? row.d : 0;
        if (!d) continue;
        const key = `${row.item}|${d}`;
        const existing = elbowTotals.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          elbowTotals.set(key, { item: row.item, d, count: 1 });
        }
      }
    }

    if (elbowTotals.size > 0) {
      sheetData.push(["Elbows"]);
      sheetData.push(["Item", "d[mm]", "Qty"]);
      Array.from(elbowTotals.values())
        .sort((a, b) => {
          if (a.item === b.item) return a.d - b.d;
          return a.item < b.item ? -1 : 1;
        })
        .forEach(({ item, d, count }) => {
          sheetData.push([item, d, count]);
        });
      sheetData.push([]);
    }

    // --- Outlets & discharge: count per item & diameter ---
    type TerminalSummary = { item: string; d: number; count: number };
    const terminalTotals = new Map<string, TerminalSummary>();

    for (const path of equationRowGroups) {
      for (const row of path) {
        if (row.item !== "outlet" && row.item !== "discharge") continue;
        const d = typeof row.d === "number" ? row.d : 0;
        if (!d) continue;
        const key = `${row.item}|${d}`;
        const existing = terminalTotals.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          terminalTotals.set(key, { item: row.item, d, count: 1 });
        }
      }
    }

    if (terminalTotals.size > 0) {
      sheetData.push(["Outlets & Discharges"]);
      sheetData.push(["Item", "d[mm]", "Qty"]);
      Array.from(terminalTotals.values())
        .sort((a, b) => {
          if (a.item === b.item) return a.d - b.d;
          return a.item < b.item ? -1 : 1;
        })
        .forEach(({ item, d, count }) => {
          sheetData.push([item, d, count]);
        });
      sheetData.push([]);
    }

    // --- Tees: grouped by main enter, main exit, side exit diameters ---
    type TeeSummary = {
      mainEnter: number;
      mainExit: number;
      sideExit: number;
      count: number;
    };
    const teeTotals = new Map<string, TeeSummary>();

    for (const path of equationRowGroups) {
      for (let i = 0; i < path.length; i++) {
        const row = path[i];
        if (row.item !== "tee_main") continue;

        let mainEnter = typeof path[i - 1]?.d === "number" ? path[i - 1]!.d! : 0;
        let mainExit = typeof row.d === "number" ? row.d : 0;
        let sideExit = typeof row.d90 === "number" ? row.d90 : 0;

        if (!mainEnter) mainEnter = mainExit;
        if (!mainExit) mainExit = mainEnter;
        if (!sideExit) sideExit = mainExit;

        if (!mainEnter || !mainExit || !sideExit) continue;

        const key = `${mainEnter}|${mainExit}|${sideExit}`;
        const existing = teeTotals.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          teeTotals.set(key, { mainEnter, mainExit, sideExit, count: 1 });
        }
      }
    }

    if (teeTotals.size > 0) {
      sheetData.push(["Tees"]);
      sheetData.push([
        "Tee_main enter d[mm]",
        "Tee_main exit d[mm]",
        "Tee_side exit d[mm]",
        "Qty",
      ]);
      Array.from(teeTotals.values())
        .sort((a, b) =>
          a.mainEnter - b.mainEnter ||
          a.mainExit - b.mainExit ||
          a.sideExit - b.sideExit
        )
        .forEach(({ mainEnter, mainExit, sideExit, count }) => {
          sheetData.push([mainEnter, mainExit, sideExit, count]);
        });
      sheetData.push([]);
    }

    const worksheet = XLSXUtils.aoa_to_sheet(sheetData);
    const workbook = XLSXUtils.book_new();
    XLSXUtils.book_append_sheet(workbook, worksheet, "Quantities");

    const baseName = fileName || "canvas";
    writeXLSXFile(workbook, `${baseName}-quantities.xlsx`);
  };

  const handleExportJson = () => {
    if (!canvasJson.components.length) {
      alert("Nothing to export: draw some components first.");
      return;
    }

    const blob = new Blob([
      JSON.stringify(canvasJson, null, 2),
    ], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${fileName || "canvas"}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleExportPhoto = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!nodes.length && !edges.length) {
      alert("Nothing to export: draw some components first.");
      return;
    }

    // Compute world-space bounding box of all nodes.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
      if (node.x < minX) minX = node.x;
      if (node.x > maxX) maxX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.y > maxY) maxY = node.y;
    }

    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
      alert("Nothing to export: no nodes found in the drawing.");
      return;
    }

    // Convert world-space bounds to canvas pixel coordinates.
    const topLeft = worldToScreen({ x: minX, y: minY }, canvas, offset, zoom);
    const bottomRight = worldToScreen({ x: maxX, y: maxY }, canvas, offset, zoom);

    let sx = Math.min(topLeft.x, bottomRight.x);
    let sy = Math.min(topLeft.y, bottomRight.y);
    let ex = Math.max(topLeft.x, bottomRight.x);
    let ey = Math.max(topLeft.y, bottomRight.y);

    // Extra padding so the numbered index circles and their connectors are fully visible
    // above and around the nodes (labels sit ~24px away from a node at default zoom).
    const padding = 40;
    sx = Math.max(0, Math.floor(sx - padding));
    sy = Math.max(0, Math.floor(sy - padding));
    ex = Math.min(canvas.width, Math.ceil(ex + padding));
    ey = Math.min(canvas.height, Math.ceil(ey + padding));

    const width = ex - sx;
    const height = ey - sy;
    if (width <= 0 || height <= 0) {
      alert("Unable to determine a valid export region.");
      return;
    }

    const scale = (typeof window !== "undefined" ? window.devicePixelRatio || 2 : 2);
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = Math.max(1, Math.floor(width * scale));
    exportCanvas.height = Math.max(1, Math.floor(height * scale));
    const exportCtx = exportCanvas.getContext("2d");
    if (!exportCtx) {
      alert("Unable to create export canvas.");
      return;
    }

    // Draw the cropped region scaled into the higher-resolution export canvas.
    try {
      exportCtx.drawImage(
        canvas,
        sx,
        sy,
        width,
        height,
        0,
        0,
        exportCanvas.width,
        exportCanvas.height
      );

      // Draw outlet numbers + capacities into the snapshot at their screen
      // positions (same as the live UI labels).
      if (outletCapacityLabels.length > 0) {
        exportCtx.save();
        exportCtx.fillStyle = "#000";
        exportCtx.textAlign = "center";
        exportCtx.textBaseline = "middle";
        const baseFontSize = 10; // px at scale 1
        exportCtx.font = `${baseFontSize * scale}px sans-serif`;

        for (const label of outletCapacityLabels) {
          const lx = (label.x - sx) * scale;
          const ly = (label.y - sy) * scale;
          if (lx < 0 || lx > exportCanvas.width || ly < 0 || ly > exportCanvas.height) {
            continue;
          }
          exportCtx.fillText(label.text, lx, ly);
        }

        exportCtx.restore();
      }

      // Draw pipe drawing indices into the snapshot only.
      if (pipeDimensionLabels.length > 0) {
        exportCtx.save();
        exportCtx.fillStyle = "#000";
        exportCtx.textAlign = "center";
        exportCtx.textBaseline = "middle";
        const baseFontSize = 10; // px at scale 1
        exportCtx.font = `${baseFontSize * scale}px sans-serif`;

        for (const label of pipeDimensionLabels) {
          // Transform from original canvas coords to export canvas coords.
          const lx = (label.x - sx) * scale;
          const ly = (label.y - sy) * scale;
          if (lx < 0 || lx > exportCanvas.width || ly < 0 || ly > exportCanvas.height) {
            continue;
          }

          exportCtx.save();
          exportCtx.translate(lx, ly);
          // Draw numbers upright; do not rotate with the pipe angle.
          exportCtx.fillText(label.text, 0, 0);
          exportCtx.restore();
        }

        exportCtx.restore();
      }

      // Post-process: convert to black-on-white linework, removing grid and colors.
      const imageData = exportCtx.getImageData(0, 0, exportCanvas.width, exportCanvas.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a === 0) continue;
        // Compute perceived brightness.
        const v = 0.299 * r + 0.587 * g + 0.114 * b;
        // Anything darker than this threshold becomes black; everything else becomes white.
        const bw = v < 140 ? 0 : 255;
        data[i] = bw;
        data[i + 1] = bw;
        data[i + 2] = bw;
      }
      exportCtx.putImageData(imageData, 0, 0);

      const dataUrl = exportCanvas.toDataURL("image/png");
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = `${fileName || "canvas"}-snapshot.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      // Fallback: export the full canvas if cropping fails for any reason.
      try {
        const dataUrl = canvas.toDataURL("image/png");
        const link = document.createElement("a");
        link.href = dataUrl;
        link.download = `${fileName || "canvas"}-snapshot.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch (innerErr) {
        console.error("Error exporting snapshot", innerErr);
        alert("Unable to export snapshot image.");
      }
    }
  };

  const handleSave = async () => {
    if (!hasProjectContext) {
      setSaveMessage(
        "Open this canvas from a project to save in Supabase, or use Export to download JSON."
      );
      return;
    }

    setIsSaving(true);
    setSaveMessage(null);

    try {
      let name = fileName;
      if (!name) {
        const entered = window.prompt("Name this design", "Untitled design");
        if (!entered) {
          setIsSaving(false);
          return;
        }
        name = entered;
        setFileName(name);
      }

      if (!fileId) {
        const { data, error } = await supabase
          .from("project_files")
          .insert({
            project_id: projectId,
            name,
            data: canvasJson,
          })
          .select("id")
          .single();

        if (error) throw error;

        const newId = (data as { id: string }).id;
        setLoadedFileId(newId);

        // Update the URL so future saves update the same file
        const params = new URLSearchParams(searchParams.toString());
        params.set("projectId", projectId);
        params.set("fileId", newId);
        router.replace(`?${params.toString()}`);

        setSaveMessage("Saved");
      } else {
        const { error } = await supabase
          .from("project_files")
          .update({
            name,
            data: canvasJson,
          })
          .eq("id", fileId);

        if (error) throw error;
        setSaveMessage("Saved");
      }
    } catch (error) {
      console.error("Error saving canvas", error);
      setSaveMessage("Error saving");
    } finally {
      setIsSaving(false);
      // Clear the message after a short delay
      setTimeout(() => setSaveMessage(null), 3000);
    }
  };

  // Auto-trigger exports when opened from an org project file card with an
  // `export` query param (equations / quantities only).
  useEffect(() => {
    if (!exportAction) return;
    if (!canvasJson.components.length || !equationRowGroups.length) return;

    if (exportAction === "equations") {
      handleExportGoogleSheets();
    } else if (exportAction === "quantities") {
      handleExportQuantities();
    }

    // Remove the export param from the URL so repeated interactions don't
    // retrigger the export.
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("export");
      router.replace(url.toString());
    }
  }, [exportAction, canvasJson.components.length, equationRowGroups.length]);

  const handleOpenCalculate = () => {
    // Previously we forced all diameters/lengths/capacities to be filled
    // before running calculations. Now we allow missing values and will
    // normalize them when the user presses Done in the dialog.
    setCalculateError(null);
    setCalculateOpen(true);
  };

  const handleDoneCalculate = () => {
    saveSnapshotForUndo();
    setEdges((prevEdges) => {
      if (prevEdges.length === 0) return prevEdges;

      // Find a reference pipe that has both diameter and length defined.
      const reference = prevEdges.find(
        (e) => typeof e.diameter === "number" && typeof e.length === "number"
      );

      const refDiameter =
        reference && typeof reference.diameter === "number"
          ? reference.diameter
          : 100;
      const refLength =
        reference && typeof reference.length === "number" ? reference.length : 10;

      return prevEdges.map((edge) => {
        const hasDiameter = typeof edge.diameter === "number";
        const hasLength = typeof edge.length === "number";

        return {
          ...edge,
          diameter: hasDiameter ? edge.diameter : refDiameter,
          length: hasLength ? edge.length : refLength,
        };
      });
    });
  };

  const handleNodeTypeChange = (nodeId: number, type: ElementType) => {
    // If multiple nodes are selected and no pipes are selected, changing the
    // type in the popover for one of them should update all selected nodes at
    // once so they stay in sync (mirrors pipe multi-edit behaviour).
    const hasNodeMultiSelectionOnly =
      multiSelectedNodeIds.length > 0 && multiSelectedEdgeIds.length === 0;

    const targetNodeIds = hasNodeMultiSelectionOnly
      ? Array.from(new Set([...multiSelectedNodeIds, nodeId]))
      : [nodeId];

    saveSnapshotForUndo();
    setNodes((prev) =>
      prev.map((node) =>
        targetNodeIds.includes(node.id)
          ? { ...node, type }
          : node
      )
    );
  };

  const handleNodeCapacityChange = (nodeId: number, capacity: number | undefined) => {
    saveSnapshotForUndo();
    setNodes((prev) =>
      prev.map((node) =>
        node.id === nodeId ? { ...node, capacity } : node
      )
    );
  };

  const handleEdgeDiameterChange = (edgeId: number, diameter: number | undefined) => {
    // If multiple pipes (edges) are selected and no nodes are selected, changing
    // the diameter in the popover for one of them should update all selected
    // pipes at once.
    const hasPipeMultiSelectionOnly =
      multiSelectedEdgeIds.length > 0 && multiSelectedNodeIds.length === 0;

    const targetEdgeIds = hasPipeMultiSelectionOnly
      ? Array.from(new Set([...multiSelectedEdgeIds, edgeId]))
      : [edgeId];

    saveSnapshotForUndo();
    setEdges((prev) =>
      prev.map((edge) =>
        targetEdgeIds.includes(edge.id)
          ? { ...edge, diameter }
          : edge
      )
    );
  };

  const handleEdgeLengthChange = (edgeId: number, length: number | undefined) => {
    // Same behavior as diameter: in a pure pipe multi-selection, edits apply to
    // all selected pipes so they stay in sync.
    const hasPipeMultiSelectionOnly =
      multiSelectedEdgeIds.length > 0 && multiSelectedNodeIds.length === 0;

    const targetEdgeIds = hasPipeMultiSelectionOnly
      ? Array.from(new Set([...multiSelectedEdgeIds, edgeId]))
      : [edgeId];

    saveSnapshotForUndo();
    setEdges((prev) =>
      prev.map((edge) =>
        targetEdgeIds.includes(edge.id)
          ? { ...edge, length }
          : edge
      )
    );
  };

  // Screen-space labels for outlet capacities (HTML overlay above WebGL symbols)
  // Outlet numbering should follow the same per-outlet ordering that the
  // calculations layer uses (equationRowGroups). This ensures that "Outlet 1"
  // in the UI matches "Outlet 1" in the calculation table/exports and that
  // any tee/length-based ordering logic is centralized in Calculations.
  const outletCapacityLabels = useMemo(
    () => {
      const canvas = canvasRef.current;
      if (!canvas) return [] as { id: number; x: number; y: number; text: string }[];

      const labels: { id: number; x: number; y: number; text: string }[] = [];

      // Map each outlet node id to its outlet index based on equationRowGroups
      // ordering. For each group (one logical outlet path), find the outlet row,
      // then map that row back to the underlying node via canonicalOrder.
      const outletIndexById = new Map<number, number>();

      equationRowGroups.forEach((rows, groupIdx) => {
        if (!rows || rows.length === 0) return;
        const outletRow = [...rows].reverse().find((r) => r.item === "outlet");
        if (!outletRow) return;

        const rowIndex = outletRow.index;
        const comp = canonicalOrder[rowIndex - 1];
        if (!comp || comp.component !== "node") return;

        const nodeId = comp.id;
        if (!outletIndexById.has(nodeId)) {
          outletIndexById.set(nodeId, groupIdx + 1);
        }
      });

      // Fallback: if calculations produced no per-outlet groups yet, fall back
      // to simple draw-order numbering.
      if (outletIndexById.size === 0) {
        let counter = 1;
        for (const entry of canonicalOrder) {
          if (entry.component !== "node") continue;
          const node = nodes.find((n) => n.id === entry.id && n.type === "outlet");
          if (!node) continue;
          if (!outletIndexById.has(node.id)) {
            outletIndexById.set(node.id, counter++);
          }
        }
      }

      for (const node of nodes) {
        if (node.type !== "outlet") continue;
        if (typeof node.capacity !== "number") continue;

        const screen = worldToScreen({ x: node.x, y: node.y }, canvas, offset, zoom);
        // Place the text slightly above the outlet symbol in screen space.
        const labelY = screen.y - 14; // px offset upwards

        const outletNo = outletIndexById.get(node.id);
        const text =
          outletNo != null
            ? `${outletNo}: ${node.capacity} L/s`
            : `${node.capacity} L/s`;

        labels.push({
          id: node.id,
          x: screen.x,
          y: labelY,
          text,
        });
      }

      return labels;
    },
    [nodes, offset, zoom, canonicalOrder]
  );

  // Screen-space labels for pipe drawing indices (component numbers) placed
  // along each pipe segment. These are only rendered into the snapshot export.
  const pipeDimensionLabels = useMemo(
    () => {
      const canvas = canvasRef.current;
      if (!canvas)
        return [] as {
          id: number;
          x: number;
          y: number;
          text: string;
          angleDeg: number;
          isVertical: boolean;
        }[];

      const labels: {
        id: number;
        x: number;
        y: number;
        text: string;
        angleDeg: number;
        isVertical: boolean;
      }[] = [];

      for (const edge of edges) {
        if (edge.type !== "pipe") continue;
        const fromNode = nodes.find((n) => n.id === edge.fromId);
        const toNode = nodes.find((n) => n.id === edge.toId);
        if (!fromNode || !toNode) continue;

        const idx = componentIndexMap.get(`edge:${edge.id}`);
        if (!idx) continue;

        const fromScreen = worldToScreen({ x: fromNode.x, y: fromNode.y }, canvas, offset, zoom);
        const toScreen = worldToScreen({ x: toNode.x, y: toNode.y }, canvas, offset, zoom);

        // Center of the line segment in screen space.
        const midX = (fromScreen.x + toScreen.x) / 2;
        const midY = (fromScreen.y + toScreen.y) / 2;

        const dx = toScreen.x - fromScreen.x;
        const dy = toScreen.y - fromScreen.y;
        const isVertical = Math.abs(dx) < 1e-3;
        const angleRad = Math.atan2(dy, dx);
        let angleDeg = (angleRad * 180) / Math.PI;
        // Keep text upright: normalize angle so it stays within [-90, 90].
        if (angleDeg > 90) angleDeg -= 180;
        if (angleDeg < -90) angleDeg += 180;

        // Offset the label away from the pipe so it doesn't overlap.
        const LABEL_PADDING = 12; // px
        let labelX = midX;
        let labelY = midY;
        if (isVertical) {
          // For vertical pipes, move the label slightly to the left so it clears the line.
          labelX = midX - LABEL_PADDING * 1.25;
        } else {
          const len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len;
          const ny = dx / len;
          // Offset on the opposite side of the normal so labels sit on the
          // other side of the pipe compared to the previous behavior.
          labelX = midX - nx * LABEL_PADDING;
          labelY = midY - ny * LABEL_PADDING;
        }

        const text = String(idx);

        labels.push({
          id: edge.id,
          x: labelX,
          y: labelY,
          text,
          angleDeg,
          isVertical,
        });
      }

      return labels;
    },
    [edges, nodes, offset, zoom, componentIndexMap]
  );

  const closePopover = () => {
    setPopoverOpen(false);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  };

  const renderPopoverBody = () => {
    if (multiPipeIds) {
      return (
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              {multiPipeIds.length} pipes selected
            </div>
            <button
              type="button"
              onClick={handleExportQuantities}
              className="rounded border border-black bg-white px-2 py-0.5 text-[11px]"
            >
              Export quantity
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {multiPipeIds.map((id, idx) => {
              const edge = edges.find((e) => e.id === id);
              if (!edge) return null;
              const row = getEdgeRow(edge);
              const labelIndex =
                componentIndexMap.get(`edge:${edge.id}`) ?? edge.id;

              return (
                <div
                  key={edge.id}
                  className="flex min-w-[140px] max-w-[160px] flex-col space-y-2 border-r pr-2 last:border-r-0 last:pr-0"
                >
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium truncate">
                      Pipe {labelIndex}
                    </div>
                    <div className="text-[10px] text-muted-foreground whitespace-nowrap">
                      #{idx + 1} / {multiPipeIds.length}
                    </div>
                  </div>
                  <div className="space-y-1 pt-1">
                    <div className="text-xs font-medium">Length</div>
                    <input
                      type="number"
                      className="w-full rounded border px-2 py-1 text-[11px]"
                      value={edge.length ?? ""}
                      onChange={(e) => {
                        const value = e.target.value;
                        const num =
                          value === "" ? undefined : Number(value);
                        if (Number.isNaN(num)) return;
                        handleEdgeLengthChange(edge.id, num);
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium">Diameter</div>
                    <input
                      type="number"
                      className="w-full rounded border px-2 py-1 text-[11px]"
                      value={edge.diameter ?? ""}
                      onChange={(e) => {
                        const value = e.target.value;
                        const num =
                          value === "" ? undefined : Number(value);
                        if (Number.isNaN(num)) return;
                        handleEdgeDiameterChange(edge.id, num);
                      }}
                    />
                  </div>
                  {row && (
                    <div className="space-y-0.5 border-t pt-2 mt-1">
                      <div className="text-xs font-medium">Hydraulics</div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        Capacity: {typeof row.Q === "number" ? `${row.Q.toFixed(3)} L/s` : "-"}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        Velocity: {typeof row.V === "number" ? row.V.toFixed(3) : "-"} m/s
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        Pressure: {typeof row.delta_P === "number" ? row.delta_P : "-"}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        Head loss: {typeof row.delta_H === "number" ? row.delta_H.toFixed(3) : "-"} m
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        Vertical: {isVerticalEdge(edge) ? "Yes" : "No"}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    if (mixedDetailByOutlet.length > 0) {
      return (
        <div className="space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <div className="text-[11px] text-muted-foreground">
              {mixedDetailByOutlet.length} outlet paths selected
            </div>
            <button
              type="button"
              onClick={handleExportQuantities}
              className="rounded border border-black bg-white px-2 py-0.5 text-[11px]"
            >
              Export quantity
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {mixedDetailByOutlet.map((group) => (
              <div
                key={group.outletIndex}
                className="flex min-w-[140px] max-w-[160px] flex-col space-y-1 border-r pr-2 last:border-r-0 last:pr-0"
              >
                <div className="text-xs font-medium mb-1">
                  Outlet {group.outletIndex}
                </div>
                {group.rows.map((row, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-2"
                  >
                    <div className="truncate">
                      {row.item} (index {row.index})
                    </div>
                    <div className="text-[10px] text-muted-foreground whitespace-nowrap">
                      d: {typeof row.d === "number" ? row.d : "-"} · L: {typeof row.L === "number" ? row.L : "-"}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      );
    }

    if (!selectedNode && !selectedEdge) {
      return (
        <div className="text-xs text-muted-foreground">
          Click a node or pipe to edit its properties.
        </div>
      );
    }

    return (
      <div className="space-y-2 text-sm">
        {selectedNode && (
          <div className="space-y-2 text-sm">
            <div className="text-right space-y-0.5">
              {selectedNodeIndex != null && (
                <div className="text-[11px] text-muted-foreground">
                  Index {selectedNodeIndex}
                </div>
              )}
              {isPureNodeMultiSelection && multiNodeIds && (
                <div className="text-[10px] text-muted-foreground">
                  Editing {multiNodeIds.length} nodes
                </div>
              )}
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium">Type</div>
              <select
                className="w-full rounded border px-2 py-1 text-xs"
                value={selectedNode.type ?? "elbow45"}
                onChange={(e) =>
                  handleNodeTypeChange(
                    selectedNode.id,
                    e.target.value as ElementType,
                  )
                }
              >
                {NODE_ELEMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            {selectedNode.type === "outlet" && (
              <div className="space-y-1">
                <div className="text-xs font-medium">Capacity</div>
                <input
                  type="number"
                  className="w-full rounded border px-2 py-1 text-xs"
                  value={selectedNode.capacity ?? ""}
                  onChange={(e) => {
                    const value = e.target.value;
                    const num =
                      value === "" ? undefined : Number(value);
                    if (Number.isNaN(num)) return;
                    handleNodeCapacityChange(selectedNode.id, num);
                  }}
                />
              </div>
            )}
            {selectedNodeRow && (
              <div className="space-y-0.5 border-t pt-2 mt-2">
                <div className="text-xs font-medium">Hydraulics</div>
                <div className="text-[10px] text-muted-foreground">
                  Capacity: {typeof selectedNodeRow.Q === "number" ? `${selectedNodeRow.Q.toFixed(3)} L/s` : "-"}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Velocity: {typeof selectedNodeRow.V === "number" ? selectedNodeRow.V.toFixed(3) : "-"} m/s
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Pressure: {typeof selectedNodeRow.delta_P === "number" ? selectedNodeRow.delta_P : "-"}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Head loss: {typeof selectedNodeRow.delta_H === "number" ? selectedNodeRow.delta_H.toFixed(3) : "-"} m
                </div>
              </div>
            )}
            <div className="pt-2 mt-2 border-t flex justify-end">
              <button
                type="button"
                onClick={handleDeleteSelected}
                className="rounded-md border border-black bg-white px-2 py-0.5 text-[11px] text-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        )}

        {selectedEdge && (
          <div className="space-y-2 text-sm">
            <div className="text-right space-y-0.5">
              {selectedEdgeIndex != null && (
                <div className="text-[11px] text-muted-foreground">
                  Index {selectedEdgeIndex}
                </div>
              )}
              {multiSelectedEdgeIds.length > 0 &&
                multiSelectedNodeIds.length === 0 && (
                  <div className="text-[10px] text-muted-foreground">
                    Editing {
                      Array.from(
                        new Set([
                          ...multiSelectedEdgeIds,
                          selectedEdge.id,
                        ]),
                      ).length
                    }{' '}
                    pipes
                  </div>
                )}
            </div>
            <div className="space-y-1 pt-1">
              <div className="text-xs font-medium">Length</div>
              <input
                type="number"
                className="w-full rounded border px-2 py-1 text-xs"
                value={selectedEdge.length ?? ""}
                onChange={(e) => {
                  const value = e.target.value;
                  const num = value === "" ? undefined : Number(value);
                  if (Number.isNaN(num)) return;
                  handleEdgeLengthChange(selectedEdge.id, num);
                }}
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium">Diameter</div>
              <input
                type="number"
                className="w-full rounded border px-2 py-1 text-xs"
                value={selectedEdge.diameter ?? ""}
                onChange={(e) => {
                  const value = e.target.value;
                  const num = value === "" ? undefined : Number(value);
                  if (Number.isNaN(num)) return;
                  handleEdgeDiameterChange(selectedEdge.id, num);
                }}
              />
            </div>
            {selectedEdgeRow && (
              <div className="space-y-0.5 border-t pt-2 mt-2">
                <div className="text-xs font-medium">Hydraulics</div>
                <div className="text-[10px] text-muted-foreground">
                  Capacity: {typeof selectedEdgeRow.Q === "number" ? `${selectedEdgeRow.Q.toFixed(3)} L/s` : "-"}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Velocity: {typeof selectedEdgeRow.V === "number" ? selectedEdgeRow.V.toFixed(3) : "-"} m/s
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Pressure: {typeof selectedEdgeRow.delta_P === "number" ? selectedEdgeRow.delta_P : "-"}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Head loss: {typeof selectedEdgeRow.delta_H === "number" ? selectedEdgeRow.delta_H.toFixed(3) : "-"} m
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Vertical: {isVerticalEdge(selectedEdge) ? "Yes" : "No"}
                </div>
              </div>
            )}
            <div className="pt-2 mt-2 border-t flex justify-end">
              <button
                type="button"
                onClick={handleDeleteSelected}
                className="rounded-md border border-black bg-white px-2 py-0.5 text-[11px] text-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* Top-left controls: back + drawing status */}
      <div className="fixed left-4 top-4 z-50 flex flex-col gap-2">
        <button
          type="button"
          onClick={handleBack}
          className="inline-flex items-center rounded-md border border-black bg-white px-3 py-1 text-xs"
        >
          <span className="mr-1">←</span>
          <span>Back</span>
        </button>
        <div className="rounded-md border border-black bg-white/90 px-3 py-1 text-[11px]">
          DRAWING {drawingEnabled ? "ENABLED" : "DISABLED"} (press 'd')
        </div>
        <div className="rounded-md border border-black bg-white/90 px-3 py-1 text-[10px] leading-tight flex items-center gap-2">
          <svg
            className="h-12 w-12 flex-shrink-0"
            viewBox="0 0 80 80"
            aria-hidden="true"
          >
            {/* light background circle */}
            <circle cx="40" cy="40" r="28" fill="#f9fafb" stroke="#e5e7eb" strokeWidth="1" />
            {/* x-axis (red): ↗ / ↙ */}
            <line x1="16" y1="64" x2="64" y2="16" stroke="#ef4444" strokeWidth="2" />
            {/* y-axis (green): ↖ / ↘ */}
            <line x1="64" y1="64" x2="16" y2="16" stroke="#22c55e" strokeWidth="2" />
            {/* z-axis (blue): vertical ↑ / ↓ */}
            <line x1="40" y1="68" x2="40" y2="12" stroke="#3b82f6" strokeWidth="2" />
            {/* origin dot */}
            <circle cx="40" cy="40" r="2.5" fill="#111827" />
          </svg>
          <div className="space-y-0.5">
            <div className="font-semibold">Axis directions</div>
            <div className="space-y-0.5">
              <div className="flex items-center gap-1">
                <span className="inline-block h-1 w-3 rounded-full bg-red-500" />
                <span className="font-mono">x / −x</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="inline-block h-1 w-3 rounded-full bg-green-500" />
                <span className="font-mono">y / −y</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="inline-block h-1 w-3 rounded-full bg-blue-500" />
                <span className="font-mono">z / −z</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Top-right horizontal menu bar + legend */}
      <div className="fixed right-4 top-4 z-50 flex flex-col items-end gap-2">
        <div className="flex items-center gap-2 rounded-md border border-black bg-white/90 px-3 py-1 text-xs">
          <div
            className="relative"
            tabIndex={-1}
            onBlur={(e) => {
              const current = e.currentTarget;
              const related = e.relatedTarget as globalThis.Node | null;
              if (!current.contains(related)) {
                setIsExportMenuOpen(false);
              }
            }}
          >
            <button
              type="button"
              onClick={() => setIsExportMenuOpen((open) => !open)}
              className="inline-flex items-center rounded-md bg-white px-3 py-1 text-xs"
            >
              <span>Export</span>
              <span className="ml-1 text-[10px]">▾</span>
            </button>
            {isExportMenuOpen && (
              <div className="absolute right-0 mt-1 w-40 rounded-md border border-black bg-white py-1 text-xs">
                <button
                  type="button"
                  className="block w-full border-b border-black px-3 py-1 text-left hover:bg-gray-100 last:border-b-0"
                  onClick={() => {
                    setIsExportMenuOpen(false);
                    handleExportExcel();
                  }}
                >
                  Excel
                </button>
                <button
                  type="button"
                  className="block w-full border-b border-black px-3 py-1 text-left hover:bg-gray-100 last:border-b-0"
                  onClick={() => {
                    setIsExportMenuOpen(false);
                    handleExportExcelReverse();
                  }}
                >
                  Excel (Reverse)
                </button>
                <button
                  type="button"
                  className="block w-full border-b border-black px-3 py-1 text-left hover:bg-gray-100 last:border-b-0"
                  onClick={() => {
                    setIsExportMenuOpen(false);
                    handleExportGoogleSheets();
                  }}
                >
                  Google Sheets
                </button>
                <button
                  type="button"
                  className="block w-full border-b border-black px-3 py-1 text-left hover:bg-gray-100 last:border-b-0"
                  onClick={() => {
                    setIsExportMenuOpen(false);
                    handleExportQuantities();
                  }}
                >
                  Quantity
                </button>
                <button
                  type="button"
                  className="block w-full border-b border-black px-3 py-1 text-left hover:bg-gray-100 last:border-b-0"
                  onClick={() => {
                    setIsExportMenuOpen(false);
                    handleExportJson();
                  }}
                >
                  JSON
                </button>
                <button
                  type="button"
                  className="block w-full px-3 py-1 text-left hover:bg-gray-100"
                  onClick={() => {
                    setIsExportMenuOpen(false);
                    handleExportPhoto();
                  }}
                >
                  Photo (PNG)
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleOpenCalculate}
            className="rounded-md bg-white px-3 py-1 text-xs"
          >
            Calculate
          </button>
          <button
            type="button"
            onClick={() => {
              handleDoneCalculate();
              setCalculateOpen(false);
            }}
            className="rounded-md bg-white px-3 py-1 text-xs"
          >
            Autofill
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="rounded-md bg-white px-3 py-1 text-xs disabled:opacity-50"
          >
            {isSaving ? "Saving..." : "Save"}
          </button>
        </div>

        {saveMessage ? (
          <p className="text-[10px] text-muted-foreground">
            {saveMessage}
          </p>
        ) : (
          !hasProjectContext && (
            <p className="text-[10px] text-muted-foreground">
              Open the canvas from a project if you want to save in Supabase. You can always use Export without a project.
            </p>
          )
        )}

        {/* Legend removed from canvas UI; see /documentation for symbol guide. */}
      </div>

      {calculateError && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
          <div className="w-[360px] max-w-full rounded-md border bg-white p-4">
            <div className="mb-2 text-sm font-medium">Cannot run calculation</div>
            <p className="mb-3 text-xs text-red-600">
              {calculateError}
            </p>
            <button
              type="button"
              onClick={() => setCalculateError(null)}
              className="rounded-md bg-white px-3 py-1 text-xs"
            >
              OK
            </button>
          </div>
        </div>
      )}

      {calculateOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
          <div className="w-[520px] max-w-full rounded-md border bg-white p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-medium">Calculation</div>
              <button
                type="button"
                onClick={() => setCalculateOpen(false)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                &times;
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="border-b pb-2 mb-2">
                <div className="font-medium mb-1">Global pressure range</div>
                <div className="text-muted-foreground">
                  <span>Max p: {pressureStats.maxP}</span>
                  {" · "}
                  <span>Min p: {pressureStats.minP}</span>
                </div>
              </div>

              {pressureStats.outletSummaries.length === 0 ? (
                <div className="text-muted-foreground">
                  No outlet paths found. Draw a discharge, pipes, and at least one outlet.
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="font-medium">Per-outlet summaries</div>
                  <div className="space-y-1 max-h-64 overflow-auto pr-1">
                    {pressureStats.outletSummaries.map((s) => (
                      <div
                        key={s.outletIndex}
                        className="rounded border px-2 py-1"
                      >
                        <div className="font-medium mb-0.5">
                          Outlet path {s.outletIndex}
                        </div>
                        <div className="text-muted-foreground space-y-0.5">
                          <div>
                            Max p: {s.maxP}
                          </div>
                          <div>
                            Min p: {s.minP}
                          </div>
                          <div>
                            p(discharge) - p(outlet): {s.deltaP}
                          </div>
                          <div>
                            Σh along path: {s.sumH.toFixed(3)} m
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <canvas
        ref={canvasRef}
        className={`w-full h-full bg-[#f7f7f5] ${cursorClass}`}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => {
          setIsPanning(false);
          setGhostEnd(null);
          setSelectionRect(null);
        }}
        onClick={handleClick}
      />

      {/* Marquee selection rectangle (Shift + drag) */}
      {selectionRect && (() => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const { x1, y1, x2, y2 } = selectionRect;
        const left = Math.min(x1, x2) + rect.left;
        const top = Math.min(y1, y2) + rect.top;
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        return (
          <div
            className="pointer-events-none fixed border border-blue-400 bg-blue-200/20"
            style={{ left, top, width, height }}
          />
        );
      })()}

      {/* Outlet capacity labels (HTML) drawn above outlet symbols */}
      {outletCapacityLabels.map((label) => (
        <div
          key={label.id}
          className="pointer-events-none fixed text-[10px] text-neutral-700"
          style={{
            left: label.x,
            top: label.y,
            transform: "translate(-50%, -100%)",
          }}
        >
          {label.text}
        </div>
      ))}

      {/* Pipe dimension labels are only drawn into the snapshot export, not in the live UI. */}

      <Popover
        open={popoverOpen}
        onOpenChange={(open) => {
          if (!open) {
            closePopover();
          } else {
            setPopoverOpen(true);
          }
        }}
      >
        <PopoverTrigger asChild>
          <div style={popoverAnchorStyle} aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent
          align="center"
          side="top"
          sideOffset={0}
          className="w-[640px] max-w-[95vw] max-h-[70vh] overflow-auto"
        >
          <div className="mb-1 flex items-center justify-end">
            <button
              type="button"
              onClick={closePopover}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              &times;
            </button>
          </div>

          {renderPopoverBody()}
        </PopoverContent>
      </Popover>
    </>
  );
}
