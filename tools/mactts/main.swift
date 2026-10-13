// mactts: a persistent on-device text-to-speech helper (AVSpeechSynthesizer) for the voice lab.
// It keeps the synthesizer (and the voices) loaded and streams PCM as it is synthesized, so the first
// audio comes back fast. Built and started by server/adapters/macTts.ts.
//
// stdin, one JSON object per line:
//   {"id":"1","text":"Hello there.","lang":"en"}           synthesize (lang: en | ro | BCP-47; optional "voice": identifier)
//   {"cmd":"voices"}                                         list voices
// stdout, framed:
//   {"id":"1","pcm":N}\n followed by N bytes of PCM16 mono 24 kHz little-endian
//   {"id":"1","done":true,"voice":"…","ms":123}\n             end of that request
//   {"id":"1","error":"…"}\n
//   {"voices":[…]}\n
//   {"ready":true}\n                                          once at start
import AVFoundation
import Foundation

let out = FileHandle.standardOutput
let outQueue = DispatchQueue(label: "mactts.out")
func emit(_ obj: [String: Any], _ bytes: Data? = nil) {
  guard var line = try? JSONSerialization.data(withJSONObject: obj) else { return }
  line.append(0x0A)
  outQueue.sync {
    out.write(line)
    if let b = bytes { out.write(b) }
  }
}

let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!
let synth = AVSpeechSynthesizer()

func quality(_ v: AVSpeechSynthesisVoice) -> Int {
  switch v.quality {
  case .premium: return 3
  case .enhanced: return 2
  default: return 1
  }
}

/// Best non-novelty voice for a language ("en" → prefers en-US; "ro" → ro-RO), premium > enhanced > default.
func bestVoice(_ lang: String) -> AVSpeechSynthesisVoice? {
  let want = lang.lowercased()
  let preferred = want == "en" ? "en-us" : want == "ro" ? "ro-ro" : want
  let all = AVSpeechSynthesisVoice.speechVoices().filter { v in
    !v.voiceTraits.contains(.isNoveltyVoice) && v.language.lowercased().hasPrefix(want.prefix(2))
  }
  return all.max { a, b in
    let sa = quality(a) * 10 + (a.language.lowercased() == preferred ? 1 : 0)
    let sb = quality(b) * 10 + (b.language.lowercased() == preferred ? 1 : 0)
    return sa < sb
  }
}

struct Job { let id: String; let text: String; let lang: String; let voice: String?; var silent = false }
var queue: [Job] = []
var busy = false

func next() {
  guard !busy, !queue.isEmpty else { return }
  busy = true
  let job = queue.removeFirst()
  let t0 = Date()
  let utterance = AVSpeechUtterance(string: job.text)
  let voice = job.voice.flatMap { AVSpeechSynthesisVoice(identifier: $0) } ?? bestVoice(job.lang)
  utterance.voice = voice
  var converter: AVAudioConverter?
  var finished = false
  synth.write(utterance) { buffer in
    guard let pcm = buffer as? AVAudioPCMBuffer else { return }
    if pcm.frameLength == 0 {
      // End of utterance.
      if !finished {
        finished = true
        if !job.silent { emit(["id": job.id, "done": true, "voice": voice?.name ?? "", "ms": Int(Date().timeIntervalSince(t0) * 1000)]) }
        DispatchQueue.main.async { busy = false; next() }
      }
      return
    }
    if converter == nil { converter = AVAudioConverter(from: pcm.format, to: target) }
    guard let conv = converter else { return }
    let ratio = target.sampleRate / pcm.format.sampleRate
    let cap = AVAudioFrameCount(Double(pcm.frameLength) * ratio) + 64
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: cap) else { return }
    var fed = false
    var err: NSError?
    conv.convert(to: outBuf, error: &err) { _, status in
      if fed { status.pointee = .noDataNow; return nil }
      fed = true
      status.pointee = .haveData
      return pcm
    }
    if let e = err { emit(["id": job.id, "error": e.localizedDescription]); return }
    if job.silent { return }
    let n = Int(outBuf.frameLength) * 2
    guard n > 0, let ch = outBuf.int16ChannelData else { return }
    emit(["id": job.id, "pcm": n], Data(bytes: ch[0], count: n))
  }
}

func handle(_ line: String) {
  guard let data = line.data(using: .utf8),
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
  if obj["cmd"] as? String == "voices" {
    let voices = AVSpeechSynthesisVoice.speechVoices().filter { !$0.voiceTraits.contains(.isNoveltyVoice) }.map {
      ["id": $0.identifier, "name": $0.name, "lang": $0.language, "quality": quality($0)] as [String: Any]
    }
    emit(["voices": voices])
    return
  }
  guard let id = obj["id"] as? String, let text = obj["text"] as? String else { return }
  queue.append(Job(id: id, text: text, lang: (obj["lang"] as? String) ?? "en", voice: obj["voice"] as? String))
  next()
}

// Warm up the voices (loading a voice is the slow part of the first request).
_ = bestVoice("en"); _ = bestVoice("ro")

DispatchQueue.global().async {
  while let line = readLine() {
    DispatchQueue.main.async { handle(line) }
  }
  exit(0)
}
// Synthesize once per language without output: the first real request then starts in ~60–90 ms.
queue.append(Job(id: "_warm_en", text: "Ready.", lang: "en", voice: nil, silent: true))
queue.append(Job(id: "_warm_ro", text: "Gata.", lang: "ro", voice: nil, silent: true))
next()
emit(["ready": true])
RunLoop.main.run()
