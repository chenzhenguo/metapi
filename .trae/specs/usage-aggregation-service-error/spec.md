# Usage Aggregation Service Error - Product Requirement Document

## Overview
- **Summary**: Fix the `TypeError: db.insert(...).values(...).onConflictDoNothing is not a function` error in the usageAggregationService.js file.
- **Purpose**: Resolve the database operation error that occurs when the usage aggregation service tries to use the `onConflictDoNothing` method which is not available in the current Drizzle ORM setup.
- **Target Users**: Developers and maintainers of the metapi project.

## Goals
- Fix the TypeError by replacing the unavailable `onConflictDoNothing` method with a compatible alternative.
- Ensure the usage aggregation service can properly insert records without conflicts.
- Maintain compatibility with all supported database dialects (SQLite, MySQL, PostgreSQL).

## Non-Goals (Out of Scope)
- Adding new features to the usage aggregation service.
- Changing the overall architecture of the database layer.
- Modifying other parts of the codebase unrelated to this error.

## Background & Context
- The error occurs in the `ensureProjectionCheckpointExists` function of the usageAggregationService.js file.
- The service is trying to use the `onConflictDoNothing` method which is not available in the current Drizzle ORM setup.
- The project uses Drizzle ORM v0.45.2 with sqlite-proxy, mysql-proxy, and pg-proxy adapters.
- The error is preventing the server from starting properly.
- The usageAggregationService.js file doesn't exist in the repository but is present in the deployed environment.

## Functional Requirements
- **FR-1**: Fix the `ensureProjectionCheckpointExists` function to use a compatible method instead of `onConflictDoNothing`.
- **FR-2**: Ensure the fix works across all supported database dialects (SQLite, MySQL, PostgreSQL).
- **FR-3**: Verify that the usage aggregation service can properly insert records without conflicts.

## Non-Functional Requirements
- **NFR-1**: The fix should be minimal and focused on the specific error.
- **NFR-2**: The fix should not introduce any new errors or performance issues.
- **NFR-3**: The fix should follow the existing code style and patterns.

## Constraints
- **Technical**: Must work with Drizzle ORM v0.45.2 and the existing proxy adapters.
- **Business**: The fix should be implemented quickly to resolve the deployment issue.
- **Dependencies**: No new dependencies should be added.

## Assumptions
- The usageAggregationService.js file exists in the deployed environment and contains the `ensureProjectionCheckpointExists` function.
- The function is trying to insert a record with a unique constraint and wants to ignore conflicts.
- The Drizzle ORM proxy adapters do not support the `onConflictDoNothing` method.

## Acceptance Criteria

### AC-1: Fix the TypeError
- **Given**: The server is started
- **When**: The usage aggregation service tries to insert a record with a conflict
- **Then**: The server starts successfully without throwing the TypeError
- **Verification**: `programmatic`

### AC-2: Ensure cross-database compatibility
- **Given**: The fix is implemented
- **When**: The server is run with different database dialects (SQLite, MySQL, PostgreSQL)
- **Then**: The usage aggregation service works correctly in all cases
- **Verification**: `programmatic`

### AC-3: Maintain existing functionality
- **Given**: The fix is implemented
- **When**: The usage aggregation service runs
- **Then**: It continues to perform its intended functionality
- **Verification**: `human-judgment`

## Open Questions
- [ ] Where is the usageAggregationService.js file generated or coming from?
- [ ] What is the exact schema of the table being inserted into?
- [ ] What unique constraint is causing the conflict?
- [ ] What is the exact implementation of the `ensureProjectionCheckpointExists` function?