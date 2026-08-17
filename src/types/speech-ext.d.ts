// Extensiones experimentales de la Web Speech API (Chrome 139+) que
// @types/dom-speech-recognition aún no trae. Todo se usa con feature-detect.

interface SpeechRecognitionPhrase {
  readonly phrase: string;
  readonly boost: number;
}

// eslint-disable-next-line no-var -- declaración global ambiente (debe ser var)
declare var SpeechRecognitionPhrase: {
  prototype: SpeechRecognitionPhrase;
  new (phrase: string, boost?: number): SpeechRecognitionPhrase;
};

interface SpeechRecognition {
  /** sesgo contextual: palabras que el reconocedor debe favorecer */
  phrases?: SpeechRecognitionPhrase[];
  /** exige reconocimiento en el dispositivo (sin nube) */
  processLocally?: boolean;
}

interface SpeechRecognitionAvailabilityOptions {
  langs: string[];
  processLocally?: boolean;
}

interface SpeechRecognitionStatic {
  available?(options: SpeechRecognitionAvailabilityOptions): Promise<"unavailable" | "downloadable" | "downloading" | "available">;
  install?(options: SpeechRecognitionAvailabilityOptions): Promise<boolean>;
}
