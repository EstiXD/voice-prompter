// Predicción del cursor entre resultados del reconocedor. Puro: sin DOM.
//
// Web Speech entrega texto con 0,3–0,8 s de retraso y a trompicones. Mientras
// el detector de voz dice que sigues hablando, el cursor avanza a tu ritmo
// medido (unidades/s) y se corrige en cuanto llega el texto real. Nunca se
// adelanta más de MAX_LEAD unidades a lo confirmado por el reconocedor, se
// detiene en silencio y deja de adivinar si el reconocedor lleva un rato
// sin avanzar (improvisas o te saliste del guion).

export const PREDICT = {
  /** unidades que la predicción puede ir por delante del reconocedor */
  MAX_LEAD: 2,
  /** ritmo inicial: ~145 palabras por minuto */
  DEFAULT_RATE: 2.4,
  MIN_RATE: 1.2,
  MAX_RATE: 4.5,
  /** peso de la medida nueva en el promedio del ritmo */
  RATE_ALPHA: 0.3,
  /** sin avance real durante este tiempo hablando → dejar de predecir */
  STALE_MS: 1400,
  /** retrocesos menores que esto se tratan como ruido del reconocedor */
  NOISE_BACK: 3,
} as const;

export class CursorPredictor {
  private real = -1;
  private realAt = 0;
  private pos = -1;
  private rate: number = PREDICT.DEFAULT_RATE;
  private speakingMs = 0;
  private lastTick = 0;
  private limit = Number.POSITIVE_INFINITY;

  /** última unidad del guion (no predecir más allá) */
  setLimit(lastUnit: number): void {
    this.limit = lastUnit;
  }

  /** cursor puesto a mano o guion nuevo: sin inercia */
  reset(unit: number, now: number): void {
    this.real = unit;
    this.pos = unit;
    this.realAt = now;
    this.speakingMs = 0;
    this.lastTick = now;
  }

  get currentRate(): number {
    return this.rate;
  }

  /** El reconocedor movió el cursor a `unit`. Devuelve la unidad a mostrar. */
  onReal(unit: number, now: number): number {
    if (unit > this.real) {
      const advanced = unit - this.real;
      // ritmo = unidades avanzadas / tiempo hablando desde el último avance
      if (this.real >= 0 && this.speakingMs > 200 && advanced <= 8) {
        const inst = advanced / (this.speakingMs / 1000);
        const clamped = Math.min(PREDICT.MAX_RATE, Math.max(PREDICT.MIN_RATE, inst));
        this.rate = this.rate * (1 - PREDICT.RATE_ALPHA) + clamped * PREDICT.RATE_ALPHA;
      }
      this.real = unit;
      this.realAt = now;
      this.speakingMs = 0;
    } else if (this.real - unit >= PREDICT.NOISE_BACK) {
      // salto real hacia atrás (repetiste una frase): seguirlo
      this.reset(unit, now);
      return this.display();
    }
    if (this.pos < this.real) this.pos = this.real;
    if (this.pos > this.real + PREDICT.MAX_LEAD) this.pos = this.real + PREDICT.MAX_LEAD;
    return this.display();
  }

  /** Avanza la predicción. `voice` = el detector oye voz ahora. */
  tick(now: number, voice: boolean): number {
    const dt = this.lastTick ? Math.min(100, Math.max(0, now - this.lastTick)) : 0;
    this.lastTick = now;
    if (!voice) return this.display();
    this.speakingMs += dt;
    if (this.real < 0) return this.display();
    if (now - this.realAt > PREDICT.STALE_MS) return this.display();
    const cap = Math.min(this.real + PREDICT.MAX_LEAD, this.limit);
    this.pos = Math.min(cap, this.pos + (this.rate * dt) / 1000);
    return this.display();
  }

  display(): number {
    return Math.floor(this.pos + 1e-6);
  }
}
