export type PressureLoss = {
  deltaP: number;
  deltaH: number;
};

export type EquationsComponent = {
  component: "node" | "edge";
  id: number;
  type?: string | null;
  fromId?: number;
  toId?: number;
  x?: number;
  y?: number;
  diameter?: number | null;
  length?: number | null;
  capacity?: number | null;
  tee_ref?: number | null;
  /**
   * Stable draw index assigned by the canvas layer.
   *
   * This is used to keep EquationRow.index in sync with the
   * on-canvas numbering so that existing components don't
   * change their displayed index when new branches are drawn.
   */
  draw_index?: number | null;
  /**
   * Optional geometry-derived flag used by the normalization layer.
   *
   * For pipes, this is computed once on the original flat component
   * list (before organize/splitByOutlet) and then copied through all
   * later transformations so that the same physical pipe always has a
   * consistent vertical/non-vertical classification.
   */
  vertical?: boolean | null;
};

export interface EquationsInput {
  components: EquationsComponent[];
}

/** Row shape used for tabular export (CSV/Excel). */
export type EquationRow = {
  index: number;
  item: string;
  Q: number;
  d: number;
  L?: number;
  vertical?: boolean;
  elbow?: number;
  reducer?: boolean;
  t90?: number;
  d90?: number;
  q90?: number;
  di?: number;
  V?: number;
  h?: number;
  Re?: number;
  f?: number;
  a?: number;
  ktee?: number;
  kred?: number;
  ktotal?: number;
  vp?: number;
  delta_H?: number;
  delta_P?: number;
};

export class Calculations {
  // One array per logical path / outlet branch
  private rows: EquationRow[][] = [];
  private input: EquationsInput;
  // Normalized, capacity-filled components used for tee statistics (q90, etc.).
  private filledComponents: EquationsComponent[] = [];
  // Canonical flat component list in drawing order, captured before organize()
  // reorders components into per-outlet paths. Geometry-derived flags such as
  // `vertical` are computed against this array so they remain stable regardless
  // of how paths are split.
  private canonicalComponents: EquationsComponent[] = [];

  constructor(input: EquationsInput) {
    // Capture a canonical copy of the incoming components *before* we do
    // any logical re-grouping into outlet paths. This is the single source
    // of truth for geometry-derived flags such as `vertical`.
    this.canonicalComponents = input.components.map((comp) => ({ ...comp }));

    // Precompute per-pipe verticality on the canonical list so that the flag is
    // fixed once and then copied through all later organize()/split steps.
    this.canonicalComponents = this.canonicalComponents.map((comp) => {
      if (comp.component === "edge" && comp.type === "pipe") {
        const vertical = this.computeVerticalFlag(
          comp,
          this.canonicalComponents
        );
        return { ...comp, vertical };
      }
      return comp;
    });

    // Use a fresh copy for all downstream normalization so we never mutate the
    // canonical geometry that vertical relies on.
    this.input = {
      components: this.canonicalComponents.map((comp) => ({ ...comp })),
    };

    const a: EquationsComponent[] = this.input.components;
    const b: EquationsComponent[][] = this.organize(a);
    const c: EquationRow[][] = this.preNormalize(b);
    this.rows = this.normalize(c);
    console.log(a);
    console.log(b);
    console.log(c);
    console.log(this.rows);
  }

  /** Public accessor used by the UI/export code. */
  toRows(): EquationRow[][] {
    return this.rows;
  }
  
  private organize(components: EquationsComponent[]): EquationsComponent[][] {
    // First, normalize tees, capacities, and diameters on the flat component
    // list. Then split into logical outlet paths, and finally insert reducer
    // nodes wherever a diameter change happens immediately after a non-reducer
    // node.
    const filled: EquationsComponent[] = this.fillDiameter(
      this.fillCapacity(this.fillTee(components))
    );
    // Keep a copy with capacities/tees normalized so tee metrics (q90, etc.)
    // can be derived by tee_ref.
    this.filledComponents = filled;
    const byOutlet: EquationsComponent[][] = this.splitByOutlet(filled);
    const withReducers: EquationsComponent[][] = this.insertReducersForDiameterChanges(byOutlet);

    return withReducers;
  }

  /**
   * After paths are organized, automatically insert reducer nodes at diameter
   * transitions that occur immediately after a non-reducer node.
   *
   * Example (single path):
   *   node(d=100) → pipe(d=100) → node(elbow90, d=100) → pipe(d=80)
   * becomes
   *   node(d=100) → pipe(d=100) → node(elbow90, d=100) → reducer → pipe(d=80)
   */
  private insertReducersForDiameterChanges(paths: EquationsComponent[][]): EquationsComponent[][] {
    if (paths.length === 0) return paths;

    // Compute a global next id so inserted reducers have unique ids.
    let maxId = -1;
    for (const path of paths) {
      for (const c of path) {
        if (typeof c.id === "number" && c.id > maxId) {
          maxId = c.id;
        }
      }
    }

    const result: EquationsComponent[][] = [];

    for (const path of paths) {
      const newPath: EquationsComponent[] = [];

      for (let i = 0; i < path.length; i++) {
        const curr = path[i];
        newPath.push(curr);

        const next = path[i + 1];
        if (!next) continue;

        // We only care about transitions where a node is immediately followed
        // by a pipe, and that node is not already a reducer.
        if (curr.component === "node" && curr.type !== "reducer" && next.type === "pipe") {
          const currD = curr.diameter ?? next.diameter ?? 0;
          const nextD = next.diameter ?? curr.diameter ?? 0;

          if (currD > 0 && nextD > 0 && currD !== nextD) {
            const reducer: EquationsComponent = {
              component: "node",
              id: ++maxId,
              type: "reducer",
              x: curr.x,
              y: curr.y,
              diameter: currD,
              // Carry the same branch flow through the reducer so downstream
              // Q, velocity, etc. remain consistent.
              capacity: next.capacity ?? curr.capacity ?? 0,
            };
            newPath.push(reducer);
          }
        }
      }

      result.push(newPath);
    }

    return result;
  }

  private splitByOutlet(components: EquationsComponent[]): EquationsComponent[][] {
    // Build logical paths (main + side branches) using tee_ref to relate
    // tee_main, tee_side, and their associated outlets.
    //
    // For a simple layout like:
    //   discharge → pipe → tee_main(ref=0) → pipe → outlet(ref=0)
    //                           → tee_side(ref=0) → elbow45 → pipe → outlet
    // we want two paths:
    //   [discharge, pipe, tee_main, pipe, outlet]
    //   [discharge, pipe, tee_side, elbow45, pipe, outlet]
    //
    // These share the upstream discharge/pipe, then diverge at the tee into a
    // main branch (through tee_main) and a side branch (through tee_side).

    if (components.length === 0) return [];

    const dischargeIndex = components.findIndex((c) => c.type === "discharge");
    if (dischargeIndex === -1) {
      // Fallback: treat the whole sequence as a single path.
      return [components];
    }

    const result: EquationsComponent[][] = [];

    // Group tees by tee_ref so we can form branches per tee.
    const teeMainByRef = new Map<number, number>();
    const teeSideByRef = new Map<number, number>();

    components.forEach((c, idx) => {
      if (c.type === "tee_main" && typeof c.tee_ref === "number") {
        teeMainByRef.set(c.tee_ref, idx);
      }
      if (c.type === "tee_side" && typeof c.tee_ref === "number") {
        teeSideByRef.set(c.tee_ref, idx);
      }
    });

    // For each tee_ref, build a main and side path where possible.
    const handledRefs = new Set<number>();

    for (const [ref, mainIdx] of teeMainByRef.entries()) {
      if (handledRefs.has(ref)) continue;
      handledRefs.add(ref);

      const sideIdx = teeSideByRef.get(ref);

      // MAIN BRANCH: from discharge to the first outlet paired with this tee_ref.
      const firstOutletIdx = components.findIndex(
        (c, idx) =>
          idx >= mainIdx && c.type === "outlet" && c.tee_ref === ref
      );

      if (firstOutletIdx !== -1) {
        const mainPath = components.slice(dischargeIndex, firstOutletIdx + 1);
        result.push(mainPath);
      }

      // SIDE BRANCH: from discharge to tee_side (sharing only discharge + pipes
      // before the tee), then along the side branch until its terminal outlet.
      if (sideIdx !== undefined) {
        const sidePath: EquationsComponent[] = [];

        // Shared upstream part: all components from discharge up to (but not
        // including) the tee. This ensures elbows/reducers, etc. that are
        // physically upstream of the tee appear in both branches, instead of
        // collapsing them into consecutive "pipe" rows.
        for (let i = dischargeIndex; i < mainIdx && i < sideIdx; i++) {
          const c = components[i];
          if (c.type === "tee_main" || c.type === "tee_side") {
            continue;
          }
          sidePath.push(c);
        }

        // From tee_side forward until the branch clearly ends (next tee_main,
        // discharge, or end of list).
        for (let i = sideIdx; i < components.length; i++) {
          const c = components[i];
          if (i > sideIdx && (c.type === "tee_main" || c.type === "discharge")) {
            break;
          }
          sidePath.push(c);
          if (c.type === "outlet") {
            // Stop after reaching a terminal outlet for this side branch.
            break;
          }
        }

        if (sidePath.length > 0) {
          result.push(sidePath);
        }
      }
    }

    // At this point, `result` may contain multiple logical paths per physical
    // outlet, especially in more complex layouts with multiple tees. We want
    // exactly one path per *outlet node* so the UI's "number of outlets" and
    // per-outlet summaries match the actual outlets in the canvas.
    const dedupedByOutlet: EquationsComponent[][] = [];
    const seenOutletIds = new Set<number>();

    for (const path of result) {
      // Find the last outlet in this path, if any.
      let lastOutletIdx = -1;
      let lastOutletId: number | null = null;
      for (let i = 0; i < path.length; i++) {
        if (path[i].type === "outlet") {
          lastOutletIdx = i;
          lastOutletId = typeof path[i].id === "number" ? path[i].id : null;
        }
      }
      if (lastOutletIdx === -1 || lastOutletId == null) {
        continue;
      }
      if (seenOutletIds.has(lastOutletId)) {
        continue;
      }
      seenOutletIds.add(lastOutletId);
      // Keep components from discharge through this outlet (inclusive).
      dedupedByOutlet.push(path.slice(0, lastOutletIdx + 1));
    }

    if (dedupedByOutlet.length === 0) {
      // No tees or no per-outlet branches could be formed: single path from
      // discharge to the last outlet in the global sequence.
      const lastOutletIdx = components
        .map((c, idx) => (c.type === "outlet" ? idx : -1))
        .filter((idx) => idx !== -1)
        .pop();
      if (typeof lastOutletIdx === "number") {
        dedupedByOutlet.push(components.slice(dischargeIndex, lastOutletIdx + 1));
      } else {
        dedupedByOutlet.push(components.slice(dischargeIndex));
      }
    }

    // Reorder outlet paths so that:
    // - The outlet whose branch (from its tee) has the greatest total pipe
    //   length appears first.
    // - The other outlet that shares the same tee_ref as that first outlet
    //   appears second (if it exists).
    // - Remaining outlets are ordered by decreasing distance from their tee.
    type PathMeta = {
      path: EquationsComponent[];
      outletId: number;
      teeRef: number | null;
      distFromTee: number;
    };

    const metas: PathMeta[] = dedupedByOutlet.map((path) => {
      // Find last outlet in this path.
      let outlet: EquationsComponent | undefined;
      let outletIdx = -1;
      for (let i = path.length - 1; i >= 0; i--) {
        if (path[i].type === "outlet") {
          outlet = path[i];
          outletIdx = i;
          break;
        }
      }

      const outletId =
        outlet && typeof outlet.id === "number" ? outlet.id : -1;
      const teeRef =
        outlet && typeof outlet.tee_ref === "number"
          ? (outlet.tee_ref as number)
          : null;

      let dist = 0;
      if (teeRef != null && outletIdx !== -1) {
        // Locate the branch tee (tee_main or tee_side) for this outlet.
        let teeIdx = path.findIndex(
          (c) => c.type === "tee_main" && c.tee_ref === teeRef
        );
        if (teeIdx === -1) {
          teeIdx = path.findIndex(
            (c) => c.type === "tee_side" && c.tee_ref === teeRef
          );
        }

        if (teeIdx !== -1 && teeIdx < outletIdx) {
          for (let i = teeIdx; i < outletIdx; i++) {
            const c = path[i];
            if (c.type === "pipe" && typeof c.length === "number") {
              dist += c.length;
            }
          }
        }
      }

      return { path, outletId, teeRef, distFromTee: dist };
    });

    const withTee = metas.filter(
      (m) => m.teeRef != null && m.distFromTee > 0
    );
    if (withTee.length === 0) {
      // No meaningful tee distances; keep original per-outlet order.
      return dedupedByOutlet;
    }

    // Pick the globally furthest outlet (largest distance from its tee).
    let firstMeta = withTee[0];
    for (const m of withTee) {
      if (m.distFromTee > firstMeta.distFromTee) {
        firstMeta = m;
      }
    }

    const orderedMetas: PathMeta[] = [];
    const remainingMetas = [...metas];

    const take = (meta: PathMeta | undefined) => {
      if (!meta) return;
      const idx = remainingMetas.indexOf(meta);
      if (idx >= 0) {
        remainingMetas.splice(idx, 1);
        orderedMetas.push(meta);
      }
    };

    // 1) Furthest outlet overall.
    take(firstMeta);

    // 2) The other outlet on the same tee_ref (if any), preferring the one with
    //    the larger distance from that tee.
    const siblingMeta = remainingMetas
      .filter((m) => m.teeRef === firstMeta.teeRef)
      .sort((a, b) => b.distFromTee - a.distFromTee)[0];
    take(siblingMeta);

    // 3) All remaining outlets, ordered by decreasing distance from their tee
    //    (tee-less outlets effectively get distFromTee = 0 and fall to the end).
    remainingMetas.sort((a, b) => b.distFromTee - a.distFromTee);
    orderedMetas.push(...remainingMetas);

    return orderedMetas.map((m) => m.path);
  }

  private fillDiameter(components: EquationsComponent[]): EquationsComponent[] {
    // Start with the first component's diameter (if any) and propagate it forward
    let current: number = components[1]?.diameter ?? 0;

    const result = components.map((comp) => {
      const updated = { ...comp };

      if (updated.type === "pipe" && updated.diameter != null) {
        current = updated.diameter;
      }

      updated.diameter = current;
      return updated;
    });

    return result;
  }

  private fillTee(components: EquationsComponent[]): EquationsComponent[] {
    // Work on a copy to avoid mutating the original input.
    const result: EquationsComponent[] = components.map((c) => ({ ...c }));

    // 1) Normalize tees: turn plain "tee" into "tee_main" and assign a stable
    // tee_ref if missing.
    let nextTeeRef = 0;

    for (const comp of result) {
      if (comp.type === "tee") {
        if (comp.tee_ref == null) {
          comp.tee_ref = nextTeeRef++;
        } else {
          nextTeeRef = Math.max(nextTeeRef, comp.tee_ref + 1);
        }
        comp.type = "tee_main";
      }
    }

    // 2) Assign tee_ref to outlets, in the same order that tee_ref is
    //    assigned to tees. For simple sequences like
    //      discharge → pipe → tee → pipe → outlet → pipe → outlet
    //    this yields:
    //      tee_main(ref=0) ↔ first outlet(ref=0),
    //      tee_main(ref=1) ↔ second outlet(ref=1), etc.
    const teeIndexes = result
      .map((c, index) => ({ c, index }))
      .filter(({ c }) => c.type === "tee_main")
      .map(({ index }) => index);

    const outletIndexes = result
      .map((c, index) => ({ c, index }))
      .filter(({ c }) => c.type === "outlet")
      .map(({ index }) => index);

    const pairCount = Math.min(teeIndexes.length, outletIndexes.length);
    for (let k = 0; k < pairCount; k++) {
      const teeIdx = teeIndexes[k];
      const outletIdx = outletIndexes[k];
      const tee = result[teeIdx];
      const outlet = result[outletIdx];
      if (!tee || !outlet) continue;
      if (outlet.tee_ref == null && tee.tee_ref != null) {
        outlet.tee_ref = tee.tee_ref;
      }
    }

    // 3) For each tee_main, if the pipe on each side changes verticality
    //    (vertical → non-vertical or vice versa), insert an elbow90
    //    immediately after the tee_main.
    const isPipeVertical = (arr: EquationsComponent[], idx: number): boolean => {
      const prev = arr[idx - 1];
      const next = arr[idx + 1];
      if (!prev || !next) return false;
      if (prev.x == null || next.x == null) return false;
      return Math.abs(prev.x - next.x) <= 0.001;
    };

    let indexOffset = 0;
    for (const teeIdx of teeIndexes) {
      const idx = teeIdx + indexOffset;
      // Find nearest pipe before and after this tee_main.
      let beforePipeIdx: number | null = null;
      for (let i = idx - 1; i >= 0; i--) {
        if (result[i].type === "pipe") {
          beforePipeIdx = i;
          break;
        }
      }
      let afterPipeIdx: number | null = null;
      for (let i = idx + 1; i < result.length; i++) {
        if (result[i].type === "pipe") {
          afterPipeIdx = i;
          break;
        }
      }

      if (
        beforePipeIdx != null &&
        afterPipeIdx != null &&
        isPipeVertical(result, beforePipeIdx) !== isPipeVertical(result, afterPipeIdx)
      ) {
        const tee = result[idx];
        const elbow90: EquationsComponent = {
          component: "node",
          id: result.length,
          type: "elbow90",
          fromId: tee.id,
          toId: result[idx + 1]?.id,
          x: tee.x,
          y: tee.y,
          tee_ref: tee.tee_ref,
        };
        result.splice(idx + 1, 0, elbow90);
        indexOffset++;
      }
    }

    // 4) Find outlets that belong to a tee (have a tee_ref).
    const outletIndexesWithTeeRef = result
      .map((c, index) => ({ c, index }))
      .filter(({ c }) => c.type === "outlet" && c.tee_ref != null)
      .map(({ index }) => index)
      .reverse(); // process in reverse so indices stay valid when splicing

    // 5) After each such outlet, insert a tee_side node with the same tee_ref
    //    and always follow it with an elbow45.
    for (const outletIndex of outletIndexesWithTeeRef) {
      const outlet = result[outletIndex];
      if (!outlet) continue;

      const next = result[outletIndex + 1];
      if (
        next &&
        next.type === "tee_side" &&
        next.tee_ref === outlet.tee_ref
      ) {
        // Already have a matching tee_side directly after this outlet.
        continue;
      }

      const teeSide: EquationsComponent = {
        component: "node",
        id: result.length,
        type: "tee_side",
        fromId: outlet.id,
        toId: next?.id,
        x: outlet.x,
        y: outlet.y,
        tee_ref: outlet.tee_ref ?? null,
        // Inherit the outlet's draw_index so that d90 for tee_side can be
        // derived from the *next* canonical component in drawing order.
        //
        // getD90() looks up the component whose draw_index is (draw_index + 1)
        // in the canonicalComponents list. For a side branch, that next
        // component is typically the first pipe on the branch, so reusing the
        // outlet's draw index here ensures tee_side rows get a non‑zero d90.
        draw_index:
          typeof outlet.draw_index === "number" && !Number.isNaN(outlet.draw_index)
            ? outlet.draw_index
            : null,
      };

      // Insert tee_side *after* the outlet.
      const teeSideIndex = outletIndex + 1;
      result.splice(teeSideIndex, 0, teeSide);

      // Always insert an elbow45 immediately after tee_side.
      const elbow45: EquationsComponent = {
        component: "node",
        id: result.length + 1,
        type: "elbow45",
        fromId: teeSide.id,
        toId: teeSide.toId,
        x: teeSide.x,
        y: teeSide.y,
        tee_ref: teeSide.tee_ref,
      };

      result.splice(teeSideIndex + 1, 0, elbow45);
    }

    return result;
  }

  private fillCapacity(components: EquationsComponent[]): EquationsComponent[] {
    // Walk from outlets back toward discharge, accumulating capacity.
    // We treat the 1D sequence as a main run with possible side branches
    // marked by (tee_main, tee_side, tee_ref):
    //
    //   discharge → ... → tee_main(ref) → ... → outlet(ref)
    //                                ↘ tee_side(ref) → ... → outlet(ref)
    //
    // Algorithm in reversed order (downstream → upstream):
    //   - At an outlet: use its own capacity (user-provided) and add it to the
    //     running flow `current`.
    //   - Along a branch between outlet and tee_side/tee_main: carry that
    //     branch's `current`.
    //   - At tee_side(ref): record the side-branch flow for this ref and reset
    //     `current` to 0 so the main-branch segment is not polluted by the
    //     side-branch outlet capacities.
    //   - At tee_main(ref): its capacity is the *main-branch* flow only
    //     (current). For upstream components, total flow is main + side, so we
    //     update `current = current + sideFlow[ref]`.
    const reversed: EquationsComponent[] = [...components].reverse();

    let current = 0;
    const sideFlowByRef = new Map<number, number>();

    const resultReversed = reversed.map((comp) => {
      const updated: EquationsComponent = { ...comp };

      if (comp.type === "outlet") {
        const own = typeof comp.capacity === "number" ? comp.capacity : 0;
        updated.capacity = own;
        current += own;
        return updated;
      }

      if (comp.type === "tee_side" && typeof comp.tee_ref === "number") {
        // Flow in the side branch at the junction.
        updated.capacity = current;
        sideFlowByRef.set(comp.tee_ref, current);
        // Reset current so subsequent main-branch components between outlet
        // and tee_main don't see the side-branch flow.
        current = 0;
        return updated;
      }

      if (comp.type === "tee_main" && typeof comp.tee_ref === "number") {
        const side = sideFlowByRef.get(comp.tee_ref) ?? 0;
        // Capacity on the tee_main itself is main-branch flow only.
        updated.capacity = current;
        // Upstream of the tee, total flow is main + side.
        current = current + side;
        return updated;
      }

      // All other components just carry the current flow.
      updated.capacity = current;
      return updated;
    });

    return resultReversed.reverse();
  }

  private splitByTee(components: EquationsComponent[]) {
    const result: EquationsComponent[][] = [];
    let current: EquationsComponent[] = [];

    for (const c of components) {
      if (c.type?.startsWith("tee")) {
        if (current.length > 0) {
          result.push(current);
          current = [];
          current.push(c);
        }
      } else {
        current.push(c);
      }
    }

    if (current.length > 0) {
      result.push(current);
    }

    return result;
  }

  private preNormalize(components: EquationsComponent[][]): EquationRow[][] {
    const outletRows: EquationRow[][] = components.map((compSet) => {
      return compSet.map((comp, index) => {
        const di = this.getDi(comp.diameter ?? 0);

        // Prefer a stable draw_index provided by the canvas layer so that
        // the EquationRow index stays aligned with the on‑canvas numbering,
        // even if this.organize()/splitByOutlet() reorder components
        // internally into logical paths.
        const drawIndex =
          typeof comp.draw_index === "number" && !Number.isNaN(comp.draw_index)
            ? comp.draw_index
            : index + 1;

        return {
          index: drawIndex,
          item: comp.type ?? "",
          Q: comp.capacity ?? 0,
          d: comp.diameter ?? 0,
          L: comp.length ?? 0,
          // Determine verticality directly from the pipe's endpoints in the
          // original component graph so it stays consistent across all
          // per‑outlet paths.
          vertical: this.isVertical(comp),
          elbow: this.countElbow(comp),
          reducer: comp.type === "reducer" ? true : false,
          t90: this.getT90(comp),
          d90: this.getD90(comp, index),
          q90: this.getQ90(comp),
          di,
          V: this.getVelocity(comp.capacity ?? 0, di),
          h: 0,
          Re: 0,
          f: 0,
          a: 0,
          ktee: 0,
          kred: 0,
          ktotal: 0,
          vp: 0,
          delta_H: 0,
          delta_P: 0,
        };
      });
    });

    return outletRows;
  }
  
  private normalize(compSets: EquationRow[][]): EquationRow[][] {
    const result: EquationRow[][] = compSets.map((compSet) => {
      const updated: EquationRow[] = compSet.map((row) => ({ ...row }));

      // Cumulative elevation head and area ratio
      for (let i = 1; i < updated.length; i++) {
        const prev = updated[i - 1];
        const curr = updated[i];

        const prevL = prev.L ?? 0;
        const prevVertical = prev.vertical ? 1 : 0;
        const prevH = prev.h ?? 0;

        curr.h = (curr.h ?? 0) + (prevH + prevL * prevVertical);

        if (i === updated.length - 1) {
          curr.a = prev.a ?? 0;
        } else {
          const nextDi = updated[i + 1].di ?? 0;
          const currDi = curr.di ?? 0;
          curr.a = nextDi === 0 ? 0 : Math.pow(currDi / nextDi, 2);
        }
      }

      // Reynolds number and velocity head
      for (const c of updated) {
        const di = c.di ?? 0;
        const V = c.V ?? 0;
        c.Re = di === 0 ? 0 : (di * V) / 0.000001;
        c.vp = (V * V) / (2 * 9.81);
      }

      // Darcy friction factor (only for pipes)
      for (const c of updated) {
        if (c.item === "pipe") {
          const Q = c.Q ?? 0;
          const d = c.d ?? 0;
          const Re = c.Re ?? 0;
          if (d > 0 && Re > 0) {
            const inner = 0.86 * Math.log(0.2 / (d * 3.7) + 5.74 / Math.pow(Re, 0.9));
            c.f = 1 / Math.pow(inner, 2);
          } else {
            c.f = 0;
          }
        } else {
          c.f = c.f ?? 0;
        }
      }

      // Ensure discharge node has area ratio 1 before computing reducer losses,
      // so its kred is derived from a = 1.
      for (const c of updated) {
        if (c.item === "discharge") {
          c.a = 1;
        }
      }

      // Reducer loss coefficient
      for (const c of updated) {
        const a = c.a ?? 0;
        if (a > 1) {
          c.kred = Math.pow(a - 1, 2);
        } else if (a === 1) {
          c.kred = 0;
        } else {
          c.kred = -0.513 * a + 0.51;
        }
      }

      // Tee loss coefficient
      const T = 1; // Placeholder constant to avoid undefined; domain value can replace this.
      for (const c of updated) {
        if (c.item && c.item.startsWith("tee")) {
          const d90 = c.d90 ?? 0;
          const d = c.d ?? 0;
          if (d === 0) continue;
          const a = Math.pow(d90 / d, 2);

          if (c.t90 === 1) {
            const q90 = c.q90 ?? 0;
            const multiplier = a > 0.35 ? 0.55 : 1;

            c.ktee =
              multiplier *
              (1 + Math.pow(q90 / a, 2) - 2 * Math.pow(1 - q90, 2) - (1.414 * Math.pow(q90, 2)) / T);
          } else if (c.t90 === 0.5) {
            if (d90 !== 0) {
              c.ktee = 0.75 - 0.35 / a;
            }
          }
        }
      }

      // Total loss coefficient and head loss
      if (updated.length > 0) {
        updated[0].ktotal = updated[0].ktotal ?? 1;
      }

      for (const c of updated) {
        const vp = c.vp ?? 0;

        // For the discharge node, force area ratio and ktotal to 1 so it
        // behaves as a pure reference/entry point regardless of upstream
        // geometry.
        if (c.item === "discharge") {
          c.a = 1;
          c.ktotal = 1;
          c.delta_H = c.ktotal * vp;
          continue;
        }

        const f = c.f ?? 0;
        const L = c.L ?? 0;
        const di = c.di ?? 0;
        const elbow = c.elbow ?? 0;
        const kred = c.kred ?? 0;
        const ktee = c.ktee ?? 0;

        const major = di === 0 ? 0 : f * (L / di);
        const minor = elbow * 0.2 + kred + ktee;
        c.ktotal = major + minor;
        c.delta_H = c.ktotal * vp;
      }

      // Ensure the final component reports the cumulative head loss up to that
      // point. If the last row has zero local loss (common for an outlet
      // marker), copy the previous row's delta_H so the head profile appears to
      // "reach" the end of the path.
      if (updated.length > 1) {
        const last = updated[updated.length - 1];
        const prev = updated[updated.length - 2];
        if ((last.delta_H ?? 0) === 0) {
          last.delta_H = prev.delta_H ?? 0;
        }
      }

      // Pressure loss accumulation
      if (updated.length > 0) {
        updated[0].delta_P = updated[0].delta_P ?? 0;
      }
      for (let i = 1; i < updated.length; i++) {
        const prev = updated[i - 1];
        const curr = updated[i];
        const prevDeltaP = prev.delta_P ?? 0;
        const prevDeltaH = prev.delta_H ?? 0;
        const prevH = prev.h ?? 0;
        const currH = curr.h ?? 0;
        const prevVp = prev.vp ?? 0;
        const currVp = curr.vp ?? 0;

        curr.delta_P =
          prevDeltaP +
          prevDeltaH +
          (prevH - currH) +
          (prevVp - currVp);
      }

      return updated;
    });

    return result;
  }

  private isVertical(comp: EquationsComponent): boolean {
    if (comp.type !== "pipe") return false;

    // Prefer a precomputed flag taken from the canonical component list so
    // vertical stays the same no matter how organize()/splitByOutlet() slice
    // the data into per-outlet paths.
    if (typeof comp.vertical === "boolean") {
      return comp.vertical;
    }

    const components =
      this.canonicalComponents.length > 0
        ? this.canonicalComponents
        : this.input.components;

    return this.computeVerticalFlag(comp, components);
  }

  private computeVerticalFlag(
    comp: EquationsComponent,
    components: EquationsComponent[]
  ): boolean {
    if (comp.type !== "pipe") return false;
    if (comp.fromId == null || comp.toId == null) return false;

    const fromNode = components.find(
      (c) => c.component === "node" && c.id === comp.fromId
    );
    const toNode = components.find(
      (c) => c.component === "node" && c.id === comp.toId
    );

    if (!fromNode || !toNode) return false;
    if (
      fromNode.x == null ||
      toNode.x == null ||
      fromNode.y == null ||
      toNode.y == null
    ) {
      return false;
    }

    const TOL = 0.001;
    return (
      Math.abs(fromNode.x - toNode.x) <= TOL &&
      Math.abs(fromNode.y - toNode.y) > TOL
    );
  }

  private countElbow(comp: EquationsComponent): number {
    if (comp.type === "elbow90") return 2;
    if (comp.type === "elbow45") return 1;
    return 0;
  }

  private getT90(comp: EquationsComponent): number {
    if (comp.type === "tee_main") return 1;
    if (comp.type === "tee_side") return 0.5;
    return 0;
  }

  private getD90(comp: EquationsComponent, _index: number): number {
    if (!comp.type?.startsWith("tee")) {
      return 0;
    }

    const drawIndex =
      typeof comp.draw_index === "number" && !Number.isNaN(comp.draw_index)
        ? comp.draw_index
        : null;

    if (drawIndex == null) return 0;

    const components =
      this.canonicalComponents.length > 0
        ? this.canonicalComponents
        : this.input.components;

    const next = components.find(
      (c) =>
        typeof c.draw_index === "number" && c.draw_index === drawIndex + 1
    );

    return next?.diameter ?? 0;
  }

  private getQ90(comp: EquationsComponent): number {
    // For now, use fixed q90 values by tee role so the UI matches the
    // desired behavior:
    // - tee_main: q90 = 0.5
    // - tee_side: q90 = 1
    if (comp.type === "tee_main") return 0.5;
    if (comp.type === "tee_side") return 1;
    return 0;
  }

  private getDi(diameter: number): number {
    return (0.922 * diameter) / 1000;
  }

  private getVelocity(Q: number, di: number): number {
    if (di === 0) return 0;
    return (Q * 0.004) / (Math.PI * di * di);
  }
}
