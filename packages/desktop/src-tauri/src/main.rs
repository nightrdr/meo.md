// meo.md desktop entry. Pure shell — all logic lives in the React UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    meo_desktop_lib::run()
}
