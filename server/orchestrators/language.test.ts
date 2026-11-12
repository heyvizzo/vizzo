// Which language a turn is in, and which pointing words it uses (TurnBase.sttFinal / routerLanguage / pointingWords).
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type RunConfig } from "../../shared/config.ts";
import { ConnectionState } from "../connection.ts";
import { RouteInputStream } from "../adapters/claudeParse.ts";
import { TurnBase } from "./turnBase.ts";
import type { TurnContext } from "./types.ts";

const open: TurnBase[] = [];
afterEach(() => { for (const b of open.splice(0)) b.cancel(); });

function turn(config: Partial<RunConfig>): TurnBase {
  const ctx: TurnContext = {
    turnId: "t1", config: { ...DEFAULT_CONFIG, ...config }, mark: () => {}, send: () => {}, sendAudio: () => {},
    cursorSamples: () => [], tAudioStart: () => 1000, connection: new ConnectionState(),
  };
  const base = new TurnBase(ctx, { collectUsage: () => ({}) });
  open.push(base);
  return base;
}

describe("the turn's language", () => {
  it("one language chosen: that one, whatever anything else says", () => {
    const b = turn({ language: "de", languages: ["de"] });
    b.sttFinal("Make this bigger", [], "en");
    expect(b.language).toBe("de");
    b.routerLanguage("en");
    expect(b.language).toBe("de");
  });

  it("Auto: what the speech engine reports, as a code", () => {
    const b = turn({ language: "auto", languages: [] });
    b.sttFinal("Mach diesen Knopf größer", [], "german");
    expect(b.language).toBe("de");
    b.routerLanguage("en");
    expect(b.language).toBe("de");
    expect(b.pointingWords().language("diesen")).toBe("de");
    expect(b.pointingWords().language("this")).toBeNull();
  });

  it("several chosen and the engine says nothing: the router's language, when it's one of them", () => {
    const b = turn({ language: "auto", languages: ["de", "fr"] });
    b.sttFinal("Mach diesen Knopf größer", []); // Scribe: no code
    expect(b.language).toBeUndefined();
    b.routerLanguage("ja"); // not chosen
    expect(b.language).toBeUndefined();
    b.routerLanguage("de");
    expect(b.language).toBe("de");
    // Both lists are used, whichever language it turns out to be.
    expect(b.pointingWords().language("diesen")).toBe("de");
    expect(b.pointingWords().language("ceci")).toBe("fr");
  });

  it("Nemotron's \"auto\" is not a language", () => {
    const b = turn({ language: "auto", languages: ["de", "en"] });
    b.sttFinal("Mach das größer", [], "auto");
    expect(b.language).toBeUndefined();
  });

  it("English + Romanian keeps its guess from the text until the router answers", () => {
    const b = turn({ language: "auto", languages: ["en", "ro"] });
    b.sttFinal("Fă butonul ăsta puțin mai mare", []);
    expect(b.language).toBe("ro");
    const old = turn({ language: "auto" }); // a config from before the pickers
    old.sttFinal("Make this button bigger please", []);
    expect(old.language).toBe("en");
  });

  it("the lists the user edited replace the starting ones", () => {
    const b = turn({ language: "de", languages: ["de"], pointingWords: { de: ["das"] } });
    b.sttFinal("Mach das größer", []);
    expect(b.pointingWords().language("das")).toBe("de");
    expect(b.pointingWords().language("dieser")).toBeNull();
  });
});

describe("the router's language field", () => {
  it("is reported as soon as it streams in, before say", () => {
    const seen: string[] = [];
    const s = new RouteInputStream(
      { onDecision: () => seen.push("decision"), onSay: () => seen.push("say"), onSayEnd: () => {}, onLanguage: (l) => seen.push(`language:${l}`) },
      ["question", "task", "clarify", "answer"], "answer",
    );
    s.feed('{"intent": "question", "estimate_seconds": 8, "language": "de", "say": "Ich schaue nach."');
    expect(seen.slice(0, 3)).toEqual(["decision", "language:de", "say"]);
  });
});
