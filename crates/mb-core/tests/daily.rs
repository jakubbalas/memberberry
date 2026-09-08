//! Calendar-note path tests, including format/parse round-trip invariants.

#![allow(clippy::unwrap_used)]

use mb_core::daily::{Period, date_from_path, path, periodic_date_from_path, periodic_path};
use mb_core::task::Date;
use proptest::prelude::*;

#[test]
fn formats_and_parses_a_daily_path() {
    let date = Date::parse("2026-09-08").unwrap();
    let note = path("Daily/", "%Y-%m-%d.md", date).unwrap();
    assert_eq!(note, "Daily/2026-09-08.md");
    assert_eq!(date_from_path("Daily/", "%Y-%m-%d.md", &note), Some(date));
}

#[test]
fn parses_directives_in_the_configured_order() {
    let date = Date::parse("2026-09-08").unwrap();
    let note = path("Journal/", "%d-%m-%Y.md", date).unwrap();
    assert_eq!(note, "Journal/08-09-2026.md");
    assert_eq!(date_from_path("Journal/", "%d-%m-%Y.md", &note), Some(date));
}

#[test]
fn weekly_and_monthly_paths_use_their_period_identity() {
    let new_year = Date::parse("2021-01-01").unwrap();
    let weekly = periodic_path(Period::Weekly, "Weekly/", "%G-W%V.md", new_year).unwrap();
    assert_eq!(weekly, "Weekly/2020-W53.md");
    assert_eq!(
        periodic_date_from_path(Period::Weekly, "Weekly/", "%G-W%V.md", &weekly),
        Date::parse("2020-12-28")
    );

    let monthly = periodic_path(Period::Monthly, "Monthly/", "%Y-%m.md", new_year).unwrap();
    assert_eq!(monthly, "Monthly/2021-01.md");
    assert_eq!(
        periodic_date_from_path(Period::Monthly, "Monthly/", "%Y-%m.md", &monthly),
        Date::parse("2021-01-01")
    );
}

#[test]
fn rejects_unsafe_folder_and_unknown_directive() {
    let date = Date::parse("2026-09-08").unwrap();
    assert_eq!(path("../Outside/", "%Y-%m-%d.md", date), None);
    assert_eq!(path("Daily/", "%Q.md", date), None);
}

#[test]
fn rejects_impossible_dates_and_non_matching_paths() {
    let date = Date::parse("2026-02-28").unwrap();
    assert_eq!(
        date_from_path("Daily/", "%Y-%m-%d.md", "Daily/2026-02-29.md"),
        None
    );
    assert_eq!(
        date_from_path("Daily/", "%Y-%m-%d.md", "Other/2026-02-28.md"),
        None
    );
    assert_eq!(path("Daily/", "%Y-%m-%d.txt", date), None);
}

proptest! {
    #[test]
    fn supported_daily_formats_round_trip(
        year in 1i32..=9999,
        month in 1u8..=12,
        day in 1u8..=31,
        format in prop_oneof![Just("%Y-%m-%d.md"), Just("%d.%m.%Y.md"), Just("%Y/%m/%d.md")],
    ) {
        let Some(date) = Date::new(year, month, day) else { return Ok(()); };
        let note = path("Daily/", format, date).unwrap();
        prop_assert_eq!(date_from_path("Daily/", format, &note), Some(date));
    }

    #[test]
    fn weekly_and_monthly_formats_round_trip(
        year in 1i32..=9999,
        month in 1u8..=12,
        day in 1u8..=31,
    ) {
        let Some(date) = Date::new(year, month, day) else { return Ok(()); };
        for (period, format) in [(Period::Weekly, "%G-W%V.md"), (Period::Monthly, "%Y-%m.md")] {
            let note = periodic_path(period, "Period/", format, date).unwrap();
            let parsed = periodic_date_from_path(period, "Period/", format, &note).unwrap();
            prop_assert_eq!(periodic_path(period, "Period/", format, parsed), Some(note));
        }
    }
}
