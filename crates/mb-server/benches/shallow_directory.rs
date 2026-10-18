//! Focused E30 metadata-only filesystem benchmark, not whole-app performance proof.
#![allow(clippy::expect_used)] // why: disposable benchmark setup assertions.
#[cfg(target_os = "linux")]
fn main() {
    use criterion::{BenchmarkId, Criterion};
    use mb_core::{Access, Member, Role, Username};
    use mb_server::{Vault, repository::AuthorizedVault, vault::Slug};
    let mut criterion = Criterion::default().configure_from_args();
    let dir = tempfile::tempdir().expect("benchmark fixture");
    let user = Username::parse("alice").expect("user");
    let access = Access::new(
        vec![Member {
            user: user.clone(),
            role: Role::Viewer,
        }],
        vec![],
    )
    .expect("ACL");
    // why: descendant size should not alter one directory listing's work.
    std::fs::create_dir_all(dir.path().join("Deep")).expect("child");
    for i in 0..5000 {
        std::fs::write(dir.path().join("Deep").join(format!("N{i}.md")), b"").expect("deep note");
    }
    let vault =
        Vault::open(Slug::parse("bench").expect("slug"), "Bench", dir.path()).expect("vault");
    let view = AuthorizedVault::new(&vault, &access, user);
    for entries in [1, 32, 127] {
        for i in 0..entries {
            std::fs::write(dir.path().join(format!("N{i:03}.md")), b"").expect("immediate note");
        }
        criterion.bench_with_input(
            BenchmarkId::new("shallow_directory", entries),
            &entries,
            |b, _| b.iter(|| std::hint::black_box(view.directory("").expect("bounded listing"))),
        );
    }
    criterion.final_summary();
}
#[cfg(not(target_os = "linux"))]
fn main() {}
