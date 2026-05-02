pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // macOS only: install the default app menu so the AppKit
            // responder chain dispatches Cmd+A/C/V/X/Z and Shift+Cmd+Z
            // through to the WKWebView. Without a menu, those
            // keystrokes are silently dropped by AppKit before the
            // page sees them.
            //
            // Windows (WebView2) and Linux (WebKitGTK) handle Ctrl+A
            // and friends natively for contenteditable and form
            // elements — no menu required, and adding one would just
            // put an unwanted menu bar in the window chrome.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::Menu;
                let menu = Menu::default(app.handle())?;
                app.set_menu(menu)?;
            }
            // Suppress the unused-binding warning on non-mac builds.
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running meo.md");
}
