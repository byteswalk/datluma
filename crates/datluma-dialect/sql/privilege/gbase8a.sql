-- GBase 8a：账号在 gbase.user（没有 account_locked、password_expired 列，User、Host 补空格到定长）；
-- 没有角色；授权只取 information_schema（存储过程的授权不列出）。

-- [principals]
SELECT CONCAT('''', TRIM(u.User), '''@''', TRIM(u.Host), '''') AS id,
       TRIM(u.User) AS name,
       TRIM(u.Host) AS host,
       'user' AS principal_kind,
       'server' AS principal_level,
       1 AS can_login,
       NULL AS locked,
       NULL AS expires_at,
       0 AS builtin,
       u.plugin AS attr_plugin
FROM gbase.user u
ORDER BY u.User, u.Host

-- [grants_of]
SELECT p.GRANTEE AS grantee, 'global' AS grant_scope, NULL AS db_name, NULL AS schema_name, NULL AS object_kind,
       NULL AS object_name, NULL AS column_name, p.PRIVILEGE_TYPE AS privilege, 'grant' AS effect,
       p.IS_GRANTABLE AS grantable, NULL AS grantor
FROM information_schema.USER_PRIVILEGES p
WHERE p.GRANTEE = {{ bind("name") }} AND p.PRIVILEGE_TYPE <> 'USAGE'
UNION ALL
SELECT p.GRANTEE, 'schema', NULL, p.TABLE_SCHEMA, NULL, NULL, NULL, p.PRIVILEGE_TYPE, 'grant', p.IS_GRANTABLE, NULL
FROM information_schema.SCHEMA_PRIVILEGES p
WHERE p.GRANTEE = {{ bind("name") }}
UNION ALL
SELECT p.GRANTEE, 'object', NULL, p.TABLE_SCHEMA, 'table', p.TABLE_NAME, NULL, p.PRIVILEGE_TYPE, 'grant', p.IS_GRANTABLE, NULL
FROM information_schema.TABLE_PRIVILEGES p
WHERE p.GRANTEE = {{ bind("name") }}
UNION ALL
SELECT p.GRANTEE, 'column', NULL, p.TABLE_SCHEMA, 'table', p.TABLE_NAME, p.COLUMN_NAME, p.PRIVILEGE_TYPE, 'grant', p.IS_GRANTABLE, NULL
FROM information_schema.COLUMN_PRIVILEGES p
WHERE p.GRANTEE = {{ bind("name") }}

