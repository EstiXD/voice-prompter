// Temporizador de grabación: cuenta antes de grabar y duración de la toma.
// Puro (sin React ni DOM) para poder probar los bordes; la interfaz solo pinta
// lo que sale de aquí.

/** Segundos de cuenta antes de grabar. El apagado es otro ajuste (`countdown`). */
export const COUNTDOWN_OPTIONS = [3, 5, 10] as const;
export const DEFAULT_COUNTDOWN_SECS = 3;

/**
 * Tramo final de la cuenta, el de mirar al lente (ahí se calibra la mirada).
 * En las cuentas largas lo anterior es para acomodarse.
 */
export const COUNTDOWN_FOCUS_SECS = 3;

/** Duración de la toma en segundos; 0 = sin límite. */
export const TAKE_LIMIT_OPTIONS = [0, 30, 60, 90, 120, 180, 300, 600] as const;
export const DEFAULT_TAKE_LIMIT = 0;

/** Cuánto antes del final cambia el reloj: primero avisa, luego apura. */
export const TAKE_ENDING_MS = 10_000;
export const TAKE_LAST_MS = 3_000;

// Solo se aceptan los valores de las listas: un número guardado a mano o por
// una versión anterior dejaría el selector sin ninguna opción marcada.
export function sanitizeCountdownSecs(v: unknown): number {
  return (COUNTDOWN_OPTIONS as readonly unknown[]).includes(v) ? (v as number) : DEFAULT_COUNTDOWN_SECS;
}

export function sanitizeTakeLimit(v: unknown): number {
  return (TAKE_LIMIT_OPTIONS as readonly unknown[]).includes(v) ? (v as number) : DEFAULT_TAKE_LIMIT;
}

/** "Sin límite", "0:30", "1:00", "10:00". */
export function formatLimit(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "Sin límite";
  const total = Math.floor(secs);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export type TakePhase =
  /** sin límite: el reloj solo cuenta */
  | "none"
  | "running"
  /** quedan 10 s o menos */
  | "ending"
  /** quedan 3 s o menos */
  | "last"
  /** se pasó del tiempo (solo ocurre si al cumplirse no se detiene) */
  | "over";

export type TakeClock = {
  /** lo que falta; `Infinity` sin límite, 0 al cumplirse o pasarse */
  remainingMs: number;
  /** 0–1 del tiempo consumido; 0 sin límite */
  progress: number;
  phase: TakePhase;
};

/** Estado del reloj de la toma a partir de lo grabado (sin contar las pausas). */
export function takeClock(elapsedMs: number, limitSecs: number): TakeClock {
  if (!Number.isFinite(limitSecs) || limitSecs <= 0) return { remainingMs: Infinity, progress: 0, phase: "none" };
  const limitMs = limitSecs * 1000;
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const remainingMs = Math.max(0, limitMs - elapsed);
  const progress = Math.min(1, elapsed / limitMs);
  // Justo en el límite ya es "pasado": con parada automática la toma se corta
  // en ese instante, y sin ella el reloj no debe volver a un tono de aviso.
  const phase: TakePhase = remainingMs <= 0 ? "over" : remainingMs <= TAKE_LAST_MS ? "last" : remainingMs <= TAKE_ENDING_MS ? "ending" : "running";
  return { remainingMs, progress, phase };
}
