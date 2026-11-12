import { describe, expect, it } from "vitest";
import { DEFAULT_POINTING_WORDS, LANGUAGES, LANGUAGE_CODES, languageCode, languageLabel, languageName, parsePointingWords, pointingWordsFor } from "./languages.ts";
import { STT_LANGUAGE_SUPPORT, sttLanguageOptions, sttLanguagesFor, turnLanguages, type SttModel } from "./config.ts";
import { isPointingWord, pointingLanguage, pointingMatcher } from "./pointing.ts";

describe("the language catalog", () => {
  it("lists 50 languages, each with a name and a starting list of pointing words", () => {
    expect(LANGUAGES).toHaveLength(50);
    expect(new Set(LANGUAGE_CODES).size).toBe(50);
    for (const l of LANGUAGES) {
      expect(l.name && l.native, l.code).toBeTruthy();
      expect(DEFAULT_POINTING_WORDS[l.code]?.length, l.code).toBeGreaterThan(3);
    }
    expect(Object.keys(DEFAULT_POINTING_WORDS).sort()).toEqual([...LANGUAGE_CODES].sort());
  });

  it("reads a speech engine's language value as a code, whatever its form", () => {
    expect(languageCode("de")).toBe("de");
    expect(languageCode("de-DE")).toBe("de");
    expect(languageCode("DEU")).toBe("de");
    expect(languageCode("german")).toBe("de");
    expect(languageCode("Spanish")).toBe("es");
    expect(languageCode("ron")).toBe("ro");
    expect(languageCode("yue-CN")).toBe("zh");
    expect(languageCode("is")).toBe("is"); // not listed, but a code
    // Nemotron answers "auto"; that's not a language.
    expect(languageCode("auto")).toBeUndefined();
    expect(languageCode("")).toBeUndefined();
    expect(languageCode(null)).toBeUndefined();
  });

  it("names them", () => {
    expect(languageName("de")).toBe("German");
    expect(languageName("xx")).toBe("xx");
    expect(languageLabel("de")).toBe("German · Deutsch");
    expect(languageLabel("en")).toBe("English");
  });
});

describe("pointing-word lists", () => {
  it("a textarea's text becomes a list", () => {
    expect(parsePointingWords("dies, diese\n dieser;hier  dort, dies")).toEqual(["dies", "diese", "dieser", "hier", "dort"]);
    expect(parsePointingWords("  ")).toEqual([]);
  });

  it("an edited list replaces the starting one", () => {
    expect(pointingWordsFor("de")).toContain("dieser");
    expect(pointingWordsFor("de", { de: ["das"] })).toEqual(["das"]);
    expect(pointingWordsFor("xx")).toEqual([]);
    const m = pointingMatcher(["de"], { de: ["das"] });
    expect(m.language("Das,")).toBe("de");
    expect(m.language("dieser")).toBeNull();
  });

  it("matches each language's own words, and only the chosen languages'", () => {
    expect(pointingLanguage("dieser", ["de", "en"])).toBe("de");
    expect(pointingLanguage("this", ["de", "en"])).toBe("en");
    expect(pointingLanguage("dieser", ["en"])).toBeNull();
    expect(isPointingWord("ceci", ["fr"])).toBe(true);
    expect(isPointingWord("d'ici", ["fr"])).toBe(true);
    expect(isPointingWord("этот", ["ru"])).toBe(true);
    expect(isPointingWord("यह", ["hi"])).toBe(true);
    expect(isPointingWord("هذا،", ["ar"])).toBe(true);
  });

  it("accents count: Spanish «esta» points, «está» doesn't", () => {
    expect(isPointingWord("esta", ["es"])).toBe(true);
    expect(isPointingWord("Aquí.", ["es"])).toBe(true);
    expect(isPointingWord("está", ["es"])).toBe(false);
  });

  it("Romanian is listed with and without its accents", () => {
    for (const w of ["ăsta", "asta", "Această", "aceasta", "ăștia", "astia", "ăştia"]) expect(isPointingWord(w, ["ro"]), w).toBe(true);
  });

  it("an entry ending in * matches every word that starts with it", () => {
    expect(isPointingWord("これを", ["ja"])).toBe(true);
    expect(isPointingWord("このボタン", ["ja"])).toBe(true);
    expect(isPointingWord("ボタン", ["ja"])).toBe(false);
    expect(isPointingWord("这个", ["zh"])).toBe(true);
    const m = pointingMatcher(["tr"], { tr: ["bun*"] });
    expect(m.language("bunu")).toBe("tr");
    expect(m.language("bu")).toBeNull();
  });
});

describe("a speech model's languages", () => {
  const models = Object.keys(STT_LANGUAGE_SUPPORT) as SttModel[];

  it("every model offers known languages", () => {
    for (const m of models) {
      const offered = sttLanguageOptions(m);
      expect(offered.length, m).toBeGreaterThan(0);
      for (const c of offered) expect(LANGUAGE_CODES, `${m} ${c}`).toContain(c);
    }
    expect(sttLanguageOptions("local_moonshine")).toEqual(["en"]);
    expect(sttLanguageOptions("local_parakeet")).toHaveLength(25);
    expect(sttLanguageOptions("scribe_v2")).toHaveLength(50);
  });

  it("a model that reports the language: Auto, or one language", () => {
    expect(sttLanguagesFor("local_whisperkit", undefined)).toEqual([]);
    expect(sttLanguagesFor("local_whisperkit", [])).toEqual([]);
    expect(sttLanguagesFor("local_whisperkit", ["de", "fr"])).toEqual(["de"]);
    expect(sttLanguagesFor("openrouter_whisper_large_v3", undefined, "ro")).toEqual(["ro"]);
    expect(sttLanguagesFor("openrouter_whisper_large_v3", undefined, "auto")).toEqual([]);
  });

  it("a model that doesn't: the languages you speak, at least one", () => {
    expect(sttLanguagesFor("scribe_v2", ["de", "en", "de"])).toEqual(["de", "en"]);
    expect(sttLanguagesFor("scribe_v2", [])).toEqual(["en"]);
    expect(sttLanguagesFor("scribe_v2", undefined)).toEqual(["en"]);
    // The old Auto was English + Romanian.
    expect(sttLanguagesFor("scribe_v2", undefined, "auto")).toEqual(["en", "ro"]);
    expect(sttLanguagesFor("local_parakeet", ["ja", "de"])).toEqual(["de"]); // no Japanese in Parakeet
  });

  it("a model that has to be told: exactly one it supports", () => {
    expect(sttLanguagesFor("local_apple", ["fr", "de"])).toEqual(["fr"]);
    expect(sttLanguagesFor("local_apple", undefined, "ro")).toEqual(["en"]); // no Romanian on Apple
    expect(sttLanguagesFor("local_moonshine", ["de"])).toEqual(["en"]);
  });

  it("a turn's languages: the chosen ones, or what a config from before the pickers meant", () => {
    expect(turnLanguages({ language: "auto", languages: ["de", "en"] })).toEqual(["de", "en"]);
    expect(turnLanguages({ language: "auto", languages: [] })).toEqual([]);
    expect(turnLanguages({ language: "auto" })).toEqual(["en", "ro"]);
    expect(turnLanguages({ language: "ro" })).toEqual(["ro"]);
  });
});
