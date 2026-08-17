export type LangOption = { code: string; label: string };

export const LANGS: LangOption[] = [
  { code: "es-MX", label: "Español (México)" },
  { code: "es-CO", label: "Español (Colombia)" },
  { code: "es-ES", label: "Español (España)" },
  { code: "es-AR", label: "Español (Argentina)" },
  { code: "es-US", label: "Español (EE. UU.)" },
  { code: "en-US", label: "English (US)" },
  { code: "pt-BR", label: "Português (Brasil)" },
];

export const DEFAULT_LANG = "es-MX";
