import React from 'react';
import { DB_SPL_MAX, DB_SPL_MIN, dbToAngleDeg } from './decibelsMetrics';

interface DecibelsNeedleProps {
  currentDb: number | null;
  peakDb: number | null;
  minDb: number | null;
}

const TICK_DBS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120] as const;
const CX = 180;
const CY = 164;
const ARC_RADIUS = 132;
const NEEDLE_RADIUS = 120;
const MAX_ANGLE_DEG = 80;

function polarPoint(angleDeg: number, radius: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: CX + Math.cos(rad) * radius,
    y: CY + Math.sin(rad) * radius,
  };
}

function describeArc(startDeg: number, endDeg: number, radius: number): string {
  const start = polarPoint(startDeg, radius);
  const end = polarPoint(endDeg, radius);
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 0 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function getNeedleColor(dbSpl: number | null): string {
  if (dbSpl === null) return '#475569';
  if (dbSpl >= 100) return '#f43f5e';
  if (dbSpl >= 80) return '#f59e0b';
  if (dbSpl >= 40) return '#10b981';
  return '#22d3ee';
}

export const DecibelsNeedle: React.FC<DecibelsNeedleProps> = ({ currentDb, peakDb, minDb }) => {
  const currentAngle =
    currentDb !== null
      ? dbToAngleDeg(currentDb, DB_SPL_MIN, DB_SPL_MAX, MAX_ANGLE_DEG)
      : -MAX_ANGLE_DEG;
  const peakAngle =
    peakDb !== null ? dbToAngleDeg(peakDb, DB_SPL_MIN, DB_SPL_MAX, MAX_ANGLE_DEG) : null;
  const minAngle =
    minDb !== null ? dbToAngleDeg(minDb, DB_SPL_MIN, DB_SPL_MAX, MAX_ANGLE_DEG) : null;

  const currentTip = polarPoint(currentAngle, NEEDLE_RADIUS);
  const minInner = minAngle !== null ? polarPoint(minAngle, 86) : null;
  const minOuter = minAngle !== null ? polarPoint(minAngle, ARC_RADIUS + 3) : null;
  const minDot = minAngle !== null ? polarPoint(minAngle, ARC_RADIUS) : null;

  const peakInner = peakAngle !== null ? polarPoint(peakAngle, 86) : null;
  const peakOuter = peakAngle !== null ? polarPoint(peakAngle, ARC_RADIUS + 3) : null;
  const peakTriTip = peakAngle !== null ? polarPoint(peakAngle, ARC_RADIUS - 6) : null;
  const peakTriLeft = peakAngle !== null ? polarPoint(peakAngle - 2.2, ARC_RADIUS + 3) : null;
  const peakTriRight = peakAngle !== null ? polarPoint(peakAngle + 2.2, ARC_RADIUS + 3) : null;

  const hotStartAngle = dbToAngleDeg(90, DB_SPL_MIN, DB_SPL_MAX, MAX_ANGLE_DEG);
  const needleColor = getNeedleColor(currentDb);

  return (
    <div className="decibels-needle-wrap">
      <svg viewBox="0 0 360 184" className="decibels-needle-svg" aria-label="Decibels Needle Meter">
        {/* Base scale arc */}
        <path
          d={describeArc(-MAX_ANGLE_DEG, MAX_ANGLE_DEG, ARC_RADIUS)}
          fill="none"
          stroke="rgba(148,163,184,0.2)"
          strokeWidth="10"
          strokeLinecap="round"
        />

        {/* High-level zone arc (90 to 120 dB SPL) */}
        <path
          d={describeArc(hotStartAngle, MAX_ANGLE_DEG, ARC_RADIUS)}
          fill="none"
          stroke="rgba(244,63,94,0.35)"
          strokeWidth="10"
          strokeLinecap="round"
        />

        {/* Observed Min..Peak span arc */}
        {minAngle !== null && peakAngle !== null && peakAngle - minAngle > 0.5 && (
          <path
            d={describeArc(minAngle, peakAngle, ARC_RADIUS)}
            fill="none"
            stroke="rgba(34,211,238,0.45)"
            strokeWidth="6"
            strokeLinecap="round"
          />
        )}

        {/* Scale ticks & labels */}
        {TICK_DBS.map((db) => {
          const deg = dbToAngleDeg(db, DB_SPL_MIN, DB_SPL_MAX, MAX_ANGLE_DEG);
          const isMajor = db % 20 === 0;
          const p1 = polarPoint(deg, isMajor ? 114 : 120);
          const p2 = polarPoint(deg, 130);
          const labelPt = polarPoint(deg, 149);
          return (
            <g key={db}>
              <line
                x1={p1.x}
                y1={p1.y}
                x2={p2.x}
                y2={p2.y}
                stroke={db >= 90 ? '#f43f5e' : isMajor ? '#94a3b8' : '#475569'}
                strokeWidth={isMajor ? 2 : 1.2}
              />
              {isMajor && (
                <text
                  x={labelPt.x}
                  y={labelPt.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="#94a3b8"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {db}
                </text>
              )}
            </g>
          );
        })}

        {/* Min marker needle/indicator */}
        {minInner && minOuter && minDot && (
          <g data-testid="decibels-needle-min" data-angle={minAngle?.toFixed(2)}>
            <line
              x1={minInner.x}
              y1={minInner.y}
              x2={minOuter.x}
              y2={minOuter.y}
              stroke="#38bdf8"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeDasharray="3 3"
            />
            <circle
              cx={minDot.x}
              cy={minDot.y}
              r="4"
              fill="#38bdf8"
              stroke="#060a12"
              strokeWidth="1.2"
            />
          </g>
        )}

        {/* Peak marker needle/indicator */}
        {peakInner && peakOuter && peakTriTip && peakTriLeft && peakTriRight && (
          <g data-testid="decibels-needle-peak" data-angle={peakAngle?.toFixed(2)}>
            <line
              x1={peakInner.x}
              y1={peakInner.y}
              x2={peakOuter.x}
              y2={peakOuter.y}
              stroke="#f59e0b"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            <polygon
              points={`${peakTriTip.x.toFixed(2)},${peakTriTip.y.toFixed(2)} ${peakTriLeft.x.toFixed(2)},${peakTriLeft.y.toFixed(2)} ${peakTriRight.x.toFixed(2)},${peakTriRight.y.toFixed(2)}`}
              fill="#f59e0b"
            />
          </g>
        )}

        {/* Current level primary needle */}
        <line
          data-testid="decibels-needle-current"
          data-angle={currentAngle.toFixed(2)}
          x1={CX}
          y1={CY}
          x2={currentTip.x}
          y2={currentTip.y}
          stroke={needleColor}
          strokeWidth="3.5"
          strokeLinecap="round"
        />
        <circle cx={CX} cy={CY} r="7" fill="#e2e8f0" />
      </svg>

      <div className="decibels-needle-legend" aria-hidden="true">
        <span className="legend-item">
          <span className="legend-dot legend-dot-min" /> Min
        </span>
        <span className="legend-item">
          <span className="legend-dot legend-dot-current" /> Current
        </span>
        <span className="legend-item">
          <span className="legend-dot legend-dot-peak" /> Peak
        </span>
      </div>
    </div>
  );
};
