//! PolyPad desktop entry point.

// Release builds are GUI applications on Windows: no console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> std::process::ExitCode {
    polypad_app::run()
}
