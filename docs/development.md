# Development

[Back to the README](../README.md)

```sh
npm test
```

Unit tests cover the pure functions (sanitize, heuristic, auto-label,
session-file resolution), plus hook-level tests that drive `before_agent_start`
and `agent_settled` against a stub `herdr` binary and a stub model registry in a
temp directory: no network, no real herdr, and the temp directory is removed
afterwards.
