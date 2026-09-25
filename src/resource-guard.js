export class ResourceGuard {
  constructor({
    limitMb = Number(process.env.WA_MEMORY_LIMIT_MB || 512),
    pauseMb = Number(process.env.WA_MEMORY_PAUSE_MB || 430),
    resumeMb = Number(process.env.WA_MEMORY_RESUME_MB || 360),
    sample = () => process.memoryUsage(),
  } = {}) {
    this.limitMb = Number.isFinite(limitMb) && limitMb > 0 ? limitMb : 512;
    this.pauseMb = Number.isFinite(pauseMb) && pauseMb > 0 ? pauseMb : Math.floor(this.limitMb * 0.84);
    this.resumeMb = Number.isFinite(resumeMb) && resumeMb > 0 ? resumeMb : Math.floor(this.limitMb * 0.70);
    this.sample = sample;
    this.blocked = false;
    this.last = null;
  }

  snapshot() {
    const raw = this.sample();
    const toMb = bytes => Math.round((Number(bytes || 0) / 1024 / 1024) * 10) / 10;
    const rssMb = toMb(raw.rss);
    const heapUsedMb = toMb(raw.heapUsed);
    const heapTotalMb = toMb(raw.heapTotal);
    const externalMb = toMb(raw.external);

    if (!this.blocked && rssMb >= this.pauseMb) this.blocked = true;
    else if (this.blocked && rssMb <= this.resumeMb) this.blocked = false;

    const pressure = this.blocked ? 'blocked' : rssMb >= this.resumeMb ? 'high' : 'normal';
    this.last = {
      rssMb,
      heapUsedMb,
      heapTotalMb,
      externalMb,
      limitMb: this.limitMb,
      pauseMb: this.pauseMb,
      resumeMb: this.resumeMb,
      pressure,
      blocked: this.blocked,
      sampledAt: new Date().toISOString(),
    };
    return this.last;
  }

  canWork() {
    return !this.snapshot().blocked;
  }
}
