//! Tantivy-backed server search, paired with the SQLite graph index (`SPEC.md` §14.1).
//!
//! Writes are unfiltered because the index describes the vault. Reads exist only on
//! [`Reader`](crate::Reader), and every query is intersected with that reader's SQLite
//! readable set before Tantivy executes it (E5). The path term is therefore authorization,
//! not a client-side result filter.

use std::path::Path;

use tantivy::collector::TopDocs;
use tantivy::query::{
    AllQuery, BooleanQuery, Occur, PhraseQuery, Query, QueryParser, TermQuery, TermSetQuery,
};
use tantivy::schema::{
    Field, IndexRecordOption, STORED, STRING, Schema, TEXT, TextFieldIndexing, TextOptions, Value,
};
use tantivy::{
    Index as TantivyIndex, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, Term, doc,
};

use crate::{Error, Reader};

const WRITER_HEAP_BYTES: usize = 50_000_000;

/// One matched block, with enough note metadata to render a result row.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    /// Vault-relative note path.
    pub path: String,
    /// Parsed note title, when one exists.
    pub title: Option<String>,
    /// Visible text of the block that matched.
    pub context: String,
    /// Tantivy relevance score. Only meaningful relative to other hits in this response.
    pub score: f32,
}

/// One readable note whose text names another note without linking to it (§9.5, E8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MentionGroup {
    /// Vault-relative path of the mentioning note.
    pub path: String,
    /// Its title, or `None` when it has nothing titleable.
    pub title: Option<String>,
    /// Visible text of each mentioning block, in document order.
    pub contexts: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
struct Fields {
    identity: Field,
    path: Field,
    title: Field,
    display_title: Field,
    alias: Field,
    tag: Field,
    body: Field,
    /// Position of the block within its note, so a mention list reads in document order.
    ordinal: Field,
}

pub(crate) struct SearchIndex {
    index: TantivyIndex,
    reader: IndexReader,
    writer: IndexWriter,
    fields: Fields,
}

impl std::fmt::Debug for SearchIndex {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SearchIndex")
            .finish_non_exhaustive()
    }
}

impl SearchIndex {
    pub(crate) fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        let path = path.as_ref();
        Self::create_in(path)?;
        match Self::open_in(path) {
            // why: a schema change rebuilds and never migrates, which is the rule
            // `schema.rs` already applies to SQLite. The text index is derived and
            // disposable (§14.1), and `Index::open` responds to an empty one by clearing
            // the note stamps, so the next reconcile rereads every Markdown file (I1).
            // Only a schema mismatch is recovered from: wiping the directory on, say, a
            // lock held by another process would destroy an index that is merely busy.
            Err(Error::Search(tantivy::TantivyError::SchemaError(_))) => {
                std::fs::remove_dir_all(path).map_err(|source| Error::Directory {
                    path: path.to_path_buf(),
                    source,
                })?;
                Self::create_in(path)?;
                Self::open_in(path)
            }
            outcome => outcome,
        }
    }

    fn create_in(path: &Path) -> Result<(), Error> {
        std::fs::create_dir_all(path).map_err(|source| Error::Directory {
            path: path.to_path_buf(),
            source,
        })
    }

    fn open_in(path: &Path) -> Result<Self, Error> {
        let directory =
            tantivy::directory::MmapDirectory::open(path).map_err(tantivy::TantivyError::from)?;
        let index = TantivyIndex::open_or_create(directory, schema())?;
        Self::from_index(index)
    }

    pub(crate) fn in_memory() -> Result<Self, Error> {
        Self::from_index(TantivyIndex::create_in_ram(schema()))
    }

    fn from_index(index: TantivyIndex) -> Result<Self, Error> {
        let fields = fields(index.schema())?;
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;
        let writer = index.writer_with_num_threads(1, WRITER_HEAP_BYTES)?;
        Ok(Self {
            index,
            reader,
            writer,
            fields,
        })
    }

    pub(crate) fn replace(
        &mut self,
        path: &str,
        title: Option<&str>,
        aliases: &[String],
        tags: &[String],
        blocks: &[String],
    ) -> Result<(), Error> {
        self.writer
            .delete_term(Term::from_field_text(self.fields.identity, path));
        let empty = String::new();
        let blocks = if blocks.is_empty() {
            std::slice::from_ref(&empty)
        } else {
            blocks
        };
        for (ordinal, context) in blocks.iter().enumerate() {
            let mut document = doc!(
                self.fields.identity => path,
                self.fields.body => context.as_str(),
                self.fields.ordinal => u64::try_from(ordinal).unwrap_or(u64::MAX),
            );
            if let Some(title) = title {
                document.add_text(self.fields.display_title, title);
            }
            if ordinal == 0 {
                document.add_text(self.fields.path, path);
                if let Some(title) = title {
                    document.add_text(self.fields.title, title);
                }
                for alias in aliases {
                    document.add_text(self.fields.alias, alias);
                }
                for tag in tags {
                    document.add_text(self.fields.tag, tag);
                }
            }
            self.writer.add_document(document)?;
        }
        Ok(())
    }

    pub(crate) fn remove(&mut self, path: &str) {
        self.writer
            .delete_term(Term::from_field_text(self.fields.identity, path));
    }

    pub(crate) fn publish(&mut self) -> Result<(), Error> {
        self.writer.commit()?;
        self.reader.reload()?;
        Ok(())
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.reader.searcher().num_docs() == 0
    }

    pub(crate) fn clear(&mut self) -> Result<(), Error> {
        self.writer.delete_all_documents()?;
        self.publish()
    }

    /// Every note's visible block text, for rebuilding the derived compact zone segments.
    pub(crate) fn all_text(&self) -> Result<std::collections::BTreeMap<String, String>, Error> {
        let searcher = self.reader.searcher();
        let limit = usize::try_from(searcher.num_docs()).unwrap_or(usize::MAX);
        if limit == 0 {
            return Ok(std::collections::BTreeMap::new());
        }
        let matches = searcher.search(&AllQuery, &TopDocs::with_limit(limit).order_by_score())?;
        let mut blocks: std::collections::BTreeMap<String, Vec<(u64, String)>> =
            std::collections::BTreeMap::new();
        for (_, address) in matches {
            let document: TantivyDocument = searcher.doc(address)?;
            let Some(path) = text(&document, self.fields.identity) else {
                continue;
            };
            blocks.entry(path).or_default().push((
                number(&document, self.fields.ordinal).unwrap_or(0),
                text(&document, self.fields.body).unwrap_or_default(),
            ));
        }
        Ok(blocks
            .into_iter()
            .map(|(path, mut blocks)| {
                blocks.sort_by_key(|(ordinal, _)| *ordinal);
                let text = blocks
                    .into_iter()
                    .map(|(_, text)| text)
                    .collect::<Vec<_>>()
                    .join("\n");
                (path, text)
            })
            .collect())
    }

    /// A required exact-identity term set: the authorization clause every query carries (E5).
    fn only(&self, paths: Vec<String>) -> TermSetQuery {
        TermSetQuery::new(
            paths
                .into_iter()
                .map(|path| Term::from_field_text(self.fields.identity, &path)),
        )
    }

    /// `name` as the body terms it tokenizes to, or `None` when it tokenizes to nothing.
    ///
    /// A mention matches whole tokens in sequence, with no prefix and no fuzziness — unlike
    /// [`SearchIndex::search`], where the user is typing and wants forgiveness. "Roadmap"
    /// must not be found in a note that only says "roadmaps".
    fn phrase(&self, name: &str) -> Option<Box<dyn Query>> {
        let mut analyzer = self.index.tokenizers().get("default")?;
        let mut terms = Vec::new();
        analyzer
            .token_stream(name)
            .process(&mut |token| terms.push(Term::from_field_text(self.fields.body, &token.text)));
        match terms.len() {
            0 => None,
            // why: `PhraseQuery::new` requires two or more terms and panics below that.
            1 => terms.pop().map(|term| {
                Box::new(TermQuery::new(term, IndexRecordOption::WithFreqs)) as Box<dyn Query>
            }),
            _ => Some(Box::new(PhraseQuery::new(terms))),
        }
    }

    /// Blocks of readable notes whose text contains one of `names`, grouped by note (§9.5).
    fn mentions(
        &self,
        names: &[String],
        readable_paths: Vec<String>,
        excluded_paths: Vec<String>,
        limit: usize,
    ) -> Result<Vec<MentionGroup>, Error> {
        if limit == 0 || readable_paths.is_empty() {
            return Ok(Vec::new());
        }
        let named: Vec<(Occur, Box<dyn Query>)> = names
            .iter()
            .filter_map(|name| self.phrase(name))
            .map(|query| (Occur::Should, query))
            .collect();
        if named.is_empty() {
            return Ok(Vec::new());
        }
        let mut clauses: Vec<(Occur, Box<dyn Query>)> = vec![
            (Occur::Must, Box::new(BooleanQuery::new(named))),
            (Occur::Must, Box::new(self.only(readable_paths))),
        ];
        if !excluded_paths.is_empty() {
            clauses.push((Occur::MustNot, Box::new(self.only(excluded_paths))));
        }

        let searcher = self.reader.searcher();
        let matches = searcher.search(
            &BooleanQuery::new(clauses),
            &TopDocs::with_limit(limit).order_by_score(),
        )?;
        let mut blocks = Vec::with_capacity(matches.len());
        for (_score, address) in matches {
            let document: TantivyDocument = searcher.doc(address)?;
            blocks.push((
                text(&document, self.fields.identity).unwrap_or_default(),
                number(&document, self.fields.ordinal).unwrap_or(0),
                text(&document, self.fields.display_title),
                text(&document, self.fields.body).unwrap_or_default(),
            ));
        }
        // why: sorted rather than left in relevance order. The panel groups by note, so a
        // score order would interleave two notes' blocks and leave a group's contexts in an
        // order that depends on how many other notes matched. Path then ordinal is the
        // backlinks panel's order (§9.5), and it is the same for every reader.
        blocks.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));

        let mut groups: Vec<MentionGroup> = Vec::new();
        for (path, _, title, context) in blocks {
            match groups.last_mut() {
                Some(group) if group.path == path => group.contexts.push(context),
                _ => groups.push(MentionGroup {
                    path,
                    title,
                    contexts: vec![context],
                }),
            }
        }
        Ok(groups)
    }

    fn search(
        &self,
        query: &str,
        readable_paths: Vec<String>,
        limit: usize,
    ) -> Result<Vec<SearchHit>, Error> {
        if query.trim().is_empty() || limit == 0 || readable_paths.is_empty() {
            return Ok(Vec::new());
        }
        let mut parser = QueryParser::for_index(
            &self.index,
            vec![
                self.fields.body,
                self.fields.title,
                self.fields.alias,
                self.fields.tag,
                self.fields.path,
            ],
        );
        for field in [
            self.fields.body,
            self.fields.title,
            self.fields.alias,
            self.fields.tag,
            self.fields.path,
        ] {
            parser.set_field_fuzzy(field, true, 1, true);
        }
        let parsed = parser.parse_query(query)?;
        let filtered = BooleanQuery::new(vec![
            (Occur::Must, parsed),
            (
                Occur::Must,
                Box::new(self.only(readable_paths)) as Box<dyn Query>,
            ),
        ]);
        let searcher = self.reader.searcher();
        let matches = searcher.search(&filtered, &TopDocs::with_limit(limit).order_by_score())?;
        matches
            .into_iter()
            .map(|(score, address)| {
                let document: TantivyDocument = searcher.doc(address)?;
                Ok(SearchHit {
                    path: text(&document, self.fields.identity).unwrap_or_default(),
                    title: text(&document, self.fields.display_title),
                    context: text(&document, self.fields.body).unwrap_or_default(),
                    score,
                })
            })
            .collect()
    }
}

impl Reader<'_> {
    /// Searches only notes in this reader's permission-filtered set (E5, §14.1).
    ///
    /// # Errors
    ///
    /// Returns an error for invalid query syntax or an unavailable index.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, Error> {
        self.search.search(query, self.readable_paths()?, limit)
    }

    /// Readable notes whose text names `path` without linking to it (E8, §9.5).
    ///
    /// The names matched are every name a wikilink could have used — path, filename stem and
    /// each alias (§4.3) — plus the note's own title, which §9.5 asks for and which §4.3 does
    /// not make a link target. A mention is therefore text somebody could have wrapped in
    /// brackets, or the heading they were referring to when they did not.
    ///
    /// Three things are excluded, and only one of them is authorization: notes outside this
    /// reader's readable set, which is E5 and is a required clause in the Tantivy query
    /// rather than a filter over its results; the note itself, which mentions its own title
    /// in its own heading; and notes that already link here, because those are backlinks and
    /// listing them twice is what "unlinked" exists to avoid.
    ///
    /// An unreadable target answers with an empty list exactly as a missing one does, which
    /// is the same invisibility rule [`Reader::backlinks`] follows (§6.5).
    ///
    /// `limit` bounds mentioning *blocks*, not notes, so a note mentioning this one five
    /// times uses five of them.
    ///
    /// # Errors
    ///
    /// Fails if a query fails or the text index is unavailable.
    pub fn unlinked_mentions(&self, path: &str, limit: usize) -> Result<Vec<MentionGroup>, Error> {
        let Some(target) = self.note_id(path)? else {
            return Ok(Vec::new());
        };
        let names = self.names_of(target)?;
        if names.is_empty() {
            return Ok(Vec::new());
        }
        let mut excluded = self.linking_paths(target)?;
        excluded.push(path.to_string());
        self.search
            .mentions(&names, self.readable_paths()?, excluded, limit)
    }

    fn readable_paths(&self) -> Result<Vec<String>, Error> {
        let mut statement = self
            .conn
            .prepare_cached("SELECT path FROM v_notes ORDER BY path")?;
        Ok(statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?)
    }

    /// Every name this note answers to, as a human spelled it.
    ///
    /// `v_note_names` holds the wikilink targets — path, stem, aliases — and deliberately not
    /// the title, because `[[Product Roadmap]]` does not resolve by heading (§4.3). §9.5 wants
    /// the title matched all the same, so it is unioned in here rather than written into the
    /// link-resolution table, where it would change what a wikilink means.
    fn names_of(&self, note: i64) -> Result<Vec<String>, Error> {
        let mut statement = self.conn.prepare_cached(
            "SELECT name FROM v_note_names WHERE note_id = ?1
             UNION
             SELECT title FROM v_notes WHERE id = ?1 AND title IS NOT NULL",
        )?;
        Ok(statement
            .query_map([note], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?)
    }

    /// Readable notes that already link to this one, which are backlinks rather than mentions.
    fn linking_paths(&self, note: i64) -> Result<Vec<String>, Error> {
        let mut statement = self.conn.prepare_cached(
            "SELECT DISTINCT n.path
             FROM v_resolved l
             JOIN v_notes n ON n.id = l.source_id
             WHERE l.target_id = ?1",
        )?;
        Ok(statement
            .query_map([note], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?)
    }
}

fn schema() -> Schema {
    let mut builder = Schema::builder();
    builder.add_text_field("identity", STRING | STORED);
    let indexed_and_stored = TextOptions::default().set_stored().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer("default")
            .set_index_option(IndexRecordOption::WithFreqsAndPositions),
    );
    builder.add_text_field("path", indexed_and_stored.clone());
    builder.add_text_field("title", indexed_and_stored.clone());
    builder.add_text_field("display_title", STORED);
    builder.add_text_field("alias", TEXT);
    builder.add_text_field("tag", TEXT);
    builder.add_text_field("body", indexed_and_stored);
    builder.add_u64_field("ordinal", STORED);
    builder.build()
}

fn fields(schema: Schema) -> Result<Fields, Error> {
    Ok(Fields {
        identity: schema.get_field("identity")?,
        path: schema.get_field("path")?,
        title: schema.get_field("title")?,
        display_title: schema.get_field("display_title")?,
        alias: schema.get_field("alias")?,
        tag: schema.get_field("tag")?,
        body: schema.get_field("body")?,
        ordinal: schema.get_field("ordinal")?,
    })
}

fn text(document: &TantivyDocument, field: Field) -> Option<String> {
    document
        .get_first(field)
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
}

fn number(document: &TantivyDocument, field: Field) -> Option<u64> {
    document.get_first(field).and_then(|value| value.as_u64())
}
