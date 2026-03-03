/**
 * TeraSwap — Futuristic Sound Engine
 *
 * All sounds are synthesized via Web Audio API (no external files).
 * Deep bass tones with futuristic character. Low volume for UI interactions,
 * impactful sound for swap success.
 */

let audioCtx: AudioContext | null = null

function getCtx(): AudioContext {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume()
  }
  return audioCtx
}

// ── Utility: create a gain node at a given volume ──
function gain(ctx: AudioContext, volume: number, t: number): GainNode {
  const g = ctx.createGain()
  g.gain.setValueAtTime(volume, t)
  return g
}

/**
 * Subtle deep click — used for button hovers / interactions
 * Very quiet, sub-bass pulse
 */
export function playClick() {
  try {
    const ctx = getCtx()
    const t = ctx.currentTime

    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(65, t)  // Deep C2
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.08)

    const g = gain(ctx, 0.04, t) // Very quiet
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08)

    osc.connect(g).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.08)
  } catch { /* silent fail */ }
}

/**
 * Quote received — soft futuristic blip
 * Sub-bass + high harmonic ping
 */
export function playQuoteReceived() {
  try {
    const ctx = getCtx()
    const t = ctx.currentTime

    // Sub-bass layer
    const bass = ctx.createOscillator()
    bass.type = 'sine'
    bass.frequency.setValueAtTime(55, t)
    bass.frequency.exponentialRampToValueAtTime(35, t + 0.15)

    const bg = gain(ctx, 0.035, t)
    bg.gain.exponentialRampToValueAtTime(0.001, t + 0.15)

    bass.connect(bg).connect(ctx.destination)
    bass.start(t)
    bass.stop(t + 0.15)

    // High harmonic ping
    const ping = ctx.createOscillator()
    ping.type = 'sine'
    ping.frequency.setValueAtTime(1200, t)
    ping.frequency.exponentialRampToValueAtTime(800, t + 0.1)

    const pg = gain(ctx, 0.015, t)
    pg.gain.exponentialRampToValueAtTime(0.001, t + 0.12)

    ping.connect(pg).connect(ctx.destination)
    ping.start(t)
    ping.stop(t + 0.12)
  } catch { /* silent fail */ }
}

/**
 * Token selection — subtle tonal shift
 */
export function playTokenSelect() {
  try {
    const ctx = getCtx()
    const t = ctx.currentTime

    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(220, t)
    osc.frequency.exponentialRampToValueAtTime(330, t + 0.06)

    const g = gain(ctx, 0.025, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08)

    osc.connect(g).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.08)
  } catch { /* silent fail */ }
}

/**
 * Approval sent — medium-depth confirmation tone
 */
export function playApproval() {
  try {
    const ctx = getCtx()
    const t = ctx.currentTime

    // Two-note arpeggio
    const notes = [110, 165] // A2 → E3
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, t + i * 0.08)

      const g = gain(ctx, 0.04, t + i * 0.08)
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.08 + 0.15)

      osc.connect(g).connect(ctx.destination)
      osc.start(t + i * 0.08)
      osc.stop(t + i * 0.08 + 0.15)
    })
  } catch { /* silent fail */ }
}

/**
 * Swap initiated — rising deep tone
 */
export function playSwapInitiated() {
  try {
    const ctx = getCtx()
    const t = ctx.currentTime

    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(50, t)
    osc.frequency.exponentialRampToValueAtTime(100, t + 0.3)

    // Low-pass filter for warmth
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(200, t)
    filter.frequency.exponentialRampToValueAtTime(400, t + 0.3)
    filter.Q.setValueAtTime(2, t)

    const g = gain(ctx, 0.04, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35)

    osc.connect(filter).connect(g).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.35)
  } catch { /* silent fail */ }
}

/**
 * ★ SWAP SUCCESS — Impactful cinematic sound
 * Multi-layered: deep bass boom + rising synth + shimmer + harmonic chord
 */
export function playSwapSuccess() {
  try {
    const ctx = getCtx()
    const t = ctx.currentTime

    // ── Layer 1: Deep bass boom ──
    const boom = ctx.createOscillator()
    boom.type = 'sine'
    boom.frequency.setValueAtTime(45, t)
    boom.frequency.exponentialRampToValueAtTime(25, t + 0.6)

    const boomGain = gain(ctx, 0.12, t)
    boomGain.gain.setValueAtTime(0.12, t)
    boomGain.gain.linearRampToValueAtTime(0.08, t + 0.1)
    boomGain.gain.exponentialRampToValueAtTime(0.001, t + 0.6)

    boom.connect(boomGain).connect(ctx.destination)
    boom.start(t)
    boom.stop(t + 0.6)

    // ── Layer 2: Rising synth sweep ──
    const sweep = ctx.createOscillator()
    sweep.type = 'sawtooth'
    sweep.frequency.setValueAtTime(80, t + 0.05)
    sweep.frequency.exponentialRampToValueAtTime(400, t + 0.4)

    const sweepFilter = ctx.createBiquadFilter()
    sweepFilter.type = 'lowpass'
    sweepFilter.frequency.setValueAtTime(300, t + 0.05)
    sweepFilter.frequency.exponentialRampToValueAtTime(2000, t + 0.4)
    sweepFilter.Q.setValueAtTime(3, t)

    const sweepGain = gain(ctx, 0.05, t + 0.05)
    sweepGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5)

    sweep.connect(sweepFilter).connect(sweepGain).connect(ctx.destination)
    sweep.start(t + 0.05)
    sweep.stop(t + 0.5)

    // ── Layer 3: Harmonic chord (major triad) ──
    const chordFreqs = [220, 277, 330, 440] // A3, C#4, E4, A4
    chordFreqs.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, t + 0.1)

      const g = gain(ctx, 0.025, t + 0.1)
      g.gain.linearRampToValueAtTime(0.03, t + 0.2)
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.0)

      osc.connect(g).connect(ctx.destination)
      osc.start(t + 0.1)
      osc.stop(t + 1.0)
    })

    // ── Layer 4: Shimmer (high-freq noise burst) ──
    const bufferSize = ctx.sampleRate * 0.3
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.08))
    }

    const noise = ctx.createBufferSource()
    noise.buffer = buffer

    const noiseFilter = ctx.createBiquadFilter()
    noiseFilter.type = 'bandpass'
    noiseFilter.frequency.setValueAtTime(4000, t + 0.08)
    noiseFilter.Q.setValueAtTime(0.5, t)

    const noiseGain = gain(ctx, 0.02, t + 0.08)
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4)

    noise.connect(noiseFilter).connect(noiseGain).connect(ctx.destination)
    noise.start(t + 0.08)

    // ── Layer 5: Sub-bass impact at the very start ──
    const impact = ctx.createOscillator()
    impact.type = 'sine'
    impact.frequency.setValueAtTime(30, t)
    impact.frequency.exponentialRampToValueAtTime(20, t + 0.2)

    const impactGain = gain(ctx, 0.15, t)
    impactGain.gain.exponentialRampToValueAtTime(0.001, t + 0.25)

    impact.connect(impactGain).connect(ctx.destination)
    impact.start(t)
    impact.stop(t + 0.25)

  } catch { /* silent fail */ }
}

/**
 * DCA Buy executed — distinct pulsing confirmation
 * Two quick ascending pings + soft bass, feels like a "purchase tick"
 */
export function playDCABuy() {
  try {
    const ctx = getCtx()
    const t = ctx.currentTime

    // ── Soft bass pulse ──
    const bass = ctx.createOscillator()
    bass.type = 'sine'
    bass.frequency.setValueAtTime(55, t)
    bass.frequency.exponentialRampToValueAtTime(35, t + 0.25)

    const bassGain = gain(ctx, 0.06, t)
    bassGain.gain.exponentialRampToValueAtTime(0.001, t + 0.25)

    bass.connect(bassGain).connect(ctx.destination)
    bass.start(t)
    bass.stop(t + 0.25)

    // ── Two ascending pings (C5 → E5) ──
    const pingFreqs = [523, 659] // C5, E5
    pingFreqs.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, t + i * 0.09)

      const g = gain(ctx, 0.03, t + i * 0.09)
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.09 + 0.12)

      osc.connect(g).connect(ctx.destination)
      osc.start(t + i * 0.09)
      osc.stop(t + i * 0.09 + 0.12)
    })

    // ── Subtle shimmer tail ──
    const shimmer = ctx.createOscillator()
    shimmer.type = 'triangle'
    shimmer.frequency.setValueAtTime(880, t + 0.15)
    shimmer.frequency.exponentialRampToValueAtTime(660, t + 0.4)

    const shimmerGain = gain(ctx, 0.012, t + 0.15)
    shimmerGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4)

    shimmer.connect(shimmerGain).connect(ctx.destination)
    shimmer.start(t + 0.15)
    shimmer.stop(t + 0.4)
  } catch { /* silent fail */ }
}

/**
 * Limit order placed — crisp confirmation with echo
 * Rising arpeggio (A4 → C#5 → E5) + soft reverb tail
 */
export function playLimitPlaced() {
  try {
    const ctx = getCtx()
    const t = ctx.currentTime

    // ── Rising arpeggio ──
    const notes = [440, 554, 659] // A4, C#5, E5
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, t + i * 0.07)

      const g = gain(ctx, 0.035, t + i * 0.07)
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.07 + 0.18)

      osc.connect(g).connect(ctx.destination)
      osc.start(t + i * 0.07)
      osc.stop(t + i * 0.07 + 0.18)
    })

    // ── Sub confirmation pulse ──
    const sub = ctx.createOscillator()
    sub.type = 'sine'
    sub.frequency.setValueAtTime(80, t)
    sub.frequency.exponentialRampToValueAtTime(50, t + 0.2)

    const sg = gain(ctx, 0.04, t)
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.25)

    sub.connect(sg).connect(ctx.destination)
    sub.start(t)
    sub.stop(t + 0.25)

    // ── Echo tail ──
    const echo = ctx.createOscillator()
    echo.type = 'triangle'
    echo.frequency.setValueAtTime(659, t + 0.25)
    echo.frequency.exponentialRampToValueAtTime(440, t + 0.5)

    const eg = gain(ctx, 0.012, t + 0.25)
    eg.gain.exponentialRampToValueAtTime(0.001, t + 0.5)

    echo.connect(eg).connect(ctx.destination)
    echo.start(t + 0.25)
    echo.stop(t + 0.5)
  } catch { /* silent fail */ }
}

/**
 * Stop Loss / Take Profit triggered — urgent alert pulse
 * Descending alert tone + fast pulse to signal automatic execution
 */
export function playTriggerAlert() {
  try {
    const ctx = getCtx()
    const t = ctx.currentTime

    // ── Alert sweep (descending) ──
    const alert = ctx.createOscillator()
    alert.type = 'sine'
    alert.frequency.setValueAtTime(880, t)
    alert.frequency.exponentialRampToValueAtTime(440, t + 0.15)

    const ag = gain(ctx, 0.06, t)
    ag.gain.exponentialRampToValueAtTime(0.001, t + 0.2)

    alert.connect(ag).connect(ctx.destination)
    alert.start(t)
    alert.stop(t + 0.2)

    // ── Double pulse ──
    const pulseFreqs = [660, 660]
    pulseFreqs.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(freq, t + 0.2 + i * 0.1)

      const g = gain(ctx, 0.04, t + 0.2 + i * 0.1)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.2 + i * 0.1 + 0.08)

      osc.connect(g).connect(ctx.destination)
      osc.start(t + 0.2 + i * 0.1)
      osc.stop(t + 0.2 + i * 0.1 + 0.08)
    })

    // ── Sub bass thump ──
    const sub = ctx.createOscillator()
    sub.type = 'sine'
    sub.frequency.setValueAtTime(60, t)
    sub.frequency.exponentialRampToValueAtTime(30, t + 0.3)

    const sg = gain(ctx, 0.08, t)
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.3)

    sub.connect(sg).connect(ctx.destination)
    sub.start(t)
    sub.stop(t + 0.3)
  } catch { /* silent fail */ }
}

/**
 * Error sound — dissonant low tone
 */
export function playError() {
  try {
    const ctx = getCtx()
    const t = ctx.currentTime

    const osc1 = ctx.createOscillator()
    osc1.type = 'square'
    osc1.frequency.setValueAtTime(80, t)
    osc1.frequency.exponentialRampToValueAtTime(60, t + 0.2)

    const osc2 = ctx.createOscillator()
    osc2.type = 'square'
    osc2.frequency.setValueAtTime(77, t) // Slight detune for dissonance
    osc2.frequency.exponentialRampToValueAtTime(58, t + 0.2)

    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(300, t)

    const g = gain(ctx, 0.03, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25)

    osc1.connect(filter)
    osc2.connect(filter)
    filter.connect(g).connect(ctx.destination)

    osc1.start(t)
    osc2.start(t)
    osc1.stop(t + 0.25)
    osc2.stop(t + 0.25)
  } catch { /* silent fail */ }
}
