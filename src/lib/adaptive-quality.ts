export interface QualityProfile {
  tier: 1 | 2 | 3 | 4;
  resolution: 'low' | 'medium' | 'high' | 'ultra';
  targetFps: number;
  maxAsciiWidth: number;
  maxAsciiHeight: number;
  useWorker: boolean;
  useWebGL: boolean;
  useColor: boolean;
  useTemporalSmoothing: boolean;
  useEdgeDetection: boolean;
  useDithering: boolean;
}

export const QUALITY_PROFILES: Record<string, QualityProfile> = {
  low: {
    tier: 1,
    resolution: 'low',
    targetFps: 15,
    maxAsciiWidth: 80,
    maxAsciiHeight: 45,
    useWorker: false,
    useWebGL: false,
    useColor: false,
    useTemporalSmoothing: false,
    useEdgeDetection: false,
    useDithering: false
  },
  medium: {
    tier: 2,
    resolution: 'medium',
    targetFps: 30,
    maxAsciiWidth: 120,
    maxAsciiHeight: 68,
    useWorker: true,
    useWebGL: false,
    useColor: false,
    useTemporalSmoothing: true,
    useEdgeDetection: false,
    useDithering: false
  },
  high: {
    tier: 3,
    resolution: 'high',
    targetFps: 45,
    maxAsciiWidth: 160,
    maxAsciiHeight: 90,
    useWorker: true,
    useWebGL: true,
    useColor: true,
    useTemporalSmoothing: true,
    useEdgeDetection: true,
    useDithering: false
  },
  ultra: {
    tier: 4,
    resolution: 'ultra',
    targetFps: 60,
    maxAsciiWidth: 200,
    maxAsciiHeight: 120,
    useWorker: true,
    useWebGL: true,
    useColor: true,
    useTemporalSmoothing: true,
    useEdgeDetection: true,
    useDithering: true
  }
};

export class AdaptiveQuality {
  private currentProfile: QualityProfile;
  private performanceHistory: number[] = [];
  private readonly HISTORY_SIZE = 30;
  private lastAdjustment = 0;
  private readonly ADJUST_INTERVAL = 2000;

  constructor() {
    this.currentProfile = this.detectInitialProfile();
  }

  private detectInitialProfile(): QualityProfile {

    const cores = navigator.hardwareConcurrency || 2;
    const memory = (navigator as any).deviceMemory || 4;
    const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    const hasWebGL = !!document.createElement('canvas').getContext('webgl2');
    const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';

    let score = 0;
    score += cores >= 8 ? 3 : cores >= 4 ? 2 : 1;
    score += memory >= 8 ? 3 : memory >= 4 ? 2 : 1;
    score += hasWebGL ? 2 : 0;
    score += hasSharedArrayBuffer ? 1 : 0;
    score += isMobile ? -2 : 1;

    if (score >= 8) return QUALITY_PROFILES.ultra;
    if (score >= 6) return QUALITY_PROFILES.high;
    if (score >= 4) return QUALITY_PROFILES.medium;
    return QUALITY_PROFILES.low;
  }

  getProfile(): QualityProfile {
    return this.currentProfile;
  }

  reportPerformance(processingTimeMs: number) {
    this.performanceHistory.push(processingTimeMs);
    if (this.performanceHistory.length > this.HISTORY_SIZE) {
      this.performanceHistory.shift();
    }

    const now = performance.now();
    if (now - this.lastAdjustment < this.ADJUST_INTERVAL) return;
    this.lastAdjustment = now;

    const avg = this.performanceHistory.reduce((a, b) => a + b, 0) / this.performanceHistory.length;
    const targetFrameTime = 1000 / this.currentProfile.targetFps;

    if (avg > targetFrameTime * 1.5) {

      this.downgrade();
    } else if (avg < targetFrameTime * 0.5 && this.performanceHistory.length >= this.HISTORY_SIZE) {

      this.upgrade();
    }
  }

  private downgrade() {
    const profiles = ['ultra', 'high', 'medium', 'low'];
    const currentIdx = profiles.indexOf(this.getProfileName());
    if (currentIdx < profiles.length - 1) {
      const nextProfile = profiles[currentIdx + 1];
      this.currentProfile = QUALITY_PROFILES[nextProfile];
    }
  }

  private upgrade() {
    const profiles = ['ultra', 'high', 'medium', 'low'];
    const currentIdx = profiles.indexOf(this.getProfileName());
    if (currentIdx > 0) {
      const nextProfile = profiles[currentIdx - 1];
      this.currentProfile = QUALITY_PROFILES[nextProfile];
    }
  }

  private getProfileName(): string {
    for (const [name, profile] of Object.entries(QUALITY_PROFILES)) {
      if (profile === this.currentProfile) return name;
    }
    return 'medium';
  }

  setProfile(name: keyof typeof QUALITY_PROFILES) {
    this.currentProfile = QUALITY_PROFILES[name];
  }
}

export const adaptiveQuality = new AdaptiveQuality();
