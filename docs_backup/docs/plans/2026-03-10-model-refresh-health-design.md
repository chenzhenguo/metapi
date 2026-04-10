---
title: Model Refresh Health + Toast Feedback
date: 2026-03-10
owner: codex
status: approved
---

# Goal
When users click the "模型" refresh action, failed model discovery should mark the account runtime health as `unhealthy` and surface a clear failure toast. Success should show the discovered model names and count.

# Scope
- Applies to all account types (Session + API Key).
- Server determines success/failure and error category; UI uses returned payload for toast text.

# Non-goals
- Changing upstream adapters' auth logic.
- Altering auto-refresh schedules or background tasks.

# Architecture
- Update `refreshModelsForAccount(...)` to return structured outcome:
  - `status`: `success` | `failed`
  - `modelCount`
  - `modelsPreview` (first N names)
  - `errorCode` (e.g. `timeout`, `unauthorized`, `empty_models`, `unknown`)
  - `errorMessage` (human-readable)
- On failure: write `runtimeHealth = unhealthy` with a reason derived from `errorCode`.
- `/api/models/check/:accountId` should return the above outcome.
- UI toast reads outcome and displays:
  - Success: `已获取到模型：A、B、C（共 N 个）`
  - Failure: `模型获取失败（请求超时）` / `模型获取失败，API Key 已无效` / `模型获取失败：<message>`

# Data Flow
1. User clicks "模型".
2. UI calls `/api/models/check/:accountId`.
3. Server refreshes models and returns structured outcome.
4. UI shows toast based on outcome and reloads list.

# Error Classification
- `timeout`: error message contains `timeout` / `timed out` / `请求超时`.
- `unauthorized`: HTTP 401/403 or message contains `invalid`, `unauthorized`, `无权`, `未提供令牌`.
- `empty_models`: request succeeded but model list empty.
- `unknown`: fallback for other errors.

# Testing
- Unit tests for `refreshModelsForAccount`:
  - Failure updates runtime health to `unhealthy`.
  - Failure classification maps to the right `errorCode`.
  - Success returns `modelsPreview` and `modelCount`.
- UI behavior: verify toast text for success vs. each failure category.
