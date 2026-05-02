require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'FoundationLLM'
  s.version          = package['version']
  s.summary          = package['description']
  s.homepage         = 'https://meo.md'
  s.license          = { :type => 'MIT' }
  s.author           = { 'meo.md' => 'support@meo.md' }
  s.platforms        = { :ios => '15.0' }
  s.source           = { :path => '.' }
  s.source_files     = 'ios/**/*.{h,m,mm,swift}'
  s.requires_arc     = true
  s.swift_version    = '5.9'
  # FoundationModels is iOS 18+, conditionally weak-linked at runtime.
  # Compiling against the SDK requires Xcode 16+. The runtime gate
  # (`#available(iOS 18.0, *)`) lets older devices still load this pod.
  s.weak_frameworks  = 'FoundationModels'
  s.dependency 'React-Core'
end
