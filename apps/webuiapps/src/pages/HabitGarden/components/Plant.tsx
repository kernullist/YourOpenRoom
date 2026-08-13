import type { PlantStage, Vitality } from '../garden';
import styles from './Plant.module.scss';

interface PlantProps {
  stage: PlantStage;
  vitality: Vitality;
  color: string;
  doneToday: boolean;
  size?: number;
}

// Inline SVG rather than image assets.
//
// 5 stages x 3 vitalities would be 15 files that still could not take the
// habit's colour. Drawing it means `currentColor` carries the user's palette
// choice through every stage for free, and wilting is a transform rather than a
// separate artwork.

const VITALITY_TILT: Record<Vitality, number> = {
  thriving: 0,
  ok: -4,
  // A wilting plant leans and shrinks slightly. It is never removed or greyed to
  // a corpse -- a dead plant reads as punishment, and punished users delete the app.
  wilting: -12,
};

const VITALITY_OPACITY: Record<Vitality, number> = {
  thriving: 1,
  ok: 0.85,
  wilting: 0.62,
};

function Leaves({ stage }: { stage: PlantStage }): JSX.Element | null {
  if (stage === 'seed') {
    return null;
  }
  return (
    <>
      <path
        d="M32 44 C22 42, 17 34, 18 27 C26 27, 32 33, 32 41 Z"
        fill="currentColor"
        opacity="0.75"
      />
      {stage !== 'sprout' ? (
        <path
          d="M32 38 C42 36, 47 28, 46 21 C38 21, 32 27, 32 35 Z"
          fill="currentColor"
          opacity="0.6"
        />
      ) : null}
      {stage === 'bud' || stage === 'bloom' ? (
        <path
          d="M32 30 C24 28, 20 21, 21 15 C28 15, 32 20, 32 27 Z"
          fill="currentColor"
          opacity="0.45"
        />
      ) : null}
    </>
  );
}

function Crown({ stage }: { stage: PlantStage }): JSX.Element | null {
  if (stage === 'bud') {
    return <ellipse cx="32" cy="14" rx="6" ry="8" fill="currentColor" opacity="0.9" />;
  }
  if (stage === 'bloom') {
    return (
      <g>
        {[0, 72, 144, 216, 288].map((angle) => (
          <ellipse
            key={angle}
            cx="32"
            cy="7"
            rx="4.5"
            ry="7"
            fill="currentColor"
            opacity="0.9"
            transform={`rotate(${angle} 32 14)`}
          />
        ))}
        <circle cx="32" cy="14" r="3.6" fill="var(--bg-1)" opacity="0.85" />
      </g>
    );
  }
  return null;
}

const STEM_TOP: Record<PlantStage, number> = {
  seed: 48,
  sprout: 36,
  leaf: 28,
  bud: 22,
  bloom: 20,
};

export function Plant({ stage, vitality, color, doneToday, size = 88 }: PlantProps): JSX.Element {
  const tilt = VITALITY_TILT[vitality];

  return (
    <svg
      className={styles.plant}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={`${stage} / ${vitality}`}
      data-stage={stage}
      data-vitality={vitality}
      data-done={doneToday ? 'true' : undefined}
      style={{ color, opacity: VITALITY_OPACITY[vitality] }}
    >
      {/* Soil line stays put regardless of stage, so growth reads as upward motion. */}
      <ellipse cx="32" cy="54" rx="17" ry="4.5" fill="var(--fill-white-10)" />

      {stage === 'seed' ? (
        <ellipse cx="32" cy="50" rx="5" ry="4" fill="currentColor" opacity="0.7" />
      ) : (
        <g transform={`rotate(${tilt} 32 52)`}>
          <path
            d={`M32 52 L32 ${STEM_TOP[stage]}`}
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            fill="none"
            opacity="0.85"
          />
          <Leaves stage={stage} />
          <Crown stage={stage} />
        </g>
      )}

      {doneToday ? (
        // A small mark for "done today", separate from growth: the stage is a
        // slow signal and the user needs a fast one in the same frame as the click.
        <circle cx="52" cy="12" r="5" fill="currentColor" className={styles.doneDot} />
      ) : null}
    </svg>
  );
}

export default Plant;
