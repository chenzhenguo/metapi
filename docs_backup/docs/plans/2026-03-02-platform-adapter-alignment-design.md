# Platform Adapter Alignment Design

**Date**: 2026-03-02
**Goal**: Align metapi platform adapters with all-api-hub behavior for full platform compatibility.

## Background

metapi supports 11 upstream platforms, but several adapters are incomplete compared to all-api-hub's implementations. This design covers 5 changes to close the gaps.

## Changes

### 1. Compatibility User-ID Headers (NewApiAdapter)

**Problem**: metapi only sends `New-Api-User` header. VoAPI, RIX_API, neo-Api, and other forks read different header names.

**Solution**: Modify `NewApiAdapter.authHeaders()` to fan out the userId across all 6 known header names:
- `New-API-User`, `Veloera-User`, `voapi-user`, `User-id`, `Rix-Api-User`, `neo-api-user`

**Files**: `src/server/services/platforms/newApi.ts`

**Impact**: All NewAPI-family platforms (new-api, anyrouter, vo-api, super-api, rix-api, neo-api) benefit automatically.

---

### 2. Sub2API Adapter Rewrite

**Problem**: Current Sub2ApiAdapter extends OneApiAdapter (9 lines, detection only). Sub2API uses JWT auth with completely different endpoints.

**Solution**: Rewrite Sub2ApiAdapter as standalone class extending BasePlatformAdapter:
- Auth: JWT Bearer token (no cookie, no session)
- User info: `GET /api/v1/auth/me` → `{ code: 0, data: { id, username, email, balance_usd } }`
- Balance: Convert `balance_usd` to quota units
- Check-in: Not supported (return unsupported)
- Models: `GET /v1/models` (OpenAI-compatible, same as current)
- Login: Not supported (JWT only)
- Token management: Not available

**Files**: `src/server/services/platforms/sub2api.ts`

---

### 3. Veloera Adapter Enhancement

**Problem**: metapi uses OneAPI's `/api/user/checkin` for Veloera check-in, but Veloera uses a different endpoint.

**Solution**: Override `checkin()` to use Veloera's actual endpoint:
- Check-in: `POST /api/user/checkin` (same path but Veloera also supports `/api/user/check_in_status` for status)
- Quota conversion: Already correct at 1,000,000 divisor

Note: Veloera's checkin path is actually the same as NewAPI. The key difference in all-api-hub is the check-in *status* endpoint (`/api/user/check_in_status`), which metapi doesn't use directly. The existing checkin implementation is likely fine. Main enhancement: add compat headers support.

**Files**: `src/server/services/platforms/veloera.ts`

---

### 4. OneHub Adapter Enhancement

**Problem**: OneHubAdapter is 10 lines, just URL detection. Missing OneHub-specific endpoints.

**Solution**: Add OneHub-specific overrides:
- Models: `GET /api/available_model` as fallback (returns `{ data: { model_name: {...}, ... } }`)
- User groups: `GET /api/user_group_map` (returns `{ data: { group_name: ratio, ... } }`)
- Token listing: Handle `{ data: [...] }` response envelope (vs bare array)

**Files**: `src/server/services/platforms/oneHub.ts`

---

### 5. DoneHub Adapter Enhancement

**Problem**: DoneHubAdapter has checkin disabled + fallback model discovery. Missing DoneHub-specific features.

**Solution**: Add DoneHub-specific overrides:
- Inherit OneHub's model/group methods
- Override model discovery fallback: try `/api/available_model` (already done)
- Keep checkin disabled (already done)

DoneHub is already partially implemented. The main missing piece is inheriting from OneHubAdapter instead of OneApiAdapter to get OneHub's enhanced methods.

**Files**: `src/server/services/platforms/doneHub.ts`

---

## Architecture

No new patterns introduced. All changes fit within the existing class hierarchy:

```
BasePlatformAdapter
├── OneApiAdapter
│   ├── OneHubAdapter (enhanced)
│   │   └── DoneHubAdapter (re-parented)
│   └── (Sub2ApiAdapter removed from this branch)
├── NewApiAdapter (compat headers added)
│   └── AnyRouterAdapter
├── VeloeraAdapter (minor enhancement)
├── Sub2ApiAdapter (rewritten, now extends BasePlatformAdapter)
└── ... (OpenAI, Claude, Gemini, CLIProxyAPI unchanged)
```

## Detection Order

Update detection order in `index.ts` to ensure Sub2API is detected before OneAPI (already the case).

## Risk Assessment

- **Low risk**: Header changes are additive (extra headers don't break existing platforms)
- **Medium risk**: Sub2API rewrite changes auth flow entirely (but current implementation doesn't work anyway)
- **Low risk**: OneHub/DoneHub enhancements add fallback paths (existing paths still work)
