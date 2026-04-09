# 批量测活功能优化 - 实现计划

## [x] Task 1: 提示词优化实现
- **Priority**: P0
- **Depends On**: None
- **Description**: 
  - 创建多样化的提示词库
  - 实现提示词选择逻辑，确保同一站点内提示词不重复
  - 修改 `buildProbeBody` 函数使用随机提示词
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `programmatic` TR-1.1: 验证提示词库包含多个不同的提示词
  - `programmatic` TR-1.2: 验证同一站点内使用不同的提示词
  - `human-judgment` TR-1.3: 验证提示词自然合理
- **Notes**: 提示词应简洁、自然，避免触发安全检查

## [x] Task 2: 站点级并发控制实现
- **Priority**: P0
- **Depends On**: None
- **Description**: 
  - 创建站点级 Lease 机制
  - 修改 `executeModelAvailabilityProbe` 函数，按站点分组处理账号
  - 实现站点级并发控制，确保同一站点的账号串行处理
  - 实现 5 分钟内不超过 5 个测活的频率限制
- **Acceptance Criteria Addressed**: AC-2, AC-3, AC-5
- **Test Requirements**:
  - `programmatic` TR-2.1: 验证同一站点的账号串行处理
  - `programmatic` TR-2.2: 验证不同站点的账号并行处理
  - `programmatic` TR-2.3: 验证站点级 Lease 机制正常工作
  - `programmatic` TR-2.4: 验证 5 分钟内不超过 5 个测活
- **Notes**: 需要保持与现有账号级 Lease 机制的兼容性

## [x] Task 3: 速率限制和频率限制实现
- **Priority**: P0
- **Depends On**: Task 2
- **Description**: 
  - 实现 TPM=1 的速率限制
  - 实现 5 分钟内不超过 5 个测活的频率限制
  - 创建站点级测活记录和计时器
- **Acceptance Criteria Addressed**: AC-3, AC-5
- **Test Requirements**:
  - `programmatic` TR-3.1: 验证速率限制为 TPM=1
  - `programmatic` TR-3.2: 验证 5 分钟内不超过 5 个测活
  - `programmatic` TR-3.3: 验证限制机制正常工作
- **Notes**: 需要考虑系统重启后的状态恢复

## [x] Task 4: 环境变量配置支持
- **Priority**: P1
- **Depends On**: None
- **Description**: 
  - 在 `config.ts` 中添加相关配置参数
  - 支持提示词自定义
  - 支持速率限制和频率限制参数配置
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `programmatic` TR-4.1: 验证环境变量配置生效
  - `programmatic` TR-4.2: 验证默认值正常工作
  - `programmatic` TR-4.3: 验证配置参数类型正确
- **Notes**: 需要确保配置参数的类型安全和默认值合理

## [x] Task 5: 测试和验证
- **Priority**: P1
- **Depends On**: Task 1, Task 2, Task 3, Task 4
- **Description**: 
  - 编写单元测试
  - 进行集成测试
  - 验证所有功能正常工作
- **Acceptance Criteria Addressed**: All
- **Test Requirements**:
  - `programmatic` TR-5.1: 所有单元测试通过
  - `programmatic` TR-5.2: 集成测试通过
  - `human-judgment` TR-5.3: 功能验证通过
- **Notes**: 需要覆盖各种边界情况和异常场景