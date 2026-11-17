export interface CardState { ease: number; interval: number; reps: number }
export interface Scheduled extends CardState { due: number }
const DAY = 86_400_000;
/** SM-2 spaced repetition. quality: 0 (blackout) … 5 (perfect). Failed cards return in 10 minutes. */
export function nextReview(c: CardState, quality: number, now = Date.now()): Scheduled {
  const q = Math.max(0, Math.min(5, Math.round(quality)));
  let { ease, interval, reps } = c;
  if (q < 3) return { ease: Math.max(1.3, ease - 0.2), interval: 0, reps: 0, due: now + 10 * 60_000 };
  reps += 1;
  interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(interval * ease);
  ease = Math.max(1.3, ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  return { ease: Math.round(ease * 100) / 100, interval, reps, due: now + interval * DAY };
}
