# 代码回退到上游项目 - Product Requirement Document

## Overview
- **Summary**: 将当前 metapi 项目的代码回退到与 cita-777/metapi 原项目完全一致的状态，保留文档文件不变。
- **Purpose**: 恢复项目到原始上游仓库的代码状态，消除当前仓库与上游之间的代码差异。
- **Target Users**: 项目维护者、开发者

## Goals
- 将代码库恢复到与 cita-777/metapi main 分支一致的状态
- 保留文档文件（README、文档目录等）不变
- 确保 git 历史正确反映回退操作

## Non-Goals (Out of Scope)
- 修改文档内容
- 添加新功能
- 修复现有 bug（除非回退操作本身解决了问题）

## Background & Context
- 当前仓库是 chenzhenguo/metapi，需要回退到 cita-777/metapi 的原始状态
- 已成功添加 upstream 远程仓库并获取了其代码
- 上游仓库 main 分支的最新提交是 c6a28c71c430668fe0ca2d555436562e576c1b53

## Functional Requirements
- **FR-1**: 恢复代码文件到 upstream/main 的状态
- **FR-2**: 保留文档文件不被修改
- **FR-3**: 确保 git 工作树干净且状态正确

## Non-Functional Requirements
- **NFR-1**: 操作应在可接受的时间内完成
- **NFR-2**: 操作应可验证和可追溯

## Constraints
- **Technical**: 使用 git 命令进行回退操作
- **Business**: 保留现有文档
- **Dependencies**: 需要访问 cita-777/metapi 上游仓库

## Assumptions
- 当前工作树是干净的
- 不需要保留当前仓库特有的代码变更
- 文档文件包括但不限于 README.md、docs/ 目录、.md 文件等

## Acceptance Criteria

### AC-1: 代码文件与上游一致
- **Given**: 当前仓库已添加 upstream 远程
- **When**: 执行代码回退操作
- **Then**: 所有代码文件（除文档外）应与 upstream/main 完全一致
- **Verification**: `programmatic`
- **Notes**: 使用 git diff 验证

### AC-2: 文档文件保留不变
- **Given**: 执行代码回退操作前
- **When**: 执行代码回退操作
- **Then**: 所有文档文件应保持不变
- **Verification**: `programmatic`
- **Notes**: 检查 README.md、docs/ 目录等

### AC-3: git 状态正确
- **Given**: 执行代码回退操作后
- **When**: 检查 git 状态
- **Then**: 工作树应该是干净的，或者有明确的变更说明
- **Verification**: `programmatic`

## Open Questions
- 无
