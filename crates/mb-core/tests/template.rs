//! Template expansion tests, including the invariant that unknown input is preserved.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use mb_core::task::Date;
use mb_core::template::{Context, expand};
use proptest::prelude::*;

fn context<'a>(date: Date, title: &'a str, selection: &'a str) -> Context<'a> {
    Context {
        date,
        time: (7, 8, 9),
        title,
        selection,
        uuid: "0199226e-7c00-7000-8000-000000000001",
        user: "Alice",
    }
}

#[test]
fn expands_the_complete_variable_set() {
    let date = Date::new(2026, 9, 8).expect("valid date");
    let result = expand(
        "{{date}} {{time}} {{date:%Y/%m/%d}} {{time:%H:%M}} {{title}} {{selection}} {{uuid}} {{user}} {{yesterday}} {{tomorrow}} {{date+3d}} {{date-2d}} {{cursor}}.",
        context(date, "Daily", "chosen"),
    );

    assert_eq!(
        result.text,
        "2026-09-08 07:08:09 2026/09/08 07:08 Daily chosen 0199226e-7c00-7000-8000-000000000001 Alice 2026-09-07 2026-09-09 2026-09-11 2026-09-06 ."
    );
    assert_eq!(result.cursor, Some(result.text.len() - 1));
}

#[test]
fn unknown_and_unclosed_variables_are_left_verbatim() {
    let date = Date::new(2026, 9, 8).expect("valid date");
    let result = expand(
        "a {{unknown}} b {{date:%Q}} c {{unclosed",
        context(date, "", ""),
    );

    assert_eq!(result.text, "a {{unknown}} b %Q c {{unclosed");
    assert_eq!(result.cursor, None);
}

#[test]
fn cursor_is_removed_and_first_cursor_wins() {
    let date = Date::new(2026, 9, 8).expect("valid date");
    let result = expand(
        "before{{cursor}}middle{{cursor}}after",
        context(date, "", ""),
    );

    assert_eq!(result.text, "beforemiddleafter");
    assert_eq!(result.cursor, Some(6));
}

#[test]
fn relative_dates_cross_month_year_and_leap_boundaries() {
    for (source, before, after) in [
        ("2024-03-01", "2024-02-29", "2024-03-02"),
        ("2026-01-01", "2025-12-31", "2026-01-02"),
    ] {
        let date = Date::parse(source).expect("valid date");
        let result = expand("{{yesterday}} {{tomorrow}}", context(date, "", ""));
        assert_eq!(result.text, format!("{before} {after}"));
    }
}

proptest! {
    #[test]
    fn calendar_relative_variables_are_real_dates(
        year in 1970i32..2100,
        month in 1u8..=12,
        day in 1u8..=28,
        offset in -365i64..=365,
    ) {
        let date = Date::new(year, month, day).expect("day 1..28 is valid");
        let expanded = expand("{{date}}{{date+3d}}{{date-2d}}", context(date, "", ""));
        prop_assert_eq!(&expanded.text[..10], date.to_string());
        let expected_plus = date.checked_add_days(3).expect("range stays representable");
        let expected_minus = date.checked_add_days(-2).expect("range stays representable");
        prop_assert_eq!(&expanded.text[10..20], expected_plus.to_string());
        prop_assert_eq!(&expanded.text[20..30], expected_minus.to_string());
        let shifted = date.checked_add_days(offset).expect("range stays representable");
        prop_assert_eq!(shifted.checked_add_days(-offset), Some(date));
    }
}
