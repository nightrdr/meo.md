// FoundationLLMModule — bridges Apple FoundationModels (iOS 18+) to
// React Native. The JS side talks to this via NativeModules.FoundationLLM
// (see packages/mobile/src/shared/ai/backends/foundation.ts).
//
// Public surface:
//   - isAvailable() -> Bool          // iOS 18+ AND OS reports model ready
//   - complete(opts) -> { promptTokens, completionTokens }
//     Streams token deltas via the `FoundationLLMOnToken` device event.
//
// Streaming model: we emit `FoundationLLMOnToken` events keyed by a
// per-call `requestId`; the JS side accumulates them. `complete`'s
// promise resolves with usage stats once the underlying session
// finishes. This matches the RCT_PROMISE pattern used in llama.rn.
//
// The `FoundationModels` framework is weak-linked (see podspec).
// `#available(iOS 18.0, *)` gates every entry point so older devices
// still load this dylib.

import Foundation
import React

#if canImport(FoundationModels)
import FoundationModels
#endif

@objc(FoundationLLM)
class FoundationLLMModule: RCTEventEmitter {
  private var hasListeners = false

  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    return ["FoundationLLMOnToken"]
  }

  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  @objc(isAvailable:rejecter:)
  func isAvailable(_ resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(FoundationModels)
    if #available(iOS 18.0, *) {
      // SystemLanguageModel.default.isAvailable returns true when the
      // OS has finished provisioning the model. Apple Intelligence is
      // gated on hardware (A17 Pro / M-series) AND user opt-in in
      // Settings → Apple Intelligence & Siri.
      let model = SystemLanguageModel.default
      resolve(model.isAvailable)
      return
    }
    #endif
    resolve(false)
  }

  @objc(complete:resolver:rejecter:)
  func complete(_ opts: NSDictionary,
                resolver resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(FoundationModels)
    if #available(iOS 18.0, *) {
      let messages = (opts["messages"] as? [[String: Any]]) ?? []
      let maxTokens = (opts["maxTokens"] as? Int) ?? 1024
      let temperature = (opts["temperature"] as? Double) ?? 0.7
      let requestId = (opts["requestId"] as? String) ?? UUID().uuidString

      // Compose a single prompt from the chat-style messages. The
      // FoundationModels API accepts a flat string + optional
      // instruction; we map "system" → instructions, the rest
      // concatenated as the user prompt with role prefixes.
      var instructions: String?
      var userPrompt = ""
      for msg in messages {
        guard let role = msg["role"] as? String,
              let content = msg["content"] as? String else { continue }
        if role == "system" {
          instructions = (instructions.map { $0 + "\n\n" } ?? "") + content
        } else {
          userPrompt += "\(role): \(content)\n"
        }
      }

      let session: LanguageModelSession
      if let instr = instructions {
        session = LanguageModelSession(instructions: instr)
      } else {
        session = LanguageModelSession()
      }

      var options = GenerationOptions()
      options.maximumResponseTokens = maxTokens
      options.temperature = temperature

      let onToken = self.emitToken
      let hasListeners = { [weak self] in self?.hasListeners ?? false }

      Task {
        do {
          var promptTokens = 0
          var completionTokens = 0
          var lastEmitted = ""

          // Streamed response: each tick yields the cumulative text.
          let stream = session.streamResponse(to: userPrompt, options: options)
          for try await partial in stream {
            // partial is the *cumulative* response so far. Diff against
            // the last emitted text to extract just the new delta —
            // matches the React-side expectation of incremental tokens.
            let full = String(describing: partial)
            if full.count > lastEmitted.count, full.hasPrefix(lastEmitted) {
              let delta = String(full.dropFirst(lastEmitted.count))
              if hasListeners() {
                onToken(requestId, delta)
              }
              lastEmitted = full
            } else if full != lastEmitted {
              // Defensive: if the stream isn't a strict prefix
              // (shouldn't happen in practice), emit the whole thing.
              if hasListeners() { onToken(requestId, full) }
              lastEmitted = full
            }
          }

          // Token counts aren't exposed by SystemLanguageModel directly.
          // We approximate with character / 4 — close enough for the
          // privacy-preserving telemetry the JS side records.
          promptTokens = max(1, userPrompt.count / 4)
          completionTokens = max(0, lastEmitted.count / 4)

          resolve([
            "promptTokens": promptTokens,
            "completionTokens": completionTokens,
          ])
        } catch {
          reject("foundation_llm_error", error.localizedDescription, error as NSError)
        }
      }
      return
    }
    #endif
    reject("foundation_llm_unavailable",
           "Apple FoundationModels requires iOS 18+ and a supported device.",
           nil)
  }

  private func emitToken(_ requestId: String, _ delta: String) {
    sendEvent(withName: "FoundationLLMOnToken",
              body: ["requestId": requestId, "delta": delta])
  }
}
