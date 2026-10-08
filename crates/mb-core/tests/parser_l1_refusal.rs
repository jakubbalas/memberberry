//! Additive L1 regression and adjacent containment controls.
use mb_core::model::{Block, BlockKind, Inline, MbSize, MbStyleProperty};
fn t(s: &str) -> Inline {
    Inline::Text(s.into())
}
fn l(s: &str) -> Inline {
    Inline::Link {
        dest: "/d".into(),
        title: Some("".into()),
        content: vec![t(s)],
    }
}
fn p(c: Vec<Inline>) -> Vec<Block> {
    vec![Block::new(BlockKind::Paragraph(c))]
}
#[test]
fn l1_cross_boundary_whole_refusal_retains_descendant_spelling() {
    let s = ":mb-style[[:mb-style[x]{size=\"small\"}]{underline=\"true\"} y](/d \"\")";
    let expected = p(vec![
        t(":mb-style"),
        l("[:mb-style[x]{size=\"small\"}]{underline=\"true\"} y"),
    ]);
    assert_eq!(
        mb_core::parse(s).blocks,
        expected,
        "cross-boundary whole-declaration refusal must not apply descendants"
    );
}
#[test]
fn valid_nested_styles_inside_native_link_remain_composed() {
    let s = "[é :mb-style[:mb-style[x]{size=\"small\"}]{underline=\"true\"} y](/d \"\")";
    let expected = p(vec![
        l("é "),
        Inline::MbStyle {
            property: MbStyleProperty::Underline,
            content: vec![Inline::MbStyle {
                property: MbStyleProperty::Size(MbSize::Small),
                content: vec![l("x")],
            }],
        },
        l(" y"),
    ]);
    assert_eq!(mb_core::parse(s).blocks, expected);
}
#[test]
fn refused_domain_does_not_disable_later_style_in_same_native_owner() {
    let s = "[a :mb-style[[:mb-style[é]{size=\"small\"}]{underline=\"true\"} y] :mb-style[z]{underline=\"true\"}](/d \"\")";
    let expected = p(vec![
        l("a :mb-style[[:mb-style[é]{size=\"small\"}]{underline=\"true\"} y] "),
        Inline::MbStyle {
            property: MbStyleProperty::Underline,
            content: vec![l("z")],
        },
    ]);
    assert_eq!(mb_core::parse(s).blocks, expected);
}
