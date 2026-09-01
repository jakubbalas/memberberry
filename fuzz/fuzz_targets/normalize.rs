//! Normalization convergence under libFuzzer (`SPEC.md` §4.5, §22.1).
//!
//! `normalize` must reach a fixpoint in one pass. If it does not, a file rewrites itself on
//! every save and the "one-time git diff" promised in §4.5 becomes permanent churn across
//! every synced client.

#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(input) = std::str::from_utf8(data) else {
        return;
    };
    let once = mb_core::normalize(input);
    let twice = mb_core::normalize(&once);
    assert_eq!(
        once, twice,
        "normalisation did not converge for input {input:?}"
    );
});
