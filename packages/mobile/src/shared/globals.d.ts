// Globals provided by Hermes/RN runtime + react-native-get-random-values polyfill.
declare const crypto: {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
};
declare const btoa: (s: string) => string;
declare const atob: (s: string) => string;
