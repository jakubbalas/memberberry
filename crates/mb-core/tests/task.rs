//! Task metadata in Obsidian Tasks syntax (`SPEC.md` §10).
//!
//! §10.1 chose emoji markers over a cleaner field syntax purely for C5 — this is the de
//! facto standard across the Obsidian Tasks ecosystem, so tasks have to round-trip with
//! tooling the user already has. That makes fidelity to *their* format, including its
//! oddities, the thing worth testing.
//!
//! The property that matters most is at the bottom: any metadata this version does not
//! understand is re-emitted verbatim. Recurrence is deferred (§10.4), and a user with
//! recurring tasks must not lose them on their first edit.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use mb_core::model::BlockKind;
use mb_core::task::{Date, Priority, Task, TaskMeta, TaskStatus};
use mb_core::{normalize, parse};

fn task_of(md: &str) -> Task {
    match parse(md).blocks.into_iter().next().expect("a block").kind {
        BlockKind::List(l) => l
            .items
            .into_iter()
            .next()
            .expect("an item")
            .task
            .expect("a task"),
        other => panic!("expected a list, got {other:?}"),
    }
}

// ---------------------------------------------------------------- dates

#[test]
fn a_date_round_trips_through_parse_and_display() {
    let d = Date::parse("2026-09-05").expect("valid");
    assert_eq!((d.year(), d.month(), d.day()), (2026, 9, 5));
    assert_eq!(d.to_string(), "2026-09-05");
}

#[test]
fn a_date_is_zero_padded_when_rendered() {
    assert_eq!(
        Date::new(2026, 1, 2).expect("valid").to_string(),
        "2026-01-02"
    );
}

#[test]
fn only_exactly_yyyy_mm_dd_parses() {
    for bad in [
        "2026-9-5",    // unpadded
        "2026-09-5",   // partially padded
        "26-09-05",    // short year
        "2026/09/05",  // wrong separator
        "2026-09-05 ", // trailing space
        " 2026-09-05", // leading space
        "2026-09-050", // too long
        "2026-09",     // partial
        "",
        "abcd-ef-gh", // right shape, not digits
        "2026-ab-05",
        "2026-09-cd",
    ] {
        assert_eq!(Date::parse(bad), None, "{bad:?} must not parse");
    }
}

#[test]
fn an_impossible_calendar_date_is_unrepresentable() {
    assert_eq!(Date::new(2026, 0, 1), None, "month 0");
    assert_eq!(Date::new(2026, 13, 1), None, "month 13");
    assert_eq!(Date::new(2026, 1, 0), None, "day 0");
    assert_eq!(Date::new(2026, 1, 32), None, "day 32");
    assert_eq!(Date::new(2026, 4, 31), None, "April has 30 days");
    assert_eq!(Date::parse("2026-02-30"), None);
}

/// The day `Date::from_unix_millis` should answer for, spelled out.
fn at(millis: i64) -> String {
    Date::from_unix_millis(millis).map_or_else(|| "none".to_string(), |d| d.to_string())
}

#[test]
fn the_unix_epoch_is_the_first_of_january_1970() {
    assert_eq!(at(0), "1970-01-01");
    assert_eq!(at(86_399_999), "1970-01-01", "the last millisecond of it");
    assert_eq!(at(86_400_000), "1970-01-02");
}

#[test]
fn a_timestamp_before_the_epoch_is_the_day_before_it() {
    // why: this is the floor-division case. Rust truncates towards zero, so a naive
    // division puts every negative timestamp on 1970-01-01.
    assert_eq!(at(-1), "1969-12-31");
    assert_eq!(at(-86_400_000), "1969-12-31");
    assert_eq!(at(-86_400_001), "1969-12-30");
}

#[test]
fn the_century_leap_year_rules_hold() {
    // 2000 is a leap year, 1900 is not — the case that catches an algorithm using only
    // "divisible by four".
    assert_eq!(at(951_782_400_000), "2000-02-29");
    assert_eq!(at(-2_203_977_600_000), "1900-02-28");
    assert_eq!(at(-2_203_891_200_000), "1900-03-01");
}

#[test]
fn a_uuid_v7_timestamp_reads_as_the_day_it_was_minted() {
    // 2026-09-05T12:34:56.789Z — the shape §4.3's `id` carries, at millisecond precision.
    assert_eq!(at(1_788_611_696_789), "2026-09-05");
}

#[test]
fn the_extremes_of_an_i64_still_land_on_a_calendar_date() {
    // why: this is what makes `from_unix_millis` total. `i64` milliseconds reach about
    // 292 million years either side of the epoch, which is inside the years a `Date` holds,
    // so there is no input for which it answers `None` — and none on which the arithmetic
    // overflows, which is what a debug build would catch here.
    assert_eq!(at(i64::MAX), "292278994-08-17");
    assert_eq!(at(i64::MIN), "-292275055-05-16");
}

#[test]
fn every_day_of_a_four_hundred_year_cycle_advances_by_exactly_one() {
    // why: an independent check rather than a round-trip through an inverse this module
    // does not have. If consecutive days always advance the calendar by one — rolling the
    // month when the month ends and the year when December does — then the mapping is the
    // Gregorian calendar, and a leap-year rule that is off by a day cannot survive it.
    // 400 years is the full leap cycle, so 1800-2200 covers both century rules.
    let start = Date::new(1800, 1, 1).expect("valid").to_string();
    let mut millis = -5_364_662_400_000_i64;
    assert_eq!(at(millis), start, "the walk starts where it means to");

    let (mut year, mut month, mut day) = (1800_i32, 1_u8, 1_u8);
    for _ in 0..146_097 {
        millis += 86_400_000;
        let next = Date::new(year, month, day + 1)
            .or_else(|| Date::new(year, month + 1, 1))
            .or_else(|| Date::new(year + 1, 1, 1))
            .expect("some following day exists");
        (year, month, day) = (next.year(), next.month(), next.day());
        assert_eq!(
            at(millis),
            next.to_string(),
            "the day after {year}-{month}-{day} disagrees"
        );
    }
    assert_eq!(at(millis), "2200-01-01", "400 years later to the day");
}

#[test]
fn month_lengths_are_right_including_leap_years() {
    for (m, len) in [
        (1, 31),
        (3, 31),
        (4, 30),
        (5, 31),
        (6, 30),
        (7, 31),
        (8, 31),
        (9, 30),
        (10, 31),
        (11, 30),
        (12, 31),
    ] {
        assert!(
            Date::new(2026, m, len).is_some(),
            "month {m} should have {len} days"
        );
        assert!(
            Date::new(2026, m, len + 1).is_none(),
            "month {m} should not have {} days",
            len + 1
        );
    }
    // February, across the full Gregorian rule.
    assert!(
        Date::new(2026, 2, 28).is_some() && Date::new(2026, 2, 29).is_none(),
        "2026 is common"
    );
    assert!(Date::new(2024, 2, 29).is_some(), "2024 is a leap year");
    assert!(
        Date::new(2000, 2, 29).is_some(),
        "2000 is a leap year: divisible by 400"
    );
    assert!(
        Date::new(1900, 2, 29).is_none(),
        "1900 is not: divisible by 100, not 400"
    );
}

#[test]
fn dates_order_chronologically() {
    let a = Date::new(2026, 1, 31).expect("valid");
    let b = Date::new(2026, 2, 1).expect("valid");
    assert!(a < b);
    assert!(Date::new(2025, 12, 31).expect("valid") < a);
}

// ---------------------------------------------------------------- markers

#[test]
fn every_status_marker_round_trips() {
    for (marker, status) in [
        (' ', TaskStatus::Todo),
        ('x', TaskStatus::Done),
        ('-', TaskStatus::Cancelled),
    ] {
        assert_eq!(TaskStatus::from_marker(marker), Some(status));
        assert_eq!(status.marker(), marker);
    }
    // Obsidian writes `[X]` too, and it means the same thing.
    assert_eq!(TaskStatus::from_marker('X'), Some(TaskStatus::Done));
    assert_eq!(TaskStatus::from_marker('?'), None);
}

#[test]
fn every_priority_marker_round_trips() {
    for p in [
        Priority::Highest,
        Priority::High,
        Priority::Medium,
        Priority::Low,
        Priority::Lowest,
    ] {
        assert_eq!(Priority::from_marker(p.marker()), Some(p));
    }
    assert_eq!(Priority::from_marker('x'), None);
}

#[test]
fn priorities_order_from_lowest_to_highest() {
    assert!(Priority::Lowest < Priority::Low);
    assert!(Priority::Low < Priority::Medium);
    assert!(Priority::Medium < Priority::High);
    assert!(Priority::High < Priority::Highest);
}

// ---------------------------------------------------------------- parsing

#[test]
fn every_date_field_parses() {
    let t = task_of(
        "- [ ] all ➕ 2026-01-01 🛫 2026-02-02 ⏳ 2026-03-03 📅 2026-04-04 ✅ 2026-05-05 ❌ 2026-06-06\n",
    );
    assert_eq!(t.meta.created, Date::new(2026, 1, 1));
    assert_eq!(t.meta.start, Date::new(2026, 2, 2));
    assert_eq!(t.meta.scheduled, Date::new(2026, 3, 3));
    assert_eq!(t.meta.due, Date::new(2026, 4, 4));
    assert_eq!(t.meta.done, Date::new(2026, 5, 5));
    assert_eq!(t.meta.cancelled, Date::new(2026, 6, 6));
}

#[test]
fn a_date_glued_to_its_marker_parses() {
    // Obsidian tolerates `📅2026-09-05` with no space; so must we, or the date is lost.
    assert_eq!(
        task_of("- [ ] x 📅2026-09-05\n").meta.due,
        Date::new(2026, 9, 5)
    );
}

#[test]
fn a_marker_without_a_usable_date_stays_prose() {
    // `📅 tomorrow` is not something this version understands. It must not be swallowed,
    // and it must not become a bogus date.
    let t = task_of("- [ ] x 📅 tomorrow\n");
    assert_eq!(t.meta.due, None);
    assert_eq!(normalize("- [ ] x 📅 tomorrow\n"), "- [ ] x 📅 tomorrow\n");
}

#[test]
fn a_marker_at_the_very_end_with_no_date_stays_prose() {
    let t = task_of("- [ ] x 📅\n");
    assert_eq!(t.meta.due, None);
    assert_eq!(normalize("- [ ] x 📅\n"), "- [ ] x 📅\n");
}

#[test]
fn metadata_is_re_emitted_in_canonical_order_regardless_of_input_order() {
    // §10.1 fixes the order so one task has one rendering.
    let scrambled = "- [ ] x ✅ 2026-05-05 🔺 📅 2026-04-04 ➕ 2026-01-01\n";
    assert_eq!(
        normalize(scrambled),
        "- [ ] x ➕ 2026-01-01 📅 2026-04-04 ✅ 2026-05-05 🔺\n"
    );
}

#[test]
fn a_task_with_no_metadata_renders_none() {
    assert!(task_of("- [ ] plain\n").meta.is_empty());
    assert_eq!(normalize("- [ ] plain\n"), "- [ ] plain\n");
}

// ---------------------------------------------------------------- the C5 property

#[test]
fn unrecognised_metadata_is_preserved_verbatim_and_in_order() {
    // §10.4 defers recurrence. A user with recurring tasks must not lose them on the first
    // edit — this is the whole reason `TaskMeta::unknown` exists.
    for source in [
        "- [ ] x 🔁 every day\n",
        "- [ ] x 🔁 every week 📅 2026-04-04\n",
        "- [ ] x 📅 2026-04-04 🔁 every month\n",
        "- [ ] x 🆔 abc123\n",
        "- [ ] x ⛔ dependency\n",
    ] {
        let out = normalize(source);
        for fragment in [
            "every day",
            "every week",
            "every month",
            "abc123",
            "dependency",
        ] {
            if source.contains(fragment) {
                assert!(
                    out.contains(fragment),
                    "{fragment:?} lost from {source:?} -> {out:?}"
                );
            }
        }
        assert_eq!(normalize(&out), out, "did not converge for {source:?}");
    }
}

#[test]
fn recurrence_is_kept_but_not_interpreted() {
    let t = task_of("- [ ] x 🔁 every day\n");
    assert!(
        !t.meta.unknown.is_empty(),
        "recurrence must be captured verbatim"
    );
    assert!(t.meta.unknown.iter().any(|u| u.contains("every day")));
}

#[test]
fn an_empty_task_meta_is_empty() {
    assert!(TaskMeta::default().is_empty());
    let meta = TaskMeta {
        priority: Some(Priority::Low),
        ..TaskMeta::default()
    };
    assert!(!meta.is_empty());
}

#[test]
fn a_task_with_metadata_and_an_anchor_keeps_both_in_the_right_order() {
    // The anchor must stay last on the line or it stops being an anchor.
    let source = "- [ ] x ⏫ ^task-1\n";
    assert_eq!(normalize(source), source);
    let t = task_of(source);
    assert_eq!(t.meta.priority, Some(Priority::High));
}
