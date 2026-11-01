//! Shared E32 folder-deletion behavior and authorization cases.
use super::support::TempDir;
use mb_core::Username;
use mb_server::repository::{AuthorizedVault, FolderDeleteError};
use mb_server::sync::SyncRegistry;
use mb_server::trash::TrashStore;
use mb_server::vault::Slug;
use mb_server::{AccessFile, Vault};

pub fn permission_preflight() {
    let dir = TempDir::new("folder-delete-permission");
    dir.write("Source/Public.md", "# Public\n");
    dir.write("Source/Secret.md", "# Secret\n");
    dir.write("Private/Note.md", "# Private\n");
    dir.write("ReadOnly/Note.md", "# Read only\n");
    std::fs::create_dir(dir.path().join("ProtectedEmpty")).expect("empty folder");
    dir.write("access.toml", "[[members]]\nuser = \"alice\"\nrole = \"owner\"\n[[members]]\nuser = \"bob\"\nrole = \"editor\"\n[[members]]\nuser = \"viewer\"\nrole = \"viewer\"\n[[rules]]\npath = \"Source/Secret.md\"\ngrant = { bob = \"none\" }\n[[rules]]\npath = \"Private\"\ngrant = { bob = \"none\" }\n[[rules]]\npath = \"ReadOnly/Note.md\"\ngrant = { bob = \"viewer\" }\n[[rules]]\npath = \"ProtectedEmpty\"\ngrant = { bob = \"viewer\" }\n");
    let vault = Vault::open(Slug::parse("v").expect("slug"), "V", dir.path()).expect("vault");
    let access = AccessFile::load(vault.root()).expect("access");
    let sync = SyncRegistry::default();
    for actor in ["bob", "viewer", "guest"] {
        let view = AuthorizedVault::new(
            &vault,
            access.policy(),
            Username::parse(actor).expect("user"),
        );
        for path in [
            "Source",
            "ReadOnly",
            "Private",
            "Private/Missing",
            "ProtectedEmpty",
        ] {
            // No confirmation is supplied: authorization must precede emptiness disclosure.
            assert!(matches!(
                view.delete_folder(path, None, &sync, 100),
                Err(FolderDeleteError::Denied)
            ));
        }
    }
    assert_eq!(
        std::fs::read_to_string(dir.path().join("Source/Public.md")).expect("untouched"),
        "# Public\n"
    );
    assert!(TrashStore::new(&vault).inspect().expect("trash").is_empty());
    // Positive control: a fully authorized caller reaches the confirmation guard.
    let owner = AuthorizedVault::new(
        &vault,
        access.policy(),
        Username::parse("alice").expect("user"),
    );
    assert!(matches!(
        owner.delete_folder("Source", None, &sync, 100),
        Err(FolderDeleteError::ConfirmationRequired)
    ));
    owner
        .delete_folder("Source", Some("Source"), &sync, 100)
        .expect("delete");
    assert!(!dir.path().join("Source").exists());
    assert_eq!(TrashStore::new(&vault).inspect().expect("trash").len(), 2);
}
