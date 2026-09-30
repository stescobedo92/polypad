//! The `.ppad` script format: a JSON header, a `---` line, then the code verbatim.
//!
//! ```text
//! {
//!   "ppad": 1,
//!   "language": "csharp",
//!   "mode": "statements",
//!   "connection": null,
//!   "packages": [],
//!   "imports": []
//! }
//! ---
//! Console.WriteLine("Hello");
//! ```
//!
//! See docs/adr/0006 for the rationale. Serializing a parsed file reproduces it byte for byte.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};

use crate::language::{ExecutionMode, Language};

/// Newest format version this build reads and the one it writes.
pub const FORMAT_VERSION: u64 = 1;

/// Largest script accepted, in bytes; protects the editor from files that are not scripts.
pub const MAX_DOCUMENT_BYTES: usize = 16 * 1024 * 1024;

/// A script: its header and its code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Document {
    /// Metadata stored before the separator.
    pub header: Header,
    /// Source code, exactly as written after the separator.
    pub code: String,
    /// Line ending used by the header and the separator.
    pub newline: Newline,
}

/// Script metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Header {
    /// Language of the code.
    pub language: Language,
    /// How the kernel runs the code; always one of the language's modes.
    pub mode: ExecutionMode,
    /// Id of the database connection the script targets (Phase 4).
    pub connection: Option<String>,
    /// Packages the script references (Phase 7).
    pub packages: Vec<PackageRef>,
    /// Namespaces or modules imported implicitly.
    pub imports: Vec<String>,
    /// Header fields this build does not know, kept so that saving never drops them.
    #[serde(with = "json_text")]
    #[cfg_attr(feature = "specta", specta(type = String))]
    pub extra: Map<String, Value>,
}

/// A package reference in the header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct PackageRef {
    /// Package id in its ecosystem.
    pub name: String,
    /// Requested version; `None` lets the resolver choose.
    pub version: Option<String>,
    /// Fields this build does not know.
    #[serde(with = "json_text")]
    #[cfg_attr(feature = "specta", specta(type = String))]
    pub extra: Map<String, Value>,
}

/// Unknown fields leave Rust as JSON text: the UI never interprets them, and a JavaScript number
/// would round integers above 2^53, changing the file on the next save.
mod json_text {
    use serde::{Deserialize, Deserializer, Serializer, de::Error as _, ser::Error as _};
    use serde_json::{Map, Value};

    pub fn serialize<S: Serializer>(
        fields: &Map<String, Value>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let text = serde_json::to_string(fields).map_err(S::Error::custom)?;
        serializer.serialize_str(&text)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Map<String, Value>, D::Error> {
        let text = String::deserialize(deserializer)?;
        serde_json::from_str(&text).map_err(D::Error::custom)
    }
}

/// Line ending of the header and separator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum Newline {
    /// `\n`, used for new scripts.
    #[default]
    Lf,
    /// `\r\n`.
    CrLf,
}

/// Result of [`parse`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    /// The script.
    pub document: Document,
    /// The file was upgraded or corrected while loading (an older format, or a mode its language
    /// does not offer), so saving it would change the file.
    pub normalized: bool,
}

/// Why a file is not a readable script.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum PpadError {
    /// The file exceeds [`MAX_DOCUMENT_BYTES`].
    #[error("the file has {size} bytes; scripts are limited to {max}")]
    TooLarge {
        /// Size of the file.
        size: usize,
        /// Limit.
        max: usize,
    },
    /// The file does not start with a JSON header.
    #[error("not a PolyPad script: the file must start with a JSON header")]
    MissingHeader,
    /// The header is not valid JSON.
    #[error("invalid header at line {line}, column {column}: {message}")]
    InvalidHeader {
        /// One-based line.
        line: usize,
        /// One-based column.
        column: usize,
        /// Parser message.
        message: String,
    },
    /// The header is not followed by a `---` line.
    #[error("expected a `---` line after the header at line {line}")]
    MissingSeparator {
        /// One-based line where the separator was expected.
        line: usize,
    },
    /// `ppad` is missing or not a supported version number.
    #[error("the header has no valid `ppad` format version")]
    InvalidVersion,
    /// The file was written by a newer PolyPad.
    #[error("created by a newer PolyPad (format {found}; this build reads up to {supported})")]
    NewerFormat {
        /// Version in the file.
        found: u64,
        /// Newest version this build reads.
        supported: u64,
    },
    /// `language` names a language this build does not know.
    #[error("unknown language `{0}`")]
    UnknownLanguage(String),
    /// `mode` names a mode this build does not know.
    #[error("unknown mode `{0}`")]
    UnknownMode(String),
    /// A known header field is missing or has the wrong type.
    #[error("invalid header field `{field}`: {message}")]
    InvalidField {
        /// Field name.
        field: &'static str,
        /// What is wrong with it.
        message: String,
    },
}

impl Header {
    /// Header of a new, empty script in `language`.
    #[must_use]
    pub fn new(language: Language) -> Self {
        Self {
            language,
            mode: language.default_mode(),
            connection: None,
            packages: Vec::new(),
            imports: Vec::new(),
            extra: Map::new(),
        }
    }
}

const SEPARATOR: &str = "---";
const BYTE_ORDER_MARK: char = '\u{feff}';
/// Header keys written from typed fields; `extra` may never repeat them.
const HEADER_FIELDS: [&str; 6] = [
    "ppad",
    "language",
    "mode",
    "connection",
    "packages",
    "imports",
];
const PACKAGE_FIELDS: [&str; 2] = ["name", "version"];

/// Parses a script.
///
/// # Errors
///
/// Returns a [`PpadError`] describing the first problem found.
pub fn parse(text: &str) -> Result<Parsed, PpadError> {
    if text.len() > MAX_DOCUMENT_BYTES {
        return Err(PpadError::TooLarge {
            size: text.len(),
            max: MAX_DOCUMENT_BYTES,
        });
    }
    let text = text.strip_prefix(BYTE_ORDER_MARK).unwrap_or(text);
    if !text.starts_with('{') {
        return Err(PpadError::MissingHeader);
    }

    // Reading exactly one JSON value (instead of searching for the separator) means nothing
    // inside the header can be mistaken for the end of it.
    let mut values = serde_json::Deserializer::from_str(text).into_iter::<Map<String, Value>>();
    let fields = match values.next() {
        Some(Ok(fields)) => fields,
        Some(Err(error)) => return Err(invalid_header(&error)),
        None => return Err(PpadError::MissingHeader),
    };
    let header_end = values.byte_offset();
    let (head, rest) = text.split_at(header_end);
    let (newline, code) = split_separator(rest).ok_or(PpadError::MissingSeparator {
        line: head.matches('\n').count() + 2,
    })?;

    let (header, normalized) = read_header(fields)?;
    Ok(Parsed {
        document: Document {
            header,
            code: code.to_owned(),
            newline,
        },
        normalized,
    })
}

/// Serializes a script; [`parse`] returns the same document.
///
/// # Errors
///
/// Only fails if JSON encoding fails, which the header's plain data cannot trigger.
pub fn serialize(document: &Document) -> Result<String, serde_json::Error> {
    let header = &document.header;
    let json = serde_json::to_string_pretty(&HeaderOut {
        ppad: FORMAT_VERSION,
        language: header.language,
        mode: header.mode,
        connection: header.connection.as_deref(),
        packages: header.packages.iter().map(PackageOut::from).collect(),
        imports: &header.imports,
        extra: unknown_fields(&header.extra, &HEADER_FIELDS),
    })?;
    let newline = match document.newline {
        Newline::Lf => "\n",
        Newline::CrLf => "\r\n",
    };
    // JSON escapes line breaks inside strings, so every '\n' here is layout.
    let json = if newline == "\n" {
        json
    } else {
        json.replace('\n', newline)
    };
    Ok(format!(
        "{json}{newline}{SEPARATOR}{newline}{}",
        document.code
    ))
}

/// Header as written: known fields in a fixed order, then unknown ones sorted by key.
#[derive(Serialize)]
struct HeaderOut<'a> {
    ppad: u64,
    language: Language,
    mode: ExecutionMode,
    connection: Option<&'a str>,
    packages: Vec<PackageOut<'a>>,
    imports: &'a [String],
    #[serde(flatten)]
    extra: BTreeMap<&'a str, &'a Value>,
}

#[derive(Serialize)]
struct PackageOut<'a> {
    name: &'a str,
    version: Option<&'a str>,
    #[serde(flatten)]
    extra: BTreeMap<&'a str, &'a Value>,
}

impl<'a> From<&'a PackageRef> for PackageOut<'a> {
    fn from(package: &'a PackageRef) -> Self {
        Self {
            name: &package.name,
            version: package.version.as_deref(),
            extra: unknown_fields(&package.extra, &PACKAGE_FIELDS),
        }
    }
}

/// Package as read: unknown fields are collected instead of rejected.
#[derive(Deserialize)]
struct PackageIn {
    name: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

fn unknown_fields<'a>(
    extra: &'a Map<String, Value>,
    known: &[&str],
) -> BTreeMap<&'a str, &'a Value> {
    extra
        .iter()
        .filter(|(key, _)| !known.contains(&key.as_str()))
        .map(|(key, value)| (key.as_str(), value))
        .collect()
}

fn invalid_header(error: &serde_json::Error) -> PpadError {
    let (line, column) = (error.line(), error.column());
    let message = error.to_string();
    // serde_json appends the position, which the error already carries as fields.
    let message = message
        .strip_suffix(&format!(" at line {line} column {column}"))
        .map_or_else(|| message.clone(), str::to_owned);
    PpadError::InvalidHeader {
        line,
        column,
        message,
    }
}

/// Splits `<newline>---<newline>code` into the newline style and the code.
fn split_separator(rest: &str) -> Option<(Newline, &str)> {
    let (newline, after_header) = match rest.strip_prefix("\r\n") {
        Some(after) => (Newline::CrLf, after),
        None => (Newline::Lf, rest.strip_prefix('\n')?),
    };
    let after_separator = after_header.strip_prefix(SEPARATOR)?;
    if after_separator.is_empty() {
        return Some((newline, ""));
    }
    let code = after_separator
        .strip_prefix("\r\n")
        .or_else(|| after_separator.strip_prefix('\n'))?;
    Some((newline, code))
}

/// Validates the header fields; the flag reports whether loading changed the document.
fn read_header(mut fields: Map<String, Value>) -> Result<(Header, bool), PpadError> {
    let version = fields
        .remove("ppad")
        .and_then(|version| version.as_u64())
        .filter(|version| *version >= 1)
        .ok_or(PpadError::InvalidVersion)?;
    if version > FORMAT_VERSION {
        return Err(PpadError::NewerFormat {
            found: version,
            supported: FORMAT_VERSION,
        });
    }
    let migrated = migrate(&mut fields, version);

    let language_id: String =
        take(&mut fields, "language")?.ok_or_else(|| PpadError::InvalidField {
            field: "language",
            message: "missing".to_owned(),
        })?;
    let language =
        parse_id::<Language>(&language_id).ok_or(PpadError::UnknownLanguage(language_id))?;
    let (mode, mode_replaced) = match take::<String>(&mut fields, "mode")? {
        None => (language.default_mode(), true),
        Some(mode_id) => {
            let mode =
                parse_id::<ExecutionMode>(&mode_id).ok_or(PpadError::UnknownMode(mode_id))?;
            if language.offers(mode) {
                (mode, false)
            } else {
                (language.default_mode(), true)
            }
        }
    };
    let connection = take::<Option<String>>(&mut fields, "connection")?.flatten();
    let packages = take::<Vec<PackageIn>>(&mut fields, "packages")?
        .unwrap_or_default()
        .into_iter()
        .map(|package| PackageRef {
            name: package.name,
            version: package.version,
            extra: package.extra,
        })
        .collect();
    let imports = take(&mut fields, "imports")?.unwrap_or_default();

    let header = Header {
        language,
        mode,
        connection,
        packages,
        imports,
        extra: fields,
    };
    Ok((header, migrated || mode_replaced))
}

/// Upgrades a header written by an older format in place; returns whether it did anything.
///
/// Format 1 is the first one, so there is nothing to upgrade yet. Each future format adds one
/// step here (1 → 2, 2 → 3, …), covered by a fixture test of the older layout.
fn migrate(_fields: &mut Map<String, Value>, version: u64) -> bool {
    version < FORMAT_VERSION
}

/// Removes and decodes a field; `Ok(None)` when it is absent.
fn take<T: DeserializeOwned>(
    fields: &mut Map<String, Value>,
    field: &'static str,
) -> Result<Option<T>, PpadError> {
    fields
        .remove(field)
        .map(|value| {
            serde_json::from_value(value).map_err(|error| PpadError::InvalidField {
                field,
                message: error.to_string(),
            })
        })
        .transpose()
}

/// Decodes a serialized enum id such as `"csharp"`.
fn parse_id<T: DeserializeOwned>(id: &str) -> Option<T> {
    serde_json::from_value(Value::String(id.to_owned())).ok()
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use serde_json::{Map, Value, json};

    use super::{
        Document, ExecutionMode, Header, Language, MAX_DOCUMENT_BYTES, Newline, PackageRef, Parsed,
        PpadError, parse, serialize,
    };

    fn parsed(text: &str) -> Parsed {
        parse(text).unwrap_or_else(|error| panic!("{error}\n---- input ----\n{text}"))
    }

    #[test]
    fn a_new_script_is_written_in_the_canonical_layout() {
        let document = Document {
            header: Header::new(Language::CSharp),
            code: "Console.WriteLine(1);\n".to_owned(),
            newline: Newline::Lf,
        };

        assert_eq!(
            serialize(&document).unwrap(),
            "{\n  \"ppad\": 1,\n  \"language\": \"csharp\",\n  \"mode\": \"statements\",\n  \
             \"connection\": null,\n  \"packages\": [],\n  \"imports\": []\n}\n---\n\
             Console.WriteLine(1);\n"
        );
    }

    #[test]
    fn header_fields_are_read_and_code_is_kept_verbatim() {
        let text = "{\n  \"ppad\": 1,\n  \"language\": \"typescript\",\n  \"mode\": \"module\",\n  \
                    \"connection\": \"prod-replica\",\n  \"packages\": [{ \"name\": \"lodash\", \
                    \"version\": \"4.17.21\" }],\n  \"imports\": [\"node:fs\"]\n}\n---\n\
                    \tconst x = 1;  \n\n";

        let result = parsed(text);

        let header = &result.document.header;
        assert_eq!(header.language, Language::TypeScript);
        assert_eq!(header.mode, ExecutionMode::Module);
        assert_eq!(header.connection.as_deref(), Some("prod-replica"));
        assert_eq!(
            header.packages,
            vec![PackageRef {
                name: "lodash".to_owned(),
                version: Some("4.17.21".to_owned()),
                extra: Map::new(),
            }]
        );
        assert_eq!(header.imports, vec!["node:fs".to_owned()]);
        assert!(header.extra.is_empty());
        assert_eq!(result.document.code, "\tconst x = 1;  \n\n");
        assert!(!result.normalized);
    }

    #[test]
    fn separator_lines_inside_the_code_belong_to_the_code() {
        let text =
            "{\"ppad\":1,\"language\":\"sql\",\"mode\":\"sql\"}\n---\nSELECT 1;\n---\n-- end\n";

        assert_eq!(parsed(text).document.code, "SELECT 1;\n---\n-- end\n");
    }

    #[test]
    fn a_separator_at_the_end_of_the_file_means_empty_code() {
        let text = "{\"ppad\":1,\"language\":\"go\",\"mode\":\"program\"}\n---";

        assert_eq!(parsed(text).document.code, "");
    }

    #[test]
    fn crlf_scripts_round_trip_byte_for_byte() {
        let text = "{\r\n  \"ppad\": 1,\r\n  \"language\": \"python\",\r\n  \"mode\": \"script\",\r\n  \
                    \"connection\": null,\r\n  \"packages\": [],\r\n  \"imports\": []\r\n}\r\n---\r\n\
                    print('hi')\r\n";

        let result = parsed(text);

        assert_eq!(result.document.newline, Newline::CrLf);
        assert_eq!(serialize(&result.document).unwrap(), text);
    }

    #[test]
    fn a_leading_byte_order_mark_is_accepted_and_not_written_back() {
        let canonical = "{\n  \"ppad\": 1,\n  \"language\": \"rust\",\n  \"mode\": \"statements\",\n  \
                         \"connection\": null,\n  \"packages\": [],\n  \"imports\": []\n}\n---\n\
                         let x = 1;\n";

        let result = parsed(&format!("\u{feff}{canonical}"));

        assert_eq!(serialize(&result.document).unwrap(), canonical);
    }

    #[test]
    fn unknown_fields_survive_a_round_trip_after_the_known_ones() {
        let text = "{\"zeta\":true,\"ppad\":1,\"language\":\"csharp\",\"mode\":\"program\",\
                    \"alpha\":{\"n\":2},\"packages\":[{\"name\":\"Dapper\",\"source\":\"nuget\"}]}\n---\n";

        let written = serialize(&parsed(text).document).unwrap();

        assert_eq!(
            written,
            "{\n  \"ppad\": 1,\n  \"language\": \"csharp\",\n  \"mode\": \"program\",\n  \
             \"connection\": null,\n  \"packages\": [\n    {\n      \"name\": \"Dapper\",\n      \
             \"version\": null,\n      \"source\": \"nuget\"\n    }\n  ],\n  \"imports\": [],\n  \
             \"alpha\": {\n    \"n\": 2\n  },\n  \"zeta\": true\n}\n---\n"
        );
    }

    #[test]
    fn extra_fields_cannot_shadow_known_ones() {
        let mut header = Header::new(Language::Go);
        header.extra.insert("language".to_owned(), json!("cobol"));
        header.extra.insert("ppad".to_owned(), json!(99));
        header.packages.push(PackageRef {
            name: "uuid".to_owned(),
            version: None,
            extra: [("name".to_owned(), json!("evil"))].into_iter().collect(),
        });
        let document = Document {
            header,
            code: String::new(),
            newline: Newline::Lf,
        };

        let written = serialize(&document).unwrap();

        assert_eq!(written.matches("\"language\"").count(), 1, "{written}");
        assert_eq!(written.matches("\"ppad\"").count(), 1, "{written}");
        assert_eq!(written.matches("\"name\"").count(), 1, "{written}");
        let reread = parsed(&written).document.header;
        assert_eq!(reread.language, Language::Go);
        assert_eq!(reread.packages[0].name, "uuid");
    }

    #[test]
    fn unknown_fields_cross_the_ipc_boundary_as_exact_json_text() {
        let text = "{\"ppad\":1,\"language\":\"go\",\"id\":12345678901234567890,                    \"packages\":[{\"name\":\"uuid\",\"size\":9007199254740993}]}
---
";
        let header = parsed(text).document.header;

        let over_ipc = serde_json::to_value(&header).unwrap();
        let back: Header = serde_json::from_value(over_ipc.clone()).unwrap();

        // A JavaScript number would round both integers; text keeps every digit.
        assert_eq!(over_ipc["extra"], json!("{\"id\":12345678901234567890}"));
        assert_eq!(
            over_ipc["packages"][0]["extra"],
            json!("{\"size\":9007199254740993}")
        );
        assert_eq!(back, header);
    }

    #[test]
    fn missing_optional_fields_take_their_defaults() {
        let result =
            parsed("{\"ppad\":1,\"language\":\"java\",\"mode\":\"expression\"}\n---\n1 + 1");

        let header = &result.document.header;
        assert_eq!(header.connection, None);
        assert!(header.packages.is_empty());
        assert!(header.imports.is_empty());
        assert!(!result.normalized);
    }

    #[test]
    fn a_mode_the_language_does_not_offer_falls_back_to_its_default() {
        let result = parsed("{\"ppad\":1,\"language\":\"python\",\"mode\":\"statements\"}\n---\n");

        assert_eq!(result.document.header.mode, ExecutionMode::Script);
        assert!(result.normalized);
    }

    #[test]
    fn a_missing_mode_takes_the_language_default() {
        let result = parsed("{\"ppad\":1,\"language\":\"go\"}\n---\n");

        assert_eq!(result.document.header.mode, ExecutionMode::Statements);
        assert!(result.normalized);
    }

    #[test]
    fn language_ids_are_the_file_format_contract() {
        let ids: Vec<Value> = Language::ALL.iter().map(|l| json!(l)).collect();

        assert_eq!(
            ids,
            vec![
                json!("csharp"),
                json!("fsharp"),
                json!("java"),
                json!("kotlin"),
                json!("go"),
                json!("typescript"),
                json!("javascript"),
                json!("python"),
                json!("rust"),
                json!("sql"),
            ]
        );
    }

    #[test]
    fn rejects_input_that_does_not_start_with_a_header() {
        assert_eq!(parse("print(1)\n").unwrap_err(), PpadError::MissingHeader);
        assert_eq!(parse("").unwrap_err(), PpadError::MissingHeader);
        assert_eq!(parse("  {}").unwrap_err(), PpadError::MissingHeader);
    }

    #[test]
    fn reports_where_the_header_json_is_broken() {
        let text =
            "{\n  \"ppad\": 1,\n  \"language\": \"csharp\"\n  \"mode\": \"statements\"\n}\n---\n";

        let error = parse(text).unwrap_err();

        assert!(
            matches!(
                error,
                PpadError::InvalidHeader {
                    line: 4,
                    column: 3,
                    ..
                }
            ),
            "{error:?}"
        );
    }

    #[test]
    fn reports_the_line_where_the_separator_is_missing() {
        let text =
            "{\n  \"ppad\": 1,\n  \"language\": \"python\",\n  \"mode\": \"script\"\n}\nprint(1)\n";

        assert_eq!(
            parse(text).unwrap_err(),
            PpadError::MissingSeparator { line: 6 }
        );
    }

    #[test]
    fn a_separator_not_on_its_own_line_is_missing() {
        let text = "{\"ppad\":1,\"language\":\"go\",\"mode\":\"program\"}\n--- trailing\n";

        assert_eq!(
            parse(text).unwrap_err(),
            PpadError::MissingSeparator { line: 2 }
        );
    }

    #[test]
    fn rejects_missing_or_malformed_versions() {
        for header in [
            "{\"language\":\"go\",\"mode\":\"program\"}",
            "{\"ppad\":\"1\",\"language\":\"go\",\"mode\":\"program\"}",
            "{\"ppad\":0,\"language\":\"go\",\"mode\":\"program\"}",
            "{\"ppad\":1.5,\"language\":\"go\",\"mode\":\"program\"}",
        ] {
            assert_eq!(
                parse(&format!("{header}\n---\n")).unwrap_err(),
                PpadError::InvalidVersion,
                "{header}"
            );
        }
    }

    #[test]
    fn refuses_scripts_written_by_a_newer_format() {
        let text = "{\"ppad\":2,\"language\":\"go\",\"mode\":\"program\"}\n---\n";

        assert_eq!(
            parse(text).unwrap_err(),
            PpadError::NewerFormat {
                found: 2,
                supported: 1
            }
        );
    }

    #[test]
    fn rejects_unknown_languages_and_modes() {
        assert_eq!(
            parse("{\"ppad\":1,\"language\":\"cobol\",\"mode\":\"program\"}\n---\n").unwrap_err(),
            PpadError::UnknownLanguage("cobol".to_owned())
        );
        assert_eq!(
            parse("{\"ppad\":1,\"language\":\"go\",\"mode\":\"repl\"}\n---\n").unwrap_err(),
            PpadError::UnknownMode("repl".to_owned())
        );
    }

    #[test]
    fn names_the_field_that_is_missing_or_mistyped() {
        let cases = [
            ("{\"ppad\":1,\"mode\":\"program\"}", "language"),
            ("{\"ppad\":1,\"language\":7}", "language"),
            (
                "{\"ppad\":1,\"language\":\"go\",\"imports\":\"fmt\"}",
                "imports",
            ),
            (
                "{\"ppad\":1,\"language\":\"go\",\"packages\":[{\"version\":\"1\"}]}",
                "packages",
            ),
            (
                "{\"ppad\":1,\"language\":\"go\",\"connection\":3}",
                "connection",
            ),
        ];
        for (header, expected) in cases {
            let error = parse(&format!("{header}\n---\n")).unwrap_err();
            assert!(
                matches!(error, PpadError::InvalidField { field, .. } if field == expected),
                "{header}: {error:?}"
            );
        }
    }

    #[test]
    fn rejects_files_above_the_size_limit() {
        let text = "x".repeat(MAX_DOCUMENT_BYTES + 1);

        assert_eq!(
            parse(&text).unwrap_err(),
            PpadError::TooLarge {
                size: MAX_DOCUMENT_BYTES + 1,
                max: MAX_DOCUMENT_BYTES
            }
        );
    }

    fn arb_extra() -> impl Strategy<Value = Map<String, Value>> {
        let value = prop_oneof![
            any::<bool>().prop_map(Value::from),
            any::<i64>().prop_map(Value::from),
            any::<String>().prop_map(Value::from),
        ];
        prop::collection::btree_map("x-[a-z]{1,8}", value, 0..3)
            .prop_map(|entries| entries.into_iter().collect())
    }

    prop_compose! {
        fn arb_package()(
            name in "[A-Za-z][A-Za-z0-9.]{0,15}",
            version in prop::option::of("[0-9][0-9.]{0,8}"),
            extra in arb_extra(),
        ) -> PackageRef {
            PackageRef { name, version, extra }
        }
    }

    fn arb_header() -> impl Strategy<Value = Header> {
        prop::sample::select(Language::ALL.to_vec())
            .prop_flat_map(|language| {
                (
                    Just(language),
                    prop::sample::select(language.modes().to_vec()),
                    prop::option::of(any::<String>()),
                    prop::collection::vec(arb_package(), 0..3),
                    prop::collection::vec(any::<String>(), 0..3),
                    arb_extra(),
                )
            })
            .prop_map(
                |(language, mode, connection, packages, imports, extra)| Header {
                    language,
                    mode,
                    connection,
                    packages,
                    imports,
                    extra,
                },
            )
    }

    proptest! {
        #[test]
        fn every_document_survives_a_round_trip(
            header in arb_header(),
            code in any::<String>(),
            newline in prop_oneof![Just(Newline::Lf), Just(Newline::CrLf)],
        ) {
            let document = Document { header, code, newline };

            let result = parse(&serialize(&document).unwrap());

            prop_assert_eq!(result, Ok(Parsed { document, normalized: false }));
        }

        #[test]
        fn code_with_separator_lines_survives_a_round_trip(
            lines in prop::collection::vec(prop_oneof![Just("---".to_owned()), ".*"], 0..6),
            crlf in any::<bool>(),
        ) {
            let code = lines.join(if crlf { "\r\n" } else { "\n" });
            let document = Document { header: Header::new(Language::Sql), code, newline: Newline::Lf };

            prop_assert_eq!(parse(&serialize(&document).unwrap()).map(|p| p.document), Ok(document));
        }

        #[test]
        fn parsing_arbitrary_text_never_panics(text in any::<String>()) {
            let _ = parse(&text);
        }

        #[test]
        fn parsing_arbitrary_headers_never_panics(rest in any::<String>()) {
            let _ = parse(&format!("{{\"ppad\":1,{rest}"));
        }
    }
}
