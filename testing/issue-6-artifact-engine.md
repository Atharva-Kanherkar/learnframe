# issue-6-artifact-engine - Test Contract

## Functional Behavior

- Generate chunk notes from transcript chunks with a cheap model role.
- Synthesize video summaries from chunk notes with a medium model role.
- Synthesize playlist syllabus from video summaries, not raw full transcripts.
- Support glossary, quiz, flashcards, study plan, and prerequisite map as composable operations.
- Use strict Zod schemas and prompt versions for every artifact operation.
- Generate only requested outputs.
- Give every artifact a schema-backed payload, prompt version, model role, and cache key.
- Preserve timestamp references where source chunks provide timestamp ranges.
- Use cache helpers so repeated unchanged artifact generation skips LLM adapter calls.
- Keep this issue separate from retrieval QA, embeddings execution, player contracts, and Skillware integration.

## Unit Tests

- Artifact schemas accept valid payloads and reject invalid payloads.
- `createLowCostArtifactEngine()` generates chunk notes for requested notes output.
- Video summaries are synthesized from chunk notes, not raw transcript chunks.
- Playlist syllabus uses compressed video summaries, not raw transcript chunks.
- Requested outputs filtering avoids unrequested artifact operations.
- Cache hits skip duplicate LLM calls.
- Generated artifacts include `promptVersion`, `modelRole`, and `cacheKey`.
- Chunk-note and summary artifacts preserve timestamp citation ranges.
- Glossary, quiz, flashcards, study plan, and prerequisite map operations produce schema-valid artifacts.

## Integration / Functional Tests

- Tests use a fake `LlmAdapter`; no real model provider is called.
- Tests use `InMemoryStorageAdapter` for cache behavior.
- Tests use existing `TranscriptChunk` contract shape from issue #3.

## Smoke Tests

- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- `npm pack --dry-run` includes built `dist` entrypoints.
- `npm audit --audit-level=critical` passes.

## E2E Tests

- N/A - issue `#6` is SDK artifact-engine infrastructure only.

## Manual / cURL Tests

- N/A - this package is a TypeScript SDK, not an HTTP service.
