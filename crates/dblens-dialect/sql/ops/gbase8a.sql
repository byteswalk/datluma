-- GBase 8a MPP overrides. There is no sys schema or statement digest; locks are table-level
-- (information_schema.TABLE_LOCKS) and slow statements come from the audit log, which is empty
-- until the audit_log variable is switched on. Sessions lists several holders, so there is no single KILL target.

-- [locks]
-- name.zh-CN: 表锁
-- name.en: Table Locks
-- category: lock
SELECT l.DB AS db, l.TableName AS locked_table,
       l.RDLCKs AS read_locks, l.WRLCKs AS write_locks, l.ExLCK AS exclusive_locks,
       l.Sessions AS sessions, NULL AS kill_sql
FROM information_schema.TABLE_LOCKS l
ORDER BY l.ExLCK DESC, l.WRLCKs DESC, l.DB, l.TableName

-- [slow_sql]
-- name.zh-CN: 慢 SQL（审计日志）
-- name.en: Slow SQL (Audit Log)
-- category: sql
SELECT a.db AS db, LEFT(a.sql_text, 300) AS sql_text, a.query_time AS query_time,
       a.`rows` AS rows_returned, a.`user` AS user_name, a.host_ip AS host, a.start_time AS last_seen
FROM gbase.audit_log a
ORDER BY a.query_time DESC
LIMIT 20
