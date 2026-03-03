'use client'

import { useEffect, useRef } from 'react'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  alpha: number
}

const PARTICLE_COUNT = 80
const MAX_DIST = 160
const MOUSE_DIST = 200
const MOUSE_REPEL = 120

// ── Cursor proximity settings ──
// When cursor is within CURSOR_GLOW_RADIUS of a connection line midpoint,
// the connection brightens from its base opacity up to the boosted opacity.
const CURSOR_GLOW_RADIUS = 250
const BASE_LINE_OPACITY = 0.08     // default connection opacity (subtle)
const MAX_LINE_OPACITY = 0.35      // connection opacity directly under cursor
const BASE_DOT_ALPHA_MULT = 0.7    // dim particles slightly at rest
const MAX_DOT_ALPHA_MULT = 1.4     // brighten particles near cursor

function getParticleColor(): string {
  if (typeof document === 'undefined') return '232, 220, 196'
  return getComputedStyle(document.documentElement).getPropertyValue('--particle-color').trim() || '232, 220, 196'
}

export default function ParticleNetwork() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mouseRef = useRef({ x: -9999, y: -9999 })
  const particlesRef = useRef<Particle[]>([])
  const animRef = useRef<number>(0)
  const colorRef = useRef(getParticleColor())

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
      return {
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
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

      // Draw connections between particles — brightness depends on cursor proximity
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x
          const dy = particles[i].y - particles[j].y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < MAX_DIST) {
            // Base factor: closer particles = more visible
            const distFactor = 1 - dist / MAX_DIST

            // Cursor proximity: measure distance from cursor to midpoint of this line
            const midX = (particles[i].x + particles[j].x) / 2
            const midY = (particles[i].y + particles[j].y) / 2
            const cmDx = midX - mouse.x
            const cmDy = midY - mouse.y
            const cursorDist = Math.sqrt(cmDx * cmDx + cmDy * cmDy)
            const cursorFactor = Math.max(0, 1 - cursorDist / CURSOR_GLOW_RADIUS)

            // Blend: base subtle opacity + cursor boost
            const opacity = distFactor * (BASE_LINE_OPACITY + (MAX_LINE_OPACITY - BASE_LINE_OPACITY) * cursorFactor * cursorFactor)

            ctx!.beginPath()
            ctx!.moveTo(particles[i].x, particles[i].y)
            ctx!.lineTo(particles[j].x, particles[j].y)
            ctx!.strokeStyle = `rgba(${colorRef.current}, ${opacity})`
            ctx!.lineWidth = 0.5 + cursorFactor * 0.5
            ctx!.stroke()
          }
        }

        // Mouse interaction lines (cursor → particle)
        const mdx = particles[i].x - mouse.x
        const mdy = particles[i].y - mouse.y
        const mDist = Math.sqrt(mdx * mdx + mdy * mdy)
        if (mDist < MOUSE_DIST) {
          const opacity = (1 - mDist / MOUSE_DIST) * 0.25
          ctx!.beginPath()
          ctx!.moveTo(particles[i].x, particles[i].y)
          ctx!.lineTo(mouse.x, mouse.y)
          ctx!.strokeStyle = `rgba(${colorRef.current}, ${opacity})`
          ctx!.lineWidth = 0.5
          ctx!.stroke()
        }
      }

      // Draw particles with glow — also brighten near cursor
      for (const p of particles) {
        const pdx = p.x - mouse.x
        const pdy = p.y - mouse.y
        const pDist = Math.sqrt(pdx * pdx + pdy * pdy)
        const pCursorFactor = Math.max(0, 1 - pDist / CURSOR_GLOW_RADIUS)
        const alphaMult = BASE_DOT_ALPHA_MULT + (MAX_DOT_ALPHA_MULT - BASE_DOT_ALPHA_MULT) * pCursorFactor
        const dotAlpha = Math.min(1, p.alpha * alphaMult)

        ctx!.beginPath()
        ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx!.fillStyle = `rgba(${colorRef.current}, ${dotAlpha})`
        ctx!.fill()

        // Glow halo for larger particles
        if (p.r > 2 || pCursorFactor > 0.3) {
          const glowRadius = p.r * (3 + pCursorFactor * 2)
          ctx!.beginPath()
          ctx!.arc(p.x, p.y, glowRadius, 0, Math.PI * 2)
          const g = ctx!.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowRadius)
          g.addColorStop(0, `rgba(${colorRef.current}, ${dotAlpha * 0.3})`)
          g.addColorStop(1, `rgba(${colorRef.current}, 0)`)
          ctx!.fillStyle = g
          ctx!.fill()
        }
      }

      // Update positions
      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy

        if (p.x < 0 || p.x > W) p.vx *= -1
        if (p.y < 0 || p.y > H) p.vy *= -1

        // Mouse repulsion
        const mdx2 = p.x - mouse.x
        const mdy2 = p.y - mouse.y
        const mDist2 = Math.sqrt(mdx2 * mdx2 + mdy2 * mdy2)
        if (mDist2 < MOUSE_REPEL) {
          p.vx += mdx2 * 0.0002
          p.vy += mdy2 * 0.0002
        }

        // Speed limit
        const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
        if (speed > 0.8) {
          p.vx *= 0.8 / speed
          p.vy *= 0.8 / speed
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

    window.addEventListener('resize', resize)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseleave', onMouseLeave)

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
      observer.disconnect()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-0"
    />
  )
}
