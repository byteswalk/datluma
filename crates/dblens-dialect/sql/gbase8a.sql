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
