# GBase 8a、GBase 8c 实测

2026-11-23。安装包是用户从南大通用官网下载的，放在 `drivers/gbase/`（不进仓库）：

- `GBase8cV6_S1.3.0B19_Unified_centos7.8_x86_64.tar.gz`
- `GBase8a_MPP_Cluster-NoLicense-FREE-9.5.3.28.12-redhat8-x86_64.tar.bz2`
- `GBase-JDBC-x86_64.zip`（8c 的 JDBC，`gbase8c-jdbc-3.0.0B02.jar`，现在用不到）
- `gbase-connector-java-9.5.0.10-build1.zip`（8a 的 JDBC，现在用不到）

两个库都装在 106 的容器里，测试连接串在 `~/.dblens-test/test-env.ps1`：`DBLENS_TEST_GBASE8C_URL`（PG 模式库）、`DBLENS_TEST_GBASE8C_A_URL`（A 模式库）、`DBLENS_TEST_GBASE8A_URL`。

## GBase 8c

内核是 openGauss 6.0.2（`select opengauss_version()`），`server_version` 报 9.2.4，`version()` 是 `(GBase8cV6 S1.3.0B19 build 8a2447f6) …`，没有 openGauss 字样。

### 安装

容器 `gbase8c`：`centos:7` 镜像（华为云 swr 镜像站），端口 5440→5432。

1. 宿主机和容器都没有 bzip2，安装包里的 `.tar.bz2` 用 python3 `tarfile` 解开，程序放 `/opt/gbase8c`。
2. 缺 `libaio.so.1`（从 `ora11204` 容器拷）和 `libedit.so.0`（CentOS 7 vault 的 `libedit-3.0-12.20121213cvs.el7` rpm 解出）。
3. 以 OS 用户 `gbase` 初始化数据目录 `/home/gbase/data`；`pg_hba.conf` 加 `host all all 0.0.0.0/0 sha256`。
4. 启动：`gs_ctl start -D /home/gbase/data -l /home/gbase/gbased.log`。容器重启后不会自动启动，要手动执行。
5. 建库 `dblens_test`（A 模式）、`dblens_test_pg`（PG 模式），用户 `dblens` 给 SYSADMIN 和 MONADMIN（运维页的慢 SQL 要读 `dbe_perf`）。

### 改动

- `Variant::detect`：版本串含 `gbase8c` 时识别为 openGauss。
- 保留字：8c 把 `UNPIVOT`（以及 `PIVOT`）当保留字，openGauss 6.0.6 不是，加进 `RESERVED`。
- `meta_live` 的 openGauss 夹具：8c 建不了枚举数组列（报 no collation was derived），8c 上去掉这一列。

### 官方 JDBC

`gbase8c-jdbc-3.0.0B02.jar`，驱动类 `com.gbase8c.Driver`，URL `jdbc:gbase8c://主机:5440/库`。A 模式、PG 模式的库都能连（sha256 认证），`getDatabaseProductName()` 返回 `GBase8c`、版本 9.2.4。驱动默认按 INFO 级别打印每次连接的日志。DBLENS 用内置的 PG 协议驱动已经全部通过，不需要它。

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
7. 建用户 `dblens`（`GRANT ALL ON *.* … WITH GRANT OPTION`）和库 `dblens_test`。

### 连接

MySQL 协议能连。mysql_async（DBLENS 的 MySQL 驱动）和 MySQL 5.7 客户端都能登录；MySQL 8.0 客户端握手失败（默认认证插件不同），DBLENS 不受影响。

官方 JDBC（`gbase-connector-java-9.5.0.10`，`com.gbase.jdbc.Driver`，`jdbc:gbase://主机:5258/库`）也能连，预处理语句、`getColumns` 正常，`getDatabaseProductName()` 返回 `GBase`。下面列的不兼容（缺列、建不了唯一索引、没有 InnoDB、不支持 `DATETIME(6)`）走 JDBC 报的是同样的服务器错误，换驱动不解决。

`VERSION()` 只返回 `9.5.3.28.12509af275af`，没有产品名；产品名在 `@@version_comment`（`GBase Enterprise Server - Advanced Edition (Commercial)`）。

2026-11-23 用户定：走内置 MySQL 协议，不走 JDBC。

### 和 MySQL 的差别（影响 DBLENS 的部分）

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

按覆盖规则的第三层做：能连、能浏览、能执行 SQL、出错有提示。

- 识别：MySQL 驱动连上后读 `@@version_comment`，以 `GBase` 开头时把版本串写成 `GBase 8a 9.5.3…`（同 GoldenDB 的 JDBC 在版本号前补产品名），识别为 `Variant::Gbase8a`，家族仍是 MySQL。
- 版本：方言版本固定按 MySQL 5.1（50100）处理。MySQL 模板加了版本分支：`GENERATION_EXPRESSION` 要 5.7.6，`PARAMETERS` 要 5.5；检查约束（8.0.16）、关键字表（8.0.13）原来就有分支。真 MySQL 5.7 以上不受影响。
- 覆盖模板 `sql/gbase8a.sql`：系统库（gbase、gclusterdb、gctmpdb）；存储过程列表 `TRIM` 名字；存储过程源码用 `SHOW CREATE {{ kind_word }} 库.名`，`Dialect::adapt_rows` 转成 line、text 两列。为此模板上下文加了 `name_ident`（按标识符引用的对象名）和 `kind_word`（只放行 FUNCTION、PROCEDURE）。
- 运维 `sql/ops/gbase8a.sql`：表锁读 `TABLE_LOCKS`（持锁会话可能有多个，没有 KILL 语句）；慢 SQL 读审计日志。
- 手动提交：8a 回滚不生效，会话切到手动提交时直接报错（`session.no_rollback`），不让用户以为能回滚。
- 新建连接：国产库分组加 GBase 8a，MySQL 驱动，默认端口 5258。

不做：表设计器、作为迁移目标、数据编辑里依赖事务的整批回滚、导入。

### 测试

服务层 `gbase8a_*`（`DBLENS_TEST_GBASE8A_URL`）：完整流程（回滚一段换成断言手动提交被拒绝）、工作台、取消、SQL 文件、运维、浏览（分布表、复制表、视图、存储过程源码、读回 DDL）共 6 个，全部通过。

通用的 MySQL 流程里，对象、编辑、设计器、导入、规范检查、模型的夹具用了 `UNIQUE`、InnoDB、MyISAM，8a 上跑不了；导出的夹具用了集群层不支持的派生表。这些没有为 8a 改。
