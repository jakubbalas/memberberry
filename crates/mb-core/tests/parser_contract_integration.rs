//! Core-only original authority, composition, grammar and public API integration.
use mb_core::model::{Block, BlockKind, Inline, MbPalette, MbSize, MbStyleProperty};
fn text(t: &str) -> Inline {
    Inline::Text(t.into())
}
fn link(t: &str, d: &str) -> Inline {
    Inline::Link {
        dest: d.into(),
        title: Some("".into()),
        content: vec![text(t)],
    }
}
fn styled(c: Vec<Inline>) -> Inline {
    Inline::MbStyle {
        property: MbStyleProperty::Underline,
        content: c,
    }
}
fn para(c: Vec<Inline>) -> Block {
    Block::new(BlockKind::Paragraph(c))
}
fn fuel(n: usize) -> (String, String, Vec<Block>) {
    let d = format!("https://example.org/{}", "a".repeat(6000));
    let body = vec!["[x][id]"; n].join(" ");
    let padding = "p".repeat(120000);
    let source =
        format!(":mb-style[{body}]{{underline=\"true\"}}\n\n{padding}\n\n[id]: <{d}> \"\"\n");
    let accepted = n.min(21);
    let mut c = Vec::new();
    for i in 0..accepted {
        if i > 0 {
            c.push(text(" "));
        }
        c.push(link("x", &d));
    }
    if n > accepted {
        c.push(text(&" [x][id]".repeat(n - accepted)));
    }
    let expected = vec![para(vec![styled(c)]), para(vec![text(&padding)])];
    (source, d, expected)
}
#[test]
fn proposed_actual_product_fuel20() {
    let (s, d, e) = fuel(20);
    assert_eq!(d.len(), 6020);
    assert_eq!(s.len(), 126224);
    assert_eq!(mb_core::parse(&s).blocks, e);
}
#[test]
fn proposed_actual_product_fuel35() {
    let (s, d, e) = fuel(35);
    assert_eq!(d.len(), 6020);
    assert_eq!(s.len(), 126344);
    assert_eq!(mb_core::parse(&s).blocks, e);
}
#[test]
fn proposed_protected_consumption_and_image_fuel() {
    let d = format!("https://example.org/{}", "a".repeat(6000));
    let pad = "p".repeat(120000);
    for (prefix, first) in [
        ("$[x][id]$", Inline::Math("[x][id]".into())),
        (
            "![x][id]",
            Inline::Image {
                dest: d.clone(),
                alt: "x".into(),
            },
        ),
    ] {
        let tail = vec!["[x][id]"; 35].join(" ");
        let s = format!(
            "{prefix} :mb-style[{tail}]{{underline=\"true\"}}\n\n{pad}\n\n[id]: <{d}> \"\"\n"
        );
        let mut c = Vec::new();
        for i in 0..20 {
            if i > 0 {
                c.push(text(" "));
            }
            c.push(link("x", &d));
        }
        c.push(text(&" [x][id]".repeat(15)));
        assert_eq!(
            mb_core::parse(&s).blocks,
            vec![
                para(vec![first, text(" "), styled(c)]),
                para(vec![text(&pad)])
            ],
            "protected/image authority {prefix}"
        );
    }
    // Masking accepted math usages must not replenish fuel for an ordinary Image.
    let hidden = vec!["[x][id]"; 21].join(" ");
    let s = format!("${hidden}$ ![x][id]\n\n{pad}\n\n[id]: <{d}> \"\"\n");
    assert_eq!(
        mb_core::parse(&s).blocks,
        vec![
            para(vec![Inline::Math(hidden.clone()), text(" ![x][id]")]),
            para(vec![text(&pad)])
        ],
        "masked parser must not promote a refused original Image"
    );
    // Raw accepted reference in invalid metadata must remain readable, but cannot refund fuel.
    let tail = vec!["[x][id]"; 35].join(" ");
    let prefix = ":mb-style[t]{bad=\"[x][id]\"}";
    let s =
        format!("{prefix} :mb-style[{tail}]{{underline=\"true\"}}\n\n{pad}\n\n[id]: <{d}> \"\"\n");
    let mut c = Vec::new();
    for i in 0..20 {
        if i > 0 {
            c.push(text(" "));
        }
        c.push(link("x", &d));
    }
    c.push(text(&" [x][id]".repeat(15)));
    assert_eq!(
        mb_core::parse(&s).blocks,
        vec![
            para(vec![
                text(":mb-style[t]{bad=\""),
                link("x", &d),
                text("\"} "),
                styled(c)
            ]),
            para(vec![text(&pad)])
        ]
    );
}
#[test]
fn proposed_overlap_and_wrapper_topology() {
    let s = ":mb-style[[[x][id]](/outer)]{underline=\"true\"}\n\n[id]: /inner \"\"";
    assert_eq!(
        mb_core::parse(s).blocks,
        vec![para(vec![
            text(":mb-style[["),
            link("x", "/inner"),
            text("](/outer)]{underline=\"true\"}")
        ])],
        "synthetic outer link promotion must refuse whole declaration"
    );
    for (s, e) in [
        (
            ":mb-style[[x]{underline=\"true\"} y](/d \"\")",
            vec![
                text(":mb-style"),
                Inline::Link {
                    dest: "/d".into(),
                    title: Some("".into()),
                    content: vec![text("[x]{underline=\"true\"} y")],
                },
            ],
        ),
        (
            "[pre :mb-style[x](/d \"\")]{underline=\"true\"}",
            vec![
                text("[pre :mb-style"),
                link("x", "/d"),
                text("]{underline=\"true\"}"),
            ],
        ),
        (
            "**:mb-style[[x](/d \"\")]{bad=\"true\"}**",
            vec![Inline::Strong(vec![
                text(":mb-style["),
                link("x", "/d"),
                text("]{bad=\"true\"}"),
            ])],
        ),
    ] {
        assert_eq!(mb_core::parse(s).blocks, vec![para(e)], "{s}");
    }
}
#[test]
fn proposed_source_map_and_registry_negatives() {
    let s = "%\u{2}context:0% &#37;&#2;context:0% :mb-style[é &amp; \\* [x](/d \"\")]{underline=\"true\"}";
    assert_eq!(
        mb_core::parse(s).blocks,
        vec![para(vec![
            text("%\u{2}context:0% %\u{2}context:0% "),
            styled(vec![text("é & * "), link("x", "/d")])
        ])]
    );
    // Math token spelling obtained by entity decoding is authored content, not a registered atom.
    let s = "&#37;&#1;context:0% $x$";
    assert_eq!(
        mb_core::parse(s).blocks,
        vec![para(vec![
            text("%\u{1}context:0% "),
            Inline::Math("x".into())
        ])]
    );
    let s = "&#37;&#2;mbregistry0qm:0% $x$";
    assert_eq!(
        mb_core::parse(s).blocks,
        vec![para(vec![
            text("%\u{2}mbregistry0qm:0% "),
            Inline::Math("x".into())
        ])],
        "authored entity-decoded registry collision"
    );
    let s = "&#37;&#2;mbregistry0qm:0% &#37;&#2;mbregistry1qs0:0% :mb-style[y]{underline=\"true\"}";
    assert_eq!(
        mb_core::parse(s).blocks,
        vec![para(vec![
            text("%\u{2}mbregistry0qm:0% %\u{2}mbregistry1qs0:0% "),
            styled(vec![text("y")])
        ])],
        "multiple registry-prefix collisions across adjacent decoded Text events"
    );
    for s in [
        ":mb-style[x\ny]{underline=\"true\"}",
        ":mb-style[x\ry]{underline=\"true\"}",
    ] {
        let m = mb_core::parse(s);
        assert!(!format!("{m:?}").contains("MbStyle"));
    }
}
#[test]
fn proposed_style_grammar_limits_eligibility() {
    for p in MbPalette::ALL {
        for (key, property) in [
            ("color", MbStyleProperty::Color(*p)),
            ("background", MbStyleProperty::Background(*p)),
        ] {
            let s = format!(":mb-style[x]{{{key}=\"{}\"}}", p.name());
            assert_eq!(
                mb_core::parse(&s).blocks,
                vec![para(vec![Inline::MbStyle {
                    property,
                    content: vec![text("x")]
                }])]
            );
        }
    }
    for (key, property) in [
        ("underline=\"true\"", MbStyleProperty::Underline),
        ("size=\"small\"", MbStyleProperty::Size(MbSize::Small)),
        ("size=\"large\"", MbStyleProperty::Size(MbSize::Large)),
    ] {
        assert_eq!(
            mb_core::parse(&format!(":mb-style[x]{{{key}}}")).blocks,
            vec![para(vec![Inline::MbStyle {
                property,
                content: vec![text("x")]
            }])]
        );
    }
    for len in [256, 257] {
        let metadata = format!("underline=\"true\"{}", " ".repeat(len - 16));
        assert_eq!(metadata.len(), len);
        let s = format!(":mb-style[[x](/d \"\")]{{{metadata}}}");
        let e = if len == 256 {
            vec![styled(vec![link("x", "/d")])]
        } else {
            vec![
                text(":mb-style["),
                link("x", "/d"),
                text(&format!("]{{{metadata}}}")),
            ]
        };
        assert_eq!(mb_core::parse(&s).blocks, vec![para(e)]);
    }
    for attrs in [
        "bad=\"true\"",
        "underline=\"false\"",
        "underline=\"true\" underline=\"true\"",
    ] {
        let s = format!(":mb-style[[x](/d \"\")]{{{attrs}}}");
        assert_eq!(
            mb_core::parse(&s).blocks,
            vec![para(vec![
                text(":mb-style["),
                link("x", "/d"),
                text(&format!("]{{{attrs}}}"))
            ])]
        );
    }
    assert_eq!(
        mb_core::parse(":mb-style[`x`]{underline=\"true\"}").blocks,
        vec![para(vec![Inline::Code("x".into())])]
    );
    assert_eq!(
        mb_core::parse(":mb-style[![x](/i)]{underline=\"true\"}").blocks,
        vec![para(vec![Inline::Image {
            dest: "/i".into(),
            alt: "x".into()
        }])]
    );
    let mut s = "[x](/d \"\")".to_string();
    for _ in 0..16 {
        s = format!(":mb-style[{s}]{{underline=\"true\"}}");
    }
    assert_eq!(
        mb_core::parse(&s).blocks,
        vec![para(vec![styled(vec![link("x", "/d")])])]
    );
    for s in [
        "```\n:mb-style[x]{underline=\"true\"}\n```",
        "    :mb-style[x]{underline=\"true\"}",
        "<i title=':mb-style[x]{underline=\"true\"}'>",
        "$$\n:mb-style[x]{underline=\"true\"}\n$$",
        "| :mb-style[x | y]{underline=\"true\"} |\n| --- | --- |",
    ] {
        assert!(
            !format!("{:?}", mb_core::parse(s)).contains("MbStyle"),
            "{s}"
        );
    }
}
#[test]
fn proposed_surgical_metadata_api_parity() {
    let options = mb_core::parse::options();
    let s = "é :mb-style[x]{underline=\"true\"} :mb-style[y]{bad=\"true\"} $z$";
    assert_eq!(
        mb_core::parse::style_metadata_spans(s, options),
        vec![14..33, 45..58]
    );
    assert_eq!(mb_core::parse::math::spans(s, options), vec![59..62]);
    let (masked, table) = mb_core::parse::math::mask(s, options);
    assert!(masked.contains("%\u{1}0%"));
    assert_eq!(table.take("%\u{1}0%"), Some((4, "z")));
    let (unmasked, t) = mb_core::parse::math::mask_except(s, options, &[59]);
    assert_eq!(unmasked, s);
    assert!(t.is_empty());
    let a = mb_core::parse(s);
    let b = mb_core::parse(&format!("---\ntitle: hi\n---\n{s}"));
    assert_eq!(a.blocks, b.blocks);
}
