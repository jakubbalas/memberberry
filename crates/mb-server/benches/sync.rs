//! Sync hot-path benchmarks (`AGENTS.md` §4.5, `SPEC.md` §21).
//!
//! What matters here is *shape*, not the absolute number: the budget target is a mid-range
//! Android phone, and this runs on a developer's laptop. So each benchmark is parameterized
//! by document size, and the question being asked is whether the cost per accepted update
//! grows with the document. It does — see `apply_remote_update`, which round-trips the whole
//! document to validate a change of a few bytes — and that is recorded here rather than
//! asserted away, so the next person to touch the path can see what they are changing.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::hint::black_box;
use std::time::Instant;

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use mb_crdt::{apply_external_markdown, document_from_update_v1};
use mb_server::Vault;
use mb_server::sync::{NoteCoordinator, ServerFrame};
use mb_server::vault::Slug;

/// Note sizes to measure across. 5k words is §21's "open a note" budget line.
const BLOCK_COUNTS: [usize; 4] = [10, 100, 500, 2_000];

/// A vault directory that cleans itself up. The bench harness cannot use `tests/support`.
struct Scratch(std::path::PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("memberberry-bench-{name}"));
        drop(std::fs::remove_dir_all(&path));
        std::fs::create_dir_all(&path).expect("scratch vault");
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        drop(std::fs::remove_dir_all(&self.0));
    }
}

/// A note body of `blocks` paragraphs, in the shape a real note has.
fn body(blocks: usize) -> String {
    let mut markdown = String::with_capacity(blocks * 48);
    for index in 0..blocks {
        markdown.push_str(&format!(
            "Paragraph {index} of a note that is long enough to be worth measuring.\n\n"
        ));
    }
    markdown.truncate(markdown.trim_end().len());
    markdown.push('\n');
    markdown
}

/// Opens a coordinator over a fresh vault containing `markdown`.
fn coordinator(scratch: &Scratch, markdown: &str) -> (Vault, NoteCoordinator) {
    drop(std::fs::remove_dir_all(scratch.0.join(".memberberry")));
    std::fs::write(scratch.0.join("One.md"), markdown).expect("note");
    let vault = Vault::open(
        Slug::parse("bench").expect("slug"),
        "Bench",
        scratch.0.clone(),
    )
    .expect("vault");
    let canonical = vault.canonical_note("One.md").expect("canonical");
    let coordinator = NoteCoordinator::open(&vault, &canonical).expect("coordinator");
    (vault, coordinator)
}

/// The lib0 update a client sends after appending one paragraph.
fn one_more_paragraph(coordinator: &NoteCoordinator, markdown: &str) -> Vec<u8> {
    use yrs::{ReadTxn, Transact};
    let replica = document_from_update_v1(&coordinator.full_update()).expect("replica");
    let vector = {
        let read = replica.transact();
        read.state_vector()
    };
    let mut extended = markdown.to_string();
    extended.push_str("\nOne more paragraph.\n");
    apply_external_markdown(&replica, &extended).expect("edit");
    let read = replica.transact();
    read.encode_state_as_update_v1(&vector)
}

/// The per-keystroke server cost: validate an incoming update, persist it, apply it.
fn accept_update(c: &mut Criterion) {
    let scratch = Scratch::new("accept-update");
    let mut group = c.benchmark_group("sync/accept_update");
    for blocks in BLOCK_COUNTS {
        let markdown = body(blocks);
        group.throughput(Throughput::Elements(1));
        group.bench_with_input(BenchmarkId::from_parameter(blocks), &blocks, |b, _| {
            b.iter_batched(
                || {
                    let (vault, coordinator) = coordinator(&scratch, &markdown);
                    let update = one_more_paragraph(&coordinator, &markdown);
                    (vault, coordinator, update)
                },
                |(_vault, mut coordinator, update)| {
                    coordinator
                        .apply_remote_update(black_box(&update), Instant::now())
                        .expect("accept")
                },
                criterion::BatchSize::SmallInput,
            );
        });
    }
    group.finish();
}

/// Materializing the CRDT back to Markdown — the debounced write, once per 800ms of typing.
fn materialize(c: &mut Criterion) {
    let scratch = Scratch::new("materialize");
    let mut group = c.benchmark_group("sync/materialize");
    for blocks in BLOCK_COUNTS {
        let markdown = body(blocks);
        group.throughput(Throughput::Bytes(markdown.len() as u64));
        group.bench_with_input(BenchmarkId::from_parameter(blocks), &blocks, |b, _| {
            b.iter_batched(
                || coordinator(&scratch, &markdown),
                |(_vault, mut coordinator)| coordinator.flush().expect("flush"),
                criterion::BatchSize::SmallInput,
            );
        });
    }
    group.finish();
}

/// Framing a broadcast. Measured because it replaced a JSON number-array encoding whose cost
/// scaled with the payload; if that ever creeps back, this is where it shows.
fn encode_frame(c: &mut Criterion) {
    let scratch = Scratch::new("encode-frame");
    let mut group = c.benchmark_group("sync/encode_frame");
    for blocks in BLOCK_COUNTS {
        let markdown = body(blocks);
        let (_vault, coordinator) = coordinator(&scratch, &markdown);
        let update = coordinator.full_update();
        group.throughput(Throughput::Bytes(update.len() as u64));
        group.bench_with_input(BenchmarkId::from_parameter(blocks), &blocks, |b, _| {
            let frame = ServerFrame::Update {
                vault: "bench".to_string(),
                note: "One.md".to_string(),
                update: update.clone(),
            };
            b.iter(|| black_box(&frame).to_wire().expect("wire"));
        });
        // The encoding this replaced, kept as a measured comparison rather than a claim in a
        // commit message. Serde renders `Vec<u8>` as a JSON array of decimal numbers.
        group.bench_with_input(
            BenchmarkId::new("json_for_comparison", blocks),
            &blocks,
            |b, _| {
                let frame = serde_json::json!({
                    "type": "update",
                    "vault": "bench",
                    "note": "One.md",
                    "update": update,
                });
                b.iter(|| serde_json::to_string(black_box(&frame)).expect("json"));
            },
        );
    }
    group.finish();
}

criterion_group!(benches, accept_update, materialize, encode_frame);
criterion_main!(benches);
