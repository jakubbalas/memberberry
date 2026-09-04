//! Response compression for the HTTP surface.
//!
//! `SPEC.md` §21.2 budgets the critical-path bundle **in gzip**, and until this existed
//! nothing in the serving path compressed anything: a cold load transferred 1.39 MB of
//! JS and WASM against a budget measured at 515.9 KB. Both figures were true and they
//! answered different questions — the budget described a deployment behind a compressing
//! proxy, and the server described itself. §21.1 called that out rather than folding it
//! into the harness's own change; this closes it.
//!
//! # Why this is hand-written rather than `tower-http`
//!
//! `tower_http::CompressionLayer` does this and more, at the cost of `tower-http` and
//! `async-compression` on the public serving path. Its advantage — compressing a body as it
//! streams — buys nothing here, because every response this server produces is already
//! wholly in memory before the middleware sees it. What is left is a content-type
//! predicate, an `Accept-Encoding` parse and a call to `flate2` — about a hundred lines,
//! for which the allowlist, the compression level and the exact set of responses that get
//! touched are all visible in one file (`AGENTS.md` §3.3, §4.1).
//!
//! # What it deliberately does not do
//!
//! - **No brotli.** It would shave a further ~15% off the WASM, and it is the obvious next
//!   step if the bundle budget stays out of range after §21.1's other levers. It is left
//!   out here so this change has one variable: gzip is what §21.2 is written in, so gzip is
//!   what makes the served figure comparable to the budgeted one.
//! - **No streaming.** A body whose length is not known up front is passed through
//!   untouched rather than buffered (see [`MAX_COMPRESS_BYTES`]).
//!
//! # BREACH
//!
//! Compressing a response that mixes a secret with attacker-controlled text leaks the
//! secret through its length. That is safe here for a specific, checkable reason: no
//! response body in this server contains a secret. Session tokens travel in `Set-Cookie`
//! and API tokens in `Authorization`, both headers, and headers are not compressed. **If a
//! CSRF token, a share-link secret or a signed URL is ever rendered into a page body, this
//! module has to exclude that route** — `form-action 'none'` and same-site cookies are why
//! no such token exists today, not an accident to be relied on silently.

use axum::extract::Request;
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;
use flate2::Compression;
use flate2::write::GzEncoder;
use http_body::Body as _;
use std::io::Write;

/// Bodies at or below this are sent as they are.
///
/// why: gzip costs an 18-byte envelope plus `Content-Encoding` and `Vary` headers, and a
/// short JSON body or a redirect compresses to more bytes than it saves. 256 is comfortably
/// above the break-even point and below anything whose size this project cares about.
const MIN_COMPRESS_BYTES: u64 = 256;

/// Bodies above this are sent as they are.
///
/// why: compressing means holding the whole body plus its compressed form in memory, and
/// §21.2 budgets the server at under 150 MB. The cap is 16 MB rather than something larger
/// because the largest thing on a compressible route is a note page, and §21.2's own
/// "notes ≥ 20k words" is three orders of magnitude below it. A body over the cap — or one
/// whose length is not known up front, which is what a streamed body looks like here — is
/// passed through *without being read*, so nothing can consume a body it cannot rebuild.
const MAX_COMPRESS_BYTES: u64 = 16 * 1024 * 1024;

/// Level 9, not the default 6.
///
/// why: `web/perf/bundle.ts` measures the §21.2 budget at level 9, on the grounds that it is
/// the smallest figure an operator can achieve and so the one a budget should be written
/// against. Serving at a lower level would mean the budget and the wire disagreed again,
/// just by less — which is the thing §21.1 objected to.
///
/// That reasoning would not survive the cost on its own, and §21.7 has the measurements
/// rather than an assertion: on the 945 KB WebAssembly module level 9 buys **783 bytes**
/// over level 6 for **47% more CPU**. What makes it the right level anyway is that the one
/// body big enough for that to matter is an immutable content-hashed asset, compressed once
/// and cached. Every other response through here is a page or a JSON reply in the low tens
/// of kilobytes, where the whole operation is under a millisecond.
const LEVEL: Compression = Compression::new(9);

/// Content types this will compress, as exact types or `type/` prefixes.
///
/// An allowlist rather than a deny-list, because the failure modes are asymmetric: a
/// compressible type missing from this list wastes bandwidth, and an incompressible one
/// wrongly included wastes CPU on every request to grow the body slightly. Everything the
/// server serves today is here; `image/*`, `font/*` and `application/octet-stream` are
/// absent on purpose, being already-compressed formats or unknown ones.
const COMPRESSIBLE: &[&str] = &[
    "text/",
    "application/javascript",
    "application/json",
    "application/wasm",
    "image/svg+xml",
];

/// Compresses a response with gzip when the client asked for it and the body is worth it.
///
/// Applied to the whole router, the WebSocket route included. What happens there was
/// **measured rather than assumed**, because the first version of this comment had it wrong
/// twice over. Compressing the `101 Switching Protocols` anyway still leaves a *working*
/// socket: axum spawns the upgrade task from the request and does not consult the response,
/// so no guard here is load-bearing for sync. And the guard that actually catches the `101`
/// is [`is_compressible`], not [`has_a_body`] — a handshake carries no content type, so it
/// fails the allowlist first. `has_a_body` is redundant for the `101` on purpose and earns
/// its place on the `304` the asset route will return once it learns conditional requests,
/// which *will* carry a content type. What both prevent is the same lie: `Content-Encoding`
/// on a response that has no body.
pub async fn gzip(request: Request, next: Next) -> Response {
    let wanted = accepts_gzip(request.headers().get(header::ACCEPT_ENCODING));
    let mut response = next.run(request).await;

    if !has_a_body(&response) || !is_compressible(&response) {
        return response;
    }
    // Set on every compressible response, not only the compressed ones: a cache that saw
    // this response without the header would be free to hand a gzipped body to a client that
    // never asked for one.
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    if !wanted {
        return response;
    }
    let Some(length) = response.body().size_hint().exact() else {
        return response;
    };
    if !(MIN_COMPRESS_BYTES..=MAX_COMPRESS_BYTES).contains(&length) {
        return response;
    }

    let (mut parts, body) = response.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, MAX_COMPRESS_BYTES as usize).await else {
        // Unreachable given the exact size hint above, and a 500 rather than a silent empty
        // body if that ever stops being true.
        return internal_error();
    };
    let Ok(compressed) = to_gzip(&bytes) else {
        return internal_error();
    };
    // why: gzip *grows* incompressible input, by the envelope plus a stored-block header per
    // chunk. Sending it anyway costs the client bytes on the wire and a decompression pass
    // for the privilege. Found by a test: an asset the route below had already declined to
    // cache for exactly this reason came back through here 23 bytes larger than the file.
    if compressed.len() >= bytes.len() {
        return Response::from_parts(parts, axum::body::Body::from(bytes));
    }

    parts
        .headers
        .insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    // Whatever length was on the way in describes the uncompressed body. Removing it lets
    // hyper set the real one from the body it is about to write.
    parts.headers.remove(header::CONTENT_LENGTH);
    Response::from_parts(parts, axum::body::Body::from(compressed))
}

/// Whether `Accept-Encoding` offers gzip with a non-zero quality.
///
/// A `q=0` is an explicit refusal and not the same as absence, which is why this parses the
/// header rather than searching it for the substring `gzip`.
pub(crate) fn accepts_gzip(header: Option<&HeaderValue>) -> bool {
    let Some(value) = header.and_then(|value| value.to_str().ok()) else {
        return false;
    };
    value.split(',').any(|entry| {
        let mut parts = entry.split(';').map(str::trim);
        let coding = parts.next().unwrap_or_default();
        if !coding.eq_ignore_ascii_case("gzip") && coding != "*" {
            return false;
        }
        parts.all(|parameter| {
            parameter
                .strip_prefix("q=")
                .and_then(|q| q.parse::<f32>().ok())
                .is_none_or(|q| q > 0.0)
        })
    })
}

/// Whether this status is allowed to carry a body at all.
///
/// RFC 9110: a `1xx`, a `204` or a `304` has no body, so `Content-Encoding` and `Vary` on one
/// describe nothing. The case that reaches this in practice is the WebSocket handshake's
/// `101`; `304` arrives once the asset route learns conditional requests.
fn has_a_body(response: &Response) -> bool {
    let status = response.status();
    !status.is_informational()
        && status != StatusCode::NO_CONTENT
        && status != StatusCode::NOT_MODIFIED
}

/// Whether this response's content type is on the allowlist and it is not already encoded.
fn is_compressible(response: &Response) -> bool {
    if response.headers().contains_key(header::CONTENT_ENCODING) {
        return false;
    }
    response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(is_compressible_type)
}

/// Whether a content type is on the allowlist.
///
/// Shared with the asset route, which compresses ahead of this middleware and must apply the
/// same rule — a second allowlist is a second thing to forget `application/wasm` from.
pub(crate) fn is_compressible_type(content_type: &str) -> bool {
    // Compared without lowercasing the header first: a content type is ASCII-insensitive
    // (RFC 9110), and `to_ascii_lowercase` would allocate a `String` on every response to
    // answer a prefix question.
    COMPRESSIBLE.iter().any(|candidate| {
        content_type.len() >= candidate.len()
            && content_type
                .get(..candidate.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(candidate))
    })
}

/// Gzips `bytes` at [`LEVEL`].
///
/// `pub(crate)` for the asset route, which compresses ahead of this middleware so an
/// immutable bundle file is compressed once rather than on every request; see
/// [`crate::http::AppState::compressed_asset`].
pub(crate) fn to_gzip(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::with_capacity(bytes.len() / 3), LEVEL);
    encoder.write_all(bytes)?;
    encoder.finish()
}

fn internal_error() -> Response {
    use axum::response::IntoResponse as _;
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "compressing the response failed",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    // AGENTS.md §4.2 permits these in tests; the crate denies them for library code.
    #![allow(clippy::expect_used)]

    use super::*;

    fn offers(value: &str) -> bool {
        accepts_gzip(Some(&HeaderValue::from_str(value).expect("a valid header")))
    }

    #[test]
    fn an_absent_accept_encoding_offers_nothing() {
        assert!(!accepts_gzip(None));
    }

    #[test]
    fn gzip_is_recognised_however_it_is_spelled_or_positioned() {
        for value in [
            "gzip",
            "GZip",
            " gzip ",
            "gzip;q=1",
            "gzip;q=0.001",
            "*",
            "br, gzip",
            "br;q=1.0, gzip;q=0.5, *;q=0.1",
            "identity;q=0, gzip",
        ] {
            assert!(offers(value), "`{value}` offers gzip");
        }
    }

    #[test]
    fn a_refusal_or_an_absence_is_not_an_offer() {
        for value in [
            "",
            "identity",
            "br",
            "br, deflate",
            // q=0 is the explicit "not this one", and the reason this parses rather than
            // searching for a substring.
            "gzip;q=0",
            "gzip;q=0.0",
            "gzip;q=0.000",
            "br, gzip;q=0",
            "*;q=0",
            // Not gzip, despite starting with it.
            "gzipped",
        ] {
            assert!(!offers(value), "`{value}` does not offer gzip");
        }
    }

    #[test]
    fn an_unparseable_quality_is_treated_as_an_offer_rather_than_a_refusal() {
        // why: only `q=0` is a refusal. A malformed parameter is a malformed *parameter*,
        // not a "no" — and reading it as one would silently stop compressing for a client
        // that sent something odd, which is a bandwidth bug nobody would ever notice. The
        // failure direction matters: guessing "yes" wastes nothing, because the client
        // asked for gzip in the same breath.
        assert!(offers("gzip;q=high"));
        assert!(offers("gzip;lolwhat"));
    }

    #[test]
    fn a_header_that_is_not_utf8_offers_nothing() {
        let raw = HeaderValue::from_bytes(&[0xff, 0xfe]).expect("a valid header value");
        assert!(!accepts_gzip(Some(&raw)));
    }

    #[test]
    fn deflate_round_trips() {
        use std::io::Read as _;
        let original = "berries ".repeat(500);
        let compressed = to_gzip(original.as_bytes()).expect("compressing");
        assert!(compressed.len() < original.len() / 10, "highly repetitive");
        let mut back = String::new();
        flate2::read::GzDecoder::new(compressed.as_slice())
            .read_to_string(&mut back)
            .expect("decompressing");
        assert_eq!(back, original);
    }

    #[test]
    fn deflate_handles_an_empty_body() {
        // Not reachable through `gzip` — MIN_COMPRESS_BYTES excludes it — but a compressor
        // that panicked on an empty slice would be a landmine for whoever changes that
        // constant.
        assert!(!to_gzip(&[]).expect("compressing nothing").is_empty());
    }
}
