//! Languages PolyPad edits and the execution modes each one offers (spec section 5).
//!
//! The serialized ids are part of the `.ppad` file format and of the IPC contract: renaming one
//! breaks existing scripts.

use serde::{Deserialize, Serialize};

/// A language a script can be written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum Language {
    /// C#.
    CSharp,
    /// F#.
    FSharp,
    /// Java.
    Java,
    /// Kotlin.
    Kotlin,
    /// Go.
    Go,
    /// TypeScript.
    TypeScript,
    /// JavaScript.
    JavaScript,
    /// Python.
    Python,
    /// Rust.
    Rust,
    /// SQL against the selected connection.
    Sql,
}

/// How a kernel interprets a script.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum ExecutionMode {
    /// A single expression whose value is dumped.
    Expression,
    /// A sequence of statements.
    Statements,
    /// A complete program with an entry point.
    Program,
    /// A script file in the language's own scripting dialect.
    Script,
    /// An ES module.
    Module,
    /// SQL statements.
    Sql,
}

impl Language {
    /// Every supported language, in the order the UI lists them.
    pub const ALL: [Self; 10] = [
        Self::CSharp,
        Self::FSharp,
        Self::Java,
        Self::Kotlin,
        Self::Go,
        Self::TypeScript,
        Self::JavaScript,
        Self::Python,
        Self::Rust,
        Self::Sql,
    ];

    /// Modes this language offers; the first one is the default.
    #[must_use]
    pub const fn modes(self) -> &'static [ExecutionMode] {
        use ExecutionMode::{Expression, Module, Program, Script, Sql, Statements};
        match self {
            Self::CSharp | Self::Java => &[Statements, Expression, Program],
            Self::FSharp | Self::Python => &[Script, Expression],
            Self::Kotlin => &[Script],
            Self::Go => &[Statements, Program],
            Self::TypeScript | Self::JavaScript => &[Statements, Expression, Module],
            Self::Rust => &[Statements],
            Self::Sql => &[Sql],
        }
    }

    /// Mode used for new scripts and when a script names a mode this language lacks.
    #[must_use]
    pub const fn default_mode(self) -> ExecutionMode {
        self.modes()[0]
    }

    /// Whether this language offers `mode`.
    #[must_use]
    pub fn offers(self, mode: ExecutionMode) -> bool {
        self.modes().contains(&mode)
    }
}
