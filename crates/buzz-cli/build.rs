//! Stamp the binary with a fingerprint that changes on every rebuild.
//!
//! LOCAL DIVERGENCE. `--version` alone cannot answer the question it gets
//! asked: every build in this workspace is `0.1.0`, so two binaries an hour
//! apart report the same string and a stale one reads as current. That has
//! twice sent a debugging session after a phantom bug — see the sidecar and
//! `~/bin/buzz.exe` shims, both of which go stale while Desktop runs.
//!
//! The build time is the load-bearing half: a commit hash still collides
//! across the dirty rebuilds that make up most of a debugging session.
//!
//! Emitting any `cargo:rerun-if-changed` replaces cargo's default (rerun when
//! any file in the package changes), so the list below has to restore it —
//! `src` for edits — and then add what the default misses: `HEAD` moves and
//! `index` writes, so committing or staging refreshes the hash and clears the
//! `-dirty` suffix instead of leaving a clean tree reporting itself dirty.

use std::process::Command;

fn main() {
    let sha = Command::new("git")
        .args(["rev-parse", "--short=8", "HEAD"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|sha| sha.trim().to_string())
        .filter(|sha| !sha.is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    let dirty = Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=no"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .is_some_and(|out| !out.stdout.is_empty());

    let sha = if dirty { format!("{sha}-dirty") } else { sha };

    let built = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    println!("cargo:rustc-env=BUZZ_CLI_GIT_SHA={sha}");
    println!("cargo:rustc-env=BUZZ_CLI_BUILT_AT={built}");

    for path in [
        "src",
        "Cargo.toml",
        "build.rs",
        "../../.git/HEAD",
        "../../.git/index",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
}
