'use client'

import { useEffect, useState } from 'react'
import { EASTEREGG_EVENT } from './hooks'

// One-shot celebration overlay. Listens for the activation event and shows
// confetti + a centered toast for ~4s, then unmounts. CSS-only — no deps.
export function EasterEggCelebration() {
  const [active, setActive] = useState(false)

  useEffect(() => {
    const onActivate = () => {
      setActive(true)
      window.setTimeout(() => setActive(false), 4200)
    }
    window.addEventListener(EASTEREGG_EVENT, onActivate)
    return () => window.removeEventListener(EASTEREGG_EVENT, onActivate)
  }, [])

  if (!active) return null

  // Generate 40 confetti pieces with staggered delays + randomized x/rotation.
  const pieces = Array.from({ length: 40 }, (_, i) => i)

  return (
    <div className="egg-celebration" role="status" aria-live="polite">
      <div className="egg-confetti">
        {pieces.map((i) => {
          const left = Math.random() * 100
          const delay = Math.random() * 0.6
          const dur = 2.4 + Math.random() * 1.6
          const rotEnd = (Math.random() * 720 - 360) | 0
          const drift = (Math.random() * 200 - 100) | 0
          const palette = ['var(--amp-accent)', '#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#f78c6b']
          const color = palette[i % palette.length]
          return (
            <span
              key={i}
              className="egg-piece"
              style={{
                left: `${left}%`,
                background: color,
                animationDelay: `${delay}s`,
                animationDuration: `${dur}s`,
                ['--rot-end' as string]: `${rotEnd}deg`,
                ['--drift' as string]: `${drift}px`,
              }}
            />
          )
        })}
      </div>
      <div className="egg-toast">
        <span className="egg-toast-spark">✦</span>
        <span>
          <strong>Easter egg unlocked.</strong>
          <br />
          <span className="muted">Hidden features are now visible.</span>
        </span>
        <span className="egg-toast-spark">✦</span>
      </div>
    </div>
  )
}
