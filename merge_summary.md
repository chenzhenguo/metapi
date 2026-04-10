此次合并主要涉及文档的更新，包括删除致谢部分、修改 API 接口返回格式以及新增超时配置最佳实践。这些变更旨在优化文档结构，提供更清晰的配置指南，并改进 API 响应格式。
| 文件 | 变更 |
|------|---------|
| README.md | 删除了"致谢"部分，移除了贡献者列表 |
| README_EN.md | 删除了"Thanks"部分，移除了贡献者列表 |
| docs/configuration.md | 添加了"超时配置最佳实践"章节，包括数据库连接、网关服务、服务器级和 Docker 级的超时设置，以及不同环境的配置指南 |
| docs/management-api.md | 修改了 GET /api/accounts 接口的返回格式，从包含 generatedAt、accounts 和 sites 的对象改为直接返回 accounts 数组 |
| docs/operations.md | 增强了 proxy timeout 错误的描述，添加了 first byte timeout 和 probe timeout 错误的描述及解决建议，在健康检查部分添加了监控超时相关指标的建议 |