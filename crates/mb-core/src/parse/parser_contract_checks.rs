//! Exact parser-context observations, measured before canonical/render reentry.
use super::*;
use std::cell::{Cell, RefCell};
#[derive(Default, Clone, Debug)]
pub(super) struct Observation {
    pub contexts: usize,
    pub authority_passes: usize,
    pub authority_bytes: usize,
    pub authority_events: usize,
    pub candidate_builds: usize,
    pub prefix_builds: usize,
    pub legacy_fallbacks: usize,
    pub structural_parses: usize,
    pub structural_bytes: usize,
    pub structural_events: usize,
    pub local_parses: usize,
    pub local_bytes: usize,
    pub local_events: usize,
    pub token_inserts: usize,
    pub token_restores: usize,
    pub map_segments: usize,
    pub live_view_bytes: usize,
    pub peak_view_bytes: usize,
    pub live_map_bytes: usize,
    pub peak_map_bytes: usize,
    pub owner_queries: usize,
    pub owner_hits: usize,
    pub cache_hits: usize,
    pub cache_misses: usize,
    pub retained_destination_bytes: usize,
    pub model_destination_bytes: usize,
    pub definition_destination_bytes: usize,
    pub definition_snapshot_bytes: usize,
    pub exclusions: Vec<Vec<usize>>,
    pub context_ids: Vec<ContextId>,
}
thread_local! {static WORK:RefCell<Observation>=RefCell::new(Observation::default());}
pub(super) fn observe(f: impl FnOnce(&mut Observation)) {
    WORK.with(|o| f(&mut o.borrow_mut()));
}
fn reset() {
    WORK.with(|o| *o.borrow_mut() = Observation::default());
    title_probe_tests::REPLAYS.with(|c| c.set(0));
}
fn snap() -> Observation {
    WORK.with(|o| o.borrow().clone())
}
fn t(s: &str) -> Inline {
    Inline::Text(s.into())
}
fn l(s: &str, d: &str, title: Option<&str>) -> Inline {
    Inline::Link {
        dest: d.into(),
        title: title.map(str::to_string),
        content: vec![t(s)],
    }
}
fn p(c: Vec<Inline>) -> Block {
    Block::new(BlockKind::Paragraph(c))
}
fn u(c: Vec<Inline>) -> Inline {
    Inline::MbStyle {
        property: crate::model::MbStyleProperty::Underline,
        content: c,
    }
}
#[test]
fn proposed_actual_public_context_nested_math_retry() {
    let source = "$a$ [o](/o \"\") :mb-style[:mb-style[[x](/d \"\")]{size=\"small\"}]{underline=\"true\"} [before :mb-style[mid]{color=\"red\"} after](/c \"\") <i data-x=\"$z$\">";
    reset();
    let actual = document(source);
    let obs = snap();
    let replays = title_probe_tests::REPLAYS.with(Cell::get);
    println!(
        "actual retry source={source:?} observations={obs:#?} title_replays={replays} model={actual:#?}"
    );
    assert_eq!(
        actual.blocks,
        vec![p(vec![
            Inline::Math("a".into()),
            t(" "),
            l("o", "/o", Some("")),
            t(" "),
            u(vec![Inline::MbStyle {
                property: crate::model::MbStyleProperty::Size(crate::model::MbSize::Small),
                content: vec![l("x", "/d", Some(""))]
            }]),
            t(" "),
            l("before ", "/c", Some("")),
            Inline::MbStyle {
                property: crate::model::MbStyleProperty::Color(crate::model::MbPalette::Red),
                content: vec![l("mid", "/c", Some(""))]
            },
            l(" after", "/c", Some("")),
            t(" <i data-x=\"$z$\">")
        ])]
    );
    assert_eq!(obs.contexts, 1);
    assert_eq!(obs.authority_passes, 1);
    assert_eq!(obs.candidate_builds, 1);
    assert_eq!(obs.legacy_fallbacks, 0);
    assert_eq!(replays, 1);
    assert!(obs.exclusions.len() >= 2, "real product retry unavailable");
    assert_eq!(obs.exclusions[0], Vec::<usize>::new());
    for pair in obs.exclusions.windows(2) {
        assert_eq!(pair[1].len(), pair[0].len() + 1);
        assert!(pair[0].iter().all(|s| pair[1].contains(s)));
    }
    assert_eq!(
        obs.exclusions.last().unwrap(),
        &vec![source.find("$z$").unwrap()]
    );
    assert!(obs.context_ids.iter().all(|id| *id == obs.context_ids[0]));
}
#[test]
fn proposed_protected_definition_classification() {
    // A raw RefDef title itself has an original product-protected math span. Duplicate
    // lookup must still use the original first definition, including installed case fold.
    let source = "[x][ID]\n\n[id]: /winner \"$z$\"\n[id]: /later \"\"";
    reset();
    let model = document(source);
    let obs = snap();
    println!("definition observations={obs:#?}");
    assert_eq!(model.blocks, vec![p(vec![l("x", "/winner", Some("$z$"))])]);
    assert_eq!(obs.authority_passes, 1);
    assert_eq!(obs.legacy_fallbacks, 0);
    for source in [
        "$$\n[id]: /hidden\n$$\n\n[x][id]",
        ":mb-style[[id]: /hidden]{underline=\"true\"}\n\n[x][id]",
        "<div>\n[id]: /hidden\n</div>\n\n[x][id]",
    ] {
        let mut raw = Parser::new_ext(source, options()).into_offset_iter();
        let events: Vec<_> = raw.by_ref().collect();
        assert!(
            raw.reference_definitions().get("id").is_none(),
            "definition witness must be original classification: {source:?} {events:?}"
        );
    }
}
#[test]
fn proposed_complete_link_content_boundaries() {
    for (source, kind, label) in [
        ("[](/d \"\")", LinkType::Inline, ""),
        ("[é &amp; \\]](/d \"\")", LinkType::Inline, "é &amp; \\]"),
        ("[x][id]\n\n[id]: /d \"\"", LinkType::Reference, "x"),
        ("[id][]\n\n[id]: /d \"\"", LinkType::Collapsed, "id"),
        ("[id]\n\n[id]: /d \"\"", LinkType::Shortcut, "id"),
        (
            "<https://example.org>",
            LinkType::Autolink,
            "https://example.org",
        ),
        ("<a@example.org>", LinkType::Email, "a@example.org"),
        ("[x] [id]\n\n[id]: /d \"\"", LinkType::Shortcut, "id"),
    ] {
        let c = ParseContext::new(source, options());
        assert_eq!(c.owners.len(), 1, "{source}");
        let owner = &c.owners[0];
        assert_eq!(
            source.get(
                owner
                    .content
                    .as_ref()
                    .expect("checked supported boundary")
                    .bytes
                    .clone()
            ),
            Some(label)
        );
        assert!(
            matches!(&c.events[owner.first].0,Event::Start(Tag::Link{link_type,..}) if *link_type==kind)
        );
        let v = SourceView::identity(&c, owner.usage.bytes.clone()).unwrap();
        let other = ParseContext::new(source, options());
        assert!(v.exact_source(&other, 0..v.text.len()).is_none());
    }
    // Boundary/map/registry negative controls use the real private types and event
    // validation, not a stand-in parser or decoded-length source map.
    let source = ":mb-style[é &amp; [x](/d \"\")]{underline=\"true\"} $z$";
    let c = ParseContext::new(source, options());
    let view = SourceView::identity(&c, 0..source.len()).unwrap();
    let owner = &c.owners[0];
    let usage = owner.usage.bytes.clone();
    let token = format!("{}s999:0%", c.token_prefix);
    let changed = view
        .replace(
            &c,
            &[(usage.clone(), token.clone(), AtomKind::Native(owner.first))],
        )
        .unwrap();
    let at = usage.start;
    assert!(changed.exact_source(&c, at..at + token.len()).is_none());
    assert!(
        view.replace(
            &c,
            &[(usage.clone(), token.clone(), AtomKind::Math(usage.start))]
        )
        .is_none(),
        "wrong atom kind"
    );
    assert!(
        view.exact_source(&c, 11..12).is_none(),
        "split UTF8 endpoints"
    );
    let mut table = style::Table::from_prefix(format!("{}s1000:", c.token_prefix));
    let token = table.insert(vec![t("x")]);
    let split = token.len() / 2;
    let events = vec![
        (
            Event::Text(pulldown_cmark::CowStr::Borrowed(&token[..split])),
            0..split,
        ),
        (
            Event::Text(pulldown_cmark::CowStr::Borrowed(&token[split..])),
            split..token.len(),
        ),
    ];
    assert!(
        table.validate_events(&token, &events),
        "adjacent Text split restores once"
    );
    let duplicate = format!("{token}{token}");
    let events = vec![(
        Event::Text(pulldown_cmark::CowStr::Borrowed(&duplicate)),
        0..duplicate.len(),
    )];
    assert!(
        !table.validate_events(&duplicate, &events),
        "duplicate token"
    );
    let events = vec![(
        Event::Code(pulldown_cmark::CowStr::Borrowed(&token)),
        0..token.len(),
    )];
    assert!(!table.validate_events(&token, &events), "swallowed token");
    let events = vec![(
        Event::Text(pulldown_cmark::CowStr::Borrowed("literal")),
        0..7,
    )];
    assert!(!table.validate_events("literal", &events), "missing token");
    let wrong = format!("{}s1000:1%", c.token_prefix);
    let events = vec![(
        Event::Text(pulldown_cmark::CowStr::Borrowed(&wrong)),
        0..wrong.len(),
    )];
    assert!(
        !table.validate_events(&wrong, &events),
        "wrong registered token index"
    );
    let events = vec![
        (
            Event::Text(pulldown_cmark::CowStr::Borrowed(&token[..split])),
            0..split,
        ),
        (Event::Start(Tag::Emphasis), split..token.len()),
        (
            Event::Text(pulldown_cmark::CowStr::Borrowed(&token[split..])),
            split..token.len(),
        ),
        (Event::End(TagEnd::Emphasis), split..token.len()),
    ];
    assert!(
        !table.validate_events(&token, &events),
        "do not join through structure"
    );
}
#[test]
fn proposed_deterministic_work_and_allocation() {
    for (n, scopes) in [(4, 1), (20, 4), (35, 16)] {
        let dest = format!("https://example.org/{}", "a".repeat(6000));
        let mut s = String::new();
        let mut expected = Vec::new();
        let mut i = 0;
        for scope in 0..scopes {
            if scope > 0 {
                s.push(' ');
                expected.push(t(" "));
            }
            let count = n / scopes + usize::from(scope < n % scopes);
            s.push_str(":mb-style[");
            let mut c = Vec::new();
            for j in 0..count {
                if j > 0 {
                    s.push(' ');
                    c.push(t(" "));
                }
                s.push_str("[x][id]");
                c.push(l("x", &dest, Some("")));
                i += 1;
            }
            s.push_str("]{underline=\"true\"}");
            expected.push(u(c));
        }
        assert_eq!(i, n);
        let padding = "p".repeat(240000);
        s.push_str(&format!("\n\n{padding}\n\n[id]: <{dest}> \"\"\n"));
        reset();
        let model = document(&s);
        let obs = snap();
        let replay = title_probe_tests::REPLAYS.with(Cell::get);
        println!("ledger n={n} scopes={scopes} observations={obs:#?} title_replays={replay}");
        assert_eq!(model.blocks, vec![p(expected), p(vec![t(&padding)])]);
        assert_eq!(obs.contexts, 1);
        assert_eq!(obs.authority_passes, 1);
        assert_eq!(obs.candidate_builds, 1);
        assert_eq!(obs.prefix_builds, 1);
        assert_eq!(obs.legacy_fallbacks, 0);
        assert_eq!(replay, 0);
        assert_eq!(obs.structural_parses, 1);
        assert_eq!(obs.local_parses, scopes + n);
        assert_eq!(obs.live_view_bytes, 0);
        assert_eq!(obs.live_map_bytes, 0);
        assert!(obs.peak_view_bytes > 0);
        assert!(obs.peak_map_bytes > 0);
        assert_eq!(
            obs.definition_snapshot_bytes,
            4 * std::mem::size_of::<Range<usize>>(),
            "observed Vec minimum capacity4 is allocation, not four definitions"
        );
        assert_eq!(
            obs.definition_destination_bytes, 0,
            "definition spans must not duplicate large authoritative destinations"
        );
        assert_eq!(obs.retained_destination_bytes, n * 6020);
        assert_eq!(obs.model_destination_bytes, n * 6020);
        assert_eq!(obs.token_inserts, obs.token_restores);
        assert!(obs.owner_queries > 0);
        assert!(obs.map_segments > 0);
        assert_eq!(obs.cache_misses, n);
        assert_eq!(obs.cache_hits, 0);
        assert_eq!(obs.owner_hits, n);
    }
}
