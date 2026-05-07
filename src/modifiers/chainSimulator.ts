// Verlet-chain physics simulator.
//
// Each "chain" is a leader sprite + an ordered list of follower
// sprites (the chain links). Followers are simulated as verlet
// points with distance constraints to their predecessor; the leader
// supplies the anchor world position each frame.
//
// Why verlet and not Euler / RK4? Verlet's position-based
// integration is rock-solid for constrained chains: constraints are
// enforced by snapping positions, never by computing forces between
// them. The result is a pendulum-like chain that doesn't explode at
// low frame rates and doesn't lose energy to numerical drift.
// Mass-spring with explicit forces would need careful tuning to
// avoid blow-ups and feels mushier in motion.
//
// Pipeline (per frame):
//   1. PixiApp evaluates each LEADER sprite's effective transform via
//      ModifierRunner (non-circular: leaders don't depend on their
//      followers structurally).
//   2. PixiApp calls step() with the leader's world position +
//      ChainConfig + dt. step() updates internal point state and
//      writes overrides into a Map keyed by follower sprite id.
//   3. ModifierRunner.baseTransform() consults that Map; if a sprite
//      has a chain override, its base x/y (and optionally rotation)
//      come from the override instead of the model. Bindings, springs,
//      animations, etc. still compose ON TOP — chain physics drives
//      position; rotation can be either chain-aligned or
//      binding-driven; a Spring modifier on rotation still smooths
//      the result.
//
// State is kept here, keyed by leader sprite id. pruneStaleState
// drops state when the leader is deleted or its chain config is
// removed.

import type {
  ChainConfig,
  RibbonConfig,
  Sprite,
  SpriteId,
} from "../types/avatar";

/** Per-point physics state. Verlet uses (pos, prevPos) instead of
 *  (pos, velocity); the implicit velocity is pos-prevPos which damps
 *  naturally with rigid constraint enforcement. */
interface PointState {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
}

interface ChainState {
  /** points[0] is set each frame from the leader's anchor; points[1..N]
   *  are simulated. We keep point[0] in here (rather than passing the
   *  leader's pos as a parameter) so velocity-coupling can compute
   *  the anchor's frame-to-frame movement against its previous slot. */
  points: PointState[];
  /** False until the chain has been initialized — first call to
   *  step() lays out the rest pose. Subsequent calls update from
   *  there. */
  initialized: boolean;
  /** Snapshot of the anchor's previous-frame world position. Used
   *  for velocity coupling — see step()'s velocity-injection block. */
  prevAnchorX: number;
  prevAnchorY: number;
}

export interface ChainOverride {
  x: number;
  y: number;
  /** Set when ChainConfig.alignRotation is true. The runner replaces
   *  the sprite's base rotation with this value before subsequent
   *  modifiers / bindings stack on top. */
  rotation: number | null;
}

export class ChainSimulator {
  private chains = new Map<SpriteId, ChainState>();
  /** Per-sprite ribbon physics state. Distinct from `chains` because
   *  ribbons are owned by the rendering sprite (single-sprite
   *  primitive) while chains are owned by a leader that drives
   *  multiple followers. Same verlet integration internals; this is
   *  just keying by SpriteId without the multi-link override map.
   *  Render code reads ring positions via getRibbonPoints(). */
  private ribbons = new Map<SpriteId, ChainState>();
  /** Per-sprite override map. Cleared at the start of each frame;
   *  populated by step() calls; queried by ModifierRunner. */
  private overrides = new Map<SpriteId, ChainOverride>();

  /** Clear per-frame override state. State PERSISTS frame-to-frame
   *  inside `chains` — that's the whole point of verlet. */
  beginFrame(): void {
    this.overrides.clear();
  }

  /** Look up the runtime override for a sprite. Returns undefined
   *  for sprites that aren't chain followers. */
  getOverride(spriteId: SpriteId): ChainOverride | undefined {
    return this.overrides.get(spriteId);
  }

  /** Drop chain state for leaders that no longer have a chain config
   *  or have been deleted. */
  pruneStaleState(sprites: Sprite[]): void {
    const liveLeaders = new Set<SpriteId>();
    for (const s of sprites) {
      if (s.chain && s.chain.links.length > 0) {
        liveLeaders.add(s.id);
      }
    }
    for (const id of Array.from(this.chains.keys())) {
      if (!liveLeaders.has(id)) this.chains.delete(id);
    }
  }

  /** Drop ribbon state for sprites that no longer have a ribbon
   *  config or have been deleted. Run alongside pruneStaleState. */
  pruneStaleRibbons(sprites: Sprite[]): void {
    const liveRibbons = new Set<SpriteId>();
    for (const s of sprites) {
      if (s.ribbon) liveRibbons.add(s.id);
    }
    for (const id of Array.from(this.ribbons.keys())) {
      if (!liveRibbons.has(id)) this.ribbons.delete(id);
    }
  }

  /** Look up the current world-space positions of a ribbon's rings.
   *  Returns an array of (segments + 1) {x, y} points, top to bottom.
   *  Renderer uses this to lay out the strip mesh's vertex
   *  positions each frame. Returns undefined for sprites without
   *  ribbon state (e.g. before the first stepRibbon, or after
   *  pruneStaleRibbons). */
  getRibbonPoints(spriteId: SpriteId): { x: number; y: number }[] | undefined {
    const state = this.ribbons.get(spriteId);
    if (!state) return undefined;
    return state.points.map((p) => ({ x: p.x, y: p.y }));
  }

  /**
   * Run one frame of verlet simulation for a ribbon attached to
   * `spriteId`. Same shape as step() above, but state lives in
   * `ribbons` (per-sprite) instead of `chains` (per-leader).
   *
   * Anchor is the sprite's own world position + rotated
   * anchorOffset, so the ribbon's TOP RING tracks the sprite as
   * it moves / rotates / parents to a head. Subsequent rings
   * simulate in world frame — gravity always pulls toward
   * world-down regardless of sprite rotation, which is what
   * users expect from ribbon physics.
   */
  stepRibbon(
    spriteId: SpriteId,
    anchorWorldX: number,
    anchorWorldY: number,
    leaderRotationDeg: number,
    config: RibbonConfig,
    dt: number,
  ): void {
    const stepDt = Math.min(dt, 0.05);
    if (stepDt <= 0) return;

    // Ribbon points: anchor + segments. So (segments + 1) total.
    const totalPoints = config.segments + 1;
    let state = this.ribbons.get(spriteId);
    if (!state || state.points.length !== totalPoints) {
      state = this.initRibbonState(
        anchorWorldX,
        anchorWorldY,
        leaderRotationDeg,
        config,
        totalPoints,
      );
      this.ribbons.set(spriteId, state);
    }

    // Anchor (point 0) tracks the sprite. Same prev-anchor delta
    // bookkeeping as the chain step for velocity coupling.
    const prevAnchorX = state.prevAnchorX;
    const prevAnchorY = state.prevAnchorY;
    state.points[0]!.prevX = state.points[0]!.x;
    state.points[0]!.prevY = state.points[0]!.y;
    state.points[0]!.x = anchorWorldX;
    state.points[0]!.y = anchorWorldY;
    state.prevAnchorX = anchorWorldX;
    state.prevAnchorY = anchorWorldY;

    const anchorDX = state.initialized ? anchorWorldX - prevAnchorX : 0;
    const anchorDY = state.initialized ? anchorWorldY - prevAnchorY : 0;
    state.initialized = true;

    // Same coupling clamp as the chain step — see that comment for
    // rationale. Cap at 2× segmentLength per frame so fast anchor
    // motion (especially upward, where gravity can't help dissipate)
    // doesn't detonate the ribbon.
    const MAX_COUPLING_DELTA = config.segmentLength * 2;
    const couplingDX = Math.max(
      -MAX_COUPLING_DELTA,
      Math.min(MAX_COUPLING_DELTA, anchorDX),
    );
    const couplingDY = Math.max(
      -MAX_COUPLING_DELTA,
      Math.min(MAX_COUPLING_DELTA, anchorDY),
    );

    // Verlet integration with gravity + damping + velocity coupling.
    // Same singularity guard as chain step: damping=0 means "no
    // damping" (perpetual swing) rather than "pow(0, dt) = 0
    // instant freeze."
    const dampingPerStep =
      config.damping <= 0 ? 1 : Math.pow(config.damping, stepDt);
    const gravityStep = config.gravity * stepDt * stepDt;
    for (let i = 1; i < totalPoints; i++) {
      const p = state.points[i]!;
      const vx = (p.x - p.prevX) * dampingPerStep;
      const vy = (p.y - p.prevY) * dampingPerStep;
      const couplingX = i === 1 ? couplingDX * config.velocityCoupling : 0;
      const couplingY = i === 1 ? couplingDY * config.velocityCoupling : 0;
      p.prevX = p.x;
      p.prevY = p.y;
      p.x += vx + couplingX;
      p.y += vy + couplingY + gravityStep;
    }

    // Distance constraints. Top is fixed (anchor); subsequent pairs
    // share the correction symmetrically. Same as chain step.
    const seg = config.segmentLength;
    for (let iter = 0; iter < config.iterations; iter++) {
      for (let i = 1; i < totalPoints; i++) {
        const a = state.points[i - 1]!;
        const b = state.points[i]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        const diff = (dist - seg) / dist;
        if (i === 1) {
          b.x -= dx * diff;
          b.y -= dy * diff;
        } else {
          const half = diff * 0.5;
          a.x += dx * half;
          a.y += dy * half;
          b.x -= dx * half;
          b.y -= dy * half;
        }
      }
    }
    // Note: ribbon doesn't write per-link rotation overrides like
    // chain does — there ARE no follower sprites to rotate. The
    // renderer reads the raw ring positions via getRibbonPoints
    // and computes mesh vertex positions from them directly.
  }

  /** Lay out the rest pose for a ribbon — same as chain init but
   *  duplicated here so the two state types stay independent. */
  private initRibbonState(
    anchorX: number,
    anchorY: number,
    leaderRotationDeg: number,
    config: RibbonConfig,
    totalPoints: number,
  ): ChainState {
    const totalAngleRad =
      ((config.restAngle + leaderRotationDeg) * Math.PI) / 180;
    const dirX = Math.sin(totalAngleRad);
    const dirY = Math.cos(totalAngleRad);

    const points: PointState[] = [];
    for (let i = 0; i < totalPoints; i++) {
      const x = anchorX + dirX * config.segmentLength * i;
      const y = anchorY + dirY * config.segmentLength * i;
      points.push({ x, y, prevX: x, prevY: y });
    }
    return {
      points,
      initialized: false,
      prevAnchorX: anchorX,
      prevAnchorY: anchorY,
    };
  }

  /**
   * Run the verlet simulation for one chain, one frame. Call AFTER
   * the leader's effective transform has been computed but BEFORE
   * any follower sprite is evaluated.
   *
   * Anchor world position is the leader's world translation plus
   * the configured anchorOffset (rotated by the leader's rotation
   * so the anchor tracks correctly when the leader rotates).
   */
  step(
    leaderId: SpriteId,
    anchorWorldX: number,
    anchorWorldY: number,
    leaderRotationDeg: number,
    config: ChainConfig,
    dt: number,
  ): void {
    if (config.links.length === 0) return;
    // Cap dt — when the tab regains focus after a long idle the
    // first dt can be hundreds of ms, which would explode an
    // implicit-velocity verlet step. 50ms is generous; in practice
    // we run at 16-17ms.
    const stepDt = Math.min(dt, 0.05);
    if (stepDt <= 0) return;

    const totalPoints = config.links.length + 1; // anchor + N followers
    let state = this.chains.get(leaderId);
    if (!state || state.points.length !== totalPoints) {
      state = this.initState(
        anchorWorldX,
        anchorWorldY,
        leaderRotationDeg,
        config,
        totalPoints,
      );
      this.chains.set(leaderId, state);
    }

    // Anchor — point 0. Set from leader's world position. Track the
    // previous-frame anchor position so velocity coupling can
    // compute frame-to-frame motion below.
    const prevAnchorX = state.prevAnchorX;
    const prevAnchorY = state.prevAnchorY;
    state.points[0]!.prevX = state.points[0]!.x;
    state.points[0]!.prevY = state.points[0]!.y;
    state.points[0]!.x = anchorWorldX;
    state.points[0]!.y = anchorWorldY;
    state.prevAnchorX = anchorWorldX;
    state.prevAnchorY = anchorWorldY;

    // Frame-to-frame anchor motion — used to seed first follower's
    // velocity coupling. On the very first step (before initialized
    // flips true), this is zero by construction.
    const anchorDX = state.initialized ? anchorWorldX - prevAnchorX : 0;
    const anchorDY = state.initialized ? anchorWorldY - prevAnchorY : 0;
    state.initialized = true;

    // Clamp the per-frame anchor delta used for velocity coupling.
    // When the user yanks the leader sprite (head, body) very fast
    // — particularly UPWARD, where gravity can't help dissipate the
    // injected energy — the raw anchorDX/Y values become large
    // single-frame impulses. Naively multiplying by velocityCoupling
    // dumps that energy into the first follower, the constraint
    // solver then redistributes the resulting overstretch through
    // every segment, and the chain whips violently for several
    // frames before settling.
    //
    // Capping the coupling source at 2× segmentLength means a single
    // frame can never inject more impulse than ~one-segment of
    // motion. The follower still tracks reasonably (it'll catch up
    // over a few frames), and slow-to-moderate motion is unaffected
    // (the cap rarely fires in normal use). Fast motion lags
    // slightly instead of detonating the chain.
    const MAX_COUPLING_DELTA = config.segmentLength * 2;
    const couplingDX = Math.max(
      -MAX_COUPLING_DELTA,
      Math.min(MAX_COUPLING_DELTA, anchorDX),
    );
    const couplingDY = Math.max(
      -MAX_COUPLING_DELTA,
      Math.min(MAX_COUPLING_DELTA, anchorDY),
    );

    // Verlet integration for followers (points 1..N).
    //
    // Damping is framerate-independent: velocity retained per second
    // is config.damping; per-step retention is damping^stepDt.
    // gravity * stepDt^2 is the standard verlet position-update term
    // for constant acceleration.
    //
    // Special-case damping <= 0: pow(0, dt) = 0, which would kill
    // velocity instantly every frame and freeze the chain. Users
    // intuitively expect damping=0 to mean "no damping at all" (the
    // OPPOSITE of instant kill); we honor that by treating any value
    // ≤ 0 as full velocity retention (perpetual swing). The dragged
    // chain still settles via gravity finding equilibrium and the
    // distance constraints, just without explicit drag. Without
    // this guard, the difference between damping=0 (frozen) and
    // damping=0.0001 (lively) is a discontinuous jump that no
    // amount of slider precision can cross smoothly.
    const dampingPerStep =
      config.damping <= 0 ? 1 : Math.pow(config.damping, stepDt);
    const gravityStep = config.gravity * stepDt * stepDt;
    for (let i = 1; i < totalPoints; i++) {
      const p = state.points[i]!;
      // Implicit velocity = pos - prevPos. Apply damping by scaling
      // the velocity contribution to next position.
      const vx = (p.x - p.prevX) * dampingPerStep;
      const vy = (p.y - p.prevY) * dampingPerStep;
      // Velocity-coupling for the first follower only — propagating
      // it down the chain naturally happens via the distance
      // constraints below. Higher coupling = whippier chain. Uses
      // the CLAMPED delta computed above so a single rapid frame
      // can't dump catastrophic energy into the chain.
      const couplingX = i === 1 ? couplingDX * config.velocityCoupling : 0;
      const couplingY = i === 1 ? couplingDY * config.velocityCoupling : 0;
      p.prevX = p.x;
      p.prevY = p.y;
      p.x += vx + couplingX;
      // Gravity is +Y in our coordinate system (canvas Y is down).
      p.y += vy + couplingY + gravityStep;
    }

    // Distance constraints — N-1 segments connect consecutive points.
    // Each iteration tightens convergence; 4 iterations is enough
    // for visually-rigid chains. The first segment (anchor → point
    // 1) is asymmetric: anchor stays put (it's the leader), so
    // point 1 absorbs the full correction.
    const seg = config.segmentLength;
    for (let iter = 0; iter < config.iterations; iter++) {
      for (let i = 1; i < totalPoints; i++) {
        const a = state.points[i - 1]!;
        const b = state.points[i]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        const diff = (dist - seg) / dist;
        if (i === 1) {
          // Anchor doesn't move — point 1 takes the full correction.
          b.x -= dx * diff;
          b.y -= dy * diff;
        } else {
          // Symmetric — both points share the correction.
          const half = diff * 0.5;
          a.x += dx * half;
          a.y += dy * half;
          b.x -= dx * half;
          b.y -= dy * half;
        }
      }
    }

    // Write overrides for each follower link. Rotation is the angle
    // from the link's predecessor TO the link itself — the direction
    // the link "points." Add 90° to convert from
    // delta-vector convention (atan2 returns angle from +X axis,
    // counterclockwise) to sprite-pointing-down convention (most
    // hair / tail tuft sprites are drawn with their attachment point
    // at the top, hanging downward — a sprite hanging straight down
    // has rotation 0 and visually points to +Y).
    for (let i = 1; i < totalPoints; i++) {
      const linkId = config.links[i - 1]!;
      const a = state.points[i - 1]!;
      const b = state.points[i]!;
      const override: ChainOverride = {
        x: b.x,
        y: b.y,
        rotation: null,
      };
      if (config.alignRotation) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        // atan2 result is in radians; convert to degrees. The +90°
        // shift above gives 0° for a sprite hanging straight down.
        const angleRad = Math.atan2(dy, dx);
        override.rotation = (angleRad * 180) / Math.PI - 90;
      }
      this.overrides.set(linkId, override);
    }
  }

  /** Lay out the rest pose: anchor at the supplied world position,
   *  each subsequent point segmentLength away in the restAngle
   *  direction. Initial prevPos == pos, so the first integration
   *  step starts with zero implicit velocity (no jolt). */
  private initState(
    anchorX: number,
    anchorY: number,
    leaderRotationDeg: number,
    config: ChainConfig,
    totalPoints: number,
  ): ChainState {
    // restAngle is degrees from straight down. Compose with the
    // leader's rotation so a sprite that's rotated 90° (lying on its
    // side) has its chain initially hanging perpendicular to the new
    // "down."
    const totalAngleRad =
      ((config.restAngle + leaderRotationDeg) * Math.PI) / 180;
    // Direction vector. restAngle=0 → straight down (+Y), 90° → +X.
    const dirX = Math.sin(totalAngleRad);
    const dirY = Math.cos(totalAngleRad);

    const points: PointState[] = [];
    for (let i = 0; i < totalPoints; i++) {
      const x = anchorX + dirX * config.segmentLength * i;
      const y = anchorY + dirY * config.segmentLength * i;
      points.push({ x, y, prevX: x, prevY: y });
    }
    return {
      points,
      initialized: false,
      prevAnchorX: anchorX,
      prevAnchorY: anchorY,
    };
  }
}
