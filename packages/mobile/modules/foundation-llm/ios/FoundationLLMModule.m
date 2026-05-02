// Objective-C bridge: exposes the Swift `FoundationLLMModule` to React
// Native's module registry under the name "FoundationLLM".
//
// RCT_EXTERN_METHOD parameter signatures must match the Swift @objc
// signatures in FoundationLLMModule.swift exactly — the runtime uses
// them to wire up the JS bindings.

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(FoundationLLM, RCTEventEmitter)

RCT_EXTERN_METHOD(isAvailable:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(complete:(NSDictionary *)opts
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
