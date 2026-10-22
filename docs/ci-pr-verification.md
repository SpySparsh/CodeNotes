# Pull Request CI Trigger Verification

This temporary document exists solely to validate that GitHub Actions automatically triggers the `Run Quality Checks & End-to-End Tests` workflow when a pull request is opened targeting `main`.

- Target Branch: `main`
- Verification Branch: `chore/verify-pr-ci-trigger`
- Purpose: Ensure pull request events execute all automated tests, RLS integration tests, Prometheus checks, linter, TypeScript compiler, production build, and Playwright E2E suites.
- Note: This temporary branch will be closed without merging and cleaned up after verification.
