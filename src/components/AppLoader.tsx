"use client";

import dynamic from "next/dynamic";

// La app vive solo en el cliente: micrófono, Web Speech, localStorage.
const PrompterApp = dynamic(() => import("./PrompterApp").then((m) => m.PrompterApp), {
  ssr: false,
  loading: () => (
    <div className="grid h-dvh place-items-center" aria-busy="true">
      <span className="wordmark text-2xl text-paper-mute">Voice Prompter</span>
    </div>
  ),
});

export function AppLoader() {
  return <PrompterApp />;
}
