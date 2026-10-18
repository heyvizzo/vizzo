// The URL of the browser pane (left of the chat in the Electron app). The app's main process sends it whenever the
// page changes; every turn's context includes it, so the model knows which page the user is looking at.
let url: string | null = null;

export function setBrowserUrl(next: string | null): void {
  url = next || null;
}

export function browserUrl(): string | null {
  return url;
}
