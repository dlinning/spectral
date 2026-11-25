import React from 'react';

export type TunerStatus = 'idle' | 'in-tune' | 'sharp' | 'flat';

interface TunerNeedleProps {
  cents: number;
  hasNote: boolean;
  status: TunerStatus;
}

const TICK_CENTS = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50] as const;
const CX = 180;
const CY = 155;
const NEEDLE_RADIUS = 122;

export const TunerNeedle: React.FC<TunerNeedleProps> = ({ cents, hasNote, status }) => {
  const clampedCents = Math.max(-50, Math.min(50, cents));
  const angleDeg = (clampedCents / 50) * 52;

  const needleColor = !hasNote
    ? '#475569'
    : status === 'in-tune'
      ? '#10b981'
      : status === 'sharp'
        ? '#f59e0b'
        : '#22d3ee';

  return (
    <svg viewBox="0 0 360 175" className="tuner-needle-svg" aria-label="Cents Needle Meter">
      {/* Outer scale arc */}
      <path
        d="M 48 110 A 136 136 0 0 1 312 110"
        fill="none"
        stroke="rgba(148,163,184,0.22)"
        strokeWidth="10"
        strokeLinecap="round"
      />
      {/* Center green in-tune arc */}
      <path
        d="M 168 20 A 136 136 0 0 1 192 20"
        fill="none"
        stroke="#10b981"
        strokeWidth="10"
        strokeLinecap="round"
      />

      {TICK_CENTS.map((c) => {
        const a = (((c / 50) * 52 - 90) * Math.PI) / 180;
        const r1 = c % 25 === 0 || c === 0 ? 114 : 120;
        const r2 = 132;
        return (
          <g key={c}>
            <line
              x1={CX + Math.cos(a) * r1}
              y1={CY + Math.sin(a) * r1}
              x2={CX + Math.cos(a) * r2}
              y2={CY + Math.sin(a) * r2}
              stroke={c === 0 ? '#10b981' : '#64748b'}
              strokeWidth={c === 0 ? 3 : 1.5}
            />
            {c % 25 === 0 && (
              <text
                x={CX + Math.cos(a) * 147}
                y={CY + Math.sin(a) * 147}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#94a3b8"
                fontSize="10"
                fontFamily="JetBrains Mono, monospace"
              >
                {c > 0 ? `+${c}` : c}
              </text>
            )}
          </g>
        );
      })}

      <line
        x1={CX}
        y1={CY}
        x2={CX}
        y2={CY - NEEDLE_RADIUS}
        style={{
          transform: `rotate(${hasNote ? angleDeg : 0}deg)`,
          transformOrigin: `${CX}px ${CY}px`,
          transition: 'transform 110ms ease-out',
        }}
        stroke={needleColor}
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <circle cx={CX} cy={CY} r="7" fill="#e2e8f0" />
    </svg>
  );
};
