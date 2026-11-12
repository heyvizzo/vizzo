// The languages Vizzo knows by name: the 50 offered in Settings → Speech to text, how a speech engine's language
// value ("de", "de-DE", "deu", "german") becomes one of their codes, and each one's starting list of pointing words
// (demonstratives and place adverbs: "this", "that", "here"…). The lists are data the user can edit in Settings;
// shared/pointing.ts matches words against them.

export interface Language {
  /** ISO 639-1. */
  code: string;
  /** English name. */
  name: string;
  /** Its own name. */
  native: string;
  /** Other codes engines use for it (ISO 639-2/3). */
  alt: readonly string[];
}

const lang = (code: string, name: string, native: string, ...alt: string[]): Language => ({ code, name, native, alt });

export const LANGUAGES: readonly Language[] = [
  lang("en", "English", "English", "eng"),
  lang("ar", "Arabic", "العربية", "ara"),
  lang("bn", "Bengali", "বাংলা", "ben"),
  lang("bg", "Bulgarian", "Български", "bul"),
  lang("ca", "Catalan", "Català", "cat"),
  lang("zh", "Chinese", "中文", "zho", "chi", "cmn", "yue", "mandarin", "cantonese"),
  lang("hr", "Croatian", "Hrvatski", "hrv"),
  lang("cs", "Czech", "Čeština", "ces", "cze"),
  lang("da", "Danish", "Dansk", "dan"),
  lang("nl", "Dutch", "Nederlands", "nld", "dut", "flemish"),
  lang("et", "Estonian", "Eesti", "est"),
  lang("tl", "Filipino", "Filipino", "fil", "tgl", "tagalog"),
  lang("fi", "Finnish", "Suomi", "fin"),
  lang("fr", "French", "Français", "fra", "fre"),
  lang("de", "German", "Deutsch", "deu", "ger"),
  lang("el", "Greek", "Ελληνικά", "ell", "gre"),
  lang("gu", "Gujarati", "ગુજરાતી", "guj"),
  lang("he", "Hebrew", "עברית", "heb", "iw"),
  lang("hi", "Hindi", "हिन्दी", "hin"),
  lang("hu", "Hungarian", "Magyar", "hun"),
  lang("id", "Indonesian", "Bahasa Indonesia", "ind"),
  lang("it", "Italian", "Italiano", "ita"),
  lang("ja", "Japanese", "日本語", "jpn"),
  lang("ko", "Korean", "한국어", "kor"),
  lang("lv", "Latvian", "Latviešu", "lav"),
  lang("lt", "Lithuanian", "Lietuvių", "lit"),
  lang("ms", "Malay", "Bahasa Melayu", "msa", "may"),
  lang("ml", "Malayalam", "മലയാളം", "mal"),
  lang("mt", "Maltese", "Malti", "mlt"),
  lang("mr", "Marathi", "मराठी", "mar"),
  lang("no", "Norwegian", "Norsk", "nor", "nob", "nb", "nn", "nno"),
  lang("fa", "Persian", "فارسی", "fas", "per", "farsi"),
  lang("pl", "Polish", "Polski", "pol"),
  lang("pt", "Portuguese", "Português", "por"),
  lang("pa", "Punjabi", "ਪੰਜਾਬੀ", "pan", "panjabi"),
  lang("ro", "Romanian", "Română", "ron", "rum", "mol", "moldavian", "moldovan"),
  lang("ru", "Russian", "Русский", "rus"),
  lang("sr", "Serbian", "Српски", "srp"),
  lang("sk", "Slovak", "Slovenčina", "slk", "slo"),
  lang("sl", "Slovenian", "Slovenščina", "slv", "slovene"),
  lang("es", "Spanish", "Español", "spa", "castilian"),
  lang("sw", "Swahili", "Kiswahili", "swa"),
  lang("sv", "Swedish", "Svenska", "swe"),
  lang("ta", "Tamil", "தமிழ்", "tam"),
  lang("te", "Telugu", "తెలుగు", "tel"),
  lang("th", "Thai", "ไทย", "tha"),
  lang("tr", "Turkish", "Türkçe", "tur"),
  lang("uk", "Ukrainian", "Українська", "ukr"),
  lang("ur", "Urdu", "اردو", "urd"),
  lang("vi", "Vietnamese", "Tiếng Việt", "vie"),
];

export const LANGUAGE_CODES: readonly string[] = LANGUAGES.map((l) => l.code);

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));
const ALIASES = new Map<string, string>(LANGUAGES.flatMap((l) => [[l.name.toLowerCase(), l.code], ...l.alt.map((a): [string, string] => [a, l.code])]));

export const isLanguage = (code: string): boolean => BY_CODE.has(code);

/**
 * A speech engine's or a model's language value as a code: "de", "de-DE", "deu" and "german" are all "de". A code we
 * don't list is kept when it looks like one (two or three letters); anything else ("auto", "", a sentence) is
 * undefined.
 */
export function languageCode(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const whole = raw.trim().toLowerCase();
  const c = whole.split(/[-_]/)[0]!;
  if (BY_CODE.has(c)) return c;
  const alias = ALIASES.get(c) ?? ALIASES.get(whole);
  if (alias) return alias;
  return /^[a-z]{2,3}$/.test(c) ? c : undefined;
}

/** "German" for "de"; the code itself for one we don't list. */
export function languageName(code: string): string {
  return BY_CODE.get(code)?.name ?? code;
}

/** "German · Deutsch" (just the name when both are the same). */
export function languageLabel(code: string): string {
  const l = BY_CODE.get(code);
  return !l ? code : l.name === l.native ? l.name : `${l.name} · ${l.native}`;
}

// ── Pointing words ────────────────────────────────────────────────────────────────────────────────
// A word matches an entry when they are the same ignoring case and punctuation. An entry that ends with `*` matches
// every word that starts with it (for languages that attach endings or particles: これ* matches これを). Accents count:
// Spanish "esta" (this) is listed, "está" (is) is not. Where people often type or get transcripts without accents
// (Romanian), both spellings are listed.

const words = (list: string): string[] => list.split(/\s+/).filter(Boolean);
/** Each word, plus its spelling without accents. */
const withPlain = (list: string): string[] => [...new Set(words(list).flatMap((w) => [w, w.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC")]))];

export const DEFAULT_POINTING_WORDS: Readonly<Record<string, readonly string[]>> = {
  en: words("this that these those here there"),
  ar: words("هذا هذه هذي هذان هؤلاء ذلك تلك أولئك هنا هناك هنالك ده دي دول هاد هاي هادا هون"),
  bn: words("এই এটা এটি এগুলো এটাকে ওই ওটা ওটি ওগুলো সেই সেটা এখানে ওখানে সেখানে এদিকে ওদিকে"),
  bg: words("този тази това тези онзи онази онова онези тоя тая туй тия тук там"),
  ca: words("aquest aquesta aquests aquestes aquell aquella aquells aquelles això allò aquí allà allí ací"),
  zh: words("这* 這* 那 那个 那些 那里 那儿 那边 那個 那裡 那邊 此"),
  hr: words("ovaj ova ovo ovi ove ovog ovoga ovu ovom taj ta to ti te tog onaj ono ovdje tu tamo ovamo ondje"),
  cs: words("ten ta to ti ty tento tato toto tenhle tahle tohle tyhle tuto tuhle tamten tamta tamto tady tu tam sem zde"),
  da: words("denne dette disse her herovre derovre herhen derhen"),
  nl: words("dit dat deze die hier daar"),
  et: words("see seda selle selles sellel need neid nende too tolle siin seal siia sinna"),
  tl: words("ito iyan iyon itong iyang nito niyan niyon dito diyan doon rito riyan roon yan yun"),
  fi: words("tämä tämän tätä tässä tähän tästä tuo tuon tuota tuossa tuohon tuosta nämä näitä nuo noita täällä tänne täältä tuolla tuonne tuolta"),
  fr: words("ce cet cette ces ceci cela ça celui celle ceux celles ci ici là-bas"),
  de: words("dies diese dieser dieses diesen diesem jene jener jenes jenen jenem hier hierhin hierher dort dorthin dahin"),
  el: words("αυτός αυτή αυτό αυτοί αυτές αυτά αυτόν αυτήν αυτού αυτής αυτών εκείνος εκείνη εκείνο εκείνοι εκείνες εκείνα τούτος τούτη τούτο εδώ εκεί"),
  gu: words("આ આને આમાં પેલું પેલો પેલી પેલા તે એ અહીં અહીંયા ત્યાં"),
  he: words("זה זאת זו אלה אלו הזה הזאת הזו האלה האלו ההוא ההיא פה כאן שם הנה לכאן לשם"),
  hi: words("यह ये इस इसे इसको इन इन्हें वह वो उस उसे उसको उन उन्हें यहाँ यहां वहाँ वहां इधर उधर"),
  hu: words("ez ezt ezen ezek ezeket ennek erre ebben ebből ezzel azt azok azokat annak arra abban azzal emez amaz itt ott ide oda"),
  id: words("ini itu sini situ sana disini disitu disana kesini kesana"),
  it: words("questo questa questi queste quello quella quelli quelle quel quei quegli qui qua lì"),
  ja: words("これ* この* ここ* こっち* こちら* あれ* あの* あそこ* あっち* あちら* それ それを それは それが その そこ そこに そっち そちら"),
  ko: words("이 저 그 이것* 이거* 이건 이걸 이게 저것* 저거* 저건 저걸 저게 그것* 그거* 그건 그걸 그게 여기* 저기* 거기* 이쪽* 저쪽* 그쪽*"),
  lv: words("šis šī šo šie šīs šim šai tas tie tās šeit tur šurp turp"),
  lt: words("šis ši šį šią šie šios šitas šita šito tas ta tą tie tos čia ten šičia"),
  ms: words("ini itu sini situ sana disini disitu disana kesini kesana"),
  ml: words("ഇത് ഈ ഇവ ഇതിനെ അത് ആ അവ അതിനെ ഇവിടെ അവിടെ"),
  mt: words("dan din dawn dak dik dawk hawn hemm hawnhekk hemmhekk"),
  mr: words("हा ही हे ह्या या तो ती ते त्या इथे तिथे इकडे तिकडे"),
  no: words("denne dette disse her der hit dit"),
  fa: words("این اینها اینو آن آنها اون اونا اونو همین همان اینجا آنجا اونجا"),
  pl: words("ten ta to tę te ci tego tej temu tym tych tymi tamten tamta tamto tamte tamci tu tutaj tam"),
  pt: words("este esta estes estas isto esse essa esses essas isso aquele aquela aqueles aquelas aquilo neste nesta nesse nessa naquele naquela deste desta desse dessa daquele daquela aqui aí ali lá cá"),
  pa: words("ਇਹ ਇਸ ਇਹਨਾਂ ਉਹ ਉਸ ਉਹਨਾਂ ਇੱਥੇ ਉੱਥੇ ਇਧਰ ਉਧਰ"),
  ro: withPlain(
    // near: acesta/această/aceștia/acestea, acest/aceste, ăsta/asta/ăștia/astea (+ oblique)
    "acesta aceasta această aceștia acestea acest aceste acestui acestei acestor ăsta asta ăștia astea ăstuia ăsteia ăstora " +
    // far: acela/aceea/aceia/acelea, acel/acea/acei/acele, ăla/aia/ăia/alea (+ oblique)
    "acela aceea aceia acelea acel acea acei acele acelui acelei acelor ăla aia ăia alea ăluia ăleia ălora " +
    // place
    "aici aicea acilea acolo acolea colo",
  ),
  ru: words("этот эта это эти этого этой этому этим этих эту тот та те того той тут здесь там сюда туда вот"),
  sr: words("ovaj ova ovo ovi ove ovu taj to onaj ovde tu tamo ovamo овај ова ово ови ове ову тај то онај овде ту тамо овамо"),
  sk: words("ten tá to tí tie tento táto toto títo tieto tamten tamtá tamto tu tam sem tuto"),
  sl: words("ta to ti te tega tej tem tisti tista tisto tale tole tukaj tu tam sem tja"),
  es: words("este esta estos estas esto ese esa esos esas eso aquel aquella aquellos aquellas aquello aquí acá ahí allí allá"),
  sw: words("hii hiki hili huyu hizi hivi haya hawa huu ile kile lile yule zile vile yale wale hapa hapo pale huko kule humu"),
  sv: words("denna denne detta dessa här där hit dit"),
  ta: words("இது இந்த இவை இதை அது அந்த அவை அதை இங்கே அங்கே இங்கு அங்கு"),
  te: words("ఇది ఈ ఇవి దీన్ని అది ఆ అవి దాన్ని ఇక్కడ అక్కడ"),
  th: words("นี้ นี่ นั้น นั่น โน้น อันนี้* อันนั้น* ตรงนี้* ตรงนั้น* ที่นี่ ที่นั่น"),
  tr: words("bu şu bunu şunu bunun şunun buna şuna bunda bundan bunlar şunlar bunları şunları burada şurada orada buraya şuraya oraya burası şurası orası buradan şuradan işte"),
  uk: words("цей ця це ці цього цієї цьому цим цих цю той те ті того тієї тут там сюди туди ось"),
  ur: words("یہ اس اسے ان وہ اُس یہاں وہاں ادھر اُدھر"),
  vi: words("này đây kia đó đấy ấy nọ"),
};

/** A textarea's text (or a saved list) as entries: split on commas, semicolons and whitespace. */
export function parsePointingWords(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((w) => w.trim()).filter(Boolean))];
}

/** The pointing words of a language: the user's list when they edited it, else the starting one ([] for one we don't list). */
export function pointingWordsFor(code: string, overrides?: Readonly<Record<string, readonly string[] | undefined>>): readonly string[] {
  return overrides?.[code] ?? DEFAULT_POINTING_WORDS[code] ?? [];
}
