// macstt: a persistent on-device speech-to-text helper (macOS 26 SpeechAnalyzer + SpeechTranscriber) for
// the voice lab. Audio streams in while the key is held; volatile results come back as partials, and the
// final transcript carries word timings (the transcriber's audioTimeRange attribute). Built and started by
// server/adapters/localStt.ts. Same framing as the other local STT helpers (tools/localstt/server.py):
//
// stdin, one JSON header per line (a "pcm" header is followed by that many bytes):
//   {"id":"1","cmd":"start","lang":"en"}        open a session (lang: en | ro | BCP-47)
//   {"id":"1","pcm":N}\n + N bytes              PCM16 mono 24 kHz little-endian
//   {"id":"1","cmd":"commit"}                   end of audio: finalize and send the transcript
//   {"id":"1","cmd":"cancel"}                   drop the session
// stdout, one JSON per line:
//   {"id":"1","partial":"…"}
//   {"id":"1","final":true,"text":"…","words":[{"text","start","end"}],"ms":123}   (seconds from the first sample)
//   {"id":"1","error":"…"}
//   {"ready":true,"locales":[…]}                once at start
import AVFoundation
import Foundation
import Speech

let out = FileHandle.standardOutput
let outQueue = DispatchQueue(label: "macstt.out")
func emit(_ obj: [String: Any]) {
  guard var line = try? JSONSerialization.data(withJSONObject: obj) else { return }
  line.append(0x0A)
  outQueue.sync { out.write(line) }
}

let inputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!

func localeFor(_ lang: String) -> Locale {
  switch lang.lowercased() {
  case "en": return Locale(identifier: "en-US")
  case "ro": return Locale(identifier: "ro-RO")
  default: return Locale(identifier: lang)
  }
}

/// Text plus word timings from a transcriber result. Runs are tokens; a run that starts with whitespace
/// (or follows one that ended with it) starts a new word.
func words(_ text: AttributedString) -> [[String: Any]] {
  var out: [[String: Any]] = []
  var cur = "", start = 0.0, end = 0.0, open = false
  func flush() {
    let t = cur.trimmingCharacters(in: .whitespacesAndNewlines)
    if open && !t.isEmpty { out.append(["text": t, "start": start, "end": end]) }
    cur = ""; open = false
  }
  for run in text.runs {
    let s = String(text[run.range].characters)
    guard let r = run.audioTimeRange else { cur += s; continue }
    if s.first?.isWhitespace == true || cur.last?.isWhitespace == true { flush() }
    if !open { start = r.start.seconds; open = true }
    cur += s
    end = r.end.seconds
  }
  flush()
  return out
}

final class Session {
  let id: String
  let analyzer: SpeechAnalyzer
  let input: AsyncStream<AnalyzerInput>.Continuation
  let format: AVAudioFormat
  let converter: AVAudioConverter?
  var finalText = AttributedString()
  var volatileText = AttributedString()
  var results: Task<Void, Error>?

  init(id: String, analyzer: SpeechAnalyzer, input: AsyncStream<AnalyzerInput>.Continuation, format: AVAudioFormat) {
    self.id = id; self.analyzer = analyzer; self.input = input; self.format = format
    converter = format == inputFormat ? nil : AVAudioConverter(from: inputFormat, to: format)
  }

  /// A transcriber result: final results accumulate, a volatile one replaces the previous volatile one.
  func add(_ text: AttributedString, isFinal: Bool) {
    if isFinal { finalText += text; volatileText = AttributedString() } else { volatileText = text }
    if id.hasPrefix("_") { return }
    let partial = String((finalText + volatileText).characters).trimmingCharacters(in: .whitespacesAndNewlines)
    if !partial.isEmpty { emit(["id": id, "partial": partial]) }
  }

  func push(_ data: Data) {
    let frames = AVAudioFrameCount(data.count / 2)
    guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: frames) else { return }
    buf.frameLength = frames
    data.withUnsafeBytes { raw in
      if let src = raw.baseAddress { memcpy(buf.int16ChannelData![0], src, data.count) }
    }
    guard let conv = converter else { input.yield(AnalyzerInput(buffer: buf)); return }
    let cap = AVAudioFrameCount(Double(frames) * format.sampleRate / inputFormat.sampleRate) + 64
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: cap) else { return }
    var fed = false
    var err: NSError?
    conv.convert(to: outBuf, error: &err) { _, status in
      if fed { status.pointee = .noDataNow; return nil }
      fed = true
      status.pointee = .haveData
      return buf
    }
    if let e = err { emit(["id": id, "error": e.localizedDescription]); return }
    if outBuf.frameLength > 0 { input.yield(AnalyzerInput(buffer: outBuf)) }
  }
}

var sessions: [String: Session] = [:]
var installed = Set<String>()

/// SpeechTranscriber (the newer, more accurate model) where it supports the language; otherwise
/// DictationTranscriber, which covers more locales (Romanian among them). Both report word time ranges.
func open(_ id: String, _ lang: String) async throws -> Session {
  let module: any SpeechModule
  let locale: Locale
  let results: (Session) -> Task<Void, Error>
  if let l = await SpeechTranscriber.supportedLocale(equivalentTo: localeFor(lang)) {
    locale = l
    let t = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [.audioTimeRange])
    module = t
    results = { s in Task { for try await r in t.results { s.add(r.text, isFinal: r.isFinal) } } }
  } else if let l = await DictationTranscriber.supportedLocale(equivalentTo: localeFor(lang)) {
    locale = l
    let t = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [.punctuation], reportingOptions: [.volatileResults], attributeOptions: [.audioTimeRange])
    module = t
    results = { s in Task { for try await r in t.results { s.add(r.text, isFinal: r.isFinal) } } }
  } else {
    throw NSError(domain: "macstt", code: 1, userInfo: [NSLocalizedDescriptionKey: "macOS speech recognition doesn't support \(lang)"])
  }
  let key = "\(type(of: module))-\(lang)"
  if !installed.contains(key) {
    // A locale's model is only kept on disk while an app reserves it (the system allows a few).
    if !(await AssetInventory.reservedLocales).contains(locale) { _ = try? await AssetInventory.reserve(locale: locale) }
    if let req = try await AssetInventory.assetInstallationRequest(supporting: [module]) { try await req.downloadAndInstall() }
    installed.insert(key)
  }
  let analyzer = SpeechAnalyzer(modules: [module])
  let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) ?? inputFormat
  try await analyzer.prepareToAnalyze(in: format)
  let (stream, cont) = AsyncStream<AnalyzerInput>.makeStream()
  let s = Session(id: id, analyzer: analyzer, input: cont, format: format)
  s.results = results(s)
  try await analyzer.start(inputSequence: stream)
  return s
}

func finish(_ s: Session) async throws -> [String: Any] {
  let t0 = Date()
  s.input.finish()
  try await s.analyzer.finalizeAndFinishThroughEndOfInput()
  try await s.results?.value
  let text = String(s.finalText.characters).trimmingCharacters(in: .whitespacesAndNewlines)
  return ["id": s.id, "final": true, "text": text, "words": words(s.finalText), "ms": Int(Date().timeIntervalSince(t0) * 1000)]
}

enum Msg { case start(String, String), pcm(String, Data), commit(String), cancel(String) }

let (messages, post) = AsyncStream<Msg>.makeStream()

// One consumer, so a session's audio is handled in order and after its start.
Task {
  // Warm-up: installs the English model if needed and loads it, so the first turn doesn't pay for it.
  do {
    let warm = try await open("_warm", "en")
    warm.push(Data(count: 4800))
    _ = try await finish(warm)
  } catch {
    FileHandle.standardError.write("warm-up failed: \(error.localizedDescription)\n".data(using: .utf8)!)
  }
  let locales = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }
  emit(["ready": true, "locales": locales])
  for await m in messages {
    switch m {
    case let .start(id, lang):
      do { sessions[id] = try await open(id, lang) } catch { emit(["id": id, "error": error.localizedDescription]) }
    case let .pcm(id, data):
      sessions[id]?.push(data)
    case let .commit(id):
      guard let s = sessions.removeValue(forKey: id) else { emit(["id": id, "error": "no session"]); continue }
      Task {
        do { emit(try await finish(s)) } catch { emit(["id": id, "error": error.localizedDescription]) }
      }
    case let .cancel(id):
      if let s = sessions.removeValue(forKey: id) { s.input.finish(); s.results?.cancel(); await s.analyzer.cancelAndFinishNow() }
    }
  }
  exit(0)
}

// stdin reader: JSON header lines, each "pcm" header followed by its bytes.
Thread.detachNewThread {
  var buf = Data()
  let stdin = FileHandle.standardInput
  while true {
    let chunk = stdin.availableData
    if chunk.isEmpty { post.finish(); return }
    buf.append(chunk)
    while let nl = buf.firstIndex(of: 0x0A) {
      let header = buf[buf.startIndex..<nl]
      guard let obj = (try? JSONSerialization.jsonObject(with: header)) as? [String: Any], let id = obj["id"] as? String else {
        buf = Data(buf[(nl + 1)...]); continue
      }
      if let n = obj["pcm"] as? Int {
        guard buf.count - (nl + 1 - buf.startIndex) >= n else { break } // wait for the whole frame
        let start = nl + 1
        post.yield(.pcm(id, Data(buf[start..<(start + n)])))
        buf = Data(buf[(start + n)...])
        continue
      }
      buf = Data(buf[(nl + 1)...])
      switch obj["cmd"] as? String {
      case "start": post.yield(.start(id, (obj["lang"] as? String) ?? "en"))
      case "commit": post.yield(.commit(id))
      case "cancel": post.yield(.cancel(id))
      default: break
      }
    }
  }
}

RunLoop.main.run()
