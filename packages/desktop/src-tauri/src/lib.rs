// Native menu bar wiring (Agent 5).
//
// Strategy:
//   * macOS: build a rich custom menu (App / File / Edit / View / Window)
//     modelled on the macOS Notes app — that's where users expect a
//     native menu and where AppKit's responder chain *requires* a Menu
//     to dispatch Cmd+A/C/V/X/Z to the WKWebView. We keep the standard
//     predefined Edit items (undo/redo/cut/copy/paste/select-all) so
//     contenteditable + form-element shortcuts keep working out of the
//     box.
//   * Windows / Linux: skip the menu bar entirely. Adding a menu to the
//     window chrome on Windows would put an unwanted bar at the top of
//     the frame; Linux WebKitGTK handles Ctrl+A natively. The JS-side
//     keyboard handlers in App.tsx already route ⌘N / ⌘K / ⌘/ etc on
//     all platforms. Menu actions exposed via the macOS menu (New Note,
//     Find, Settings…) all have JS-keyboard equivalents on Win/Linux.
//
// Custom menu items send their id (e.g. "new-note", "settings",
// "export.pdf") through `on_menu_event`, which we forward to the JS
// frontend as a Tauri event named "menu://<id>". App.tsx subscribes
// via the `useMenuEvents` hook in `src/menus.ts`. Predefined items
// (cut/copy/paste/quit/etc.) are handled by AppKit directly and don't
// fire menu events — that's the whole point of using them.

use tauri::Emitter;

mod biometric;

pub fn run() {
    let builder = tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let menu = build_macos_menu(app.handle())?;
                app.set_menu(menu)?;
            }
            // Suppress the unused-binding warning on non-mac builds.
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            biometric::biometric_save,
            biometric::biometric_load,
            biometric::biometric_clear,
            biometric::biometric_available,
        ])
        .on_menu_event(|app, event| {
            // Forward every custom-menu id to JS as `menu://<id>`.
            // Predefined items (undo/cut/quit/...) never reach this
            // handler — AppKit consumes them — so anything we see here
            // is one of our `MenuItem::with_id` ids.
            let id = event.id().as_ref().to_string();
            let topic = format!("menu://{id}");
            // Best-effort emit. If the webview isn't ready yet (very
            // early menu click during startup) the event is dropped;
            // there's nothing useful to do about it.
            let _ = app.emit(&topic, ());
        });

    builder
        .run(tauri::generate_context!())
        .expect("error while running meo.md");
}

#[cfg(target_os = "macos")]
fn build_macos_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let pkg = app.package_info();
    let about_metadata = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    // ─── App menu (macOS only) ───
    let app_menu = Submenu::with_items(
        app,
        &pkg.name,
        true,
        &[
            // Custom "About Meo" → JS modal. We use our own id rather
            // than the predefined About so we can control the modal
            // (link to meo.md, etc.).
            &MenuItem::with_id(app, "about", "About Meo", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let _ = about_metadata; // we ship our own about modal; keep the
                            // metadata struct around in case we want
                            // to fall back to the native sheet later.

    // ─── File ───
    let export_submenu = Submenu::with_items(
        app,
        "Export as",
        true,
        &[
            &MenuItem::with_id(app, "export.md", "Markdown", true, None::<&str>)?,
            &MenuItem::with_id(app, "export.pdf", "PDF", true, None::<&str>)?,
            &MenuItem::with_id(app, "export.docx", "DOCX", true, None::<&str>)?,
            &MenuItem::with_id(app, "export.txt", "Plain Text", true, None::<&str>)?,
            &MenuItem::with_id(app, "export.html", "HTML", true, None::<&str>)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "new-note", "New Note", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(
                app,
                "new-folder",
                "New Folder",
                true,
                Some("Shift+CmdOrCtrl+N"),
            )?,
            &MenuItem::with_id(app, "new-tag", "New Tag", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "new-device", "New Device…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "import-markdown",
                "Import Markdown…",
                true,
                None::<&str>,
            )?,
            &export_submenu,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "print", "Print…", true, Some("CmdOrCtrl+P"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    // ─── Edit ───
    // Predefined items keep the AppKit responder chain happy so
    // Cmd+A/C/V/X/Z continue to reach the WKWebView. The custom items
    // (Find, Search Notes, Add Link) emit menu events to JS.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "find", "Find in Note", true, Some("CmdOrCtrl+F"))?,
            &MenuItem::with_id(
                app,
                "search-notes",
                "Search Notes",
                true,
                Some("CmdOrCtrl+K"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "insert-link",
                "Add Link…",
                true,
                Some("Shift+CmdOrCtrl+K"),
            )?,
        ],
    )?;

    // ─── View ───
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(
                app,
                "toggle-sidebar",
                "Toggle Sidebar",
                true,
                Some("Ctrl+CmdOrCtrl+S"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "mode.edit", "Edit Mode", true, Some("CmdOrCtrl+1"))?,
            &MenuItem::with_id(
                app,
                "mode.split",
                "Split Mode",
                true,
                Some("CmdOrCtrl+2"),
            )?,
            &MenuItem::with_id(
                app,
                "mode.preview",
                "Preview Mode",
                true,
                Some("CmdOrCtrl+3"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "ask-meo", "Ask Meo", true, Some("CmdOrCtrl+/"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    // ─── Window ───
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )
}
