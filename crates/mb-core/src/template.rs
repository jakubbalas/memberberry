//! Pure expansion of the template variables from `SPEC.md` §15.2.
//!
//! The caller supplies every changing value. This keeps the engine deterministic and
//! usable from both the server and WASM without letting templates execute code or read
//! process state.

use core::fmt::Write as _;

use crate::task::Date;

/// The values available while expanding one template.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Context<'a> {
    /// The calendar date used by date variables.
    pub date: Date,
    /// The wall-clock time as `(hour, minute, second)`.
    pub time: (u8, u8, u8),
    /// The target note title.
    pub title: &'a str,
    /// The selected text, or an empty string when there is no selection.
    pub selection: &'a str,
    /// A fresh UUIDv7 supplied by the caller.
    pub uuid: &'a str,
    /// The current user's display name.
    pub user: &'a str,
}

/// The expanded template and the byte offset at which the cursor should land.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expanded {
    /// Expanded UTF-8 text.
    pub text: String,
    /// Byte offset in [`Expanded::text`], if the template contained `{{cursor}}`.
    pub cursor: Option<usize>,
}

/// Expands the supported variables in `template`.
///
/// Unknown or malformed variables remain verbatim. `{{cursor}}` is removed and its first
/// position is returned in [`Expanded::cursor`]. No template can invoke code or access I/O.
#[must_use]
pub fn expand(template: &str, context: Context<'_>) -> Expanded {
    let mut output = String::with_capacity(template.len());
    let mut cursor = None;
    let mut rest = template;

    while let Some(start) = rest.find("{{") {
        output.push_str(&rest[..start]);
        let after_open = &rest[start + 2..];
        let Some(end) = after_open.find("}}") else {
            output.push_str(&rest[start..]);
            break;
        };
        let name = &after_open[..end];
        if name == "cursor" {
            cursor.get_or_insert(output.len());
        } else if let Some(value) = value(name, context) {
            output.push_str(&value);
        } else {
            output.push_str(&rest[start..start + end + 4]);
        }
        rest = &after_open[end + 2..];
    }
    if !rest.is_empty() && !rest.contains("{{") {
        output.push_str(rest);
    }

    Expanded {
        text: output,
        cursor,
    }
}

fn value(name: &str, context: Context<'_>) -> Option<String> {
    match name {
        "date" => Some(context.date.to_string()),
        "time" => Some(format_time(context.time)),
        "title" => Some(context.title.to_string()),
        "selection" => Some(context.selection.to_string()),
        "uuid" => Some(context.uuid.to_string()),
        "user" => Some(context.user.to_string()),
        "yesterday" => Some(context.date.checked_add_days(-1)?.to_string()),
        "tomorrow" => Some(context.date.checked_add_days(1)?.to_string()),
        _ => name
            .strip_prefix("date:")
            .map(|format| format_date(context.date, format))
            .or_else(|| {
                name.strip_prefix("time:")
                    .map(|format| format_time_with(format, context.time))
            })
            .or_else(|| relative_date(name, context.date)),
    }
}

fn relative_date(name: &str, date: Date) -> Option<String> {
    let offset = name.strip_prefix("date")?.strip_suffix('d')?;
    let amount = offset
        .strip_prefix('+')
        .or_else(|| offset.strip_prefix('-'))?;
    let amount = amount.parse::<i64>().ok()?;
    let amount = if offset.starts_with('-') {
        -amount
    } else {
        amount
    };
    Some(date.checked_add_days(amount)?.to_string())
}

fn format_time(time: (u8, u8, u8)) -> String {
    format_time_with("%H:%M:%S", time)
}

fn format_date(date: Date, format: &str) -> String {
    format_tokens(format, |token| match token {
        'Y' => Some(format_number(i64::from(date.year()), 4)),
        'm' => Some(format_number(i64::from(date.month()), 2)),
        'd' => Some(format_number(i64::from(date.day()), 2)),
        _ => None,
    })
}

fn format_time_with(format: &str, time: (u8, u8, u8)) -> String {
    format_tokens(format, |token| match token {
        'H' => Some(format_number(i64::from(time.0), 2)),
        'M' => Some(format_number(i64::from(time.1), 2)),
        'S' => Some(format_number(i64::from(time.2), 2)),
        _ => None,
    })
}

fn format_tokens(format: &str, value: impl Fn(char) -> Option<String>) -> String {
    let mut output = String::new();
    let mut chars = format.chars();
    while let Some(character) = chars.next() {
        if character != '%' {
            output.push(character);
            continue;
        }
        match chars.next() {
            Some('%') => output.push('%'),
            Some(token) => {
                output.push('%');
                output.push(token);
                if let Some(rendered) = value(token) {
                    output.truncate(output.len() - 2);
                    output.push_str(&rendered);
                }
            }
            None => output.push('%'),
        }
    }
    output
}

fn format_number(value: i64, width: usize) -> String {
    let mut output = String::new();
    let _ = write!(output, "{value:0width$}");
    output
}
