//! Database connections, schema introspection and SQL execution.
//!
//! Responsibilities (Phase 4): a `DatabaseProvider` abstraction over PostgreSQL, MySQL, SQLite
//! (`sqlx`) and SQL Server (`tiberius`), read-only sessions and server-side cancellation.
