//! Full handler rollback under actual I/O-boundary faults, not only standalone primitives.
use super::*;
fn no_temps(root: &std::path::Path) {
    for e in std::fs::read_dir(root).expect("entries") {
        let p = e.expect("entry").path();
        assert!(
            !p.file_name()
                .expect("name")
                .to_string_lossy()
                .starts_with(".memberberry-"),
            "no orphan operation temporary"
        );
        if p.is_dir() {
            no_temps(&p);
        }
    }
}
#[tokio::test]
async fn actual_policy_and_config_preparation_io_faults_preserve_every_prior_byte_and_retry_both_modes()
 {
    use storage::test_io::Fault;
    for new in [false, true] {
        for (stage, fault) in [
            ("policy", Fault::Write),
            ("policy", Fault::Sync),
            ("policy", Fault::Rename),
            ("policy", Fault::DirectorySync),
            ("config", Fault::Write),
            ("config", Fault::Sync),
            ("commit", Fault::Rename),
        ] {
            let f = Fixture::new();
            let before = f.config_bytes();
            let project = f.dir.path().join("Projects/Public");
            let note = std::fs::read(project.join("Readme.md")).expect("original Markdown");
            let foreign = b"non-Markdown\0\xff";
            std::fs::write(project.join("Foreign.bin"), foreign).expect("foreign");
            let input = f.confirmed(new).await;
            let hook = match stage {
                "policy" => &f.state.registration.hooks.policy_fault,
                "config" => &f.state.registration.hooks.config_fault,
                _ => &f.state.registration.hooks.commit_fault,
            };
            *hook.lock().expect("external I/O boundary") = fault;
            let (status, _) = f.call(input, true).await;
            assert_eq!(
                status,
                if stage == "policy" && fault == Fault::Rename {
                    StatusCode::CONFLICT
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                },
                "actual {stage} {fault:?}, new={new}"
            );
            f.assert_unpublished(&before);
            assert!(!f.dir.path().join("Projects/New").exists());
            assert!(!project.join("access.toml").exists());
            assert_eq!(
                std::fs::read(project.join("Readme.md")).expect("preserved Markdown"),
                note
            );
            assert_eq!(
                std::fs::read(project.join("Foreign.bin")).expect("preserved non-Markdown"),
                foreign
            );
            no_temps(f.dir.path());
            *hook.lock().expect("fault removed") = Fault::None;
            let input = f.confirmed(new).await;
            assert_eq!(
                f.call(input, true).await.0,
                StatusCode::CREATED,
                "same exact registration retries after scoped cleanup"
            );
            assert_eq!(
                crate::ServerConfig::load(&f.dir.path().join("server.toml"))
                    .expect("fresh parsed registry")
                    .vaults
                    .len(),
                1
            );
            assert_eq!(f.state.len(), 1);
            let root = f.dir.path().join(if new {
                "Projects/New"
            } else {
                "Projects/Public"
            });
            let policy = AccessFile::load(&root).expect("fresh policy");
            assert_eq!(
                policy.policy().effective_role(
                    &Username::parse("alice").expect("creator"),
                    &mb_core::NotePath::parse("Readme.md").expect("path")
                ),
                mb_core::Role::Owner
            );
            no_temps(f.dir.path());
            println!(
                "MB_REGISTRATION_IO_ASSERTIONS_COMPLETED stage={stage} fault={fault:?} new={new}"
            );
        }
    }
}
