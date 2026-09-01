//! Parser totality under libFuzzer (`SPEC.md` §22.1).
//!
//! The property suite already asserts this over generated input; a coverage-guided fuzzer
//! reaches the corners a generator does not — deeply nested containers, truncated UTF-8
//! sequences, escape runs that flip the escaper's state machine.
//!
//! `mb-core` runs in the browser on the keystroke path, so a panic here is a crashed editor
//! holding unsaved work. That is the whole reason parsing is specified as total.

#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // Fuzz the whole pipeline, not just the parse: a panic in the serializer or the
    // extractor is just as fatal, and only the parser's own output reaches them.
    let Ok(input) = std::str::from_utf8(data) else {
        return;
    };
    let doc = mb_core::parse(input);
    let markdown = mb_core::to_markdown(&doc);
    let _ = mb_core::extract(&doc);

    // Everything the parser produces must be expressible in the editor's schema, or the
    // note cannot be opened. Asserted here as well as in the property suite because the
    // fuzzer explores inputs the generator cannot reach.
    assert!(
        mb_core::schema::validate(&doc).is_ok(),
        "parse produced a document outside schema.json: {:?}\n{}",
        mb_core::schema::validate(&doc),
        markdown
    );
});
