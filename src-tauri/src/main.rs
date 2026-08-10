// Tauri's release executable exports Windows symbols, so localized MSVC linkers
// print an informational "Creating library" message. Rust cannot classify the
// localized text as `linker_info`; keep actual linker errors while silencing
// that target-specific diagnostic at the binary boundary.
#![cfg_attr(all(windows, target_env = "msvc"), allow(linker_messages))]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = sideral_editor_lib::run() {
        eprintln!("Sideral Editor failed to start: {error}");
        std::process::exit(1);
    }
}
