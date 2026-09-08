#![allow(clippy::expect_used)]

use criterion::{BatchSize, Criterion, criterion_group, criterion_main};
use mb_search::{AclHash, Change, Note, NoteId, Query, Segment, ZoneId};

fn metadata() -> (ZoneId, AclHash) {
    (
        ZoneId::from_hex(&"01".repeat(32)).expect("zone"),
        AclHash::from_hex(&"02".repeat(32)).expect("ACL"),
    )
}

fn notes(count: u32, suffix: &str) -> Vec<Change> {
    (0..count)
        .map(|number| {
            let mut id = [0_u8; 16];
            id.get_mut(0..4)
                .expect("four-byte prefix")
                .copy_from_slice(&number.to_be_bytes());
            let text = (0..500)
                .map(|offset| format!("term{}", (number * 149 + offset % 150) % 200_000))
                .chain(std::iter::once(suffix.to_string()))
                .collect::<Vec<_>>()
                .join(" ");
            Change::Upsert(Note {
                id: Some(NoteId::from_bytes(id)),
                title: format!("Generated note {number}"),
                path: format!("Generated/{number}.md"),
                tags: vec![format!("generated/group-{}", number % 100)],
                icon: None,
                text,
            })
        })
        .collect()
}

fn compact(criterion: &mut Criterion) {
    let (zone, acl) = metadata();
    let fixture = notes(1_000, "base");
    criterion.bench_function("compact build 1k x 500 words", |bencher| {
        bencher.iter_batched(
            || fixture.clone(),
            |changes| Segment::build(zone, acl, changes).expect("segment"),
            BatchSize::LargeInput,
        );
    });

    let segment = Segment::build(zone, acl, fixture).expect("segment");
    let query = Query::parse("term19 AND tag:group").expect("query");
    criterion.bench_function("compact prefix-and-field query 1k", |bencher| {
        bencher.iter(|| {
            segment
                .search(std::hint::black_box(&query))
                .expect("search")
        });
    });

    let delta = Segment::build(zone, acl, notes(100, "delta")).expect("delta");
    let base_bytes = segment.as_bytes().to_vec();
    let delta_bytes = delta.as_bytes().to_vec();
    criterion.bench_function("compact merge 1k plus 100", |bencher| {
        bencher.iter_batched(
            || {
                (
                    Segment::from_bytes(base_bytes.clone()).expect("base"),
                    Segment::from_bytes(delta_bytes.clone()).expect("delta"),
                )
            },
            |(base, delta)| Segment::merge(std::hint::black_box(&[base, delta])),
            BatchSize::LargeInput,
        );
    });
}

criterion_group!(benches, compact);
criterion_main!(benches);
