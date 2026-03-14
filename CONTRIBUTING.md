# Contributing to AgentTrace

## Prerequisites

- Node 22+
- npm

## Setup

```
git clone https://github.com/angelofrisina/agenttrace.git
cd agenttrace
npm install
npm test
```

## Development Workflow

1. Branch from `main`: `git checkout -b your-feature-name`
2. Write tests first — all new behavior must have test coverage
3. Run the full test suite: `npm test`
4. Run the typechecker: `npm run typecheck`
5. Open a pull request against `main`

## Code Style

- TypeScript strict mode — no `any`, no type suppression without a comment explaining why
- ESM throughout — use `import`/`export`, never `require`/`module.exports`
- No default exports — all exports are named
- One class per file; keep files focused
- Tests live in `test/` and mirror the source file they cover (e.g., `src/store/index.ts` -> `test/store.test.ts`)

## Pull Request Guidelines

- One feature or fix per PR — keep diffs reviewable
- Describe what the change does and why in the PR body
- All tests must pass before requesting review
- If you're adding a public API, update the README API reference table for that class

## Running Tests

```
npm test           # run all tests once
npm run test:watch # watch mode during development
npm run typecheck  # type-check without emitting
npm run build      # compile to dist/
```

## Reporting Bugs

Open a GitHub issue with a minimal reproduction. Include the Node version and a code snippet that demonstrates the problem.

For security vulnerabilities, see [SECURITY.md](./SECURITY.md).
