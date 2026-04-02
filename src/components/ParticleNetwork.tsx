'use client'

import { useEffect, useRef } from 'react'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  alpha: number
  baseVx: number   // original velocity (for lerp back to calm)
  baseVy: number
}

// Q17: Reduce particles on mobile for performance; Q35: respect prefers-reduced-motion
const IS_BROWSER = typeof window !== 'undefined'
const IS_MOBILE = IS_BROWSER && window.innerWidth < 768
const PREFERS_REDUCED_MOTION = IS_BROWSER && window.matchMedia('(prefers-reduced-motion: reduce)').matches
const PARTICLE_COUNT = PREFERS_REDUCED_MOTION ? 20 : IS_MOBILE ? 55 : 110
const MAX_DIST = 160
const MOUSE_DIST = 200
const MOUSE_REPEL = 120

// ── Cursor proximity settings ──
const CURSOR_GLOW_RADIUS = 250
const BASE_LINE_OPACITY = 0.13
const MAX_LINE_OPACITY = 0.35
const BASE_DOT_ALPHA_MULT = 1.1
const MAX_DOT_ALPHA_MULT = 1.4

// ── Warp mode settings (active while scrolling — "travelling through space") ──
const WARP_FORCE = 0.014            // outward centrifugal force from viewport center
const WARP_SPEED_LIMIT = 16         // max particle speed during full warp
const WARP_TRAIL_MAX = 13           // max trail length (particle radii)
const WARP_LERP_IN = 0.14           // how fast warp kicks in on scroll
const WARP_LERP_OUT = 0.02          // how slowly it calms back down

// ── Turbo mode settings (active during swap transactions) ──
const TURBO_SPEED_MULT = 12         // velocity multiplier during turbo (was 4.5)
const TURBO_MAX_DIST = 280          // much larger connection radius (was 220)
const TURBO_LINE_OPACITY = 0.45     // much brighter base connections (was 0.25)
const TURBO_DOT_ALPHA_MULT = 2.2    // much brighter dots (was 1.6)
const TURBO_GLOW_RADIUS = 10        // much larger glow halos (was 6)
const TURBO_LERP_IN = 0.08          // faster transition into turbo (was 0.04)
const TURBO_LERP_OUT = 0.015        // slower fade out for dramatic effect
const TURBO_JITTER = PREFERS_REDUCED_MOTION ? 0.01 : 0.06 // Q35: minimal jitter for reduced motion

function getParticleColor(): string {
  if (typeof document === 'undefined') return '232, 220, 196'
  return getComputedStyle(document.documentElement).getPropertyValue('--particle-color').trim() || '232, 220, 196'
}

// ── Global turbo state (set via custom events from SwapBox) ──
let globalTurbo = false
export function setParticleTurbo(active: boolean) {
  globalTurbo = active
  window.dispatchEvent(new CustomEvent('particle-turbo', { detail: { active } }))
}

export default function ParticleNetwork() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mouseRef = useRef({ x: -9999, y: -9999 })
  const particlesRef = useRef<Particle[]>([])
  const animRef = useRef<number>(0)
  const colorRef = useRef(getParticleColor())
  const turboRef = useRef(0) // 0 = calm, 1 = full turbo (lerped)
  const warpRef  = useRef(0) // 0 = calm, 1 = full warp (lerped from scroll)
  const warpTargetRef = useRef(0) // driven by scroll events

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let W = 0, H = 0

    function resize() {
      W = canvas!.width = window.innerWidth
      H = canvas!.height = window.innerHeight
    }

    function createParticle(): Particle {
      const vx = (Math.random() - 0.5) * 0.4
      const vy = (Math.random() - 0.5) * 0.4
      return {
        x: Math.random() * W,
        y: Math.random() * H,
        vx, vy,
        baseVx: vx, baseVy: vy,
        r: Math.random() * 2 + 1,
        alpha: Math.random() * 0.5 + 0.2,
      }
    }

    function init() {
      resize()
      particlesRef.current = []
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        particlesRef.current.push(createParticle())
      }
    }

    function draw() {
      const particles = particlesRef.current
      const mouse = mouseRef.current
      ctx!.clearRect(0, 0, W, H)

      // ── Lerp turbo intensity ──
      const targetTurbo = globalTurbo ? 1 : 0
      turboRef.current += (targetTurbo - turboRef.current) * (globalTurbo ? TURBO_LERP_IN : TURBO_LERP_OUT)
      if (Math.abs(turboRef.current - targetTurbo) < 0.001) turboRef.current = targetTurbo
      const t = turboRef.current // 0-1 turbo intensity

      // ── Lerp warp intensity (scroll-driven) ──
      const warpTarget = warpTargetRef.current
      warpRef.current += (warpTarget - warpRef.current) * (warpTarget > warpRef.current ? WARP_LERP_IN : WARP_LERP_OUT)
      if (Math.abs(warpRef.current - warpTarget) < 0.001) warpRef.current = warpTarget
      const w = warpRef.current // 0-1 warp intensity

      // ── Interpolated settings ──
      const maxDist = MAX_DIST + (TURBO_MAX_DIST - MAX_DIST) * t
      const baseLineOp = BASE_LINE_OPACITY + (TURBO_LINE_OPACITY - BASE_LINE_OPACITY) * t
      const baseDotMult = BASE_DOT_ALPHA_MULT + (TURBO_DOT_ALPHA_MULT - BASE_DOT_ALPHA_MULT) * t
      const speedLimit = 0.8 + (0.8 * TURBO_SPEED_MULT - 0.8) * t + WARP_SPEED_LIMIT * w

      // Draw connections between particles — brightness depends on cursor proximity + turbo
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x
          const dy = particles[i].y - particles[j].y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < maxDist) {
            const distFactor = 1 - dist / maxDist

            const midX = (particles[i].x + particles[j].x) / 2
            const midY = (particles[i].y + particles[j].y) / 2
            const cmDx = midX - mouse.x
            const cmDy = midY - mouse.y
            const cursorDist = Math.sqrt(cmDx * cmDx + cmDy * cmDy)
            const cursorFactor = Math.max(0, 1 - cursorDist / CURSOR_GLOW_RADIUS)

            const opacity = distFactor * (baseLineOp + (MAX_LINE_OPACITY - baseLineOp) * cursorFactor * cursorFactor)

            ctx!.beginPath()
            ctx!.moveTo(particles[i].x, particles[i].y)
            ctx!.lineTo(particles[j].x, particles[j].y)
            ctx!.strokeStyle = `rgba(${colorRef.current}, ${opacity})`
            ctx!.lineWidth = 0.5 + cursorFactor * 0.5 + t * 1.2
            ctx!.stroke()
          }
        }

        // Mouse interaction lines
        const mdx = particles[i].x - mouse.x
        const mdy = particles[i].y - mouse.y
        const mDist = Math.sqrt(mdx * mdx + mdy * mdy)
        if (mDist < MOUSE_DIST) {
          const opacity = (1 - mDist / MOUSE_DIST) * (0.25 + t * 0.15)
          ctx!.beginPath()
          ctx!.moveTo(particles[i].x, particles[i].y)
          ctx!.lineTo(mouse.x, mouse.y)
          ctx!.strokeStyle = `rgba(${colorRef.current}, ${opacity})`
          ctx!.lineWidth = 0.5 + t * 0.3
          ctx!.stroke()
        }
      }

      // Draw particles — dots normally, streaking trails during warp
      for (const p of particles) {
        const pdx = p.x - mouse.x
        const pdy = p.y - mouse.y
        const pDist = Math.sqrt(pdx * pdx + pdy * pdy)
        const pCursorFactor = Math.max(0, 1 - pDist / CURSOR_GLOW_RADIUS)
        const alphaMult = baseDotMult + (MAX_DOT_ALPHA_MULT - baseDotMult) * pCursorFactor
        const dotAlpha = Math.min(1, p.alpha * alphaMult)
        const drawR = p.r + t * 2.0

        if (w > 0.05) {
          // ── Warp trail — gradient line shooting outward from center ──
          const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 0.01
          const trailLen = drawR * WARP_TRAIL_MAX * w * Math.min(1, speed / 4)
          // Trail goes opposite to velocity direction
          const tx = p.x - (p.vx / speed) * trailLen
          const ty = p.y - (p.vy / speed) * trailLen
          const grad = ctx!.createLinearGradient(tx, ty, p.x, p.y)
          grad.addColorStop(0, `rgba(${colorRef.current}, 0)`)
          grad.addColorStop(1, `rgba(${colorRef.current}, ${dotAlpha})`)
          ctx!.beginPath()
          ctx!.moveTo(tx, ty)
          ctx!.lineTo(p.x, p.y)
          ctx!.strokeStyle = grad
          ctx!.lineWidth = drawR * (1.2 + w * 0.8)
          ctx!.stroke()
          // Bright head dot
          ctx!.beginPath()
          ctx!.arc(p.x, p.y, drawR * (0.8 + w * 0.6), 0, Math.PI * 2)
          ctx!.fillStyle = `rgba(${colorRef.current}, ${Math.min(1, dotAlpha * 1.3)})`
          ctx!.fill()
        } else {
          // ── Normal dot with optional glow ──
          ctx!.beginPath()
          ctx!.arc(p.x, p.y, drawR, 0, Math.PI * 2)
          ctx!.fillStyle = `rgba(${colorRef.current}, ${dotAlpha})`
          ctx!.fill()

          if (p.r > 2 || pCursorFactor > 0.3 || t > 0.2) {
            const glowRadius = drawR * (3 + pCursorFactor * 2 + t * TURBO_GLOW_RADIUS)
            ctx!.beginPath()
            ctx!.arc(p.x, p.y, glowRadius, 0, Math.PI * 2)
            const g = ctx!.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowRadius)
            g.addColorStop(0, `rgba(${colorRef.current}, ${dotAlpha * (0.3 + t * 0.2)})`)
            g.addColorStop(1, `rgba(${colorRef.current}, 0)`)
            ctx!.fillStyle = g
            ctx!.fill()
          }
        }
      }

      // Update positions
      for (const p of particles) {
        // During turbo: aggressive random jitter — particles dart around chaotically
        if (t > 0.01) {
          const turboForce = t * TURBO_JITTER
          p.vx += (Math.random() - 0.5) * turboForce
          p.vy += (Math.random() - 0.5) * turboForce
          // Occasional burst: 10% chance of extra kick
          if (Math.random() < 0.1) {
            p.vx += (Math.random() - 0.5) * turboForce * 3
            p.vy += (Math.random() - 0.5) * turboForce * 3
          }
        }

        // ── Warp: push particles outward from viewport centre ──
        if (w > 0.01) {
          const cx = W / 2, cy = H / 2
          const odx = p.x - cx, ody = p.y - cy
          const oDist = Math.sqrt(odx * odx + ody * ody) || 1
          // Stronger force the further from centre (parallax depth feel)
          const forceMag = w * WARP_FORCE * (1 + oDist / (W * 0.25))
          p.vx += (odx / oDist) * forceMag
          p.vy += (ody / oDist) * forceMag
        }

        p.x += p.vx
        p.y += p.vy

        // During warp: stars that fly off-screen are reborn near the centre
        if (w > 0.25 && (p.x < -30 || p.x > W + 30 || p.y < -30 || p.y > H + 30)) {
          p.x = W / 2 + (Math.random() - 0.5) * 100
          p.y = H / 2 + (Math.random() - 0.5) * 100
          p.vx = p.baseVx
          p.vy = p.baseVy
        } else if (w <= 0.25) {
          if (p.x < 0 || p.x > W) p.vx *= -1
          if (p.y < 0 || p.y > H) p.vy *= -1
        }

        // Mouse repulsion
        const mdx2 = p.x - mouse.x
        const mdy2 = p.y - mouse.y
        const mDist2 = Math.sqrt(mdx2 * mdx2 + mdy2 * mdy2)
        if (mDist2 < MOUSE_REPEL) {
          p.vx += mdx2 * 0.0002
          p.vy += mdy2 * 0.0002
        }

        // Speed limit (higher during turbo)
        const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
        if (speed > speedLimit) {
          p.vx *= speedLimit / speed
          p.vy *= speedLimit / speed
        }

        // When turbo ends, gently pull velocities back toward base
        if (t < 0.05 && !globalTurbo) {
          p.vx += (p.baseVx - p.vx) * 0.01
          p.vy += (p.baseVy - p.vy) * 0.01
        }
      }

      animRef.current = requestAnimationFrame(draw)
    }

    function onMouseMove(e: MouseEvent) {
      mouseRef.current = { x: e.clientX, y: e.clientY }
    }

    function onMouseLeave() {
      mouseRef.current = { x: -9999, y: -9999 }
    }

    // ── Scroll → warp mode ──
    let scrollTimer: ReturnType<typeof setTimeout>
    function onScroll() {
      warpTargetRef.current = 1
      clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => { warpTargetRef.current = 0 }, 160)
    }

    window.addEventListener('resize', resize)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseleave', onMouseLeave)
    window.addEventListener('scroll', onScroll, { passive: true })

    // Watch for theme changes via class mutations on <html>
    const observer = new MutationObserver(() => {
      colorRef.current = getParticleColor()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    init()
    draw()

    return () => {
      cancelAnimationFrame(animRef.current)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseleave', onMouseLeave)
      window.removeEventListener('scroll', onScroll)
      clearTimeout(scrollTimer)
      observer.disconnect()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-30"
    />
  )
}
