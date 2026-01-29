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
  diameter?: number | null;
  length?: number | null;
  capacity?: number | null;
  tee_ref?: number | null;
};

export interface EquationsInput {
  components: EquationsComponent[];
}

export type NodeComponent = {
  component: "node";
  x?: number;
  y?: number;
  ctype: string;
  diameter_in: number;
  diameter_out: number;
  capacity: number;
  velocity: number;
  pressure: number;
  head_loss: number;
  draw_index: number;
  tee_ref?: number;
};

export type EdgeComponent = {
  component: "edge";
  ctype: string;
  vertical: boolean;
  diameter_in: number; // mm
  diameter_out: number; // mm
  length: number; // m
  capacity: number; // L/s (nominal, stream-wise)
  velocity: number; // m/s
  pressure: number; // Pa (internal, converted to mbar for display)
  head_loss: number; // m
  draw_index: number;
  tee_ref?: number;
};

/** Row shape used for tabular export (CSV/Excel). */
export type EquationRow = {
  index: number;
  elementType: string;
  vertical?: boolean;
  diameter_in?: number;
  diameter_out?: number;
  length?: number;
  capacity?: number;
  velocity: number;
  pressureLoss: number;
  headLoss: number;
  tee_ref?: number;
};

export class Equations {
  private data: (NodeComponent | EdgeComponent)[] = [];

  private readonly K_ELBOW_45: number = 0.2;
  private readonly K_ELBOW_90: number = 0.4;
  private readonly K_OUTLET: number = 0.0;
  private readonly K_DISCHARGE: number = 1.0;

  private readonly g: number = 9.81; // m/s^2
  private readonly rho: number = 1000; // kg/m^3 (water)
  private readonly viscosity: number = 1e-6; // m^2/s (kinematic)

  constructor(input: EquationsInput) {
    // Treat the incoming component array as an ordered 1D stream in drawing
    // order. We no longer reverse the data; all indices and capacities flow in
    // the same direction the user drew the components.
    this.data = this.normalize(input.components);
    this.computeHydraulics();
  }

  /**
   * Return a list of rows suitable for CSV / spreadsheet export.
   */
  toRows(): EquationRow[] {
    return this.data.map<EquationRow>((c) => {
      const drawIndex = (c as NodeComponent | EdgeComponent).draw_index;
      const index = (typeof drawIndex === "number" ? drawIndex : 0) + 1;

      if (c.component === "edge") {
        return {
          index,
          elementType: c.ctype,
          vertical: c.vertical,
          diameter_in: c.diameter_in,
          diameter_out: c.diameter_out,
          length: c.length,
          // capacity is stored internally as L/s and surfaced as-is
          capacity: c.capacity,
          // velocity already in m/s
          velocity: c.velocity,
          // convert internal Pa to mbar for display
          pressureLoss: c.pressure / 100,
          // head loss is already in meters
          headLoss: c.head_loss,
        };
      }

      return {
        index,
        elementType: c.ctype,
        diameter_in: c.diameter_in,
        diameter_out: c.diameter_out,
        // capacity stored as L/s
        capacity: c.capacity,
        // velocity already in m/s
        velocity: c.velocity,
        // convert internal Pa to mbar for display
        pressureLoss: c.pressure / 100,
        // head loss in meters
        headLoss: c.head_loss,
        tee_ref: c.tee_ref,
      };
    });
  }

  // --- Internal helpers ----------------------------------------------------

  private normalize(components: EquationsComponent[]): (NodeComponent | EdgeComponent)[] {
    return components.map((raw, index) => {
      const elementType = (raw.type ?? "").toString() ||
        (raw.component === "edge" ? "pipe" : "node");

      if (raw.component === "edge") {
        const diameter_in =
          typeof raw.diameter === "number" && raw.diameter > 0 ? raw.diameter : 100; // mm
        const diameter_out = diameter_in;
        const length =
          typeof raw.length === "number" && raw.length > 0 ? raw.length : 10; // m

        return {
          component: "edge",
          ctype: elementType,
          vertical: false,
          diameter_in,
          diameter_out,
          length,
          capacity: 0,
          velocity: 0,
          pressure: 0,
          head_loss: 0,
          draw_index: index,
        } satisfies EdgeComponent;
      }

      const capacity =
        typeof raw.capacity === "number" && raw.capacity > 0 ? raw.capacity : 0;

      const diameter_in =
        raw.type !== "outlet" && components[index + 1]
          ? (components[index + 1].diameter as number | null) ?? 0
          : (components[index - 1]?.diameter as number | null) ?? 0;

      const diameter_out =
        raw.type !== "discharge" && components[index - 1]
          ? (components[index - 1].diameter as number | null) ?? 0
          : (components[index + 1]?.diameter as number | null) ?? 0;

      return {
        component: "node",
        ctype: elementType,
        diameter_in,
        diameter_out,
        capacity,
        velocity: 0,
        pressure: 0,
        head_loss: 0,
        draw_index: index,
        tee_ref: typeof raw.tee_ref === "number" ? raw.tee_ref : undefined,
      } satisfies NodeComponent;
    });
  }

  /**
   * Compute hydraulics along the 1D component sequence in **drawing order**.
   *
   * Q (capacity) is computed as we walk from the first drawn component to the
   * last:
   * - At an `outlet` node: the node's own capacity is injected into the stream.
   * - At a `discharge` node: we treat it as a sink and subtract its capacity
   *   from the running total (clamped at zero).
   * - All other nodes and edges simply carry the current stream capacity
   *   forward.
   */
  private computeHydraulics(): void {
    if (this.data.length === 0) return;

    const flows: number[] = new Array(this.data.length).fill(0);
    let Q = 0;

    // --- Pass 1: compute capacity Q along the sequence ----------------------
    for (let i = 0; i < this.data.length; i++) {
      const comp = this.data[i];

      if (comp.component === "node") {
        const node = comp as NodeComponent;

        // Inject outlet capacity into the stream.
        if (node.ctype === "outlet") {
          Q += node.capacity;
        } else if (node.ctype === "discharge") {
          // Simple treatment of discharge as a sink: remove its own capacity
          // from the running flow, but never go negative.
          Q = Math.max(0, Q - node.capacity);
        }

        flows[i] = Q;
        node.capacity = Q;
      } else {
        const edge = comp as EdgeComponent;
        // Edges simply carry the current stream capacity.
        flows[i] = Q;
        edge.capacity = Q;
      }
    }

    // --- Pass 2: compute velocities and losses using the capacity Q ---------
    for (const comp of this.data) {
      if (comp.component === "edge") {
        const edge = comp as EdgeComponent;
        const Qedge = edge.capacity;
        const di = edge.diameter_in; // use inlet diameter
        const L = edge.length;

        const V = this.velocity(Qedge, di);
        const { deltaP, deltaH } = this.pressureLoss(di, L, V);

        edge.velocity = V;
        edge.pressure = deltaP;
        edge.head_loss = deltaH;
      } else {
        const node = comp as NodeComponent;
        const Qnode = node.capacity;
        const di = node.diameter_in;
        const V = this.velocity(Qnode, di); // Per-fitting velocity based on local inlet diameter.
        const K = this.minorLossK(node.ctype);
        const { deltaP, deltaH } = this.minorPressureLoss(K, V);

        node.velocity = V;
        node.pressure = deltaP;
        node.head_loss = deltaH;
      }
    }
  }

  // di_mm: diameter in millimetres, L: length in metres, V: velocity in m/s
  private pressureLoss(di_mm: number, L: number, V: number): PressureLoss {
    const di = di_mm / 1000; // convert to metres
    if (di <= 0 || L <= 0 || V === 0) {
      return { deltaP: 0, deltaH: 0 };
    }

    const Re = this.reynoldsNumber(V, di);
    const f = this.frictionFactor(di, Re);
    const deltaP = f * (L / di) * 0.5 * this.rho * V * V;
    const deltaH = deltaP / (this.rho * this.g);
    return { deltaP, deltaH };
  }

  private minorPressureLoss(K: number, V: number): PressureLoss {
    if (K === 0 || V === 0) {
      return { deltaP: 0, deltaH: 0 };
    }

    const deltaP = K * 0.5 * this.rho * V * V;
    const deltaH = (K * V * V) / (2 * this.g);
    return { deltaP, deltaH };
  }

  private minorLossK(ctype: string): number {
    switch (ctype) {
      case "elbow45":
        return this.K_ELBOW_45;
      case "elbow90":
        return this.K_ELBOW_90;
      case "outlet":
        return this.K_OUTLET;
      case "discharge":
        return this.K_DISCHARGE;
      default:
        return 0;
    }
  }

  // Q_lps: capacity in L/s, di_mm: diameter in millimetres
  private velocity(Q_lps: number, di_mm: number): number {
    if (di_mm <= 0) return 0;
    const di = di_mm / 1000; // metres
    const area = (Math.PI / 4) * di * di; // m^2
    if (area === 0) return 0;
    const Q_m3s = Q_lps / 1000; // 1 L/s = 1e-3 m^3/s
    return Q_m3s / area; // m/s
  }

  private reynoldsNumber(V: number, di: number): number {
    // V in m/s, di in metres, viscosity in m^2/s → Re is dimensionless
    if (this.viscosity === 0) return 0;
    return (V * di) / this.viscosity;
  }

  private frictionFactor(di: number, Re: number): number {
    if (di <= 0 || Re <= 0) {
      return 0.02; // nominal turbulent default
    }

    const roughness = 4.5e-5; // m, typical commercial steel
    const term = roughness / (3.7 * di) + 5.74 / Math.pow(Re, 0.9);
    const f = 1 / Math.pow(0.86 * Math.log(term), 2);
    return isFinite(f) && f > 0 ? f : 0.02;
  }
}
