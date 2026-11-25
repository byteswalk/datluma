-- 只在 MariaDB 上执行
-- @@ idx_on_generated
CREATE INDEX idx_emp_name_upper ON datluma_meta.emp (name_upper)
-- @@ seq_meta
CREATE SEQUENCE datluma_meta.seq_meta START WITH 100 INCREMENT BY 5 MINVALUE 1 MAXVALUE 99999 CYCLE CACHE 10
-- @@ seq_default
CREATE SEQUENCE datluma_meta.seq_plain
