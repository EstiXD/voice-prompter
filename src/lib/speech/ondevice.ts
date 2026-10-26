// Reconocimiento en el dispositivo (Chrome/Edge 139+): el modelo de voz corre
// en la máquina, sin ida y vuelta a la nube, y los interinos llegan antes.
// Requiere descargar el paquete del idioma una vez (install()).

import { getSpeechRecognitionCtor } from "./support";

export type OnDeviceState = "unsupported" | "unavailable" | "downloadable" | "downloading" | "available";

type Static = {
  available?: (o: { langs: string[]; processLocally?: boolean }) => Promise<string>;
  install?: (o: { langs: string[]; processLocally?: boolean }) => Promise<boolean>;
};

function ctorStatic(): Static | null {
  const ctor = getSpeechRecognitionCtor() as unknown as Static | null;
  return ctor && typeof ctor.available === "function" ? ctor : null;
}

export async function onDeviceState(lang: string): Promise<OnDeviceState> {
  const c = ctorStatic();
  if (!c?.available) return "unsupported";
  try {
    const r = await c.available({ langs: [lang], processLocally: true });
    return r === "available" || r === "downloadable" || r === "downloading" || r === "unavailable" ? r : "unavailable";
  } catch {
    return "unsupported";
  }
}

/** Descarga el paquete del idioma. Debe llamarse desde un gesto del usuario. */
export async function installOnDevice(lang: string): Promise<boolean> {
  const c = ctorStatic();
  if (!c?.install) return false;
  try {
    return await c.install({ langs: [lang], processLocally: true });
  } catch {
    return false;
  }
}
