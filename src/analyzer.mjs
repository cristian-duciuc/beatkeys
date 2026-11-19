const SIZE = 2048;

export const BANDS = [
  [20, 250],
  [250, 4000],
  [4000, 16000],
];
// Level in dBFS at which each step lights. Tune these with `npm run levels`.
export const STEP_DB = [-40, -29, -20, -12];
// Evens out the bands so typical music sits around -16 dB in each. Bass carries the most
// energy and the highs the least.
const BAND_GAIN_DB = [-3, 0, 10];
// How fast a band falls after a peak, in dB per second. The rise is instant.
const RELEASE_DB_PER_S = 40;
// How fast the volume bar falls. Around 10 suits 2.5 updates a second, 15 suits 4, and 30 suits 10.
const VOLUME_RELEASE_DB_PER_S = 20;

// In-place iterative radix-2 FFT. The length must be a power of two.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(angle * k);
        const wi = Math.sin(angle * k);
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

// Level of each band in dBFS, where a full-scale sine reads about 0 dB.
export function bandLevels(samples, sampleRate) {
  const n = samples.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = samples[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  fft(re, im);
  const binHz = sampleRate / n;
  return BANDS.map(([low, high], band) => {
    let power = 0;
    const last = Math.min(n / 2 - 1, Math.floor(high / binHz));
    for (let k = Math.max(1, Math.ceil(low / binHz)); k <= last; k++) {
      // The Hann window halves the gain, so 4/n brings a full-scale sine back to 1.
      const amplitude = (4 * Math.hypot(re[k], im[k])) / n;
      power += amplitude * amplitude;
    }
    return 10 * Math.log10(power + 1e-12) + BAND_GAIN_DB[band];
  });
}

export class Analyzer {
  sampleRate = 48000;
  ring = new Float32Array(SIZE);
  position = 0;
  levels = BANDS.map(() => -120);
  volume = -120; // RMS of all frequencies in dBFS, where a full-scale sine reads about -3 dB
  lastUpdate = 0;

  push(samples) {
    for (const sample of samples) {
      this.ring[this.position] = sample;
      this.position = (this.position + 1) % SIZE;
    }
  }

  // Analyzes the latest SIZE samples. `now` is in seconds.
  update(now) {
    const ordered = new Float32Array(SIZE);
    ordered.set(this.ring.subarray(this.position));
    ordered.set(this.ring.subarray(0, this.position), SIZE - this.position);
    const elapsed = this.lastUpdate ? now - this.lastUpdate : 0;
    this.lastUpdate = now;
    bandLevels(ordered, this.sampleRate).forEach((db, band) => {
      this.levels[band] = Math.max(db, this.levels[band] - RELEASE_DB_PER_S * elapsed);
    });
    const rms = Math.sqrt(ordered.reduce((sum, sample) => sum + sample * sample, 0) / SIZE);
    this.volume = Math.max(20 * Math.log10(rms + 1e-6), this.volume - VOLUME_RELEASE_DB_PER_S * elapsed);
  }

  // Lit steps per band, 0 to 4.
  steps() {
    return this.levels.map((db) => STEP_DB.filter((threshold) => db > threshold).length);
  }
}
