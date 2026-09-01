//! Rendering the block model to HTML.
//!
//! The escaping tests below are the important half. This renderer takes **someone's private
//! notes and shows them to other people** — over the M0 server now, and over anonymous
//! share links at §17. A note is untrusted input: it can hold `<script>`, an `onerror=`
//! attribute, or a `javascript:` URL pasted from anywhere. An escaping hole here is stored
//! cross-site scripting in an application whose entire purpose is holding private data.
//!
//! Structural tests come first because they are quick to read; the security ones carry the
//! weight.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use mb_core::html::{self, Urls};
use mb_core::parse;

/// Renders Markdown with no URL prefixes.
fn h(md: &str) -> String {
    html::document(&parse(md), &Urls::default())
}

/// Renders with the prefixes the M0 server uses.
fn h_at(md: &str, note: &str, media: &str) -> String {
    html::document(&parse(md), &Urls { note, media })
}

// ---------------------------------------------------------------- blocks

#[test]
fn a_paragraph_becomes_a_p() {
    assert_eq!(h("hello\n"), "<p>hello</p>\n");
}

#[test]
fn headings_render_at_their_level() {
    for level in 1..=6 {
        let md = format!("{} h\n", "#".repeat(level));
        assert_eq!(h(&md), format!("<h{level}>h</h{level}>\n"));
    }
}

#[test]
fn emphasis_marks_map_to_semantic_elements() {
    assert_eq!(
        h("*em* **strong** ~~del~~ ==mark== `code`\n"),
        "<p><em>em</em> <strong>strong</strong> <del>del</del> <mark>mark</mark> <code>code</code></p>\n"
    );
}

#[test]
fn a_bullet_list_renders_as_ul() {
    assert_eq!(
        h("- one\n- two\n"),
        "<ul>\n<li><p>one</p>\n</li>\n<li><p>two</p>\n</li>\n</ul>\n"
    );
}

#[test]
fn an_ordered_list_keeps_its_start_number() {
    let out = h("3. three\n4. four\n");
    assert!(out.starts_with("<ol start=\"3\">"), "{out}");
}

#[test]
fn an_ordered_list_starting_at_one_needs_no_start_attribute() {
    assert!(!h("1. one\n").contains("start="));
}

#[test]
fn a_task_list_renders_disabled_checkboxes() {
    // Disabled on purpose: this is a read-only view, and an enabled checkbox would invite a
    // click that changes nothing and looks like a lost edit.
    let out = h("- [ ] todo\n- [x] done\n- [-] cancelled\n");
    assert!(out.contains("class=\"mb-task-list\""), "{out}");
    assert_eq!(
        out.matches("type=\"checkbox\" disabled").count(),
        3,
        "{out}"
    );
    assert_eq!(
        out.matches("checked").count(),
        1,
        "only the done task is checked: {out}"
    );
    assert!(out.contains("mb-task-todo"), "{out}");
    assert!(out.contains("mb-task-done"), "{out}");
    assert!(out.contains("mb-task-cancelled"), "{out}");
}

#[test]
fn a_plain_list_is_not_marked_as_a_task_list() {
    assert!(!h("- one\n").contains("mb-task-list"));
}

#[test]
fn a_code_block_carries_its_language_class() {
    assert_eq!(
        h("```rust\nfn main() {}\n```\n"),
        "<pre><code class=\"language-rust\">fn main() {}</code></pre>\n"
    );
}

#[test]
fn a_code_block_without_a_language_has_no_class() {
    assert_eq!(h("```\nplain\n```\n"), "<pre><code>plain</code></pre>\n");
}

#[test]
fn a_divider_becomes_an_hr() {
    assert_eq!(h("***\n"), "<hr />\n");
}

#[test]
fn a_blockquote_nests_its_blocks() {
    assert_eq!(
        h("> quoted\n"),
        "<blockquote><p>quoted</p>\n</blockquote>\n"
    );
}

#[test]
fn a_callout_carries_its_kind_fold_and_title() {
    let out = h("> [!warning]- Careful\n> body\n");
    assert!(out.contains("mb-callout-warning"), "{out}");
    assert!(out.contains("data-fold=\"collapsed\""), "{out}");
    assert!(
        out.contains("<div class=\"mb-callout-title\">Careful</div>"),
        "{out}"
    );
    assert!(out.contains("body"), "{out}");
}

#[test]
fn an_untitled_callout_is_titled_with_its_kind() {
    let out = h("> [!note]\n> body\n");
    assert!(
        out.contains("<div class=\"mb-callout-title\">note</div>"),
        "{out}"
    );
}

#[test]
fn a_table_carries_column_alignment() {
    let out = h("| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n");
    assert!(
        out.contains("<th style=\"text-align:left\">a</th>"),
        "{out}"
    );
    assert!(
        out.contains("<th style=\"text-align:center\">b</th>"),
        "{out}"
    );
    assert!(
        out.contains("<th style=\"text-align:right\">c</th>"),
        "{out}"
    );
    assert!(
        out.contains("<td style=\"text-align:left\">1</td>"),
        "{out}"
    );
    assert!(out.contains("<thead>") && out.contains("<tbody>"), "{out}");
}

#[test]
fn math_is_emitted_as_source_for_a_client_side_renderer() {
    assert!(h("$$\nx^2\n$$\n").contains("<div class=\"mb-math-block\">x^2</div>"));
    assert!(h("inline $x^2$ here\n").contains("<span class=\"mb-math\">x^2</span>"));
}

#[test]
fn a_hard_break_becomes_a_br() {
    assert!(h("a\\\nb\n").contains("<br />"));
}

#[test]
fn a_block_anchor_becomes_an_element_id() {
    // So `[[Note#^anchor]]` actually jumps to something in a browser.
    assert_eq!(h("text ^my-id\n"), "<p id=\"my-id\">text</p>\n");
}

// ---------------------------------------------------------------- links

#[test]
fn a_wikilink_uses_the_note_prefix_and_is_percent_encoded() {
    let out = h_at("[[Some Note]]\n", "/v/personal/", "/v/personal/media/");
    assert!(
        out.contains("<a class=\"mb-wikilink\" href=\"/v/personal/Some%20Note\">Some Note</a>"),
        "{out}"
    );
}

#[test]
fn a_wikilink_alias_is_what_the_reader_sees() {
    let out = h_at("[[Target|shown]]\n", "/v/p/", "/m/");
    assert!(out.contains(">shown</a>"), "{out}");
    assert!(out.contains("href=\"/v/p/Target\""), "{out}");
}

#[test]
fn a_wikilink_anchor_becomes_a_fragment() {
    assert!(h_at("[[Note#Heading]]\n", "/v/p/", "/m/").contains("href=\"/v/p/Note#Heading\""));
    assert!(h_at("[[Note#^block-id]]\n", "/v/p/", "/m/").contains("href=\"/v/p/Note#block-id\""));
}

#[test]
fn an_embed_is_marked_but_still_renders_as_a_link() {
    // Transclusion needs the index, which is M4. Until then the reference must not silently
    // disappear from the page.
    let out = h_at("![[Note]]\n", "/v/p/", "/m/");
    assert!(out.contains("class=\"mb-embed\""), "{out}");
    assert!(out.contains("data-embed=\"true\""), "{out}");
    assert!(out.contains(">Note</a>"), "{out}");
}

#[test]
fn a_relative_image_uses_the_media_prefix() {
    let out = h_at("![alt](media/ab/cd/x.png)\n", "/v/p/", "/v/p/media/");
    assert!(
        out.contains("src=\"/v/p/media/media/ab/cd/x.png\""),
        "{out}"
    );
    assert!(out.contains("alt=\"alt\""), "{out}");
}

#[test]
fn an_absolute_image_url_is_left_alone() {
    let out = h_at(
        "![alt](https://example.com/x.png)\n",
        "/v/p/",
        "/v/p/media/",
    );
    assert!(out.contains("src=\"https://example.com/x.png\""), "{out}");
}

#[test]
fn an_external_link_gets_noopener_and_noreferrer() {
    // noopener stops the opened page reaching back through `window.opener`; noreferrer keeps
    // the vault's URL out of another site's logs.
    let out = h("[x](https://example.com)\n");
    assert!(out.contains("rel=\"noopener noreferrer\""), "{out}");
}

#[test]
fn an_internal_link_does_not_get_rel() {
    assert!(!h("[x](./other.md)\n").contains("rel="));
}

#[test]
fn a_tag_and_an_emoji_shortcode_stay_visible() {
    assert!(h("#nested/tag\n").contains("<span class=\"mb-tag\">#nested/tag</span>"));
    let out = h(":shortcode:\n");
    assert!(out.contains("data-shortcode=\"shortcode\""), "{out}");
    assert!(
        out.contains(":shortcode:</span>"),
        "unresolved emoji must stay readable: {out}"
    );
}

// ---------------------------------------------------------------- escaping

#[test]
fn html_escaping_blocks_script_injection() {
    // Raw HTML is downgraded to text at parse time (§4.4), so the angle brackets arrive
    // here as content. They must leave as entities.
    let out = h("<script>alert(1)</script>\n");
    assert!(!out.contains("<script"), "script tag survived: {out}");
    assert!(out.contains("&lt;script&gt;"), "{out}");
}

#[test]
fn an_img_onerror_payload_is_escaped() {
    let out = h("<img src=x onerror=alert(1)>\n");
    assert!(!out.contains("<img src=x"), "{out}");
    assert!(out.contains("&lt;img"), "{out}");
}

#[test]
fn text_escapes_the_three_dangerous_characters() {
    let out = h("a < b & c > d\n");
    assert_eq!(out, "<p>a &lt; b &amp; c &gt; d</p>\n");
}

#[test]
fn an_attribute_cannot_be_closed_from_content() {
    // A quote inside an anchor id, a language, an alt or a shortcode would otherwise end the
    // attribute and let the next characters become one.
    let out = h("![\" onerror=\"alert(1)](x.png)\n");
    assert!(
        !out.contains("onerror=\"alert"),
        "attribute broke out: {out}"
    );
    assert!(out.contains("&quot;"), "{out}");

    let out = h("```\" onload=\"alert(1)\ncode\n```\n");
    assert!(
        !out.contains("onload=\"alert"),
        "attribute broke out: {out}"
    );

    let out = h("text ^\"><script>alert(1)</script>\n");
    assert!(!out.contains("<script"), "attribute broke out: {out}");
}

#[test]
fn a_javascript_url_is_neutralised() {
    for scheme in [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "  javascript:alert(1)",
        "vbscript:msgbox(1)",
        "data:text/html,<script>alert(1)</script>",
        "file:///etc/passwd",
    ] {
        let md = format!("[click]({scheme})\n");
        let out = h(&md);
        assert!(
            out.contains("#blocked"),
            "{scheme:?} was not blocked: {out}"
        );
        assert!(!out.to_lowercase().contains("javascript:"), "{out}");
        assert!(!out.to_lowercase().contains("vbscript:"), "{out}");
    }
}

#[test]
fn a_scheme_split_by_control_characters_is_still_blocked() {
    // Browsers ignore control characters and whitespace when resolving a scheme, so
    // `java\nscript:` executes. Checking the raw string would miss it.
    assert_eq!(html::safe_url("java\nscript:alert(1)"), "#blocked");
    assert_eq!(html::safe_url("java\tscript:alert(1)"), "#blocked");
    assert_eq!(html::safe_url("java\u{0}script:alert(1)"), "#blocked");
}

#[test]
fn an_ordinary_url_is_untouched() {
    for url in [
        "https://example.com/a?b=c&d=e#f",
        "http://example.com",
        "./relative.md",
        "/absolute/path",
        "mailto:someone@example.com",
    ] {
        assert_eq!(html::safe_url(url), url, "{url} should be left alone");
    }
}

#[test]
fn a_wikilink_target_cannot_break_out_of_its_href() {
    // A quote is not a legal wikilink target character, so the scanner declines and the
    // whole thing stays text — which is also safe. Assert the outcome that matters.
    let out = h_at("[[a\"><script>alert(1)</script>]]\n", "/v/p/", "/m/");
    assert!(!out.contains("<script"), "{out}");
    assert!(
        !out.contains("href=\"/v/p/a\""),
        "no href should be built: {out}"
    );

    // A target that *is* legal but needs encoding must be encoded, not emitted raw.
    let out = h_at("[[a b&c]]\n", "/v/p/", "/m/");
    assert!(out.contains("href=\"/v/p/a%20b%26c\""), "{out}");
    assert!(
        out.contains(">a b&amp;c</a>"),
        "the text is escaped, not encoded: {out}"
    );
}

#[test]
fn a_callout_kind_cannot_break_out_of_its_class() {
    let out = h("> [!\"><script>alert(1)</script>]\n> body\n");
    assert!(!out.contains("<script"), "{out}");
}

#[test]
fn escaped_content_survives_a_render_of_every_construct() {
    // A single document holding every block and inline kind, each carrying a payload. The
    // point is coverage of the escaping, not of the structure.
    // Payloads are `<xssN>` rather than real tag names, so a hit cannot be our own markup.
    let md = concat!(
        "# <xss1>\n\n",
        "para <xss2>&amp;</xss2> \"quoted\"\n\n",
        "- [ ] task <xss3>\n\n",
        "> [!note] <xss4>\n> <xss5>\n\n",
        "```<xss6>\n<xss7>\n```\n\n",
        "| <xss8> |\n| --- |\n| <xss9> |\n\n",
        "$$\n<xss10>\n$$\n\n",
        "[[<xss11>]] ![<xss12>](x.png) #tag :emoji: $<xss13>$\n",
    );
    let out = h(md);
    for n in 1..=13 {
        assert!(
            !out.contains(&format!("<xss{n}>")),
            "payload {n} survived unescaped: {out}"
        );
    }
    assert!(
        out.contains("&lt;xss1&gt;"),
        "it must survive as text: {out}"
    );
}

// ---------------------------------------------------------------- documents

#[test]
fn an_empty_document_renders_nothing() {
    assert_eq!(h(""), "");
}

#[test]
fn frontmatter_is_not_rendered() {
    // It is metadata, not prose; the page shows it as properties if at all.
    let out = h("---\ntags: [a]\n---\n\nbody\n");
    assert_eq!(out, "<p>body</p>\n");
}

#[test]
fn rendering_never_panics_on_anything_the_parser_produces() {
    for md in [
        "",
        "\u{0}\u{1}\u{b}",
        "- \n- \n",
        ">\n",
        "|\n|\n",
        "$$$$",
        "```\n",
        "![](  )",
        "[[]]",
        "#",
        "~~~~~~",
        "\u{feff}zero width",
        "🎉 emoji and RTL: مرحبا",
    ] {
        let _ = h(md);
    }
}
