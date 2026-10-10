# ADR-002: TS/JS first using a constrained compiler API

**Status:** Accepted (baseline from the V0.1 master plan, 10 October 2026)

**Context:** parser syntax and module resolution are language/ecosystem-specific.

**Decision:** pinned TypeScript syntax/resolver via virtual FS, safe config subset, explicit confidence.

**Alternatives rejected:** regex extraction, full dependency install/typecheck, all-language generic import guesses.

**Consequences:** no execution; incomplete external/framework contexts are visible; fixtures drive fidelity.

**Review trigger:** a required resolver behavior cannot be represented safely; narrow scope before adopting another parser/resolver.
