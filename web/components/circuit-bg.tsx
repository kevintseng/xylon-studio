'use client'

/**
 * Animated circuit board background with signal dots moving along traces.
 *
 * Layers:
 *  1. Static SVG circuit pattern (tiled)
 *  2. Overlay SVG with animated signal dots traveling along circuit paths
 *  3. Slow gradient sweep
 */
export function CircuitBackground() {
  // Define circuit trace paths that span across the viewport
  // Each path is an SVG path string (horizontal/vertical lines with right-angle turns)
  const traces = [
    {
      // Top-left: horizontal right, down, right
      d: 'M -20 80 H 180 V 160 H 350 V 240 H 500',
      dur: '6s',
      delay: '0s',
    },
    {
      // Mid-left: down, right, down, right
      d: 'M 100 -20 V 120 H 300 V 280 H 520 V 400',
      dur: '7s',
      delay: '1s',
    },
    {
      // Top-right area: left, down, left
      d: 'M 1520 100 H 1200 V 220 H 950 V 380 H 780',
      dur: '8s',
      delay: '0.5s',
    },
    {
      // Bottom-left: right, up, right
      d: 'M -20 600 H 150 V 450 H 380 V 350 H 550',
      dur: '6.5s',
      delay: '2s',
    },
    {
      // Center: complex route
      d: 'M 400 -20 V 100 H 650 V 250 H 850 V 400 H 1000',
      dur: '7.5s',
      delay: '1.5s',
    },
    {
      // Bottom-right: left, up
      d: 'M 1520 500 H 1300 V 350 H 1100 V 200 H 900',
      dur: '7s',
      delay: '3s',
    },
  ]

  return (
    <>
      {/* Layer 1: Static circuit pattern */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-[0.07]">
        <svg
          className="absolute inset-0 w-full h-full"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <pattern
              id="circuit-pattern"
              x="0"
              y="0"
              width="120"
              height="120"
              patternUnits="userSpaceOnUse"
            >
              <line x1="0" y1="30" x2="50" y2="30" stroke="currentColor" strokeWidth="1" />
              <line x1="70" y1="30" x2="120" y2="30" stroke="currentColor" strokeWidth="1" />
              <line x1="20" y1="90" x2="100" y2="90" stroke="currentColor" strokeWidth="1" />
              <line x1="50" y1="0" x2="50" y2="30" stroke="currentColor" strokeWidth="1" />
              <line x1="70" y1="30" x2="70" y2="60" stroke="currentColor" strokeWidth="1" />
              <line x1="20" y1="60" x2="20" y2="90" stroke="currentColor" strokeWidth="1" />
              <line x1="100" y1="90" x2="100" y2="120" stroke="currentColor" strokeWidth="1" />
              <circle cx="50" cy="30" r="3" fill="currentColor" />
              <circle cx="70" cy="30" r="3" fill="currentColor" />
              <circle cx="20" cy="90" r="3" fill="currentColor" />
              <circle cx="100" cy="90" r="3" fill="currentColor" />
              <circle cx="70" cy="60" r="2" fill="currentColor" />
              <circle cx="20" cy="60" r="2" fill="currentColor" />
              <rect x="35" y="55" width="30" height="20" rx="2" stroke="currentColor" strokeWidth="1" fill="none" />
              <line x1="40" y1="55" x2="40" y2="48" stroke="currentColor" strokeWidth="0.8" />
              <line x1="50" y1="55" x2="50" y2="48" stroke="currentColor" strokeWidth="0.8" />
              <line x1="60" y1="55" x2="60" y2="48" stroke="currentColor" strokeWidth="0.8" />
              <line x1="40" y1="75" x2="40" y2="82" stroke="currentColor" strokeWidth="0.8" />
              <line x1="50" y1="75" x2="50" y2="82" stroke="currentColor" strokeWidth="0.8" />
              <line x1="60" y1="75" x2="60" y2="82" stroke="currentColor" strokeWidth="0.8" />
              <polyline points="0,60 10,60 10,90 20,90" fill="none" stroke="currentColor" strokeWidth="1" />
              <polyline points="100,90 100,110 110,110 110,120" fill="none" stroke="currentColor" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#circuit-pattern)" />
        </svg>
      </div>

      {/* Layer 2: Animated signal dots traveling along circuit traces */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <svg
          className="absolute inset-0 w-full h-full"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 1500 800"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            {/* Glow filter for signal dots */}
            <filter id="signal-glow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {traces.map((trace, i) => (
            <g key={i}>
              {/* Faint trace path (barely visible guide line) */}
              <path
                d={trace.d}
                fill="none"
                stroke="rgba(96,165,250,0.06)"
                strokeWidth="1"
              />
              {/* Moving signal dot with glow */}
              <circle r="3" fill="#60a5fa" opacity="0.7" filter="url(#signal-glow)">
                <animateMotion
                  dur={trace.dur}
                  begin={trace.delay}
                  repeatCount="indefinite"
                  path={trace.d}
                />
              </circle>
              {/* Trailing dot (slightly behind, dimmer) */}
              <circle r="2" fill="#60a5fa" opacity="0.3">
                <animateMotion
                  dur={trace.dur}
                  begin={trace.delay}
                  repeatCount="indefinite"
                  path={trace.d}
                  keyPoints="0;0.97"
                  keyTimes="0;1"
                />
              </circle>
            </g>
          ))}
        </svg>
      </div>

      {/* Layer 3: Slow gradient sweep */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="absolute -inset-1/4 animate-circuit-sweep"
          style={{
            background: 'radial-gradient(ellipse 800px 500px at center, rgba(59,130,246,0.06), transparent)',
          }}
        />
      </div>
    </>
  )
}
