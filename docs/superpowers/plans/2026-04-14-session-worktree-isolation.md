# Session Worktree Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session switching worktree-backed so sessions attached to different worktrees keep stable branch context without shared-directory auto-checkout.

**Architecture:** Phase 1 formalizes a shared session/worktree contract in shared sync, not in ephemeral UI state. Worktree metadata producers populate canonical fields, a dedicated shared-sync store holds authoritative session↔worktree attachments, and UI surfaces render that state. Shared sync must use runtime-backed canonicalization to validate `cwd`, recover resolvable legacy sessions, and surface attention states for missing/invalid worktrees plus in-progress Git operations.

**Tech Stack:** TypeScript, React, Zustand, Bun, existing OpenChamber git/worktree helpers

---

## File Structure / Ownership Map

- Modify: `packages/ui/src/types/worktree.ts`
  - Extend worktree metadata with canonical fields.
- Modify: `packages/ui/src/stores/types/sessionTypes.ts`
  - Define `SessionWorktreeAttachment`.
- Modify: `packages/ui/src/lib/api/types.ts`
  - Extend runtime/shared-sync contract for canonicalization and in-progress Git operation state.
- Modify: `packages/ui/src/lib/gitApi.ts`
  - Consume new runtime methods with HTTP/runtime delegation.
- Modify: `packages/ui/src/lib/gitApiHttp.ts`
  - Call new web git endpoints when runtime APIs are not injected.
- Modify: `packages/web/server/lib/git/service.js`
  - Authoritative worktree canonicalization, legacy recovery, and git operation attention state.
- Modify: `packages/web/server/lib/git/routes.js`
  - Expose HTTP endpoints for the new contract.
- Modify: `packages/web/server/lib/git/DOCUMENTATION.md`
  - Document the new runtime contract.
- Modify: `packages/web/src/api/index.ts`
  - Register web runtime API methods.
- Modify: `packages/vscode/src/bridge-git-runtime.ts`
  - Bridge the new git runtime methods into the VS Code webview.
- Modify: `packages/vscode/src/gitService.ts`
  - Implement VS Code-side canonicalization helpers using the git extension/runtime.
- Create: `packages/ui/src/sync/session-worktree-contract.ts`
  - Shared-sync-owned canonicalization helpers and formatting helpers.
- Create: `packages/ui/src/sync/session-worktree-contract.test.ts`
  - Unit tests for canonicalization, formatting, repair actions, unborn handling, legacy recovery.
- Create: `packages/ui/src/sync/session-worktree-store.ts`
  - Authoritative shared-sync store for session↔worktree attachments.
- Create: `packages/ui/src/sync/session-worktree-store.test.ts`
  - Tests for attachment persistence/selectors.
- Modify: `packages/ui/src/lib/worktrees/worktreeManager.ts`
  - Populate canonical metadata when worktrees are listed/created.
- Modify: `packages/ui/src/lib/worktreeSessionCreator.ts`
  - Initialize canonical attachments for isolated and current-worktree sessions.
- Modify: `packages/ui/src/components/session/SessionSidebar.tsx`
  - Keep discovered worktree inventory aligned with canonical metadata.
- Modify: `packages/ui/src/hooks/useDetectedWorktreeRoot.ts`
  - Remain a narrow fallback only when shared-sync metadata is unavailable.
- Modify: `packages/ui/src/sync/session-ui-store.ts`
  - Consume authoritative session↔worktree attachments when switching/opening sessions.
- Create: `packages/ui/src/sync/session-ui-store.test.ts`
  - Store-level tests for switching and session creation flows.
- Modify: `packages/ui/src/components/chat/ChatInput.tsx`
  - Clarify new-session targets.
- Modify: `packages/ui/src/components/layout/Header.tsx`
  - Render canonical branch/legacy/degraded/attention state.
- Modify: `packages/ui/src/components/views/GitView.tsx`
  - Render degraded state and Phase 1 repair actions.

## Task 1: Define the shared session/worktree contract

**Files:**
- Modify: `packages/ui/src/types/worktree.ts`
- Modify: `packages/ui/src/stores/types/sessionTypes.ts`
- Modify: `packages/ui/src/lib/api/types.ts`
- Modify: `packages/ui/src/lib/gitApi.ts`
- Modify: `packages/ui/src/lib/gitApiHttp.ts`
- Modify: `packages/web/server/lib/git/service.js`
- Modify: `packages/web/server/lib/git/routes.js`
- Modify: `packages/web/server/lib/git/DOCUMENTATION.md`
- Modify: `packages/web/src/api/index.ts`
- Modify: `packages/vscode/src/bridge-git-runtime.ts`
- Modify: `packages/vscode/src/gitService.ts`
- Create: `packages/ui/src/sync/session-worktree-contract.ts`
- Create: `packages/ui/src/sync/session-worktree-contract.test.ts`
- Create: `packages/ui/src/sync/session-worktree-store.ts`
- Create: `packages/ui/src/sync/session-worktree-store.test.ts`

- [ ] **Step 1: Write the failing contract tests**

Create `packages/ui/src/sync/session-worktree-contract.test.ts` with cases for:

```ts
import { describe, expect, test } from 'bun:test'
import {
  resolveSessionWorktreeState,
  formatSessionWorktreeBadge,
  getSessionWorktreeRepairActions,
} from './session-worktree-contract'

describe('resolveSessionWorktreeState', () => {
  test('keeps cwd when runtime canonicalization validates it inside worktreeRoot', () => {})
  test('falls back to worktreeRoot when runtime canonicalization rejects cwd', () => {})
  test('preserves unborn head state', () => {})
  test('recovers legacy session when runtime canonicalization resolves a worktree', () => {})
})

test('formats needs-attention badge', () => {})
test('returns phase-1 repair actions for missing worktree', () => {})
```

Create `packages/ui/src/sync/session-worktree-store.test.ts` with cases for:

```ts
import { describe, expect, test } from 'bun:test'

describe('session-worktree-store', () => {
  test('stores authoritative attachment by session id', () => {})
  test('clears attachment by session id', () => {})
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/ui/src/sync/session-worktree-contract.test.ts && bun test packages/ui/src/sync/session-worktree-store.test.ts`
Expected: FAIL because the contract/store modules do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Define shared types:

```ts
export type SessionWorktreeAttachment = {
  worktreeRoot: string | null
  cwd: string | null
  branch: string | null
  headState: 'branch' | 'detached' | 'unborn'
  worktreeStatus: 'ready' | 'missing' | 'invalid' | 'not-a-repo'
  worktreeSource: 'existing' | 'created-for-session' | null
  legacy: boolean
  degraded: boolean
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null
}
```

Add runtime/shared-sync contract types in `packages/ui/src/lib/api/types.ts` for:

- validating that `cwd` exists and is inside `worktreeRoot`
- resolving legacy directories to recoverable worktree attachments
- exposing in-progress Git operation attention state for merge/rebase/cherry-pick/revert/bisect

Implement the authoritative runtime contract across runtimes:

- `packages/web/server/lib/git/service.js`: add canonicalization + legacy recovery + operation-state derivation
- `packages/web/server/lib/git/routes.js`: add HTTP endpoints
- `packages/ui/src/lib/gitApiHttp.ts` + `packages/ui/src/lib/gitApi.ts`: expose the methods to shared sync
- `packages/web/src/api/index.ts`: register the web runtime handlers
- `packages/vscode/src/gitService.ts` + `packages/vscode/src/bridge-git-runtime.ts`: provide VS Code parity
- `packages/web/server/lib/git/DOCUMENTATION.md`: update docs for the new contract

Create:

- `session-worktree-contract.ts` for canonicalization/formatting/repair helpers
- `session-worktree-store.ts` as the authoritative shared-sync holder:

```ts
sessionWorktreeAttachments: Map<string, SessionWorktreeAttachment>
setSessionWorktreeAttachment(sessionId, attachment)
getSessionWorktreeAttachment(sessionId)
clearSessionWorktreeAttachment(sessionId)
```

`session-ui-store.ts` must not become the authority.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/ui/src/sync/session-worktree-contract.test.ts && bun test packages/ui/src/sync/session-worktree-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/types/worktree.ts packages/ui/src/stores/types/sessionTypes.ts packages/ui/src/lib/api/types.ts packages/ui/src/lib/gitApi.ts packages/ui/src/lib/gitApiHttp.ts packages/web/server/lib/git/service.js packages/web/server/lib/git/routes.js packages/web/server/lib/git/DOCUMENTATION.md packages/web/src/api/index.ts packages/vscode/src/bridge-git-runtime.ts packages/vscode/src/gitService.ts packages/ui/src/sync/session-worktree-contract.ts packages/ui/src/sync/session-worktree-contract.test.ts packages/ui/src/sync/session-worktree-store.ts packages/ui/src/sync/session-worktree-store.test.ts
git commit -m "feat: define shared session worktree contract"
```

## Task 2: Canonicalize metadata producers

**Files:**
- Modify: `packages/ui/src/lib/worktrees/worktreeManager.ts`
- Modify: `packages/ui/src/lib/worktreeSessionCreator.ts`
- Modify: `packages/ui/src/components/session/SessionSidebar.tsx`
- Modify: `packages/ui/src/hooks/useDetectedWorktreeRoot.ts`

- [ ] **Step 1: Write the failing producer test**

Add to `packages/ui/src/sync/session-worktree-contract.test.ts`:

```ts
test('canonical producer metadata preserves branch/detached/unborn states', () => {})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ui/src/sync/session-worktree-contract.test.ts`
Expected: FAIL until producers supply canonical metadata consistently.

- [ ] **Step 3: Write minimal implementation**

Update producers so discovered/created metadata includes:

```ts
{
  worktreeRoot: path,
  worktreeStatus: 'ready',
  headState: 'branch' | 'detached' | 'unborn',
  worktreeSource: 'existing' | 'created-for-session'
}
```

Rules:

- `worktreeManager.ts` is the main producer for listed/created worktrees
- `worktreeSessionCreator.ts` initializes canonical attachments for both isolated sessions and current-worktree sessions
- `SessionSidebar.tsx` keeps discovered inventory aligned with canonical shape
- `useDetectedWorktreeRoot.ts` remains fallback-only, never primary truth
- do not collapse all branchless states into `detached`; support `unborn`

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/ui/src/sync/session-worktree-contract.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/worktrees/worktreeManager.ts packages/ui/src/lib/worktreeSessionCreator.ts packages/ui/src/components/session/SessionSidebar.tsx packages/ui/src/hooks/useDetectedWorktreeRoot.ts packages/ui/src/sync/session-worktree-contract.test.ts
git commit -m "feat: canonicalize worktree metadata producers"
```

## Task 3: Route session switching and session creation through authoritative shared sync

**Files:**
- Modify: `packages/ui/src/sync/session-worktree-store.ts`
- Modify: `packages/ui/src/sync/session-ui-store.ts`
- Create: `packages/ui/src/sync/session-ui-store.test.ts`

- [ ] **Step 1: Write the failing store tests**

Create `packages/ui/src/sync/session-ui-store.test.ts` with cases for:

```ts
import { describe, expect, test } from 'bun:test'

describe('session-ui-store worktree routing', () => {
  test('setCurrentSession uses canonical cwd when valid', () => {})
  test('setCurrentSession falls back to worktreeRoot when cwd is degraded', () => {})
  test('new session in current worktree initializes canonical attachment', () => {})
  test('isolated session initializes created-for-session attachment', () => {})
  test('legacy session upgrades when runtime canonicalization recovers a worktree', () => {})
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/ui/src/sync/session-ui-store.test.ts`
Expected: FAIL because store switching/creation flows do not yet use authoritative attachments.

- [ ] **Step 3: Write minimal implementation**

Update shared sync and UI store flow so:

- `session-worktree-store.ts` remains the authoritative holder of attachments
- `session-ui-store.ts` reads from it when switching/opening sessions
- shared sync uses runtime-backed canonicalization to:
  - validate that `cwd` exists and is inside `worktreeRoot`
  - recover legacy sessions when possible
- current-worktree session creation and isolated session creation both initialize authoritative attachments
- no implicit branch restore is introduced

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/ui/src/sync/session-ui-store.test.ts && bun test packages/ui/src/sync/session-worktree-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/sync/session-worktree-store.ts packages/ui/src/sync/session-ui-store.ts packages/ui/src/sync/session-ui-store.test.ts packages/ui/src/sync/session-worktree-store.test.ts
git commit -m "feat: route sessions through authoritative worktree attachments"
```

## Task 4: Clarify new-session target UX

**Files:**
- Modify: `packages/ui/src/components/chat/ChatInput.tsx`
- Modify: `packages/ui/src/lib/worktreeSessionCreator.ts`
- Modify: `packages/ui/src/sync/session-worktree-contract.test.ts`

- [ ] **Step 1: Write the failing UX helper test**

Add to `packages/ui/src/sync/session-worktree-contract.test.ts`:

```ts
test('labels current worktree and isolated worktrees distinctly', () => {})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ui/src/sync/session-worktree-contract.test.ts`
Expected: FAIL because target labeling helper does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Update `ChatInput.tsx` and `worktreeSessionCreator.ts` so the user can clearly distinguish:

- current worktree / project-root target
- isolated worktree target
- pending bootstrap worktree target

Keep existing selector structure and current safeguards.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/ui/src/sync/session-worktree-contract.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/chat/ChatInput.tsx packages/ui/src/lib/worktreeSessionCreator.ts packages/ui/src/sync/session-worktree-contract.ts packages/ui/src/sync/session-worktree-contract.test.ts
git commit -m "feat: clarify session worktree targets"
```

## Task 5: Add degraded and needs-attention UI

**Files:**
- Modify: `packages/ui/src/components/layout/Header.tsx`
- Modify: `packages/ui/src/components/views/GitView.tsx`
- Modify: `packages/ui/src/sync/session-worktree-contract.ts`
- Modify: `packages/ui/src/sync/session-worktree-store.ts`
- Modify: `packages/ui/src/sync/session-worktree-contract.test.ts`
- Modify: `packages/ui/src/sync/session-ui-store.test.ts`

- [ ] **Step 1: Write the failing UI-state tests**

Extend tests for:

```ts
test('returns needs-attention badge for invalid worktree', () => {})
test('returns needs-attention badge for in-progress git operations', () => {})
test('returns open-without-worktree-features repair action for missing worktree', () => {})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/ui/src/sync/session-worktree-contract.test.ts && bun test packages/ui/src/sync/session-ui-store.test.ts`
Expected: FAIL because chrome/attention/repair behavior is incomplete.

- [ ] **Step 3: Write minimal implementation**

Implement:

- `Header.tsx`: canonical branch/legacy/degraded/attention rendering
- `GitView.tsx`: degraded notices and Phase 1 repair actions
- `session-worktree-store.ts` / shared sync state: attention reasons for merge/rebase/cherry-pick/revert/bisect

Phase 1 repair scope:

- ship `Open without worktree features`
- wire `Locate worktree` only if runtime support already exists
- otherwise defer `Locate worktree` explicitly; do not fake it

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/ui/src/sync/session-worktree-contract.test.ts && bun test packages/ui/src/sync/session-ui-store.test.ts && bun test packages/ui/src/sync/session-worktree-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/layout/Header.tsx packages/ui/src/components/views/GitView.tsx packages/ui/src/sync/session-worktree-contract.ts packages/ui/src/sync/session-worktree-store.ts packages/ui/src/sync/session-worktree-contract.test.ts packages/ui/src/sync/session-ui-store.test.ts packages/ui/src/sync/session-worktree-store.test.ts
git commit -m "feat: show worktree-backed session state"
```

## Task 6: Enforce mutation safety on attached worktrees

**Files:**
- Modify: `packages/ui/src/components/views/GitView.tsx`
- Modify: `packages/ui/src/sync/session-worktree-store.ts`
- Modify: `packages/ui/src/sync/session-worktree-contract.ts`
- Modify: `packages/ui/src/lib/gitApi.ts`
- Modify: `packages/ui/src/lib/gitApiHttp.ts`
- Modify: `packages/web/server/lib/git/service.js`
- Modify: `packages/web/server/lib/git/routes.js`
- Modify: `packages/ui/src/sync/session-worktree-contract.test.ts`
- Modify: `packages/ui/src/sync/session-ui-store.test.ts`

- [ ] **Step 1: Write the failing safety tests**

Extend tests for:

```ts
test('branch switching targets only the attached worktree root', () => {})
test('branch switching is blocked when the attached worktree is dirty', () => {})
test('branch switching is blocked during merge/rebase/cherry-pick/revert/bisect attention states', () => {})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/ui/src/sync/session-worktree-contract.test.ts && bun test packages/ui/src/sync/session-ui-store.test.ts`
Expected: FAIL because safety gating is not implemented yet.

- [ ] **Step 3: Write minimal implementation**

Implement mutation-safety enforcement so:

- branch switching and other high-risk worktree mutations always operate on the session's attached worktree root
- shared sync/runtime contract exposes enough status to block unsafe mutations when the worktree is dirty or has an in-progress Git operation
- `GitView.tsx` disables or gates unsafe actions with explicit reasons instead of attempting them optimistically
- no action silently falls back to another directory/worktree

High-risk mutations to gate in Phase 1:

- branch checkout
- branch creation/rename when it mutates the attached worktree state
- worktree cleanup/removal entrypoints shown in UI

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/ui/src/sync/session-worktree-contract.test.ts && bun test packages/ui/src/sync/session-ui-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/views/GitView.tsx packages/ui/src/sync/session-worktree-store.ts packages/ui/src/sync/session-worktree-contract.ts packages/ui/src/lib/gitApi.ts packages/ui/src/lib/gitApiHttp.ts packages/web/server/lib/git/service.js packages/web/server/lib/git/routes.js packages/ui/src/sync/session-worktree-contract.test.ts packages/ui/src/sync/session-ui-store.test.ts
git commit -m "feat: enforce safe mutations for attached worktrees"
```

## Task 7: Full verification and cleanup

**Files:**
- Verify: `packages/ui/src/**`
- Verify: `docs/superpowers/specs/2026-04-14-session-worktree-isolation-design.md`

- [ ] **Step 1: Run contract tests**

Run: `bun test packages/ui/src/sync/session-worktree-contract.test.ts`
Expected: PASS

- [ ] **Step 2: Run shared-sync store tests**

Run: `bun test packages/ui/src/sync/session-worktree-store.test.ts`
Expected: PASS

- [ ] **Step 3: Run UI store tests**

Run: `bun test packages/ui/src/sync/session-ui-store.test.ts`
Expected: PASS

- [ ] **Step 4: Run type-check**

Run: `bun run type-check`
Expected: PASS

- [ ] **Step 5: Run lint**

Run: `bun run lint`
Expected: PASS

- [ ] **Step 6: Run build**

Run: `bun run build`
Expected: PASS

- [ ] **Step 7: Manual verification**

Verify these flows manually:

- create session in current worktree
- create isolated session in new worktree
- switch between sessions attached to different worktrees
- confirm branch label stays tied to the selected worktree
- open a recoverable legacy session and verify runtime canonicalization upgrades it
- open a missing worktree session
- open an invalid/not-a-repo session
- verify detached HEAD rendering
- verify unborn branch rendering
- verify needs-attention rendering for merge/rebase/cherry-pick/revert/bisect when feasible
- confirm degraded/legacy UI does not trigger checkout
- confirm dirty worktree UI still behaves safely

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src docs/superpowers/plans/2026-04-14-session-worktree-isolation.md
git commit -m "feat: implement session worktree isolation"
```
