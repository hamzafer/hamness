/**
 * One animation loop for every orb on the page, so they all share one time. It only runs while
 * the tab is visible and some orb is on screen; time away does not count, so an orb resumes
 * where it stopped. Under reduced motion it never loops: each orb gets one still frame.
 */

export interface ClockEnv {
  raf(cb: (t: number) => void): number;
  caf(id: number): void;
  hidden(): boolean;
  reducedMotion(): boolean;
}

export interface Ticking {
  /** Seconds into the shared animation, or null for the still frame. */
  draw(seconds: number | null): void;
  /** False once its canvas has left the page. */
  readonly connected: boolean;
}

export class OrbClock {
  private orbs = new Map<Ticking, { visible: boolean }>();
  private id: number | undefined;
  private last: number | undefined;
  private elapsed = 0;

  constructor(private env: ClockEnv) {}

  get size(): number {
    return this.orbs.size;
  }

  has(orb: Ticking): boolean {
    return this.orbs.has(orb);
  }

  add(orb: Ticking): void {
    this.orbs.set(orb, { visible: true });
    if (this.env.reducedMotion()) orb.draw(null);
    else this.wake();
  }

  remove(orb: Ticking): void {
    this.orbs.delete(orb);
  }

  setVisible(orb: Ticking, visible: boolean): void {
    const o = this.orbs.get(orb);
    if (o) o.visible = visible;
    this.wake();
  }

  /** Redraw every orb now (a theme change); still frames under reduced motion. */
  repaint(): void {
    const still = this.env.reducedMotion();
    for (const orb of this.live()) orb.draw(still ? null : this.elapsed);
    this.wake();
  }

  /** Start or stop the loop to match the tab, the motion setting and what is on screen. */
  wake(): void {
    const run = !this.env.hidden() && !this.env.reducedMotion() && this.anyVisible();
    if (run && this.id === undefined) this.id = this.env.raf((t) => this.tick(t));
    if (!run && this.id !== undefined) {
      this.env.caf(this.id);
      this.id = undefined;
    }
    if (!run) this.last = undefined;
  }

  private live(): Ticking[] {
    for (const orb of this.orbs.keys()) if (!orb.connected) this.orbs.delete(orb);
    return [...this.orbs.keys()];
  }

  private anyVisible(): boolean {
    return this.live().some((orb) => this.orbs.get(orb)?.visible);
  }

  private tick(t: number): void {
    this.id = undefined;
    if (this.last !== undefined) this.elapsed += Math.max(0, t - this.last) / 1000;
    this.last = t;
    for (const orb of this.live()) if (this.orbs.get(orb)?.visible) orb.draw(this.elapsed);
    this.wake();
  }
}
