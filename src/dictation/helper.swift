// Botbench's speech helper: turns an audio file into text with Apple's on-device speech recognition
// (the Speech framework's SpeechAnalyzer and SpeechTranscriber, macOS 26 and later). Botbench compiles this file with
// the Swift compiler of Apple's command line developer tools into its data folder and runs it like any other program.
//
//   helper check               prints one word: ready, no-model (the English model is not on this Mac) or unsupported
//   helper install             downloads the English model through the system (Apple's asset service), then prints ready
//   helper transcribe <file>   prints what was said in the file (16 kHz mono WAV from Botbench, or any file macOS reads)
//
// Recognition runs in the system's local speech service; the audio is not sent anywhere. Errors go to stderr, one line,
// never with the transcript in them.

import AVFoundation
import Foundation
import Speech

let LOCALE = Locale(identifier: "en-US")

func fail(_ message: String, _ code: Int32) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}

@available(macOS 26.0, *)
func modelInstalled() async -> Bool {
  guard SpeechTranscriber.isAvailable, let locale = await SpeechTranscriber.supportedLocale(equivalentTo: LOCALE) else { return false }
  let installed = await SpeechTranscriber.installedLocales
  return installed.contains { $0.identifier(.bcp47) == locale.identifier(.bcp47) }
}

@available(macOS 26.0, *)
func transcriber() async -> SpeechTranscriber {
  let locale = await SpeechTranscriber.supportedLocale(equivalentTo: LOCALE) ?? LOCALE
  return SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
}

@available(macOS 26.0, *)
func main(_ args: [String]) async {
  switch args.first {
  case "check":
    print(await modelInstalled() ? "ready" : (SpeechTranscriber.isAvailable ? "no-model" : "unsupported"))
  case "install":
    do {
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [await transcriber()]) {
        try await request.downloadAndInstall()
      }
      print(await modelInstalled() ? "ready" : "no-model")
    } catch {
      fail("The English speech model could not be installed: \(error.localizedDescription)", 3)
    }
  case "transcribe" where args.count == 2:
    guard await modelInstalled() else { fail("The English speech model is not on this Mac.", 4) }
    let file: AVAudioFile
    do {
      file = try AVAudioFile(forReading: URL(fileURLWithPath: args[1]))
    } catch {
      fail("The recording could not be read as audio.", 5)
    }
    do {
      let module = await transcriber()
      let analyzer = SpeechAnalyzer(modules: [module])
      async let text: String = module.results.reduce("") { $0 + String($1.text.characters) }
      if let last = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: last)
      } else {
        await analyzer.cancelAndFinishNow()
      }
      print(try await text.trimmingCharacters(in: .whitespacesAndNewlines))
    } catch {
      fail("Speech recognition failed: \(error.localizedDescription)", 6)
    }
  default:
    fail("usage: helper check | install | transcribe <file>", 2)
  }
}

if #available(macOS 26.0, *) {
  await main(Array(CommandLine.arguments.dropFirst()))
} else {
  print("unsupported")
}
