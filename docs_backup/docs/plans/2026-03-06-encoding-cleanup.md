# Source Encoding Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove mojibake-corrupted Chinese literals from source and tests, then add regression coverage so the corruption does not re-enter the repository unnoticed.

**Architecture:** Keep the fix narrow: add one regression test that scans `src/` for known mojibake markers, then replace each corrupted literal with the intended UTF-8 text in the affected source and test files. Verification stays focused on the new guard plus the currently failing Vitest files.

**Tech Stack:** TypeScript, Vitest, Node.js filesystem APIs

---

### Task 1: Add a failing mojibake regression test

**Files:**
- Create: `src/encoding.mojibake.test.ts`
- Test: `src/encoding.mojibake.test.ts`

**Step 1: Write the failing test**

Create a Vitest file that scans `src/**/*.{ts,tsx,js,jsx}` and fails when any source line contains known mojibake markers currently present in the repo.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/encoding.mojibake.test.ts`
Expected: FAIL with matches from the currently corrupted files.

**Step 3: Keep the failure output readable**

List file paths, line numbers, and the matched marker text in the assertion message.

**Step 4: Re-run test to verify it still fails for the expected reason**

Run: `npm test -- src/encoding.mojibake.test.ts`
Expected: FAIL and only point at real mojibake matches.

### Task 2: Repair corrupted source literals

**Files:**
- Modify: `src/server/routes/api/accounts.ts`
- Modify: `src/web/i18n.supplement.ts`

**Step 1: Replace the unsupported-platform mojibake message**

Use a single readable Chinese message in `accounts.ts`, aligned with the existing translation key in `i18n.supplement.ts`.

**Step 2: Remove or normalize the matching corrupted i18n entry**

Keep only the valid UTF-8 translation key/value pair for that backend message.

**Step 3: Run the mojibake test**

Run: `npm test -- src/encoding.mojibake.test.ts`
Expected: still FAIL, but no longer report the repaired source files.

### Task 3: Repair corrupted test fixtures and selectors

**Files:**
- Modify: `src/web/pages/dashboard.site-speed-button.test.tsx`
- Modify: `src/server/services/platforms/newApi.test.ts`

**Step 1: Fix the dashboard selector text**

Replace the corrupted speed-button label match with the intended UTF-8 text.

**Step 2: Fix corrupted upstream fixture/expectation messages in `newApi.test.ts`**

Use readable Chinese strings that match the adapter’s intended behavior.

**Step 3: Run focused tests**

Run: `npm test -- src/web/pages/dashboard.site-speed-button.test.tsx`
Expected: PASS

Run: `npm test -- src/server/services/platforms/newApi.test.ts`
Expected: PASS

### Task 4: Verify end-to-end cleanup

**Files:**
- Test: `src/encoding.mojibake.test.ts`
- Test: `src/web/pages/accounts.rebind-panel-focus.test.tsx`
- Test: `src/web/pages/dashboard.site-speed-button.test.tsx`
- Test: `src/server/services/platforms/newApi.test.ts`

**Step 1: Re-run the regression guard**

Run: `npm test -- src/encoding.mojibake.test.ts`
Expected: PASS

**Step 2: Re-run the CI-facing tests**

Run: `npm test -- src/web/pages/accounts.rebind-panel-focus.test.tsx src/web/pages/dashboard.site-speed-button.test.tsx`
Expected: PASS

**Step 3: Re-run the backend platform test**

Run: `npm test -- src/server/services/platforms/newApi.test.ts`
Expected: PASS
