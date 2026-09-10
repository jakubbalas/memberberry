//! Safe input and fetching for the web clipper (`SPEC.md` §16.3).

use std::net::{IpAddr, Ipv6Addr};
use std::time::Duration;

use crate::Vault;

/// Whether one authenticated actor may clip into an exact destination path.
#[must_use]
pub fn may_write(
    access: &mb_core::Access,
    actor: &mb_core::Username,
    path: &mb_core::NotePath,
    token_role: Option<mb_core::Role>,
) -> bool {
    matches!(
        access.effective_role(actor, path),
        mb_core::Role::Owner | mb_core::Role::Editor
    ) && token_role.is_none_or(|role| matches!(role, mb_core::Role::Owner | mb_core::Role::Editor))
}

/// Maximum HTML fetched for one clip.
pub const MAX_HTML_BYTES: usize = 4 * 1024 * 1024;
/// Maximum wall-clock time spent fetching one page and its images.
pub const MAX_CLIP_DURATION: Duration = Duration::from_secs(20);
const MAX_REDIRECTS: usize = 3;
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGES: usize = 32;

/// Errors produced before HTML reaches the core converter.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FetchError {
    /// The URL is not an allowed public HTTP(S) URL.
    #[error("clip URL is not allowed")]
    Url,
    /// The remote server exceeded one of the clip budgets.
    #[error("clip response exceeded its limit")]
    TooLarge,
    /// The remote server could not be reached or returned an invalid response.
    #[error("clip fetch failed")]
    Network,
}

/// Rejects schemes, hostnames and literal addresses that must never be fetched server-side.
pub fn validate_url(value: &str) -> Result<reqwest::Url, FetchError> {
    let url = reqwest::Url::parse(value).map_err(|_| FetchError::Url)?;
    if !matches!(url.scheme(), "http" | "https") || url.username() != "" || url.password().is_some()
    {
        return Err(FetchError::Url);
    }
    let host = url.host_str().ok_or(FetchError::Url)?;
    if host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host.eq_ignore_ascii_case("metadata.google.internal")
    {
        return Err(FetchError::Url);
    }
    if let Ok(address) = host.trim_matches(['[', ']']).parse::<IpAddr>()
        && is_private(address)
    {
        return Err(FetchError::Url);
    }
    Ok(url)
}

/// Fetches bounded HTML, following only a few validated redirects.
pub async fn fetch(url: &str) -> Result<(String, String), FetchError> {
    let fetched = fetch_bounded(url, MAX_HTML_BYTES).await?;
    let html = String::from_utf8(fetched.bytes).map_err(|_| FetchError::Network)?;
    Ok((html, fetched.url))
}

/// Rehosts safe, bounded image URLs found in a clip before it becomes Markdown.
pub async fn rehost_images(html: &str, base: &str, vault: &Vault) -> String {
    let mut output = html.to_string();
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0usize;
    let mut fetched = 0usize;
    while fetched < MAX_IMAGES {
        let Some(start) = lower.get(cursor..).and_then(|part| part.find("<img")) else {
            break;
        };
        let start = cursor + start;
        let Some(end_offset) = lower.get(start..).and_then(|part| part.find('>')) else {
            break;
        };
        let end = start + end_offset;
        let Some(src_offset) = lower.get(start..end).and_then(|part| part.find("src")) else {
            cursor = end.saturating_add(1);
            continue;
        };
        let attribute = start + src_offset + 3;
        let Some(value_start) = html
            .get(attribute..end)
            .and_then(|part| part.find('='))
            .map(|offset| attribute + offset + 1)
        else {
            cursor = end.saturating_add(1);
            continue;
        };
        let value_start = html
            .get(value_start..)
            .map(|value| value.trim_start_matches(char::is_whitespace).len())
            .map(|offset| value_start + offset)
            .unwrap_or(value_start);
        let Some((value_end, raw_url)) = html_attribute_value(html, value_start, end) else {
            cursor = end.saturating_add(1);
            continue;
        };
        if let Ok(url) = reqwest::Url::parse(base).and_then(|base| base.join(raw_url))
            && validate_url(url.as_str()).is_ok()
            && let Ok((bytes, content_type)) = fetch_bytes(url.as_str()).await
            && let Some(extension) = image_extension(raw_url, &content_type, &bytes)
            && let Ok(store) = crate::media::Store::new(vault)
            && let Ok(path) = store.put(&bytes, extension).await
        {
            output = output.replace(raw_url, &path);
            fetched += 1;
        }
        cursor = value_end.saturating_add(1);
    }
    output
}

fn html_attribute_value(html: &str, start: usize, end: usize) -> Option<(usize, &str)> {
    let first = html.as_bytes().get(start).copied()?;
    if matches!(first, b'"' | b'\'') {
        let close = html.get(start + 1..end)?.find(char::from(first))? + start + 1;
        return Some((close, html.get(start + 1..close)?));
    }
    let value = html.get(start..end)?;
    let length = value.find(char::is_whitespace).unwrap_or(value.len());
    Some((start + length, value.get(..length)?))
}

async fn client_for(url: &reqwest::Url) -> Result<reqwest::Client, FetchError> {
    let host = url.host_str().ok_or(FetchError::Url)?;
    let port = url.port_or_known_default().ok_or(FetchError::Url)?;
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| FetchError::Network)?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|address| is_private(address.ip())) {
        return Err(FetchError::Url);
    }
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        // why: pin the addresses just checked. Resolving again inside reqwest would reopen
        // DNS rebinding between validation and connection.
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| FetchError::Network)
}

async fn fetch_bytes(url: &str) -> Result<(Vec<u8>, String), FetchError> {
    let fetched = fetch_bounded(url, MAX_IMAGE_BYTES).await?;
    Ok((fetched.bytes, fetched.content_type))
}

struct Fetched {
    bytes: Vec<u8>,
    content_type: String,
    url: String,
}

async fn fetch_bounded(url: &str, max_bytes: usize) -> Result<Fetched, FetchError> {
    let mut current = validate_url(url)?;
    for redirect in 0..=MAX_REDIRECTS {
        let client = client_for(&current).await?;
        let response = client
            .get(current.clone())
            .send()
            .await
            .map_err(|_| FetchError::Network)?;
        if response.status().is_redirection() {
            if redirect == MAX_REDIRECTS {
                return Err(FetchError::Network);
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(FetchError::Network)?;
            current = validate_url(
                current
                    .join(location)
                    .map_err(|_| FetchError::Url)?
                    .as_str(),
            )?;
            continue;
        }
        if !response.status().is_success() {
            return Err(FetchError::Network);
        }
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes as u64)
        {
            return Err(FetchError::TooLarge);
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mut bytes = Vec::new();
        let mut response = response;
        while let Some(chunk) = response.chunk().await.map_err(|_| FetchError::Network)? {
            if bytes.len().saturating_add(chunk.len()) > max_bytes {
                return Err(FetchError::TooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok(Fetched {
            bytes,
            content_type,
            url: current.to_string(),
        });
    }
    Err(FetchError::Network)
}

fn image_extension(url: &str, content_type: &str, bytes: &[u8]) -> Option<&'static str> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let requested = parsed.path().rsplit('.').next().unwrap_or("");
    let requested = if requested.eq_ignore_ascii_case("jpeg") {
        "jpg"
    } else {
        requested
    };
    let requested = match requested.to_ascii_lowercase().as_str() {
        "jpg" | "png" | "gif" | "webp" => requested,
        _ if content_type.contains("jpeg") => "jpg",
        _ if content_type.contains("png") => "png",
        _ if content_type.contains("gif") => "gif",
        _ if content_type.contains("webp") => "webp",
        _ => return None,
    };
    crate::media::upload_extension(bytes, requested)
}

fn is_private(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_broadcast()
                || address.is_documentation()
                || address.octets()[0] == 0
                || address.octets()[0] >= 224
        }
        IpAddr::V6(address) => {
            address.is_loopback() || address.is_unspecified() || is_ipv6_private(address)
        }
    }
}

fn is_ipv6_private(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || address
            .to_ipv4()
            .is_some_and(|v4| is_private(IpAddr::V4(v4)))
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use tempfile::TempDir;

    use super::{
        FetchError, client_for, html_attribute_value, image_extension, is_private, rehost_images,
        validate_url,
    };
    use crate::{Slug, Vault};

    #[test]
    fn rejects_non_http_and_private_targets() {
        for value in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "http://127.0.0.1/",
            "http://[::1]/",
            "http://metadata.google.internal/",
        ] {
            assert_eq!(validate_url(value), Err(FetchError::Url));
        }
    }

    #[test]
    fn accepts_public_http_urls_without_credentials() {
        assert!(validate_url("https://example.com/article").is_ok());
        assert_eq!(
            validate_url("https://user@example.com/"),
            Err(FetchError::Url)
        );
    }

    #[test]
    fn accepts_only_matching_supported_image_formats() {
        assert_eq!(
            image_extension("https://example.com/photo.png", "image/png", b"not png"),
            None
        );
        assert_eq!(
            image_extension("https://example.com/photo.svg", "image/svg+xml", b"<svg/>"),
            None
        );
    }

    #[test]
    fn reads_quoted_unquoted_and_malformed_html_attribute_values() {
        assert_eq!(
            html_attribute_value("\"one.png\"", 0, 9),
            Some((8, "one.png"))
        );
        assert_eq!(
            html_attribute_value("'two.png'", 0, 9),
            Some((8, "two.png"))
        );
        assert_eq!(
            html_attribute_value("three.png rest", 0, 14),
            Some((9, "three.png"))
        );
        assert_eq!(html_attribute_value("\"unclosed", 0, 9), None);
        assert_eq!(html_attribute_value("", 0, 0), None);
    }

    #[tokio::test]
    async fn malformed_and_private_image_sources_are_left_unchanged()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = TempDir::new()?;
        let vault = Vault::open(Slug::parse("clip-test")?, "Clip test", directory.path())?;
        for html in [
            "<img",
            "<img alt='none'>",
            "<img src>",
            "<img src='unclosed>",
            "<img src='http://127.0.0.1/private.png'>",
        ] {
            assert_eq!(
                rehost_images(html, "https://example.com/base", &vault).await,
                html
            );
        }
        Ok(())
    }

    #[tokio::test]
    async fn a_checked_public_literal_can_build_a_pinned_client()
    -> Result<(), Box<dyn std::error::Error>> {
        let url = reqwest::Url::parse("https://8.8.8.8/")?;
        assert!(client_for(&url).await.is_ok());
        Ok(())
    }

    #[test]
    fn rejects_private_addresses_after_dns_resolution() {
        for address in [
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)),
            IpAddr::V4(Ipv4Addr::BROADCAST),
            IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)),
            IpAddr::V4(Ipv4Addr::new(224, 0, 0, 1)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            IpAddr::V6(Ipv6Addr::UNSPECIFIED),
            IpAddr::V6(Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 1)),
            IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1)),
            IpAddr::V6(Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0x7f00, 1)),
        ] {
            assert!(is_private(address), "{address} must never be connected to");
        }
        assert!(!is_private(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!is_private(IpAddr::V6(Ipv6Addr::new(
            0x2001, 0x4860, 0x4860, 0, 0, 0, 0, 0x8888,
        ))));
    }
}
