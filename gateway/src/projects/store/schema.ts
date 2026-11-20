import type { DatabaseSync } from "node:sqlite";
/** 项目数据与个人会话物理分离，事务提交根指针和持久事件。 */
export function initializeProjectSchema(db: DatabaseSync) {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version !== 0 && version !== 1) throw new Error("项目数据库版本不兼容");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
      root TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, authz INTEGER NOT NULL DEFAULT 1, config_revision INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}', rules TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, deleted_at INTEGER);
    CREATE TABLE IF NOT EXISTS members (project TEXT REFERENCES projects(id), tenant TEXT, role TEXT NOT NULL, status TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, joined INTEGER NOT NULL, PRIMARY KEY(project,tenant));
    CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON members(project) WHERE role='owner' AND status='active';
    CREATE TRIGGER IF NOT EXISTS protect_owner BEFORE UPDATE ON members WHEN OLD.role='owner' AND (NEW.role!='owner' OR NEW.status!='active')
      BEGIN SELECT RAISE(ABORT,'不能改变唯一所有者'); END;
    CREATE TRIGGER IF NOT EXISTS protect_owner_delete BEFORE DELETE ON members WHEN OLD.role='owner' BEGIN SELECT RAISE(ABORT,'不能删除所有者'); END;
    CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY,project TEXT REFERENCES projects(id),target TEXT NOT NULL,inviter TEXT NOT NULL,
      role TEXT NOT NULL,status TEXT NOT NULL,expires INTEGER NOT NULL,created INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS pending_invite ON invites(project,target) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY,bytes INTEGER NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS revisions (project TEXT REFERENCES projects(id),revision INTEGER,root TEXT NOT NULL,actor TEXT NOT NULL,paths TEXT NOT NULL,
      created INTEGER NOT NULL,PRIMARY KEY(project,revision));
    CREATE TABLE IF NOT EXISTS operations (scope TEXT,actor TEXT,operation TEXT,request_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,actor,operation));
    CREATE TABLE IF NOT EXISTS events (project TEXT REFERENCES projects(id),seq INTEGER,kind TEXT NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(project,seq));
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY,project TEXT,actor TEXT NOT NULL,action TEXT NOT NULL,operation TEXT,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY,project TEXT REFERENCES projects(id),actor TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,expires INTEGER NOT NULL,consumed TEXT);
    CREATE TABLE IF NOT EXISTS chats (project TEXT REFERENCES projects(id),id TEXT,title TEXT NOT NULL,actor TEXT NOT NULL,created INTEGER NOT NULL,seq INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project,id));
    CREATE TABLE IF NOT EXISTS messages (project TEXT,chat TEXT,seq INTEGER,kind TEXT NOT NULL,actor TEXT,run TEXT,text TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,
      PRIMARY KEY(project,chat,seq),FOREIGN KEY(project,chat) REFERENCES chats(project,id));
    CREATE TABLE IF NOT EXISTS member_views (project TEXT,tenant TEXT,chat TEXT,read_seq INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project,tenant,chat));
    CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY,project TEXT REFERENCES projects(id),actor TEXT NOT NULL,text TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY,project TEXT REFERENCES projects(id),chat TEXT NOT NULL,actor TEXT NOT NULL,base INTEGER NOT NULL,root TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,patch TEXT NOT NULL DEFAULT '[]',model TEXT NOT NULL,rules TEXT NOT NULL,created INTEGER NOT NULL,error TEXT);
    CREATE TABLE IF NOT EXISTS budget_ledger (id TEXT PRIMARY KEY,project TEXT REFERENCES projects(id),run TEXT NOT NULL,request TEXT UNIQUE,day TEXT NOT NULL,reserved INTEGER NOT NULL,charged INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS exports (id TEXT PRIMARY KEY,project TEXT REFERENCES projects(id),root TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY,project TEXT,actor TEXT NOT NULL,source TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS migrated_paths (tenant TEXT,path TEXT,project TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(tenant,path));
    CREATE TABLE IF NOT EXISTS ipc_nonces (nonce TEXT PRIMARY KEY,expires INTEGER NOT NULL);
    PRAGMA user_version=1;
  `);
}
