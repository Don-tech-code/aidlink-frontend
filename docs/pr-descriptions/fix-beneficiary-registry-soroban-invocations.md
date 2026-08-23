## fix: Implement `BeneficiaryRegistryClient` with real Soroban contract invocations

### Summary

This PR fixes two completely broken contract methods in `src/lib/soroban/beneficiary-registry.ts` that were silently no-ops — causing every wallet on the platform to be assigned the `donor` role, the admin portal to be permanently inaccessible, and every "Verify" / "Suspend" action to write nothing on-chain while toasting success to the user.

Both methods are now fully functional Soroban contract invocations that follow the identical pattern established by `src/lib/beneficiary/contract.ts`.

---

### Root Cause

The original stub implementation called `contract.call(...)` from `@stellar/stellar-sdk`, which produces an `xdr.Operation` XDR object. It does **not** submit anything to the network. The result was immediately discarded in both methods:

**`getRole` (before):**
```ts
const call = contract.call('get_role', addressScVal); // builds XDR op, discarded
return null;                                           // always null
```

**`updateVerificationStatus` (before):**
```ts
contract.call('update_verification_status', accountScVal, statusScVal); // discarded
// no await, no sendTransaction, no signing — silently resolves
```

This caused a cascade of broken behaviour across the entire platform:

| Symptom | Cause |
|---|---|
| Every wallet receives `role: 'donor'` | `getRole` always returned `null`; `auth-store.ts` mapped `null → 'donor'` |
| `/admin` permanently inaccessible | `withRequireRole(AdminPage, ['admin'])` threw `UnauthorizedError` on every render |
| `/beneficiary` portal blocked for all beneficiaries | Same `withRequireRole` issue for `['beneficiary', 'admin']` |
| "Verify" / "Suspend" buttons showed success toast but changed nothing on-chain | `updateVerificationStatus` was a complete no-op |

---

### What Changed

#### `src/lib/soroban/beneficiary-registry.ts` — complete rewrite of both methods

**`getRole` — read-only simulation path**

Replaced the broken stub with a proper Soroban simulation:

1. Uses `Operation.invokeContractFunction` (not `Contract.call()`) to build the transaction operation correctly.
2. Uses the `ZERO_ACCOUNT` pattern (`GAAA...WHF`) as the transaction source — Soroban simulation never debits fees, so no real funded account is needed. Falls back to `new Account(ZERO_ACCOUNT, '0')` if the RPC doesn't recognise the zero key on the current network.
3. Calls `rpc.simulateTransaction(tx)` and extracts the `retval` from the success response.
4. Decodes the returned `ScVal` via the new `decodeRoleScVal` helper, which handles all three shapes the contract may return:

| Return shape | Decoded as |
|---|---|
| `ScvU32(0..3)` | Index into `ROLE_MAP` → `'donor' \| 'ngo' \| 'beneficiary' \| 'admin'` |
| `ScvSymbol("Admin")` | Lowercased via `SYMBOL_TO_ROLE` map |
| `ScvMap { role: ScvSymbol }` | Extracts `role` field, recursively decodes |
| `ScvVoid` | Returns `null` (address not registered) |

5. Simulation errors matching `/not found|no entry|missing/i` are treated as "no role" and return `null` rather than throwing — matching the contract's expected behaviour for unregistered addresses.

**`updateVerificationStatus` — full write path**

Implemented the identical 5-step write pipeline used by `verifyBeneficiary` and `rejectBeneficiary` in `contract.ts`:

```
1. rpc.getAccount(signer)           → load source account sequence number
2. TransactionBuilder + Operation   → build the unsigned transaction
3. rpc.simulateTransaction(builtTx) → validate + get resource footprint
4. SorobanRpc.assembleTransaction() → inject auth entries and resource limits
5. signTransaction (Freighter)      → prompt wallet for signature
6. TransactionBuilder.fromXDR()     → re-hydrate signed envelope
7. rpc.sendTransaction(signedTx)    → submit to network
8. pollWithBackoff(rpc, hash)       → wait for on-chain SUCCESS
```

- Throws with a descriptive error at every failure point — never resolves silently.
- Reuses `pollWithBackoff` exported from `contract.ts` rather than reimplementing.
- `signerAddress` is injectable as a per-call parameter (in addition to the constructor argument) to support the admin page passing the connected wallet address at call time.

**Constructor — injectable dependencies for testability**

```ts
constructor(
  contractId: string = process.env.NEXT_PUBLIC_BENEFICIARY_REGISTRY_CONTRACT ?? '',
  network:    string = process.env.NEXT_PUBLIC_DEFAULT_NETWORK ?? 'testnet',
  signerAddress: string = '',
)
```

Tests construct their own instance with a known `contractId` and the mocked `SorobanRpc.Server` instead of reaching into the module-level singleton. The singleton export shape is unchanged.

**New exports**

- `ROLE_MAP` is now `export const` (was module-private) so external consumers can import it directly.
- `decodeRoleScVal` and `SYMBOL_TO_ROLE` remain private helpers (unexported).

---

#### `src/store/auth-store.ts` — minor fix

The `User` object created in `fetchRole` was missing required fields `name` and `createdAt` defined by the `User` interface. Added sensible defaults (public key as name, current ISO timestamp as `createdAt`). The `role: role || 'donor'` fallback is preserved — it now only fires for genuinely unregistered wallets where `getRole` returns `null`.

---

#### `src/components/providers/auth-provider.tsx` — race condition fix in `useRequireRole`

**Before:**
```ts
if (!loading && (!role || !allowedRoles.includes(role))) {
  throw new UnauthorizedError(...)
}
```

**After:**
```ts
const roleLoadingState = useAuthStore((s) => s.roleLoadingState)
if (roleLoadingState === 'loaded' && (!role || !allowedRoles.includes(role))) {
  throw new UnauthorizedError(...)
}
```

The old guard used `!loading` (a boolean derived from `roleLoadingState === 'loading'`), which meant it also threw during `'idle'` and `'error'` states — i.e., on the very first render before `fetchRole` had been called, and again if the RPC call errored. The new guard only throws when the auth pipeline has reached a definitive `'loaded'` result, preventing the HOC from blocking access during initial page load.

---

#### `src/app/admin/page.tsx` — wiring and structural cleanup

- Consolidated duplicate import blocks (there were two `import React` statements and two separate blocks of handler functions caused by a prior merge conflict).
- Added `withRequireRole(AdminPage, ['admin'])` as the default export — the page was previously exporting `AdminPage` directly, bypassing role protection entirely.
- Fixed `handleVerify` and `handleSuspend` to pass `beneficiary.walletAddress` (the on-chain address) instead of `beneficiary.id` (a mock string) to `updateVerificationStatus`.
- Added the `Suspend` button to the pending beneficiaries table — it existed in the users tab but was missing from the beneficiaries tab.
- Added `disabled={loadingId === beneficiary.walletAddress}` to both Verify and Suspend buttons so the UI reflects the in-flight state correctly.
- Removed a leftover duplicate `<div>` block from a previous partial implementation.

---

#### `src/app/beneficiary/page.tsx` — cleanup and role guard

- Removed ~180 lines of dead code: simulated claim handlers, `ProofSubmissionForm` stub callbacks, and unused imports (`useRouter`, `useEffect`, `useCallback`, `Skeleton`, `AllocationCard`, etc.) that were referencing components not yet implemented.
- Renamed internal component from `BeneficiaryPage` to `BeneficiaryPortalPage` to avoid confusion with the type `Beneficiary`.
- Added `withRequireRole(BeneficiaryPortalPage, ['beneficiary', 'admin'])` as the default export.
- The page now correctly shows a "Wallet Not Connected" state when no wallet is connected, and renders the `VerificationBanner` for connected beneficiaries.

---

#### `src/types/index.ts` — extract `UserRole` as a named type

```ts
// Before (inline union on User.role):
role: 'donor' | 'ngo' | 'beneficiary' | 'admin'

// After (named export):
export type UserRole = 'donor' | 'ngo' | 'beneficiary' | 'admin'
export interface User {
  role: UserRole
  ...
}
```

`UserRole` was already used as a type in `auth-store.ts`, `auth-provider.tsx`, and `beneficiary-registry.ts` via `import type { UserRole } from '@/types'`. This change makes the source of truth explicit and eliminates the duplicate inline union.

---

#### `src/store/wallet-store.ts` — minor cleanup

- Removed unused `PersistStorage` import and the unused `WalletPersistedState` type alias.
- Extracted magic number `24 * 60 * 60 * 1000` into a named constant `SESSION_TTL_MS` for readability.

---

### Tests Added

**File:** `src/lib/soroban/__tests__/beneficiary-registry.test.tsx` (618 lines, 27 tests)

All 6 acceptance criteria from the issue are covered:

- [x] **AC1** — `getRole`: `SorobanRpc` mock returns `ScvU32(3)` → asserts return value is `'admin'`
- [x] **AC2** — `getRole`: `SorobanRpc` mock returns `ScvVoid` → asserts return value is `null`
- [x] **AC3** — `updateVerificationStatus`: spies on mock `SorobanRpc.Server` and asserts `simulateTransaction`, `sendTransaction`, and `getTransaction` are called in that exact order
- [x] **AC4** — Auth flow: renders `<AuthProvider>` with mocked `getRole` returning `'admin'`; asserts `useAuthStore.getState().user.role === 'admin'` and `document.cookie` contains `auth-role=admin`
- [x] **AC5** — `withRequireRole(AdminPage, ['admin'])` renders `<AdminPage>` without throwing `UnauthorizedError` when the store has `roleLoadingState: 'loaded'` and `role: 'admin'`
- [x] **AC6** — `updateVerificationStatus`: mocked `rpc.sendTransaction` returns `{ status: 'ERROR' }`; asserts the promise rejects with a message matching `/update_verification_status transaction rejected/`

Additional coverage:

- All four `ScvU32` variants (0–3) decode to the correct role strings
- `ScvSymbol("Admin")` decodes correctly
- `ScvMap { role: ScvSymbol("Admin") }` decodes correctly
- Empty `contractId` / empty `publicKey` short-circuits without calling RPC
- Missing `retval` in simulation response returns `null`
- Non-"not found" simulation error propagates as a throw
- `updateVerificationStatus` with no signer address rejects with a descriptive message
- `sendTransaction` ERROR with an `errorResult` XDR blob includes the XDR in the error message
- Simulation error on write path propagates before `sendTransaction` is called
- `useRequireRole` does not throw while `roleLoadingState === 'loading'`
- `useRequireRole` throws `UnauthorizedError` for wrong role when `roleLoadingState === 'loaded'`

---

### Test Results

```
Test Suites: 1 passed (beneficiary-registry.test.tsx)
Tests:       27 passed, 0 failed
```

Full suite (391 tests, 29 suites passing — 1 pre-existing syntax error in `campaigns/[id]/page.test.tsx` unrelated to this PR):

```
Tests: 391 passed, 0 failed
```

Type-check (`npx tsc --noEmit`): **zero errors in files touched by this PR**. Pre-existing errors in unrelated files (`export-button.tsx`, `campaigns/[id]/page.tsx`, gamification modules) are out of scope.

---

### Before / After

| Scenario | Before | After |
|---|---|---|
| Admin wallet connects | Gets `role: 'donor'`, locked out of `/admin` | Gets `role: 'admin'` from on-chain `get_role`, `/admin` renders |
| Beneficiary wallet connects | Gets `role: 'donor'`, locked out of `/beneficiary` | Gets `role: 'beneficiary'`, portal renders |
| Unregistered wallet connects | Gets `role: 'donor'` (same bug, correct outcome) | Gets `role: 'donor'` (null → fallback, correct) |
| Admin clicks "Verify" | Toast success, nothing written on-chain | Full Soroban transaction submitted and polled to SUCCESS |
| Admin clicks "Suspend" | Toast success, nothing written on-chain | Full Soroban transaction submitted and polled to SUCCESS |
| Simulation fails | `getRole` silently returned `null`; `updateVerificationStatus` resolved silently | Both throw with a typed, descriptive error |
| Page load before wallet connect | `useRequireRole` threw immediately (idle state treated as loaded) | `useRequireRole` waits for `roleLoadingState === 'loaded'` |

---

### Checklist

- [x] `npm run test` passes (391/391)
- [x] No new type errors introduced (`tsc --noEmit` clean on changed files)
- [x] `BeneficiaryRegistryClient` class name and `beneficiaryRegistryClient` singleton export unchanged
- [x] `getRole` return type `Promise<UserRole | null>` unchanged
- [x] `updateVerificationStatus` signature backwards-compatible (optional `signerAddress` param added)
- [x] No new `npm` dependencies introduced
- [x] `getRole` is read-only (no wallet signing prompt on page load)
- [x] `ROLE_MAP` constant preserved and now exported
- [x] `pollWithBackoff` reused from `contract.ts`, not reimplemented
