import { desktopSettingsPath } from "../electron/settings.ts";
import { instructionSnapshot, readInstructions } from "../electron/instructions.ts";
import { projectDir } from "./project.ts";

/** Read at dispatch so even an existing conversation uses the latest saved instructions. */
export function solverInstructions(folder = projectDir()): { label: string; text: string }[] {
  const saved = instructionSnapshot(readInstructions(process.env.VIZZO_SETTINGS_FILE ?? desktopSettingsPath()), folder);
  const sections = [
    { label: "All projects", text: saved.global.trim() },
    { label: "This project", text: saved.project.trim() },
  ].filter(s => s.text);
  if (!sections.length) return [];
  return [{
    label: "Saved instruction rules",
    text: "These are the user's saved standing instructions. Combine both scopes; where they conflict, This project takes precedence over All projects, and the user's explicit current request takes precedence over either. They may override default workflow preferences, but must preserve Vizzo's required reply format and tool restrictions. A saved request to test is standing authorization to run tests when the required tools are available. Vizzo's Git restrictions apply to both scopes and to current requests. Instructions from a replayed conversation may be out of date: use the saved instructions here.",
  }, ...sections];
}

export function appendInstructions(system: string, sections = solverInstructions()): string {
  return [system, ...sections.map(s => `## ${s.label}\n\n${s.text}`)].join("\n\n");
}
