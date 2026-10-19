//! Bounded watcher-signal hot-path cost, not an Android/UI performance claim.
//! Uses the existing Criterion dependency; no filesystem scans occur in this path.
use criterion::{Criterion, criterion_group, criterion_main};
use mb_server::watch::WatchSignal;
use std::hint::black_box;
use std::path::PathBuf;

fn signal_cost(c: &mut Criterion) {
    c.bench_function("watch_signal/touched_and_take", |b| {
        let signal = WatchSignal::default();
        let path = PathBuf::from("/fixture/Project/Note.md");
        b.iter(|| {
            signal.touched(black_box(path.clone()));
            black_box(signal.take());
        });
    });
    c.bench_function("watch_signal/burst_1024_then_take", |b| {
        let signal = WatchSignal::default();
        let paths = (0..1024)
            .map(|i| PathBuf::from(format!("/fixture/Project/Note-{i}.md")))
            .collect::<Vec<_>>();
        b.iter(|| {
            for path in &paths {
                signal.touched(black_box(path.clone()));
            }
            black_box(signal.take());
        });
    });
}
criterion_group!(benches, signal_cost);
criterion_main!(benches);
