# GBase 8a、GBase 8c 实测

2026-11-23。安装包是用户从南大通用官网下载的，放在 `drivers/gbase/`（不进仓库）：

- `GBase8cV6_S1.3.0B19_Unified_centos7.8_x86_64.tar.gz`
- `GBase8a_MPP_Cluster-NoLicense-FREE-9.5.3.28.12-redhat8-x86_64.tar.bz2`
- `GBase-JDBC-x86_64.zip`（8c 的 JDBC，`gbase8c-jdbc-3.0.0B02.jar`，现在用不到）
- `gbase-connector-java-9.5.0.10-build1.zip`（8a 的 JDBC，现在用不到）

两个库都装在 106 的容器里，测试连接串在 `~/.datluma-test/test-env.ps1`：`DATLUMA_TEST_GBASE8C_URL`（PG 模式库）、`DATLUMA_TEST_GBASE8C_A_URL`（A 模式库）、`DATLUMA_TEST_GBASE8A_URL`。

## GBase 8c

内核是 openGauss 6.0.2（`select opengauss_version()`），`server_version` 报 9.2.4，`version()` 是 `(GBase8cV6 S1.3.0B19 build 8a2447f6) …`，没有 openGauss 字样。

### 安装

容器 `gbase8c`：`centos:7` 镜像（华为云 swr 镜像站），端口 5440→5432。

1. 宿主机和容器都没有 bzip2，安装包里的 `.tar.bz2` 用 python3 `tarfile` 解开，程序放 `/opt/gbase8c`。
2. 缺 `libaio.so.1`（从 `ora11204` 容器拷）和 `libedit.so.0`（CentOS 7 vault 的 `libedit-3.0-12.20121213cvs.el7` rpm 解出）。
3. 以 OS 用户 `gbase` 初始化数据目录 `/home/gbase/data`；`pg_hba.conf` 加 `host all all 0.0.0.0/0 sha256`。
4. 启动：容器里放了 `/home/gbase/start.sh`（设好 `GAUSSHOME`、`PATH`、`LD_LIBRARY_PATH` 后执行 `gs_ctl start -D /home/gbase/data -l /home/gbase/gbased.log`）。容器重启后不会自动启动，要以 gbase 用户执行它。
5. 建库 `datluma_test`（A 模式）、`datluma_test_pg`（PG 模式），用户 `datluma` 给 SYSADMIN 和 MONADMIN（运维页的慢 SQL 要读 `dbe_perf`）。

### 改动

- `Variant::detect`：版本串含 `gbase8c` 时识别为 openGauss。
- 保留字：8c 把 `UNPIVOT`（以及 `PIVOT`）当保留字，openGauss 6.0.6 不是，加进 `RESERVED`。
- `meta_live` 的 openGauss 夹具：8c 建不了枚举数组列（报 no collation was derived），8c 上去掉这一列。

### 官方 JDBC

`gbase8c-jdbc-3.0.0B02.jar`，驱动类 `com.gbase8c.Driver`，URL `jdbc:gbase8c://主机:5440/库`。A 模式、PG 模式的库都能连（sha256 认证），`getDatabaseProductName()` 返回 `GBase8c`、版本 9.2.4。驱动默认按 INFO 级别打印每次连接的日志。DATLUMA 用内置的 PG 协议驱动已经全部通过，不需要它。

### 结果

按 openGauss 的测试集跑：驱动一致性 31/31（要串行跑），元数据 2/2，服务层 22/22，权限 2/2，API 2/2，迁移的 openGauss 路线到 PG、到达梦实跑通过（到 MySQL、Oracle 当时没设连接串，没实跑）。

## GBase 8a

FREE 版 9.5.3.28.12，单节点集群（gcware、coordinator、data 各一个，都在同一个容器）。

### 安装

容器 `gbase8a`：`rockylinux:8`，`--privileged`，端口 5258。安装包只读挂在 `/pkg`。

1. 装依赖：python2（`python` 链到 python2）、openssh-server、bc、net-tools、psmisc、tar、gcc-c++、libnsl、numactl-libs；启动 sshd，root 和 `gbase` 用户能用密码 SSH 到本机；每次 SSH 前删掉 `/run/nologin`。
2. 安装程序只认 CentOS：把容器的 `/etc/system-release` 写成 `CentOS Linux release 8.5.2111`。
3. 内核参数检查在容器里过不了：`InstallFuns.py` 的 `CheckRootEnv` 改成直接返回 `(True, [])`（原文件备份为 `InstallFuns.py.orig`）。
4. **不要在容器里跑 `SetSysEnv.py`。** 它改的是内核全局参数，privileged 容器里会直接改到 106 宿主机。这次已经改过一次，事后按 Ubuntu 默认值改回：`vm.swappiness=60`、`vm.vfs_cache_pressure=100`、`vm.min_free_kbytes=67584`、`vm.max_map_count=1048576`。
5. `gcinstall.py --silent=/opt/pkg/gcinstall/single.options`，安装到 `/opt/gbase`，dba 用户 `gbase`。
6. 以 `gbase` 用户建分布：`gcChangeInfo.xml` 只列本节点，`echo y | gcadmin distribution gcChangeInfo.xml p 1 d 0`（会问“没有副本是否继续”，不喂 `y` 会一直等）；然后 `gccli -uroot` 执行 `initnodedatamap;`。
7. 建用户 `datluma`（`GRANT ALL ON *.* … WITH GRANT OPTION`）和库 `datluma_test`。
8. 重启：容器重启后服务不会自动起来，IP 也可能变（集群按 172.17.0.4 安装）。以 root 执行容器里的 `/root/start8a.sh`：没有 172.17.0.4 时给 eth0 加这个别名，删掉 `/run/nologin`，起 sshd，再以 gbase 用户 `gcware_services all start`、`gcluster_services all start`。

### 连接

MySQL 协议能连。mysql_async（DATLUMA 的 MySQL 驱动）和 MySQL 5.7 客户端都能登录；MySQL 8.0 客户端握手失败（默认认证插件不同），DATLUMA 不受影响。

官方 JDBC（`gbase-connector-java-9.5.0.10`，`com.gbase.jdbc.Driver`，`jdbc:gbase://主机:5258/库`）也能连，预处理语句、`getColumns` 正常，`getDatabaseProductName()` 返回 `GBase`。下面列的不兼容（缺列、建不了唯一索引、没有 InnoDB、不支持 `DATETIME(6)`）走 JDBC 报的是同样的服务器错误，换驱动不解决。

`VERSION()` 只返回 `9.5.3.28.12509af275af`，没有产品名；产品名在 `@@version_comment`（`GBase Enterprise Server - Advanced Edition (Commercial)`）。

2026-11-23 用户定：走内置 MySQL 协议，不走 JDBC。

### 和 MySQL 的差别（影响 DATLUMA 的部分）

- `information_schema.COLUMNS` 没有 `GENERATION_EXPRESSION`、`DATETIME_PRECISION`，多一列 `TABLE_VC`（虚拟集群）。
- 没有 `CHECK_CONSTRAINTS`、`KEYWORDS`、`PARAMETERS` 表。存储过程的参数只能从 `SHOW CREATE PROCEDURE` 读到（`gbase.proc.param_list` 是 blob，查询报“不支持的数据类型”）。
- 默认 `sql_mode` 带 `PAD_CHAR_TO_FULL_LENGTH`：`ROUTINES.ROUTINE_NAME` 读出来补空格到 64 个字符。
- 不支持回滚：`autocommit=0`、`BEGIN` 都不报错，但 `ROLLBACK` 之后数据还在。
- 建不了 `UNIQUE` 约束和普通索引（报 `GBA-02DD-0013 Unsupported index type`）；主键、自增列可以。
- 建表有 `DISTRIBUTED BY('列')`（哈希分布）和 `REPLICATED`（复制表），存储引擎是 `EXPRESS`，没有 InnoDB、MyISAM。
- `sql_mode` 默认带 `ANSI_QUOTES`、`PIPES_AS_CONCAT`：双引号是标识符，`||` 是拼接。反引号照样能用；`SHOW CREATE TABLE` 输出的是双引号。
- 不支持 `DATETIME(6)`、JSON 类型；部分派生表写法报 `GBA-02SC-1001`（集群层不支持）。
- 没有 `sys` 库和语句摘要表。锁在 `information_schema.TABLE_LOCKS`（表级）；慢语句在 `gbase.audit_log`，要打开 `audit_log` 变量才有记录。

### 适配

先按第三层（能连、能浏览、能执行 SQL、出错有提示）做，2026-11-24 用户要求“方方面面都测好”后，把依赖回滚、主键唯一的功能也一并处理了。

识别和数据字典：

- 识别：MySQL 驱动连上后读 `@@version_comment`，以 `GBase` 开头时把版本串写成 `GBase 8a 9.5.3…`（同 GoldenDB 的 JDBC 在版本号前补产品名），识别为 `Variant::Gbase8a`，家族仍是 MySQL。
- 版本：方言版本固定按 MySQL 5.1（50100）处理。MySQL 模板加了版本分支：`GENERATION_EXPRESSION` 要 5.7.6，`PARAMETERS` 要 5.5。真 MySQL 5.7 以上不受影响。
- 覆盖模板 `sql/gbase8a.sql`：
  - 系统库（gbase、gclusterdb、gctmpdb）。
  - 约束查询去掉 `LEFT JOIN REFERENTIAL_CONSTRAINTS`：8a 上有这个连接时 `KEY_COLUMN_USAGE` 的连接条件失效，所有系统表的主键列都会带出来（表数据因此变成只读）。
  - 索引的方法读成空（8a 只有 GLOBAL HASH，相当于默认方法），比对时不会把同一个索引当成改过。
  - 存储过程名 `TRIM`（默认 sql_mode 带 `PAD_CHAR_TO_FULL_LENGTH`），源码用 `SHOW CREATE {{ kind_word }} 库.名`。为此模板上下文加了 `name_ident`、`kind_word`。
  - 表的行数读 `performance_schema.TABLES`（`information_schema` 的 `TABLE_ROWS` 总是 0，而 `performance_schema` 只回答指定了单个库和表的查询）。
- 运维 `sql/ops/gbase8a.sql`：表锁读 `TABLE_LOCKS`；慢 SQL 读审计日志（`audit_log` 打开后才有记录）。
- 账号权限 `sql/privilege/gbase8a.sql`：账号读 `gbase.user`；没有角色。

回滚不生效、主键不检查唯一：

- 手动提交：会话切到手动提交时报错（`session.no_rollback`）。执行 SQL 文件选“一个事务”同样拒绝。
- 数据编辑：不开事务。写之前逐条用 `COUNT(*)` 确认修改、删除只命中一行，有一条不对就一行都不写；中途出错时如实报已生效的条数。
- 导入：按主键更新、整体一个事务、清空后导入，提交时就拒绝（按主键更新会插入重复行；后两种失败时无法恢复）。
- 自增列不接受显式值：导入、编辑里写自增列报服务器原文。

建表和结构变更：

- 表设计器：类型列表去掉 8a 没有的类型（JSON、ENUM、SET、无符号、小数秒、空间类型）；唯一约束、外键、检查约束、生成列、多列或唯一索引在预览时报出原因；索引单独用 `CREATE INDEX` 建。修改列只支持加长 VARCHAR 和改注释，其他改动报服务器原文，不走重建。
- 结构同步、模型同步：外键、唯一约束、检查约束、多列或唯一索引跳过，每项一条说明。
- 迁移到 8a：自增列改成普通列（迁来的主键值写不进自增列），唯一约束和外键跳过并说明，时间类型去掉小数秒。

其他：

- 规范检查：EXPRESS 引擎默认允许；行数规则读不到整个 schema 的行数，在 8a 上不起作用。
- 新建连接：GBase 一个入口，表单里选型号 8s / 8a / 8c。

### 测试

服务层 `gbase8a_*`（`DATLUMA_TEST_GBASE8A_URL`）12 个全部通过：完整流程、工作台、取消、SQL 文件、运维、浏览、表设计、数据编辑、导出、导入、规范检查、模型（反向、同步、写回、ER 图、数据字典、库对库）。权限、API 各 1 个通过。迁移 8 条路线通过：8a 和 MySQL、PostgreSQL、达梦、Oracle 23ai 互迁，数据校验一致、读回结构一致。
