//! Task inbox queries (`SPEC.md` §10.3) and their E5 boundary.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

mod support;

use mb_core::task::{Date, Priority};
use mb_index::{TaskQuery, TaskSort};
use support::{indexed, user, viewer_everywhere, viewer_except};

fn date(value: &str) -> Date {
    Date::parse(value).expect("test date")
}

#[test]
fn inbox_lists_only_open_tasks_and_keeps_source_locations() {
    let mut index = indexed(&[(
        "Projects/Plan.md",
        "# Plan\n\n- [ ] Ship it 📅 2026-09-10 ➕ 2026-09-01 ⏫ ^ship\n- [x] Finished ✅ 2026-09-02\n- [-] Cancelled ❌ 2026-09-03\n",
    )]);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");

    let tasks = reader.tasks(&TaskQuery::default()).expect("tasks");
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].path, "Projects/Plan.md");
    assert_eq!(tasks[0].block_id.as_deref(), Some("ship"));
    assert_eq!(tasks[0].text, "Ship it");
    assert_eq!(tasks[0].due.as_deref(), Some("2026-09-10"));
    assert_eq!(tasks[0].created.as_deref(), Some("2026-09-01"));
    assert_eq!(tasks[0].priority, Some(Priority::High));
}

#[test]
fn filters_compose_over_folder_tag_priority_due_date_and_note() {
    let mut index = indexed(&[
        (
            "Projects/Plan.md",
            "---\ntags: [work/shipping]\n---\n\n- [ ] Match 📅 2026-09-10 ⏫ ^match\n",
        ),
        (
            "Projects/Other.md",
            "---\ntags: [work]\n---\n\n- [ ] Wrong priority 📅 2026-09-10 🔽\n",
        ),
        (
            "Archive/Plan.md",
            "---\ntags: [work/shipping]\n---\n\n- [ ] Wrong folder 📅 2026-09-10 ⏫\n",
        ),
    ]);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");
    let query = TaskQuery {
        folder: Some("Projects".to_string()),
        tag: Some("#work".to_string()),
        priority: Some(Priority::High),
        due_from: Some(date("2026-09-09")),
        due_to: Some(date("2026-09-11")),
        note: Some("Projects/Plan.md".to_string()),
        sort: TaskSort::Due,
    };

    let tasks = reader.tasks(&query).expect("tasks");
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].text, "Match");
}

#[test]
fn sort_orders_are_deterministic_and_place_missing_values_last() {
    let mut index = indexed(&[
        ("Later.md", "- [ ] Later 📅 2026-09-12 ➕ 2026-09-05 🔽\n"),
        ("Early.md", "- [ ] Early 📅 2026-09-10 ➕ 2026-09-01 ⏫\n"),
        ("None.md", "- [ ] No values\n"),
    ]);
    let access = viewer_everywhere("alice");
    let reader = index.reader(&access, &user("alice")).expect("reader");

    for (sort, expected) in [
        (TaskSort::Due, ["Early.md", "Later.md", "None.md"]),
        (TaskSort::Priority, ["Early.md", "Later.md", "None.md"]),
        (TaskSort::Created, ["Early.md", "Later.md", "None.md"]),
        (TaskSort::Path, ["Early.md", "Later.md", "None.md"]),
    ] {
        let tasks = reader
            .tasks(&TaskQuery {
                sort,
                ..TaskQuery::default()
            })
            .expect("tasks");
        let paths: Vec<_> = tasks.iter().map(|task| task.path.as_str()).collect();
        assert_eq!(paths, expected, "sort {sort:?}");
    }
}

#[test]
fn e5_task_rows_and_text_from_unreadable_notes_are_absent() {
    let mut index = indexed(&[
        ("Shared.md", "- [ ] Visible task 📅 2026-09-10\n"),
        (
            "Private/Salary.md",
            "- [ ] Canary compensation task 📅 2026-09-09 🔺\n",
        ),
    ]);
    let limited = viewer_except("alice", &["Private"]);
    let reader = index.reader(&limited, &user("alice")).expect("reader");

    let tasks = reader.tasks(&TaskQuery::default()).expect("tasks");
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].path, "Shared.md");
    assert!(!tasks.iter().any(|task| task.text.contains("Canary")));
}
