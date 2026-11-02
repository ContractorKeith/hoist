// Embedded SQL travels with the compiled executable. Append migrations, never edit applied ones.
export const migrations = [
  `CREATE TABLE apps (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    domain TEXT NOT NULL,
    health_path TEXT NOT NULL DEFAULT '/',
    retention INTEGER NOT NULL DEFAULT 5 CHECK (retention > 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE releases (
    id INTEGER PRIMARY KEY,
    app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    branch TEXT NOT NULL,
    number INTEGER NOT NULL CHECK (number > 0),
    git_sha TEXT NOT NULL,
    image TEXT NOT NULL,
    config_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('building', 'live', 'stopped', 'failed')),
    container_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (app_id, branch, number)
  );
  CREATE TRIGGER immutable_release_snapshot BEFORE UPDATE OF image, config_json ON releases
    BEGIN SELECT RAISE(ABORT, 'release snapshots are immutable'); END;
  CREATE TABLE config (
    app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (app_id, key)
  );
  CREATE TABLE previews (
    app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    branch TEXT NOT NULL,
    slug TEXT NOT NULL,
    last_push_at TEXT NOT NULL,
    PRIMARY KEY (app_id, branch),
    UNIQUE (app_id, slug)
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,
    expires_at TEXT NOT NULL
  );`,
  `CREATE TABLE releases_next (
    id INTEGER PRIMARY KEY,
    app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    branch TEXT NOT NULL,
    number INTEGER NOT NULL CHECK (number > 0),
    git_sha TEXT NOT NULL,
    image TEXT NOT NULL,
    config_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('building', 'built', 'live', 'stopped', 'failed')),
    container_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (app_id, branch, number)
  );
  INSERT INTO releases_next SELECT * FROM releases;
  DROP TABLE releases;
  ALTER TABLE releases_next RENAME TO releases;
  CREATE TRIGGER immutable_release_snapshot BEFORE UPDATE OF image, config_json ON releases
    BEGIN SELECT RAISE(ABORT, 'release snapshots are immutable'); END;`,
  `CREATE TABLE locks (
    name TEXT PRIMARY KEY,
    owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
    heartbeat_at TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    child_pid INTEGER
  );`,
  `ALTER TABLE releases ADD COLUMN pruned_at TEXT;`,
  `ALTER TABLE apps ADD COLUMN main_branch TEXT;
  WITH RECURSIVE chars(app_id, branch, pos, slug) AS (
    SELECT DISTINCT app_id, branch, 1, '' FROM releases WHERE branch <> 'main'
    UNION ALL
    SELECT app_id, branch, pos + 1, slug ||
      CASE WHEN lower(substr(branch, pos, 1)) GLOB '[a-z0-9-]'
        THEN lower(substr(branch, pos, 1)) ELSE '-' END
      FROM chars WHERE pos <= length(branch)
  ), collapsed(app_id, branch, slug) AS (
    SELECT app_id, branch, slug FROM chars WHERE pos = length(branch) + 1
    UNION ALL
    SELECT app_id, branch, replace(slug, '--', '-') FROM collapsed WHERE instr(slug, '--') > 0
  )
  INSERT OR IGNORE INTO previews(app_id, branch, slug, last_push_at)
    SELECT app_id, branch, trim(slug, '-'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM collapsed WHERE instr(slug, '--') = 0;`,
] as const;

export const schemaVersion = migrations.length;
