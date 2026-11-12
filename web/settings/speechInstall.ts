import type { InstallState } from "../../shared/protocol.ts";

interface InstallResponse {
  installs: InstallState[];
  error?: string;
  missingDependency?: "uv";
}

/** Ask only when the server detects missing uv. Cancelling never queues an install. */
export async function requestSpeechInstall(
  request: { kind: string; engine: string; action: string },
  modelName: string,
  confirmInstall: (message: string) => boolean = (message) => confirm(message),
): Promise<InstallResponse | null> {
  const send = async (installUv = false): Promise<InstallResponse> => {
    const response = await fetch("/api/speech/install", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, ...(installUv ? { installUv: true } : {}) }),
    });
    return response.json() as Promise<InstallResponse>;
  };
  const result = await send();
  if (request.action !== "install" || result.missingDependency !== "uv") return result;
  if (!confirmInstall(`Install uv to continue?\n\n${modelName} needs uv to set up Python. Vizzo can download and install uv from astral.sh into ~/.local/bin, then continue installing the model.\n\nChoose OK to install automatically, or Cancel to stop.`)) return null;
  return send(true);
}
