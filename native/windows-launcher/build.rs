//! Embed the application icon and version metadata into OpenCodex.exe.
//!
//! Without this the launcher shows the default Windows executable icon in
//! Explorer, the taskbar and the logon-task list, which is the only place a
//! user actually sees this binary.

fn main() {
    if !cfg!(target_os = "windows") {
        return;
    }

    println!("cargo:rerun-if-changed=assets/OpenCodex.ico");
    println!("cargo:rerun-if-changed=build.rs");

    let mut resource = winresource::WindowsResource::new();
    resource.set_icon("assets/OpenCodex.ico");
    resource.set("FileDescription", "OpenCodex gateway launcher");
    resource.set("ProductName", "OpenCodex");
    resource.set("CompanyName", "OpenCodex");
    resource.set("LegalCopyright", "MIT");

    // A missing resource compiler must not break the build: the launcher works
    // perfectly well without an icon, so degrade instead of failing.
    if let Err(error) = resource.compile() {
        println!("cargo:warning=could not embed the application icon: {error}");
    }
}
