# 产品、兼容模式和验证状态

一张表看清每个数据库产品有哪些模式、怎么连、测到什么程度。细节见各行链接的笔记。

## 规则

- **新建连接时选的是产品，只决定怎么连**（协议或驱动、默认端口）。每个产品只有一个入口。
- **兼容模式连上后自动识别**，用户不用选。识别结果在“测试连接”里显示，并记在连接配置上（`variant`）。
- 覆盖分三层：协议（MySQL、PG、Oracle、达梦、SQL Server、Informix、SQLite）→ 各协议的原生系统表和方言 → 兼容模式和分支产品。
  第三层不追全，保证能连、能浏览、能执行 SQL、出错有提示；有真实用户反馈再修。

## 总表

| 产品 | 模式 | 怎么连 | 验证状态 | 笔记 |
|---|---|---|---|---|
| MySQL | — | 原生 MySQL 协议 | 5.7、8.0、9.7 全量 | [mysql-versions](mysql-versions.md) |
| MariaDB | — | 原生 MySQL 协议 | 12.3：完整流程、表设计器 | [m0-3b-metadata](m0-3b-metadata.md) |
| TiDB | — | 原生 MySQL 协议 | v8.5 全量 | [domestic-batch1](domestic-batch1.md) |
| OceanBase | MySQL 模式租户 | 原生 MySQL 协议 | 社区版 4.4.2.1 全量；企业版 4.4.2.2 的 sys 租户测试连接 | [domestic-batch1](domestic-batch1.md) |
| OceanBase | Oracle 模式租户 | 先按 MySQL 连，被拒（1235）后自动改走官方 JDBC，按 Oracle 方式处理 | 企业版 4.4.2.2：服务层 10 个流程、权限、迁移 | [oceanbase-oracle](oceanbase-oracle.md) |
| GoldenDB | MySQL 模式租户 | 官方 JDBC | V6.1.03.12SP5：11 个流程和双向迁移（触发器除外） | [goldendb](goldendb.md) |
| GoldenDB | Oracle 模式租户 | 官方 JDBC，`sql_mode` 含 `ORA_COMPATIBLE_MODE` 时按 Oracle 兼容处理 | 同上版本，11 个流程 | [goldendb](goldendb.md) |
| PostgreSQL | — | 原生 PG 协议 | 12、14、18 全量 | [postgres-versions](postgres-versions.md) |
| 人大金仓 KingbaseES | Oracle 模式 | 原生 PG 协议，探测后按 Oracle 兼容处理 | V8R6、V9R1、V9R2 全量 | [kingbase-versions](kingbase-versions.md) |
| 人大金仓 KingbaseES | PG 模式 | 原生 PG 协议 | V8R6、V9R1、V9R2 全量 | [kingbase-versions](kingbase-versions.md) |
| 人大金仓 KingbaseES | MySQL 模式 | 原生 PG 协议，按 PG 规则处理 | V9R1 | [kingbase-versions](kingbase-versions.md) |
| 人大金仓 KingbaseES | SQL Server 模式 | 原生 PG 协议，`Compat::SqlServer` | V9R1 | [kingbase-versions](kingbase-versions.md) |
| openGauss | A 模式（Oracle 兼容） | 原生 PG 协议，按库探测 | 5.0、6.0.6、7.0.0 全量 | [opengauss-lts](opengauss-lts.md) |
| openGauss | PG 模式 | 原生 PG 协议 | 5.0、6.0.6、7.0.0 全量 | [opengauss-lts](opengauss-lts.md) |
| openGauss | B 模式（MySQL 兼容） | 原生 PG 协议 | 未适配，连接时提示 | |
| GaussDB | A 模式、PG 模式 | 原生 PG 协议 | 开发者版全量；云版未测 | [gaussdb](gaussdb.md) |
| Oracle | — | Instant Client 或 JDBC | 11.2、19c、23ai 全量；JDBC 连 11.2 也通过 | |
| 达梦 DM8 | 兼容模式 0、2、3、4、7 | 内置 JDBC | 各模式全量；1、5、6、8 现场少见，没测 | [dameng-compat](dameng-compat.md) |
| SQL Server | — | 原生 TDS | 2022、2025 Express；2017 未实测 | [m6a-sqlserver](m6a-sqlserver.md) |
| GBase 8s | — | JDBC（gbasedbtjdbc，自备） | 除修改账号外的全部功能 | [m8a-gbase8s](m8a-gbase8s.md) |
| SQLite | — | 内置 | 全量（桌面版和本机运行的浏览器版） | [m10a-sqlite](m10a-sqlite.md) |

“全量”指工作区的驱动一致性、元数据、数据编辑、导入导出、表设计、迁移等测试。版本号以各笔记为准，这里只列主线。
