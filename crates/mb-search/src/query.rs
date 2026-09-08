//! Offline query syntax. Terms are prefix-matched; quoted phrases deliberately degrade to
//! AND because the compact format stores no positions (`SPEC.md` §14.2).

use std::collections::BTreeSet;

use unicode_normalization::UnicodeNormalization;

use crate::Error;

/// A searchable field. `Any` is populated from every indexed text field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    /// Combined namespace populated from all searchable fields.
    Any,
    /// Visible note text.
    Body,
    /// Display title.
    Title,
    /// Vault-relative path.
    Path,
    /// Full tags.
    Tag,
}

impl Field {
    pub(crate) const fn marker(self) -> u8 {
        match self {
            Self::Any => 1,
            Self::Body => 2,
            Self::Title => 3,
            Self::Path => 4,
            Self::Tag => 5,
        }
    }

    fn named(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "body" => Some(Self::Body),
            "title" => Some(Self::Title),
            "path" => Some(Self::Path),
            "tag" => Some(Self::Tag),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Expr {
    Term(Field, String),
    And(Box<Self>, Box<Self>),
    Or(Box<Self>, Box<Self>),
    Not(Box<Self>),
}

/// A parsed compact-index query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    expression: Expr,
    phrase_degraded: bool,
}

impl Query {
    /// Parses boolean query syntax. `NOT` binds tighter than `AND`, which binds tighter than
    /// `OR`; adjacent terms imply `AND`. Field names are `body`, `title`, `path`, and `tag`.
    pub fn parse(source: &str) -> Result<Self, QueryError> {
        let tokens = lex(source)?;
        if tokens.is_empty() {
            return Err(QueryError::Empty);
        }
        let phrase_degraded = tokens.iter().any(|token| matches!(token, Token::Phrase(_)));
        let mut parser = Parser {
            tokens: &tokens,
            position: 0,
        };
        let expression = parser.or()?;
        if parser.position != tokens.len() {
            return Err(QueryError::UnexpectedToken);
        }
        Ok(Self {
            expression,
            phrase_degraded,
        })
    }

    /// Whether at least one quoted phrase is using the documented offline AND fallback.
    #[must_use]
    pub const fn phrase_degraded(&self) -> bool {
        self.phrase_degraded
    }

    pub(crate) fn evaluate<F>(
        &self,
        universe: &BTreeSet<u32>,
        mut lookup: F,
    ) -> Result<BTreeSet<u32>, Error>
    where
        F: FnMut(Field, &str) -> Result<BTreeSet<u32>, Error>,
    {
        evaluate(&self.expression, universe, &mut lookup)
    }
}

fn evaluate<F>(
    expression: &Expr,
    universe: &BTreeSet<u32>,
    lookup: &mut F,
) -> Result<BTreeSet<u32>, Error>
where
    F: FnMut(Field, &str) -> Result<BTreeSet<u32>, Error>,
{
    match expression {
        Expr::Term(field, term) => lookup(*field, term),
        Expr::And(left, right) => {
            let left = evaluate(left, universe, lookup)?;
            let right = evaluate(right, universe, lookup)?;
            Ok(left.intersection(&right).copied().collect())
        }
        Expr::Or(left, right) => {
            let left = evaluate(left, universe, lookup)?;
            let right = evaluate(right, universe, lookup)?;
            Ok(left.union(&right).copied().collect())
        }
        Expr::Not(inner) => {
            let excluded = evaluate(inner, universe, lookup)?;
            Ok(universe.difference(&excluded).copied().collect())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Word(String),
    Phrase(String),
    And,
    Or,
    Not,
    Left,
    Right,
}

fn lex(source: &str) -> Result<Vec<Token>, QueryError> {
    let mut chars = source.chars().peekable();
    let mut tokens = Vec::new();
    while let Some(character) = chars.next() {
        if character.is_whitespace() {
            continue;
        }
        match character {
            '(' => tokens.push(Token::Left),
            ')' => tokens.push(Token::Right),
            '"' => {
                let mut phrase = String::new();
                let mut closed = false;
                for next in chars.by_ref() {
                    if next == '"' {
                        closed = true;
                        break;
                    }
                    phrase.push(next);
                }
                if !closed {
                    return Err(QueryError::UnclosedQuote);
                }
                tokens.push(Token::Phrase(phrase));
            }
            _ => {
                let mut word = String::from(character);
                while let Some(next) = chars.peek() {
                    if next.is_whitespace() || matches!(next, '(' | ')' | '"') {
                        break;
                    }
                    if let Some(next) = chars.next() {
                        word.push(next);
                    }
                }
                tokens.push(match word.to_ascii_uppercase().as_str() {
                    "AND" => Token::And,
                    "OR" => Token::Or,
                    "NOT" => Token::Not,
                    _ => Token::Word(word),
                });
            }
        }
    }
    Ok(tokens)
}

struct Parser<'a> {
    tokens: &'a [Token],
    position: usize,
}

impl Parser<'_> {
    fn or(&mut self) -> Result<Expr, QueryError> {
        let mut expression = self.and()?;
        while self.take(&Token::Or) {
            expression = Expr::Or(Box::new(expression), Box::new(self.and()?));
        }
        Ok(expression)
    }

    fn and(&mut self) -> Result<Expr, QueryError> {
        let mut expression = self.unary()?;
        loop {
            if self.take(&Token::And) || self.starts_expression() {
                expression = Expr::And(Box::new(expression), Box::new(self.unary()?));
            } else {
                break;
            }
        }
        Ok(expression)
    }

    fn unary(&mut self) -> Result<Expr, QueryError> {
        if self.take(&Token::Not) {
            return Ok(Expr::Not(Box::new(self.unary()?)));
        }
        if self.take(&Token::Left) {
            let expression = self.or()?;
            if !self.take(&Token::Right) {
                return Err(QueryError::UnclosedParenthesis);
            }
            return Ok(expression);
        }
        let token = self
            .tokens
            .get(self.position)
            .ok_or(QueryError::MissingTerm)?;
        self.position += 1;
        match token {
            Token::Word(word) => {
                if let Some(name) = word.strip_suffix(':')
                    && let Some(Token::Phrase(phrase)) = self.tokens.get(self.position)
                {
                    let field = Field::named(name).ok_or(QueryError::UnknownField)?;
                    self.position += 1;
                    return phrase_expression(field, phrase);
                }
                word_expression(word)
            }
            Token::Phrase(phrase) => phrase_expression(Field::Any, phrase),
            _ => Err(QueryError::MissingTerm),
        }
    }

    fn take(&mut self, wanted: &Token) -> bool {
        if self.tokens.get(self.position) == Some(wanted) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn starts_expression(&self) -> bool {
        matches!(
            self.tokens.get(self.position),
            Some(Token::Word(_) | Token::Phrase(_) | Token::Not | Token::Left)
        )
    }
}

fn word_expression(word: &str) -> Result<Expr, QueryError> {
    let (field, value) = if let Some((name, value)) = word.split_once(':') {
        let field = Field::named(name).ok_or(QueryError::UnknownField)?;
        if value.is_empty() {
            return Err(QueryError::MissingTerm);
        }
        (field, value)
    } else {
        (Field::Any, word)
    };
    phrase_expression(field, value)
}

fn phrase_expression(field: Field, value: &str) -> Result<Expr, QueryError> {
    let terms = normalize_terms(value);
    let mut terms = terms.into_iter();
    let first = terms.next().ok_or(QueryError::MissingTerm)?;
    Ok(terms.fold(Expr::Term(field, first), |left, term| {
        Expr::And(Box::new(left), Box::new(Expr::Term(field, term)))
    }))
}

fn normalize_terms(value: &str) -> Vec<String> {
    value
        .nfc()
        .collect::<String>()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// Invalid compact-index query syntax.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum QueryError {
    #[error("query is empty")]
    Empty,
    #[error("query is missing a term")]
    MissingTerm,
    #[error("query uses an unknown field")]
    UnknownField,
    #[error("quoted query is not closed")]
    UnclosedQuote,
    #[error("parenthesized query is not closed")]
    UnclosedParenthesis,
    #[error("query contains an unexpected operator or parenthesis")]
    UnexpectedToken,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boolean_precedence_is_not_then_and_then_or() {
        let query = Query::parse("one OR two AND NOT three").expect("query");
        assert_eq!(
            query.expression,
            Expr::Or(
                Box::new(Expr::Term(Field::Any, "one".into())),
                Box::new(Expr::And(
                    Box::new(Expr::Term(Field::Any, "two".into())),
                    Box::new(Expr::Not(Box::new(Expr::Term(Field::Any, "three".into()))))
                ))
            )
        );
    }

    #[test]
    fn adjacent_terms_and_a_phrase_are_ands() {
        let query = Query::parse("title:Roadmap \"next step\"").expect("query");
        assert!(query.phrase_degraded());
        assert!(matches!(query.expression, Expr::And(_, _)));
    }

    #[test]
    fn a_field_can_scope_a_quoted_phrase() {
        let query = Query::parse("title:\"Product Roadmap\"").expect("query");
        assert_eq!(
            query.expression,
            Expr::And(
                Box::new(Expr::Term(Field::Title, "product".into())),
                Box::new(Expr::Term(Field::Title, "roadmap".into()))
            )
        );
    }

    #[test]
    fn malformed_queries_fail_closed() {
        for source in ["", "OR x", "x AND", "(x", "x)", "\"x"] {
            assert!(Query::parse(source).is_err(), "{source}");
        }
    }
}
