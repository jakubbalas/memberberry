//! Sync convergence under concurrency and partition (`SPEC.md` §22.3).
//!
//! N simulated clients edit one note from seeded-random scripts while the network partitions
//! and heals underneath them, and an external process rewrites the Markdown as an extra
//! participant. The assertion is the one that matters for C2: every replica ends at the same
//! CRDT state *and* the same serialized Markdown, and the file on disk is that Markdown.
//!
//! Sockets are deliberately not involved. Convergence is a property of the CRDT and the
//! coordinator; testing it through a WebSocket would add scheduling noise to a test whose
//! whole value is determinism. `tests/websocket.rs` covers the wire.
//!
//! Every case runs from a printed seed. A failure reproduces exactly with
//! `MB_CONVERGENCE_SEEDS=<seed> cargo test -p mb-server --test convergence`.

#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]

mod support;

use std::time::Instant;

use mb_core::Username;
use mb_crdt::{apply_external_markdown, document_from_update_v1, document_from_yrs};
use mb_server::Vault;
use mb_server::sync::{ConnectionId, ExternalUpdate, NoteCoordinator, ServerFrame, SyncRegistry};
use mb_server::vault::Slug;
use mb_server::watch::Changes;
use support::TempDir;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

/// SplitMix64. Inlined rather than pulled in as a dependency: a test needs a *stable*
/// sequence far more than a statistically excellent one, and vendoring three lines beats
/// letting a version bump silently change which interleavings this suite explores.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, bound: usize) -> usize {
        if bound == 0 {
            return 0;
        }
        usize::try_from(self.next() % bound as u64).unwrap_or(0)
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

/// One simulated editor: a replica plus whatever it has not yet been able to send.
struct Client {
    doc: Doc,
    /// What the server has acknowledged from this client, so updates are sent once.
    sent: StateVector,
    connected: bool,
}

impl Client {
    fn from(state: &[u8]) -> Self {
        let doc = document_from_update_v1(state).expect("initial state");
        let sent = doc.transact().state_vector();
        Self {
            doc,
            sent,
            connected: true,
        }
    }

    /// Rewrites this replica to `markdown`, as a local edit nobody else has seen yet.
    fn edit(&mut self, markdown: &str) {
        drop(apply_external_markdown(&self.doc, markdown));
    }

    /// The updates this replica owes the server, and the vector they bring it up to.
    fn pending(&mut self) -> Option<Vec<u8>> {
        let (update, now) = {
            let read = self.doc.transact();
            (
                read.encode_state_as_update_v1(&self.sent),
                read.state_vector(),
            )
        };
        // An update with no new operations still encodes to a short non-empty frame, so
        // compare vectors rather than trusting the length.
        if now == self.sent {
            return None;
        }
        self.sent = now;
        Some(update)
    }

    fn receive(&self, update: &[u8]) {
        if let Ok(update) = Update::decode_v1(update) {
            drop(self.doc.transact_mut().apply_update(update));
        }
    }

    fn markdown(&self) -> String {
        mb_core::to_markdown(&document_from_yrs(&self.doc).expect("valid replica"))
    }
}

/// The note bodies clients pick between. Deliberately varied in block structure, since the
/// external diff is block-granular (§3.4) and a single-paragraph corpus would never exercise
/// the insert/delete/retain paths.
const BODIES: &[&str] = &[
    "alpha\n",
    "alpha\n\nbeta\n",
    "# Heading\n\nalpha\n",
    "- one\n- two\n",
    "alpha\n\n- one\n- two\n\ngamma\n",
    "# Heading\n\n- [ ] a task\n\nbeta\n",
    "> a quote\n\nalpha\n",
    "alpha\n\nbeta\n\ngamma\n\ndelta\n",
];

fn body(rng: &mut Rng) -> &'static str {
    BODIES[rng.below(BODIES.len())]
}

/// Runs one seeded scenario and returns the Markdown everyone agreed on.
fn converge(seed: u64, clients: usize, rounds: usize) -> String {
    let dir = TempDir::new(&format!("convergence-{seed}"));
    let note = dir.write("One.md", "start\n");
    let vault = Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap();
    let canonical = vault.canonical_note("One.md").unwrap();
    let registry = SyncRegistry::default();
    let user = Username::parse("alice").unwrap();
    let (outbound, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    let ServerFrame::Sync { update: start, .. } = registry
        .subscribe(
            &vault,
            &canonical,
            "One.md",
            &user,
            ConnectionId::issue(),
            outbound,
        )
        .unwrap()
    else {
        panic!("subscribing returns the document state");
    };

    let mut rng = Rng(seed);
    let mut replicas: Vec<Client> = (0..clients).map(|_| Client::from(&start)).collect();
    // Updates a partitioned replica has missed, replayed to it when the partition heals.
    let mut backlog: Vec<Vec<Vec<u8>>> = vec![Vec::new(); clients];

    for _ in 0..rounds {
        // The network moves first, so an edit can be made while already partitioned.
        for replica in &mut replicas {
            if rng.chance(15) {
                replica.connected = !replica.connected;
            }
        }

        let who = rng.below(clients);
        let target = body(&mut rng);
        replicas[who].edit(target);

        // Everyone who can reach the server pushes what they owe it.
        for index in 0..clients {
            if !replicas[index].connected {
                continue;
            }
            let Some(update) = replicas[index].pending() else {
                continue;
            };
            if registry
                .apply_update(&vault, &canonical, &update, &|_, _, _| true)
                .is_err()
            {
                continue;
            }
            fan_out(&mut inbox, &replicas, &mut backlog);
        }

        // An external process — Obsidian, `git pull` — rewrites the file underneath us.
        if rng.chance(20) {
            std::fs::write(&note, body(&mut rng)).unwrap();
            drop(registry.maintain(Instant::now(), &Changes::All, &|_, _, _| true));
            fan_out(&mut inbox, &replicas, &mut backlog);
        }
    }

    // Heal every partition and let the system quiesce: replay backlogs, then keep pushing
    // and fanning out until a full pass moves nothing.
    for replica in &mut replicas {
        replica.connected = true;
    }
    for (index, missed) in backlog.iter_mut().enumerate() {
        for update in missed.drain(..) {
            replicas[index].receive(&update);
        }
    }
    for _ in 0..(clients * 4 + 8) {
        let mut moved = false;
        for index in 0..clients {
            let Some(update) = replicas[index].pending() else {
                continue;
            };
            if registry
                .apply_update(&vault, &canonical, &update, &|_, _, _| true)
                .is_ok()
            {
                moved = true;
                fan_out(&mut inbox, &replicas, &mut backlog);
            }
        }
        if !moved {
            break;
        }
    }
    // No second backlog drain: every replica is connected by now, so `fan_out` delivers
    // directly and the backlog cannot grow again. Verified by deleting it and watching
    // nothing change — a redundant safety net hides the case it was supposed to catch.
    assert!(
        backlog.iter().all(Vec::is_empty),
        "seed {seed}: healing left updates undelivered"
    );

    let agreed = replicas.first().expect("at least one replica").markdown();
    for (index, replica) in replicas.iter().enumerate() {
        assert_eq!(
            replica.markdown(),
            agreed,
            "seed {seed}: replica {index} did not converge"
        );
    }

    // The server is a replica too, and Layer 1 must be the same text (C2).
    assert!(registry.flush_all().is_empty(), "seed {seed}: flush failed");
    assert_eq!(
        std::fs::read_to_string(&note).unwrap(),
        agreed,
        "seed {seed}: the Markdown on disk diverged from the converged state"
    );

    let mut reopened = NoteCoordinator::open(&vault, &canonical).unwrap();
    assert_eq!(
        reopened.inspect_external_change().unwrap(),
        ExternalUpdate::SelfWrite,
        "seed {seed}: a restart must see its own write, not a phantom external edit"
    );
    agreed
}

/// Delivers everything the server has broadcast: to connected replicas now, to partitioned
/// ones as backlog.
fn fan_out(
    inbox: &mut tokio::sync::mpsc::UnboundedReceiver<ServerFrame>,
    replicas: &[Client],
    backlog: &mut [Vec<Vec<u8>>],
) {
    while let Ok(frame) = inbox.try_recv() {
        let (ServerFrame::Update { update, .. } | ServerFrame::Sync { update, .. }) = frame else {
            continue;
        };
        for (index, replica) in replicas.iter().enumerate() {
            if replica.connected {
                replica.receive(&update);
            } else {
                backlog[index].push(update.clone());
            }
        }
    }
}

/// The seeds this suite runs. Overridable so a CI failure can be replayed on its own.
fn seeds() -> Vec<u64> {
    match std::env::var("MB_CONVERGENCE_SEEDS") {
        Ok(list) => list
            .split(',')
            .filter_map(|seed| seed.trim().parse().ok())
            .collect(),
        Err(_) => (1..=24).collect(),
    }
}

#[test]
fn replicas_converge_through_partitions_and_external_edits() {
    for seed in seeds() {
        println!("convergence seed {seed}");
        let agreed = converge(seed, 4, 40);
        assert!(
            !agreed.is_empty(),
            "seed {seed}: converged on an empty note, which means nothing was exercised"
        );
    }
}

#[test]
fn a_single_client_round_trips_every_body_unchanged() {
    // Guards the corpus itself: if a body does not survive parse → CRDT → serialize, the
    // convergence assertions above would be comparing two equally wrong strings.
    let dir = TempDir::new("convergence-corpus");
    let note = dir.write("One.md", "start\n");
    let vault = Vault::open(Slug::parse("personal").unwrap(), "Personal", dir.path()).unwrap();
    let canonical = vault.canonical_note("One.md").unwrap();

    for source in BODIES {
        std::fs::write(&note, source).unwrap();
        let mut coordinator = NoteCoordinator::open(&vault, &canonical).unwrap();
        drop(coordinator.inspect_external_change().unwrap());
        let document =
            document_from_yrs(&document_from_update_v1(&coordinator.full_update()).expect("state"))
                .expect("valid document");
        assert_eq!(&mb_core::to_markdown(&document), source);
        std::fs::remove_dir_all(dir.path().join(".memberberry")).unwrap();
    }
}

#[test]
fn heavier_concurrency_still_converges() {
    // More replicas per document than §7.5's five-participant budget, to make interleavings
    // that a four-client run would only reach occasionally the common case instead.
    for seed in [101_u64, 202, 303] {
        println!("heavy convergence seed {seed}");
        drop(converge(seed, 8, 60));
    }
}
