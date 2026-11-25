//! 新建、删除库和模式，新建用户时的表空间和角色，表空间列表的实库测试。环境变量见 `live.rs`，没设置时直接通过。
//! 要串行运行（`--test-threads=1`）。用的对象都以 dblens_ns 开头，开始时先删一次，结束时删掉。

use std::path::Path;
use std::sync::Arc;

use dblens_dialect::NamespaceChange;
use dblens_dialect::privilege::{
    GrantScope, GrantTarget, PrincipalKind, PrincipalLevel, PrincipalRef, PrivChange, Secret, UserOptions,
};
use dblens_driver::{ConnectParams, DriverId};
use dblens_service::{
    DefaultPolicy, DriverRegistry, Environment, NamespaceRequest, ProfileInput, SecretBackend, Secrets,
    Service, Store,
};

const LIB_OPTIONS: [&str; 2] = ["oracle_client_lib_dir", "jdbc_dir"];
const PASSWORD: &str = "Dblens_Ns_9x!";

async fn setup(env: &str) -> Option<(tempfile::TempDir, Service, String, DriverId)> {
    let url = std::env::var(env).ok()?;
    let (driver, params) = ConnectParams::from_url(&url).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(dir.path()).unwrap());
    let secrets = Arc::new(Secrets::with_backend(store.clone(), SecretBackend::Vault));
    secrets.init_vault("测试主密码").unwrap();
    let registry = Arc::new(DriverRegistry::new(store.clone()));
    let via_jdbc = driver == DriverId::Dameng || params.options.get("client").is_some_and(|c| c == "jdbc");
    for option in LIB_OPTIONS.iter().filter(|_| !via_jdbc) {
        if let Some(lib) = params.options.get(*option) {
            registry.set_lib_dir(driver, Some(Path::new(lib))).unwrap();
        }
    }
    let service = Service::with_parts(store, secrets, registry, Arc::new(DefaultPolicy));
    let mut options = params.options.clone();
    options.retain(|k, _| via_jdbc || !LIB_OPTIONS.contains(&k.as_str()));
    let p = service
        .create_profile(
            ProfileInput {
                name: "ns".into(),
                driver,
                host: params.host.clone(),
                port: params.port,
                user: params.user.clone(),
                database: params.database.clone(),
                options,
                environment: Environment::Test,
                color: None,
                connect_timeout_secs: 10,
                product: None,
            },
            Some(&params.password),
        )
        .unwrap();
    Some((dir, service, p.id, driver))
}

fn req(catalog: Option<&str>, change: NamespaceChange) -> NamespaceRequest {
    NamespaceRequest { catalog: catalog.map(Into::into), change, confirm_name: None }
}

/// 执行，忽略"不存在"之类的错误（清理用）。
async fn quietly(service: &Service, id: &str, catalog: Option<&str>, change: NamespaceChange) {
    let _ = service.namespace_apply(id, &req(catalog, change)).await;
}

async fn names(service: &Service, id: &str, catalog: Option<&str>, schemas: bool) -> Vec<String> {
    let p = service.profile(id).unwrap().in_catalog(catalog);
    let list = if schemas {
        service.metadata.schemas(&p, None).await.unwrap()
    } else {
        service.metadata.catalogs(&p, None).await.unwrap()
    };
    list.into_iter().map(|s| s.name.to_lowercase()).collect()
}

/// 建库 → 预览删除（空库没有表）→ 删除；系统库不能删。
async fn database_round_trip(env: &str, service: &Service, id: &str, system: &str, catalogs: bool) {
    let name = "dblens_ns_db";
    quietly(service, id, None, NamespaceChange::DropDatabase { name: name.into() }).await;
    let create = NamespaceChange::CreateDatabase { name: name.into(), charset: None, collation: None };
    let preview = service.namespace_preview(id, &req(None, create.clone())).await.unwrap();
    assert_eq!(preview.statements.len(), 1, "{env}");
    service.namespace_apply(id, &req(None, create)).await.unwrap();
    assert!(names(service, id, None, !catalogs).await.contains(&name.to_string()), "{env}: 建库后看不到");

    let drop = NamespaceChange::DropDatabase { name: name.into() };
    let preview = service.namespace_preview(id, &req(None, drop.clone())).await.unwrap();
    assert!(preview.confirm_name.is_none(), "{env}: 测试环境不用输入名称");
    service.namespace_apply(id, &req(None, drop)).await.unwrap();
    assert!(!names(service, id, None, !catalogs).await.contains(&name.to_string()), "{env}: 删库后还在");

    let err = service
        .namespace_preview(id, &req(None, NamespaceChange::DropDatabase { name: system.into() }))
        .await;
    assert!(err.is_err(), "{env}: 系统库 {system} 不该能删");
}

/// 建模式 → 删除；系统模式不能删。
async fn schema_round_trip(
    env: &str,
    service: &Service,
    id: &str,
    catalog: Option<&str>,
    name: &str,
    owner: Option<&str>,
    system: &str,
) {
    quietly(service, id, catalog, NamespaceChange::DropSchema { name: name.into() }).await;
    let create = NamespaceChange::CreateSchema { name: name.into(), owner: owner.map(Into::into) };
    service.namespace_apply(id, &req(catalog, create)).await.unwrap();
    let lower = name.to_lowercase();
    assert!(names(service, id, catalog, true).await.contains(&lower), "{env}: 建模式后看不到");
    service
        .namespace_apply(id, &req(catalog, NamespaceChange::DropSchema { name: name.into() }))
        .await
        .unwrap();
    assert!(!names(service, id, catalog, true).await.contains(&lower), "{env}: 删模式后还在");
    let err = service
        .namespace_preview(id, &req(catalog, NamespaceChange::DropSchema { name: system.into() }))
        .await;
    assert!(err.is_err(), "{env}: 系统模式 {system} 不该能删");
}

fn user_ref(name: &str) -> PrincipalRef {
    PrincipalRef { name: name.into(), host: None, kind: PrincipalKind::User, level: PrincipalLevel::Database }
}

/// Oracle、达梦：带默认表空间和角色建用户，确认生效后删掉。返回建好的用户名（删除前）。
async fn user_with_storage(env: &str, service: &Service, id: &str, oracle: bool) {
    let name = "DBLENS_NS_U";
    let _ = service
        .privilege_apply(id, None, &PrivChange::Drop { principal: user_ref(name), cascade: true }, None)
        .await;
    // OceanBase 的 Oracle 租户没有表空间设置，只建用户
    let storage = service.privilege_overview(id, None).await.unwrap().caps.user_storage;
    let spaces = service.tablespaces(id).await.unwrap();
    let pick = |want: &str, kind: &str| {
        spaces
            .iter()
            .find(|s| s.name == want)
            .or_else(|| spaces.iter().find(|s| s.kind.as_deref() == Some(kind) && !s.name.starts_with("SYS")))
            .map(|s| s.name.clone())
    };
    let default = pick(if oracle { "USERS" } else { "MAIN" }, "PERMANENT");
    let options = if storage {
        assert!(!spaces.is_empty(), "{env}: 表空间列表是空的");
        assert!(default.is_some(), "{env}: 没有可用的默认表空间：{spaces:?}");
        UserOptions {
            default_tablespace: default.clone(),
            temporary_tablespace: if oracle { pick("TEMP", "TEMPORARY") } else { None },
            unlimited_quota: oracle,
            roles: if oracle { vec!["CONNECT".into(), "RESOURCE".into()] } else { vec!["RESOURCE".into()] },
        }
    } else {
        UserOptions::default()
    };
    let change =
        PrivChange::CreateUser { name: name.into(), host: None, password: Secret::new(PASSWORD), options };
    let preview = service.privilege_preview(id, None, &change).await.unwrap();
    if let (true, Some(d)) = (storage, &default) {
        assert!(
            preview.statements[0].contains(&format!("DEFAULT TABLESPACE {d}")),
            "{env}: {:?}",
            preview.statements
        );
    }
    let r = service.privilege_apply(id, None, &change, None).await.unwrap();
    assert_eq!(r.error, None, "{env}: {:?}", r.failed);

    // 权限矩阵的批量提交：一次授予系统权限和别的用户表上的对象权限，再回收其中一个
    let me = user_ref(name);
    let owner = service.profile(id).unwrap().input.user.split('@').next().unwrap_or_default().to_uppercase();
    let overview = service.privilege_overview(id, None).await.unwrap();
    let sys_priv = overview.catalog.global[1].to_string(); // CREATE TABLE / CREATE VIEW
    let table = format!("DBLENS_NS_T{}", if oracle { "O" } else { "D" });
    let session = service.open_session(id).await.unwrap();
    for sql in [format!("DROP TABLE {table}"), format!("CREATE TABLE {table} (ID INT)")] {
        service.sessions.execute(session.id, &sql, true).await.unwrap();
        while let Some(ev) = service.sessions.next(session.id, 100).await.unwrap() {
            if matches!(ev, dblens_service::SessionEvent::Done) {
                break;
            }
        }
    }
    service.sessions.close(session.id, false).await.unwrap();
    let target = |o: Option<&str>| GrantTarget {
        schema: o.map(|_| owner.clone()),
        object_kind: o.map(|_| "table".into()),
        object: o.map(Into::into),
        ..Default::default()
    };
    let grant = |scope, o: Option<&str>, p: &str| PrivChange::Grant {
        grantee: me.clone(),
        scope,
        target: target(o),
        privilege: p.into(),
        with_grant: false,
    };
    let batch = [
        grant(GrantScope::Global, None, &sys_priv),
        grant(GrantScope::Object, Some(&table), "SELECT"),
        grant(GrantScope::Object, Some(&table), "INSERT"),
    ];
    let r = service.privilege_apply_batch(id, None, &batch, None).await.unwrap();
    assert_eq!((r.done.len(), r.error.clone()), (3, None), "{env}: {:?}", r.failed);
    let direct = service.principal_privileges(id, None, name).await.unwrap().direct;
    let has = |p: &str| direct.iter().any(|g| g.privilege.eq_ignore_ascii_case(p));
    assert!(has(&sys_priv) && has("SELECT") && has("INSERT"), "{env}: {direct:?}");
    let revoke = PrivChange::Revoke {
        grantee: me.clone(),
        scope: GrantScope::Object,
        target: target(Some(&table)),
        privilege: "INSERT".into(),
        grantable: false,
        grantor: None,
    };
    let r = service.privilege_apply_batch(id, None, &[revoke], None).await.unwrap();
    assert_eq!(r.error, None, "{env}");
    let direct = service.principal_privileges(id, None, name).await.unwrap().direct;
    assert!(!direct.iter().any(|g| g.privilege.eq_ignore_ascii_case("INSERT")), "{env}: INSERT 没回收");

    // 新用户的模式出现在模式列表里；达梦还能在这个用户名下另建模式
    let schemas = names(service, id, None, true).await;
    if !oracle {
        schema_round_trip(env, service, id, None, "DBLENS_NS_S", Some(name), "SYS").await;
    }
    let overview = service.privilege_overview(id, None).await.unwrap();
    assert!(overview.principals.iter().any(|p| p.name == name), "{env}: 用户列表里没有新用户");
    let r = service
        .privilege_apply(id, None, &PrivChange::Drop { principal: user_ref(name), cascade: true }, None)
        .await
        .unwrap();
    assert_eq!(r.error, None, "{env}");
    let _ = schemas;
}

#[tokio::test]
async fn mysql() {
    let Some((_d, service, id, _)) = setup("DBLENS_TEST_MYSQL_URL").await else { return };
    database_round_trip("mysql", &service, &id, "information_schema", false).await;
    assert!(service.tablespaces(&id).await.unwrap().is_empty());
}

#[tokio::test]
async fn postgres() {
    let Some((_d, service, id, _)) = setup("DBLENS_TEST_PG_URL").await else { return };
    schema_round_trip("pg", &service, &id, None, "dblens_ns_s", None, "information_schema").await;
    // 金仓的表空间叫 sys_default
    let spaces = service.tablespaces(&id).await.unwrap();
    assert!(spaces.iter().any(|s| s.name.ends_with("_default")), "{spaces:?}");
}

#[tokio::test]
async fn opengauss() {
    let Some((_d, service, id, _)) = setup("DBLENS_TEST_OPENGAUSS_URL").await else { return };
    schema_round_trip("opengauss", &service, &id, None, "dblens_ns_s", None, "information_schema").await;
}

#[tokio::test]
async fn sqlserver() {
    let Some((_d, service, id, _)) = setup("DBLENS_TEST_SQLSERVER_URL").await else { return };
    database_round_trip("sqlserver", &service, &id, "master", true).await;
    // 库里建架构：用连接的库
    schema_round_trip("sqlserver", &service, &id, Some("dblens_test"), "dblens_ns_s", Some("dbo"), "sys")
        .await;
}

#[tokio::test]
async fn oracle() {
    let Some((_d, service, id, _)) = setup("DBLENS_TEST_ORACLE_URL").await else { return };
    let caps = service.namespace_caps(&id).await.unwrap();
    assert!(!caps.database && !caps.schema, "Oracle 不提供建库、建模式");
    user_with_storage("oracle", &service, &id, true).await;
}

#[tokio::test]
async fn dameng() {
    let Some((_d, service, id, driver)) = setup("DBLENS_TEST_DM_URL").await else { return };
    assert_eq!(driver, DriverId::Dameng);
    user_with_storage("dameng", &service, &id, false).await;
}

#[tokio::test]
async fn gbase8s() {
    let Some((_d, service, id, _)) = setup("DBLENS_TEST_GBASE_URL").await else { return };
    let caps = service.namespace_caps(&id).await.unwrap();
    assert!(!caps.database && !caps.schema, "GBase 8s 不提供建库、建模式");
    assert!(service.tablespaces(&id).await.unwrap().is_empty());
    let create = NamespaceChange::CreateSchema { name: "dblens_ns_s".into(), owner: None };
    assert!(service.namespace_preview(&id, &req(None, create)).await.is_err());
}
