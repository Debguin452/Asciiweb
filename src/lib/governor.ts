export interface GovernorState {
  level: number;
  lowLight: boolean;
  scaleMul: number;
  fpsCap: number;
}

const LEVELS: Omit<GovernorState, "level">[] = [
  { lowLight: true,  scaleMul: 1,    fpsCap: 60 },
  { lowLight: true,  scaleMul: 0.85, fpsCap: 60 },
  { lowLight: true,  scaleMul: 0.7,  fpsCap: 60 },
  { lowLight: false, scaleMul: 0.55, fpsCap: 60 },
  { lowLight: false, scaleMul: 0.55, fpsCap: 20 },
];

const MAX_LEVEL = LEVELS.length - 1;
const HIGH_LOAD = 0.8;
const LOW_LOAD = 0.45;
const DEGRADE_AFTER = 1500;
const UPGRADE_AFTER = 6000;
const SETTLE = 2000;
const REGRESS_WINDOW = 8000;
const SPIKE_RATIO = 2.5;
const SPIKES_TO_PANIC = 3;
const SPIKE_WINDOW = 1000;
const MAX_BACKOFF = 60000;
const SELF_SHARE = 0.12;
const SELF_MAX_INTERVAL = 250;

export class FrameGovernor {
  private level = 0;
  private sendLoad = 0;
  private paintMs = 0;
  private highSince = 0;
  private lowSince = 0;
  private lastChange = 0;
  private lastUpgrade = 0;
  private holdUntil = 0;
  private backoff = 8000;
  private spikes: number[] = [];
  private selfMs = 0;
  private lastSelf = 0;
  private frameSelf = 0;
  private listener: ((s: GovernorState) => void) | null = null;

  state: GovernorState = { level: 0, ...LEVELS[0] };

  onChange(fn: (s: GovernorState) => void) { this.listener = fn; }

  reset() {
    this.sendLoad = 0; this.paintMs = 0; this.highSince = 0; this.lowSince = 0;
    this.spikes.length = 0; this.backoff = 8000; this.holdUntil = 0;
    this.selfMs = 0; this.lastSelf = 0; this.frameSelf = 0;
    this.apply(0, performance.now());
  }

  notePaint(ms: number) {
    if (!(ms >= 0) || ms > 1000) return;
    this.paintMs += (ms - this.paintMs) * 0.1;
  }

  shouldPaintSelf(now: number): boolean {
    const interval = Math.min(SELF_MAX_INTERVAL, this.selfMs / SELF_SHARE);
    return now - this.lastSelf >= interval;
  }

  noteSelfPaint(ms: number, now: number) {
    if (!(ms >= 0) || ms > 1000) return;
    this.selfMs += (ms - this.selfMs) * 0.2;
    this.lastSelf = now;
    this.frameSelf += ms;
  }

  noteWork(rawMs: number, budgetMs: number, now: number) {
    const workMs = Math.max(0, rawMs - this.frameSelf);
    this.frameSelf = 0;
    if (!(workMs >= 0) || !(budgetMs > 0) || workMs > 2000) return;
    this.sendLoad += (workMs / budgetMs - this.sendLoad) * 0.1;
    const load = this.sendLoad + this.paintMs / budgetMs;

    if (workMs > budgetMs * SPIKE_RATIO) {
      this.spikes.push(now);
      while (this.spikes.length && now - this.spikes[0] > SPIKE_WINDOW) this.spikes.shift();
      if (this.spikes.length >= SPIKES_TO_PANIC) {
        this.spikes.length = 0;
        this.degrade(now, 2);
        return;
      }
    }

    if (now - this.lastChange < SETTLE) return;

    if (load > HIGH_LOAD) {
      this.lowSince = 0;
      if (!this.highSince) this.highSince = now;
      if (now - this.highSince >= DEGRADE_AFTER) this.degrade(now, 1);
    } else if (load < LOW_LOAD) {
      this.highSince = 0;
      if (!this.lowSince) this.lowSince = now;
      if (now - this.lowSince >= UPGRADE_AFTER && now >= this.holdUntil && this.level > 0) this.upgrade(now);
    } else {
      this.highSince = 0;
      this.lowSince = 0;
    }
  }

  private degrade(now: number, steps: number) {
    const regressed = this.lastUpgrade > 0 && now - this.lastUpgrade < REGRESS_WINDOW;
    if (regressed) {
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
      this.holdUntil = now + this.backoff;
      this.lastUpgrade = 0;
    }
    this.highSince = 0;
    this.apply(Math.min(MAX_LEVEL, this.level + steps), now);
  }

  private upgrade(now: number) {
    this.lowSince = 0;
    this.lastUpgrade = now;
    this.apply(this.level - 1, now);
  }

  private apply(level: number, now: number) {
    if (level === this.level && this.state.level === level) return;
    this.level = level;
    this.lastChange = now;
    this.state = { level, ...LEVELS[level] };
    this.listener?.(this.state);
  }
}
