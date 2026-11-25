-- GBase 8a MPP overrides. The dialect version is fixed at 5.1 (see Dialect::detect), so the base template
-- already skips GENERATION_EXPRESSION, PARAMETERS, CHECK_CONSTRAINTS and KEYWORDS.
-- gbase, gclusterdb and gctmpdb are the cluster's own databases.

-- [schemas]
SELECT s.SCHEMA_NAME AS name,
       CASE WHEN LOWER(s.SCHEMA_NAME) IN ('information_schema', 'performance_schema', 'gbase', 'gclusterdb', 'gctmpdb') THEN 1 ELSE 0 END AS is_system
FROM information_schema.SCHEMATA s
ORDER BY s.SCHEMA_NAME

-- [routines]
-- Names come back blank-padded to 64 characters (the default sql_mode has PAD_CHAR_TO_FULL_LENGTH).
SELECT TRIM(r.ROUTINE_NAME) AS name, r.ROUTINE_TYPE AS kind, NULLIF(TRIM(r.ROUTINE_COMMENT), '') AS comment
FROM information_schema.ROUTINES r
WHERE r.ROUTINE_SCHEMA = {{ bind("schema") }}
  AND r.ROUTINE_TYPE IN ('PROCEDURE', 'FUNCTION')
{% if filter %}
  AND (UPPER(r.ROUTINE_NAME) LIKE UPPER({{ bind("filter") }}) ESCAPE '!'
       OR UPPER(COALESCE(r.ROUTINE_COMMENT, '')) LIKE UPPER({{ bind("filter") }}) ESCAPE '!')
{% endif %}
ORDER BY r.ROUTINE_NAME, r.ROUTINE_TYPE

-- [routine_source]
-- No PARAMETERS table, so the definition comes from SHOW CREATE (Dialect::adapt_rows keeps its Create … column).
{% if kind_word %}
SHOW CREATE {{ kind_word }} {{ schema_ident }}.{{ name_ident }}
{% else %}
SELECT 1 AS line, NULL AS text FROM DUAL WHERE 1 = 0
{% endif %}

-- [keys]
-- The base query LEFT JOINs REFERENTIAL_CONSTRAINTS; on 8a that join drops the KEY_COLUMN_USAGE join conditions and
-- every system table's primary key columns come back for each key. EXPRESS tables have no foreign keys anyway.
SELECT tc.TABLE_NAME AS table_name,
       tc.CONSTRAINT_NAME AS constraint_name,
       CASE tc.CONSTRAINT_TYPE WHEN 'PRIMARY KEY' THEN 'P' ELSE 'U' END AS constraint_type,
       k.COLUMN_NAME AS column_name,
       k.ORDINAL_POSITION AS position,
       NULL AS ref_schema,
       NULL AS ref_table,
       NULL AS ref_column,
       NULL AS on_delete,
       NULL AS on_update
FROM information_schema.TABLE_CONSTRAINTS tc
JOIN information_schema.KEY_COLUMN_USAGE k
  ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
 AND k.TABLE_NAME = tc.TABLE_NAME
 AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
WHERE tc.TABLE_SCHEMA = {{ bind("schema") }}
  AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE')
{% if table %}
  AND tc.TABLE_NAME = {{ bind("table") }}
{% endif %}
ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, k.ORDINAL_POSITION

-- [indexes]
-- Every 8a index is a GLOBAL HASH index (the only kind), reported as no method like other databases' defaults.
SELECT s.TABLE_NAME AS table_name,
       s.INDEX_NAME AS index_name,
       CASE WHEN s.NON_UNIQUE = 0 THEN 1 ELSE 0 END AS is_unique,
       CASE WHEN s.INDEX_TYPE LIKE '%HASH' THEN NULL ELSE s.INDEX_TYPE END AS method,
       s.COLUMN_NAME AS column_expr,
       s.SEQ_IN_INDEX AS position,
       0 AS descending
FROM information_schema.STATISTICS s
WHERE s.TABLE_SCHEMA = {{ bind("schema") }}
  AND s.NON_UNIQUE = 1
{% if table %}
  AND s.TABLE_NAME = {{ bind("table") }}
{% endif %}
ORDER BY s.TABLE_NAME, s.INDEX_NAME, s.SEQ_IN_INDEX

-- [table_storage]
-- information_schema.TABLES.TABLE_ROWS is always 0 on 8a; performance_schema.TABLES has the real count but only
-- answers a query naming exactly one schema and table.
SELECT t.ENGINE AS engine,
       (SELECT MAX(c.CHARACTER_SET_NAME) FROM information_schema.COLLATION_CHARACTER_SET_APPLICABILITY c
         WHERE c.COLLATION_NAME = t.TABLE_COLLATION) AS charset,
       t.TABLE_COLLATION AS collation,
       NULL AS tablespace,
       (SELECT p.TABLE_ROWS FROM performance_schema.TABLES p
         WHERE p.TABLE_SCHEMA = {{ bind("schema") }} AND p.TABLE_NAME = {{ bind("table") }}) AS row_count
FROM information_schema.TABLES t
WHERE t.TABLE_SCHEMA = {{ bind("schema") }}
  AND t.TABLE_NAME = {{ bind("table") }}
