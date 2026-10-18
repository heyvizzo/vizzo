// macOS permission checks for the Settings window. Microphone status comes from Electron; the other two are
// files and the keychain. Nothing here prompts the user — a keychain check that would show a dialog reports
// "not allowed" instead.
import { execFile } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PermissionRow {
  id: "microphone" | "full-disk" | "chrome-keychain";
  name: string;
  ok: boolean;
  /** Short status next to the dot. */
  summary: string;
  /** What to do when it is off, or what it unlocks when it is on. */
  instruction: string;
  action?: { id: "allow-microphone" | "open-microphone" | "open-full-disk"; label: string };
}

export type Access = "ok" | "denied" | "missing";

const SAFARI_COOKIES = [
  "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
  "Library/Cookies/Cookies.binarycookies",
];

function canRead(path: string): Access {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    return "ok";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    return "denied";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Safari's cookie file is unreadable without Full Disk Access. Either candidate being readable is enough. */
export function fullDiskAccess(home = homedir()): Access {
  let missing = true;
  for (const relative of SAFARI_COOKIES) {
    const access = canRead(join(home, relative));
    if (access === "ok") return "ok";
    if (access === "denied") missing = false;
  }
  return missing ? "missing" : "denied";
}

export function microphoneRow(status: string): PermissionRow {
  if (status === "granted") {
    return {
      id: "microphone",
      name: "Microphone",
      ok: true,
      summary: "Allowed",
      instruction: "The voice chat can hear you.",
    };
  }
  if (status === "not-determined") {
    return {
      id: "microphone",
      name: "Microphone",
      ok: false,
      summary: "Not allowed yet",
      instruction: "macOS asks the first time the chat wants the microphone. Choose OK.",
      action: { id: "allow-microphone", label: "Allow microphone" },
    };
  }
  return {
    id: "microphone",
    name: "Microphone",
    ok: false,
    summary: "Blocked",
    instruction: "System Settings → Privacy & Security → Microphone, and turn on Electron. Then check again.",
    action: { id: "open-microphone", label: "Open System Settings" },
  };
}

export function fullDiskRow(access: Access): PermissionRow {
  if (access === "ok") {
    return {
      id: "full-disk",
      name: "Full Disk Access",
      ok: true,
      summary: "Allowed",
      instruction: "Safari cookies can be imported under Browser cookies above.",
    };
  }
  const hidden = access === "missing";
  return {
    id: "full-disk",
    name: "Full Disk Access",
    ok: false,
    summary: "Not allowed",
    instruction: hidden
      ? "System Settings → Privacy & Security → Full Disk Access, turn on Electron, then quit and reopen this app. Safari also has to have been opened once. macOS applies this only to a new launch."
      : "System Settings → Privacy & Security → Full Disk Access, turn on Electron, then quit and reopen this app. macOS applies this only to a new launch.",
    action: { id: "open-full-disk", label: "Open System Settings" },
  };
}

export function keychainRow(access: Access): PermissionRow {
  if (access === "ok") {
    return {
      id: "chrome-keychain",
      name: "Chrome keychain",
      ok: true,
      summary: "Allowed",
      instruction: "Chrome cookies can be decrypted for Browser cookies above.",
    };
  }
  if (access === "missing") {
    return {
      id: "chrome-keychain",
      name: "Chrome keychain",
      ok: false,
      summary: "Not found",
      instruction: "Open Chrome once so it creates the “Chrome Safe Storage” password. Then use Import from Chrome under Browser cookies above and choose Always Allow.",
    };
  }
  return {
    id: "chrome-keychain",
    name: "Chrome keychain",
    ok: false,
    summary: "Not allowed yet",
    instruction: "Use Import from Chrome under Browser cookies above. When macOS asks to use the “Chrome Safe Storage” password, choose Always Allow.",
  };
}

/** Reads whether this app may use Chrome's Safe Storage item, without showing the keychain dialog. */
export async function chromeKeychainAccess(): Promise<Access> {
  const script = `
import Security
let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: "Chrome Safe Storage",
  kSecAttrAccount as String: "Chrome",
  kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
]
let status = SecItemCopyMatching(query as CFDictionary, nil)
if status == errSecSuccess { print("ok") }
else if status == errSecItemNotFound { print("missing") }
else { print("denied") }
`;
  try {
    const { stdout } = await execFileAsync("/usr/bin/swift", ["-e", script], { encoding: "utf8", timeout: 20_000 });
    const line = stdout.trim();
    if (line === "ok" || line === "missing") return line;
    return "denied";
  } catch {
    return "denied";
  }
}
