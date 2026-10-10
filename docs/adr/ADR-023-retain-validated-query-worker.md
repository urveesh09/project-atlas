# ADR-023: Retain the validating worker for queries

Date: 2026-10-10. Status: accepted.

The first implementation terminated the validating worker and sent the full decoded graph to a second query worker. Profiling exposed another synchronous structured clone and repeated graph indexing; early search could also wait for that index to initialize.

For browser imports, prepare graph/city/search indexes once in the validating worker, return the validated bundle and HTML indexes, then retain that worker for bounded search/reach/overlay requests. Ownership passes to the dataset model and its QueryClient; replacing the dataset terminates it and rejects pending queries. Failed/cancelled loads still terminate immediately. The standalone query-worker entry remains available for independently constructed models and unit tests.

Validation remains complete before the viewer or query handler receives repository data. Worker message IDs, deadlines, pending limits and stale-result guards remain unchanged. The retained worker holds immutable graph/index data, not repository source or authentication credentials.
