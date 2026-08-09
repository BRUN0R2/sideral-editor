#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = sideral_editor_lib::run() {
        eprintln!("Sideral Editor failed to start: {error}");
        std::process::exit(1);
    }
}
