/** Personal instructions saved by Vizzo, independently of harness instruction files. */
export interface StoredInstructions {
  global: string;
  projects: Record<string, string>;
}

export interface InstructionsSnapshot {
  global: string;
  project: string;
  projectDir: string | null;
}

export type InstructionEdit =
  | { scope: "global"; text: string }
  | { scope: "project"; text: string; projectDir: string };

export interface InstructionsBridge {
  get(): Promise<InstructionsSnapshot>;
  save(edit: InstructionEdit): Promise<void>;
}
