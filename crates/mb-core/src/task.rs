//! Task metadata: due dates, priorities, and the Obsidian Tasks emoji syntax.
//!
//! `SPEC.md` §10.1 chose emoji markers over a cleaner `[due:: …]` field syntax purely for
//! C5: this is the de facto standard across the Obsidian Tasks ecosystem, so tasks
//! round-trip with tooling the user already has.
//!
//! Markers this module does not recognise (notably recurrence, `🔁`, deferred in §10.4)
//! are preserved **verbatim** in [`TaskMeta::unknown`] and re-emitted unchanged. Dropping
//! them would silently destroy user data on the first edit.

use core::fmt;

pub const M_CREATED: char = '➕';
pub const M_START: char = '🛫';
pub const M_SCHEDULED: char = '⏳';
pub const M_DUE: char = '📅';
pub const M_DONE: char = '✅';
pub const M_CANCELLED: char = '❌';
/// Recognised only so that it starts the metadata region and is preserved in
/// [`TaskMeta::unknown`]. Recurrence semantics are deferred (`SPEC.md` §10.4).
pub const M_RECURRENCE: char = '🔁';

pub const P_HIGHEST: char = '🔺';
pub const P_HIGH: char = '⏫';
pub const P_MEDIUM: char = '🔼';
pub const P_LOW: char = '🔽';
pub const P_LOWEST: char = '⏬';

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TaskStatus {
    #[default]
    Todo,
    Done,
    Cancelled,
}

impl TaskStatus {
    #[must_use]
    pub fn marker(self) -> char {
        match self {
            Self::Todo => ' ',
            Self::Done => 'x',
            Self::Cancelled => '-',
        }
    }

    #[must_use]
    pub fn from_marker(c: char) -> Option<Self> {
        match c {
            ' ' => Some(Self::Todo),
            'x' | 'X' => Some(Self::Done),
            '-' => Some(Self::Cancelled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    Lowest,
    Low,
    Medium,
    High,
    Highest,
}

impl Priority {
    #[must_use]
    pub fn marker(self) -> char {
        match self {
            Self::Highest => P_HIGHEST,
            Self::High => P_HIGH,
            Self::Medium => P_MEDIUM,
            Self::Low => P_LOW,
            Self::Lowest => P_LOWEST,
        }
    }

    #[must_use]
    pub fn from_marker(c: char) -> Option<Self> {
        match c {
            P_HIGHEST => Some(Self::Highest),
            P_HIGH => Some(Self::High),
            P_MEDIUM => Some(Self::Medium),
            P_LOW => Some(Self::Low),
            P_LOWEST => Some(Self::Lowest),
            _ => None,
        }
    }
}

/// A calendar date, `YYYY-MM-DD`. Validated on construction so an invalid date cannot be
/// represented (AGENTS.md §4.1). No times in v1 (`SPEC.md` §10.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Date {
    year: i32,
    month: u8,
    day: u8,
}

impl Date {
    /// Returns `None` if the date is not a real calendar date.
    #[must_use]
    pub fn new(year: i32, month: u8, day: u8) -> Option<Self> {
        if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
            return None;
        }
        Some(Self { year, month, day })
    }

    /// Parses exactly `YYYY-MM-DD`. Rejects anything else, including partial dates.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        let b = s.as_bytes();
        if b.len() != 10 || b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
            return None;
        }
        let (y, rest) = s.split_at(4);
        let m = rest.get(1..3)?;
        let d = rest.get(4..6)?;
        if !y.bytes().all(|c| c.is_ascii_digit())
            || !m.bytes().all(|c| c.is_ascii_digit())
            || !d.bytes().all(|c| c.is_ascii_digit())
        {
            return None;
        }
        Self::new(y.parse().ok()?, m.parse().ok()?, d.parse().ok()?)
    }

    #[must_use]
    pub fn year(self) -> i32 {
        self.year
    }
    #[must_use]
    pub fn month(self) -> u8 {
        self.month
    }
    #[must_use]
    pub fn day(self) -> u8 {
        self.day
    }
}

impl fmt::Display for Date {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i32, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TaskMeta {
    pub created: Option<Date>,
    pub start: Option<Date>,
    pub scheduled: Option<Date>,
    pub due: Option<Date>,
    pub done: Option<Date>,
    pub cancelled: Option<Date>,
    pub priority: Option<Priority>,
    /// Unrecognised trailing metadata, preserved verbatim and re-emitted in order (§10.4).
    pub unknown: Vec<String>,
}

impl TaskMeta {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Task {
    pub status: TaskStatus,
    pub meta: TaskMeta,
}

/// Serializes metadata in the fixed canonical order of `SPEC.md` §4.5 / §10.1.
///
/// Returns an empty string when there is no metadata, so callers can append unconditionally.
#[must_use]
pub fn render_meta(meta: &TaskMeta) -> String {
    let mut out = String::new();
    let mut push = |marker: char, value: Option<Date>| {
        if let Some(d) = value {
            out.push(' ');
            out.push(marker);
            out.push(' ');
            out.push_str(&d.to_string());
        }
    };
    push(M_CREATED, meta.created);
    push(M_START, meta.start);
    push(M_SCHEDULED, meta.scheduled);
    push(M_DUE, meta.due);
    push(M_DONE, meta.done);
    push(M_CANCELLED, meta.cancelled);
    if let Some(p) = meta.priority {
        out.push(' ');
        out.push(p.marker());
    }
    for extra in &meta.unknown {
        out.push(' ');
        out.push_str(extra);
    }
    out
}

fn date_marker_field(c: char) -> Option<fn(&mut TaskMeta) -> &mut Option<Date>> {
    match c {
        M_CREATED => Some(|m| &mut m.created),
        M_START => Some(|m| &mut m.start),
        M_SCHEDULED => Some(|m| &mut m.scheduled),
        M_DUE => Some(|m| &mut m.due),
        M_DONE => Some(|m| &mut m.done),
        M_CANCELLED => Some(|m| &mut m.cancelled),
        _ => None,
    }
}

/// True if `c` begins metadata we can interpret. Used to find where the task text ends.
fn is_known_marker(c: char) -> bool {
    date_marker_field(c).is_some() || Priority::from_marker(c).is_some() || c == M_RECURRENCE
}

/// Splits trailing task metadata off the end of a task's text.
///
/// Returns `(remaining_text, meta)`. The metadata region starts at the first *valid*
/// marker preceded by whitespace — "valid" meaning a date marker actually followed by a
/// well-formed date, so prose like "call me 📅 sometime" is left alone as text.
///
/// Once the region starts, everything to the end belongs to metadata: unrecognised runs
/// are captured verbatim rather than dropped.
#[must_use]
pub fn split_meta(text: &str) -> (String, TaskMeta) {
    let Some(start) = find_meta_start(text) else {
        return (text.to_string(), TaskMeta::default());
    };
    let (head, region) = text.split_at(start);
    let meta = parse_meta_region(region);
    (head.trim_end().to_string(), meta)
}

fn find_meta_start(text: &str) -> Option<usize> {
    let mut prev_ws = true;
    for (idx, c) in text.char_indices() {
        if prev_ws && is_known_marker(c) {
            let rest = text.get(idx + c.len_utf8()..).unwrap_or("");
            let valid = if date_marker_field(c).is_some() {
                next_token(rest).is_some_and(|(tok, _)| Date::parse(tok).is_some())
            } else {
                true
            };
            if valid {
                return Some(idx);
            }
        }
        prev_ws = c.is_whitespace();
    }
    None
}

/// Returns the next whitespace-delimited token and the remainder after it.
fn next_token(s: &str) -> Option<(&str, &str)> {
    let trimmed = s.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    let (tok, rest) = trimmed.split_at(end);
    Some((tok, rest))
}

fn parse_meta_region(region: &str) -> TaskMeta {
    let mut meta = TaskMeta::default();
    let mut verbatim = String::new();
    let mut rest = region;

    let flush = |verbatim: &mut String, meta: &mut TaskMeta| {
        let trimmed = verbatim.trim();
        if !trimmed.is_empty() {
            meta.unknown.push(trimmed.to_string());
        }
        verbatim.clear();
    };

    while let Some((token, remainder)) = next_token(rest) {
        let mut chars = token.chars();
        let first = chars.next();
        let after_marker = chars.as_str();

        match first {
            Some(c) if date_marker_field(c).is_some() => {
                // The date may be glued to the marker or separated by a space.
                let (value, next_rest) = if after_marker.is_empty() {
                    match next_token(remainder) {
                        Some((tok, r)) => (tok, r),
                        None => ("", remainder),
                    }
                } else {
                    (after_marker, remainder)
                };
                match Date::parse(value) {
                    Some(date) => {
                        flush(&mut verbatim, &mut meta);
                        if let Some(field) = date_marker_field(c) {
                            *field(&mut meta) = Some(date);
                        }
                        rest = next_rest;
                    }
                    None => {
                        // A marker without a usable date is not metadata we understand.
                        verbatim.push(' ');
                        verbatim.push_str(token);
                        rest = remainder;
                    }
                }
            }
            Some(c) if Priority::from_marker(c).is_some() && after_marker.is_empty() => {
                flush(&mut verbatim, &mut meta);
                meta.priority = Priority::from_marker(c);
                rest = remainder;
            }
            _ => {
                verbatim.push(' ');
                verbatim.push_str(token);
                rest = remainder;
            }
        }
    }
    flush(&mut verbatim, &mut meta);
    meta
}
