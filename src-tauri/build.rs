fn main() {
    let mut attributes = tauri_build::Attributes::new();

    // On Windows, `tauri-winres` links the application manifest with
    // `rustc-link-arg-bins`, so it never reaches the test binaries. Without the
    // Common-Controls dependency the unit-test executable fails to start with
    // STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139). Embed the manifest through
    // `rustc-link-arg` (which applies to every artifact, tests included)
    // instead. See https://github.com/tauri-apps/tauri/issues/13419.
    #[cfg(windows)]
    {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        embed_windows_manifest();
    }

    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

#[cfg(windows)]
fn embed_windows_manifest() {
    const MANIFEST_FILE: &str = "windows-app-manifest.xml";

    let manifest = std::env::current_dir().unwrap().join(MANIFEST_FILE);

    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
        manifest.to_str().unwrap()
    );
}
