# pi-fleet

Fleet: a delegation module for pi that hands suitable work to cheaper models,
collects compact evidence, and returns work to the primary after one escalation.

## Quick start

```bash
git clone <repo-url> && cd pi-fleet
npm install
./bin/fleet --json        # → {"ok":true}
```

No compile step. The CLI runs TypeScript source directly via Node's
type-stripping flag (`--experimental-strip-types`). There are zero runtime
dependencies.

## Testing

The verification ladder has six rungs. CI runs rungs 0 to 3; rungs 4 (live
Pi smoke) and 5 (module evals) are hand-run and deliberately absent from CI.

| Rung | What                        | Command |
|------|-----------------------------|---------|
| 0    | `tsc --noEmit` (strict)     | `npm run rung:0` |
| 1    | Unit tests                  | `npm run rung:1` |
| 2    | Integration tests           | `npm run rung:2` |
| 3    | Conformance tests (CLI ≡ MCP) | `npm run rung:3` |

Run all rungs in order:

```bash
npm test
```

## Project layout

```
bin/fleet              Shell wrapper — invokes Node on src/main.ts
src/envelope.ts        Envelope and Problem types
src/main.ts            CLI entry point and argument processing
tests/rung1.unit.*     Unit tests (envelope, run)
tests/rung2.integration.*  Integration tests (spawn the real binary)
tests/rung3.conformance.*  Conformance tests (placeholder)
tsconfig.json          Strict-mode TypeScript config (noEmit)
```

## Licence

MIT. See [LICENSE](LICENSE).
