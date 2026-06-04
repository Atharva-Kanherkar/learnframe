# issue-5-sdk-foundations - Test Contract

## Functional Behavior

- Package root exports `createYoutubeLearningSdk` and `createLearnFrame` factory functions.
- Package root exports public contracts for sources, metadata, transcripts, chunks, artifacts, progress events, SDK errors, and adapter interfaces.
- Video sources and playlist sources are validated with Zod schemas.
- A video source is normalized into a course-like processing result containing a playlist of one item.
- Core package has no Skillware dependency or Skillware-specific persistence assumptions.
- Adapter contracts expose cache/provenance-friendly data early enough for later cost, latency, and accuracy work.
- The SDK can be instantiated with in-memory adapters only.
- The initial `process()` implementation validates source shape and delegates resolution through the configured source resolver.
- The initial `ask()` implementation validates input and returns an explicit insufficient-context response until retrieval QA is implemented.

## Unit Tests

- `sourceSchema` accepts valid YouTube video source shape and rejects invalid URLs.
- `sourceSchema` accepts valid YouTube playlist source shape and rejects invalid source types.
- `createYoutubeLearningSdk` can be instantiated with in-memory adapters and exported from the package root.
- `sdk.process()` treats a video input as a playlist of one through the source resolver result.
- `sdk.process()` emits progress events for validation and source resolution.
- `sdk.ask()` returns an insufficient-context answer with confidence metadata before retrieval is implemented.
- In-memory storage adapter stores, retrieves, deletes, and reports cache hits deterministically.

## Integration / Functional Tests

- SDK factory plus in-memory source resolver plus in-memory storage work together for a single-video processing call.
- No integration with Skillware, YouTube network calls, LLM providers, embeddings providers, or transcript providers is required for issue `#5`.

## Smoke Tests

- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.

## E2E Tests

- N/A - issue `#5` defines SDK foundations only and does not expose a runnable end-user flow.

## Manual / cURL Tests

- N/A - this package is a TypeScript SDK, not an HTTP service.
