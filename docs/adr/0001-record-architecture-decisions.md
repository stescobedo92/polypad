# ADR-0001: Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-09-30

## Context

PolyPad is built in phases (see `docs/spec/polypad-spec.md`, section 6) and several choices are
expensive to revert: the kernel protocol, the sandbox strategy, the IPC contract, the security
baseline. The reasons behind them must survive the people and sessions that made them.

## Decision

Every relevant decision is recorded as a numbered Markdown file in `docs/adr/`, using the
sections Context, Decision, Consequences (and Alternatives when useful). ADRs are immutable once
accepted; a later ADR supersedes an earlier one and both link to each other.

## Consequences

- Pull requests that introduce or change a decision include the ADR in the same change.
- Code comments point to ADRs (for example `docs/adr/0002`) instead of repeating the rationale.
