//! Fixed manual full-tree F01–F16 contract oracles, translated without inference.
use mb_core::model::{Block, BlockKind, Inline, MbSize, MbStyleProperty};

#[test]
fn proposed_link_inside_style_external_empty() {
    let source: &str =
        ":mb-style[[literal][id]]{underline=\"true\"}\n\n[id]: https://example.org \"\"";
    let expected = vec![Block::new(BlockKind::Paragraph(vec![Inline::MbStyle {
        property: MbStyleProperty::Underline,
        content: vec![Inline::Link {
            dest: "https://example.org".into(),
            title: Some("".into()),
            content: vec![Inline::Text("literal".into())],
        }],
    }]))];
    let actual = mb_core::parse(source);
    println!("F01 source={source:?} actual={actual:#?}");
    assert_eq!(actual.blocks, expected, "fixed full tree F01");
}

#[test]
fn proposed_style_inside_link_content() {
    let source: &str = "[before :mb-style[mid]{underline=\"true\"} after](/d \"\")";
    let expected = vec![Block::new(BlockKind::Paragraph(vec![
        Inline::Link {
            dest: "/d".into(),
            title: Some("".into()),
            content: vec![Inline::Text("before ".into())],
        },
        Inline::MbStyle {
            property: MbStyleProperty::Underline,
            content: vec![Inline::Link {
                dest: "/d".into(),
                title: Some("".into()),
                content: vec![Inline::Text("mid".into())],
            }],
        },
        Inline::Link {
            dest: "/d".into(),
            title: Some("".into()),
            content: vec![Inline::Text(" after".into())],
        },
    ]))];
    let actual = mb_core::parse(source);
    println!("F02 source={source:?} actual={actual:#?}");
    assert_eq!(actual.blocks, expected, "fixed full tree F02");
}

#[test]
fn proposed_nested_styles_inside_native_link() {
    let source: &str =
        "[:mb-style[:mb-style[x]{size=\"small\"}]{underline=\"true\"}](/d \"named\")";
    let expected = vec![Block::new(BlockKind::Paragraph(vec![Inline::MbStyle {
        property: MbStyleProperty::Underline,
        content: vec![Inline::MbStyle {
            property: MbStyleProperty::Size(MbSize::Small),
            content: vec![Inline::Link {
                dest: "/d".into(),
                title: Some("named".into()),
                content: vec![Inline::Text("x".into())],
            }],
        }],
    }]))];
    let actual = mb_core::parse(source);
    println!("F03 source={source:?} actual={actual:#?}");
    assert_eq!(actual.blocks, expected, "fixed full tree F03");
}

#[test]
fn proposed_style_spelling_in_destination_is_literal() {
    let source: &str = "[x](<:mb-style[y]{underline=\"true\"}>)";
    let expected = vec![Block::new(BlockKind::Paragraph(vec![Inline::Link {
        dest: ":mb-style[y]{underline=\"true\"}".into(),
        title: None,
        content: vec![Inline::Text("x".into())],
    }]))];
    let actual = mb_core::parse(source);
    println!("F04 source={source:?} actual={actual:#?}");
    assert_eq!(actual.blocks, expected, "fixed full tree F04");
}

#[test]
fn proposed_style_spelling_in_native_title_is_literal() {
    let source: &str = "[x](/d ':mb-style[y]{underline=\"true\"}')";
    let expected = vec![Block::new(BlockKind::Paragraph(vec![Inline::Link {
        dest: "/d".into(),
        title: Some(":mb-style[y]{underline=\"true\"}".into()),
        content: vec![Inline::Text("x".into())],
    }]))];
    let actual = mb_core::parse(source);
    println!("F05 source={source:?} actual={actual:#?}");
    assert_eq!(actual.blocks, expected, "fixed full tree F05");
}

#[test]
fn proposed_bracket_conflict_link_crosses_intended_namespace_label() {
    let source: &str = ":mb-style[[x]{underline=\"true\"} y](/d \"\")";
    let expected = vec![Block::new(BlockKind::Paragraph(vec![
        Inline::Text(":mb-style".into()),
        Inline::Link {
            dest: "/d".into(),
            title: Some("".into()),
            content: vec![Inline::Text("[x]{underline=\"true\"} y".into())],
        },
    ]))];
    let actual = mb_core::parse(source);
    println!("F06 source={source:?} actual={actual:#?}");
    assert_eq!(actual.blocks, expected, "fixed full tree F06");
}

#[test]
fn proposed_bracket_conflict_reverse_boundary_native_link_survives() {
    let source: &str = "[pre :mb-style[x](/d \"\")]{underline=\"true\"}";
    let expected = vec![Block::new(BlockKind::Paragraph(vec![
        Inline::Text("[pre :mb-style".into()),
        Inline::Link {
            dest: "/d".into(),
            title: Some("".into()),
            content: vec![Inline::Text("x".into())],
        },
        Inline::Text("]{underline=\"true\"}".into()),
    ]))];
    let actual = mb_core::parse(source);
    println!("F07 source={source:?} actual={actual:#?}");
    assert_eq!(actual.blocks, expected, "fixed full tree F07");
}

#[test]
fn proposed_unknown_inner_style_whole_readable_link() {
    let source: &str = "[pre :mb-style[x]{bad=\"true\"} post](/d \"\")";
    let expected = vec![Block::new(BlockKind::Paragraph(vec![Inline::Link {
        dest: "/d".into(),
        title: Some("".into()),
        content: vec![Inline::Text("pre :mb-style[x]{bad=\"true\"} post".into())],
    }]))];
    let actual = mb_core::parse(source);
    println!("F08 source={source:?} actual={actual:#?}");
    assert_eq!(actual.blocks, expected, "fixed full tree F08");
}

#[test]
fn proposed_unclosed_inner_metadata_preserves_link() {
    let source: &str = "[pre :mb-style[x]{underline=\"true\" post](/d \"\")";
    let expected = vec![Block::new(BlockKind::Paragraph(vec![Inline::Link {
        dest: "/d".into(),
        title: Some("".into()),
        content: vec![Inline::Text(
            "pre :mb-style[x]{underline=\"true\" post".into(),
        )],
    }]))];
    let actual = mb_core::parse(source);
    println!("F09 source={source:?} actual={actual:#?}");
    assert_eq!(actual.blocks, expected, "fixed full tree F09");
}

#[test]
fn proposed_depth17_whole_literal_root_does_not_flatten_native_link() {
    let source: &str = ":mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[[x](/d \"\")]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}";
    let expected=vec![Block::new(BlockKind::Paragraph(vec![Inline::Text(":mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[:mb-style[".into()),Inline::Link {dest:"/d".into(),title:Some("".into()),content:vec![Inline::Text("x".into())]},Inline::Text("]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}]{underline=\"true\"}".into())]))];
    let actual = mb_core::parse(source);
    println!("F10 source={source:?} actual={actual:#?}");
    assert_eq!(actual.blocks, expected, "fixed full tree F10");
}

#[test]
fn proposed_native_link_code_image_split_no_empty_styles() {
    let source: &str = ":mb-style[[x](/d \"\") `tail` ![a](/i)]{underline=\"true\"}";
    let expected = vec![Block::new(BlockKind::Paragraph(vec![
        Inline::MbStyle {
            property: MbStyleProperty::Underline,
            content: vec![
                Inline::Link {
                    dest: "/d".into(),
                    title: Some("".into()),
                    content: vec![Inline::Text("x".into())],
                },
                Inline::Text(" ".into()),
            ],
        },
        Inline::Code("tail".into()),
        Inline::MbStyle {
            property: MbStyleProperty::Underline,
            content: vec![Inline::Text(" ".into())],
        },
        Inline::Image {
            dest: "/i".into(),
            alt: "a".into(),
        },
    ]))];
    let actual = mb_core::parse(source);
    println!("F11 source={source:?} actual={actual:#?}");
    assert_eq!(actual.blocks, expected, "fixed full tree F11");
}

#[test]
fn proposed_outside_emphasis_not_projected() {
    let source: &str = ":mb-style[*hi]{underline=\"true\"}*";
    let expected = vec![Block::new(BlockKind::Paragraph(vec![
        Inline::MbStyle {
            property: MbStyleProperty::Underline,
            content: vec![Inline::Text("*hi".into())],
        },
        Inline::Text("*".into()),
    ]))];
    let actual = mb_core::parse(source);
    println!("F12 source={source:?} actual={actual:#?}");
    assert_eq!(actual.blocks, expected, "fixed full tree F12");
}

#[test]
fn proposed_code_definition_never_resolves_external_usage() {
    let source: &str = "```\n[id]: /hidden \"\"\n```\n\n[x][id]";
    let expected = vec![
        Block::new(BlockKind::CodeBlock {
            lang: None,
            code: "[id]: /hidden \"\"".into(),
        }),
        Block::new(BlockKind::Paragraph(vec![Inline::Text("[x][id]".into())])),
    ];
    let actual = mb_core::parse(source);
    println!("F13 source={source:?} actual={actual:#?}");
    assert_eq!(actual.blocks, expected, "fixed full tree F13");
}

#[test]
fn proposed_style_label_definition_spelling_not_definition() {
    let source: &str =
        ":mb-style[[id]: /hidden]{underline=\"true\"}\n\n[x][id]\n\n[id]: /outside \"\"";
    let expected = vec![
        Block::new(BlockKind::Paragraph(vec![Inline::MbStyle {
            property: MbStyleProperty::Underline,
            content: vec![
                Inline::Link {
                    dest: "/outside".into(),
                    title: Some("".into()),
                    content: vec![Inline::Text("id".into())],
                },
                Inline::Text(": /hidden".into()),
            ],
        }])),
        Block::new(BlockKind::Paragraph(vec![Inline::Link {
            dest: "/outside".into(),
            title: Some("".into()),
            content: vec![Inline::Text("x".into())],
        }])),
    ];
    let actual = mb_core::parse(source);
    println!("F14 source={source:?} actual={actual:#?}");
    assert_eq!(actual.blocks, expected, "fixed full tree F14");
}

#[test]
fn proposed_metadata_definition_spelling_no_promotion() {
    let source: &str = ":mb-style[x]{bad=\"[id]: /hidden\"}\n\n[out][id]";
    let expected = vec![
        Block::new(BlockKind::Paragraph(vec![Inline::Text(
            ":mb-style[x]{bad=\"[id]: /hidden\"}".into(),
        )])),
        Block::new(BlockKind::Paragraph(vec![Inline::Text("[out][id]".into())])),
    ];
    let actual = mb_core::parse(source);
    println!("F15 source={source:?} actual={actual:#?}");
    assert_eq!(actual.blocks, expected, "fixed full tree F15");
}

#[test]
fn proposed_raw_accepted_usage_hidden_by_math_keeps_consumption() {
    let source: &str = "$[x][id]$ [out][id]\n\n[id]: /d \"\"";
    let expected = vec![Block::new(BlockKind::Paragraph(vec![
        Inline::Math("[x][id]".into()),
        Inline::Text(" ".into()),
        Inline::Link {
            dest: "/d".into(),
            title: Some("".into()),
            content: vec![Inline::Text("out".into())],
        },
    ]))];
    let actual = mb_core::parse(source);
    println!("F16 source={source:?} actual={actual:#?}");
    assert_eq!(actual.blocks, expected, "fixed full tree F16");
}
