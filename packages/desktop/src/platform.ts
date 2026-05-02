// Platform detection + shortcut-display helpers.
//
// Tauri runs on macOS (WKWebView), Windows (WebView2), and Linux
// (WebKitGTK). The keyboard MODIFIER is the same logical key -
// `event.metaKey || event.ctrlKey` correctly handles Cmd on Mac /
// Ctrl on Win+Linux when wiring listeners. But the *display* of that
// modifier in tooltips and badges differs:
//
//   macOS  → ⌘  (Command symbol)
//   else   → Ctrl
//
// And Shift / Alt have similar conventions:
//
//   macOS  → ⇧ ⌥
//   else   → Shift+ Alt+
//
// Use these constants when formatting shortcut hints for users.

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

export const isMac = /Mac/i.test(ua);
export const isWindows = /Windows/i.test(ua);

/** Modifier key prefix in shortcut display: "⌘" on macOS, "Ctrl+" on Win/Linux. */
export const Mod = isMac ? '⌘' : 'Ctrl+';
/** Shift key prefix: "⇧" on macOS, "Shift+" on Win/Linux. */
export const Shift = isMac ? '⇧' : 'Shift+';
/** Alt / Option key prefix: "⌥" on macOS, "Alt+" on Win/Linux. */
export const Alt = isMac ? '⌥' : 'Alt+';

/**
 * Format a shortcut for display. Examples:
 *   shortcut('K')           → "⌘K"   on Mac, "Ctrl+K"   on Win/Linux
 *   shortcut('K', 'shift')  → "⇧⌘K"  on Mac, "Ctrl+Shift+K" on Win/Linux
 */
export function shortcut(key: string, ...modifiers: ('shift' | 'alt')[]): string {
  if (isMac) {
    let out = '';
    if (modifiers.includes('alt')) out += Alt;
    if (modifiers.includes('shift')) out += Shift;
    out += Mod + key;
    return out;
  }
  // Windows / Linux: Ctrl+Shift+Alt+K style
  const parts = ['Ctrl'];
  if (modifiers.includes('shift')) parts.push('Shift');
  if (modifiers.includes('alt')) parts.push('Alt');
  parts.push(key);
  return parts.join('+');
}
