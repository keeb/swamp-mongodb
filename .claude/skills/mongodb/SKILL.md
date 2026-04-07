---
name: mongodb
description: Query and write MongoDB collections from swamp workflows using the @keeb/mongodb model — run filtered finds, list collections for connectivity diagnostics, look up users by username or email, fetch related account/organization/member records, and insert documents. Use when wiring MongoDB reads or writes into swamp automation, diagnosing connectivity to a Mongo cluster, searching a `user` collection, walking related-record graphs, or seeding test data. Triggers on "mongodb", "mongo", "@keeb/mongodb", "query mongo", "mongodb diagnose", "find user in mongo", "insert into mongo", "mongo collection", "find_related", or when a workflow needs data from a MongoDB database.
---

# @keeb/mongodb

Swamp extension for reading from and writing to MongoDB. One model, five
methods. Wraps the official `mongodb` Node driver.

## Model: `@keeb/mongodb`

Single model type. The same instance handles diagnostics, queries, lookups, and
inserts — pick the method, not a sub-model.

### Global arguments

Configured once per model instance in the definition YAML:

| Field        | Type   | Required | Default | Description            |
| ------------ | ------ | -------- | ------- | ---------------------- |
| `mongodbUri` | string | yes      | —       | MongoDB connection URI |
| `database`   | string | no       | `test`  | Database name to query |

`mongodbUri` is a secret — store in a vault, reference with a vault expression.
Never hardcode.

The driver uses a 15s `serverSelectionTimeoutMS` and 15s `connectTimeoutMS`. A
fresh client is opened and closed for every method call — there is no connection
pooling across invocations.

### Methods

#### `diagnose`

Connect, list collections, and report estimated document counts. Always probes
the URI's default database; optionally probes additional databases too.

| Argument    | Type     | Required | Default | Description                                      |
| ----------- | -------- | -------- | ------- | ------------------------------------------------ |
| `databases` | string[] | no       | `[]`    | Extra database names to inspect beyond the URI's |

Use this first when wiring a new instance — it surfaces auth, network, and
collection-name issues before the real workflow runs.

#### `query`

General-purpose find against a collection in the configured `database`.

| Argument     | Type                  | Required | Default | Description                            |
| ------------ | --------------------- | -------- | ------- | -------------------------------------- |
| `collection` | string                | yes      | —       | Collection name                        |
| `filter`     | object                | no       | `{}`    | MongoDB filter document                |
| `projection` | object<string,number> | no       | `{}`    | Fields to include (1) or exclude (0)   |
| `sort`       | object<string,number> | no       | `{}`    | Sort spec (1 ascending, -1 descending) |
| `limit`      | number                | no       | `20`    | Max documents to return                |

#### `find_user`

Targeted search of the `user` collection by `username` or `email`. Built on top
of `query` but with a saner shape for the common case.

| Argument | Type                      | Required | Default      | Description                                  |
| -------- | ------------------------- | -------- | ------------ | -------------------------------------------- |
| `query`  | string                    | yes      | —            | Search term                                  |
| `field`  | `"username"` \| `"email"` | no       | `"username"` | Field to match against                       |
| `exact`  | boolean                   | no       | `false`      | Exact match (true) or case-insensitive regex |

Default behavior is a case-insensitive regex — fast for humans, scary for large
collections without an index.

#### `find_related`

Given a user ID, find matching records in the `account`, `organization`, and
`member` collections (matching on a `userId` field in each). Returns all three
result sets keyed by collection.

| Argument | Type   | Required | Description                           |
| -------- | ------ | -------- | ------------------------------------- |
| `userId` | string | yes      | User ID to look up across collections |

Hardcoded collection list and hardcoded `userId` field name — only useful for
schemas that match this layout.

#### `insert`

Insert one or more documents into a collection via `insertMany`.

| Argument     | Type     | Required | Description         |
| ------------ | -------- | -------- | ------------------- |
| `collection` | string   | yes      | Collection name     |
| `documents`  | object[] | yes      | Documents to insert |

Returns `{ collection, insertedCount, insertedIds }`. Even a single document
goes through `insertMany`.

### Resources

| Name           | Lifetime | GC | Schema             |
| -------------- | -------- | -- | ------------------ |
| `queryResults` | infinite | 10 | passthrough object |

Every method writes to the same `queryResults` resource under the key
`queryResults`. Each call overwrites the previous result for that instance —
**there is no per-method or per-collection separation**. If a workflow needs to
preserve outputs from multiple calls, declare multiple model instances or
materialize results into a separate model between calls.

Shape inside the resource varies by method:

- `diagnose`:
  `{ defaultDatabase, databases: { <name>: { collectionCount, collections: { <col>: count } } } }`
- `query`: `{ collection, filter, count, results }`
- `find_user`: `{ query, field, exact, collection, count, results }`
- `find_related`: `{ userId, related: { account, organization, member } }`
- `insert`: `{ collection, insertedCount, insertedIds }`

## Defining an instance

```yaml
# definition.yaml
models:
  - name: prod-mongo
    type: "@keeb/mongodb"
    globalArguments:
      mongodbUri: "{{ vault.mongodb.prodUri }}"
      database: "app"
```

Store the URI in a vault first:

```bash
swamp vault set mongodb prodUri 'mongodb+srv://user:pass@cluster.mongodb.net/app'
```

## Calling methods from a workflow

```yaml
# workflows/find-user.yaml
jobs:
  lookup:
    steps:
      - name: search
        model: prod-mongo
        method: find_user
        arguments:
          query: "alice@example.com"
          field: email
          exact: true

      - name: relations
        model: prod-mongo
        method: find_related
        needs: [search]
        arguments:
          userId: "{{ data.latest('prod-mongo', 'queryResults').attributes.results[0]._id }}"
```

## Running ad-hoc from the CLI

```bash
swamp model run prod-mongo diagnose
swamp model run prod-mongo query --arg collection=user --arg 'limit=5'
swamp model run prod-mongo find_user --arg query=alice --arg field=username
```

JSON-shaped args (`filter`, `projection`, `sort`, `documents`) need to be quoted
as JSON strings on the CLI.

## Common patterns

### Wire a query result into a downstream model

```yaml
arguments:
  userId: "{{ data.latest('prod-mongo', 'queryResults').attributes.results[0]._id }}"
```

CEL `data.latest(...)` reads the most recent `queryResults` for the named
instance. Because every method overwrites the same resource, be careful that the
previous step in the same job is the one whose output you want.

### Multiple databases on one cluster

Declare one model instance per database, each with its own `database` global arg
pointing at the same `mongodbUri`. Don't try to switch databases per-call — the
model has no per-method database override.

### Diagnose before query

In a fresh repo or new credential, run `diagnose` once interactively to confirm
collections exist and counts are non-zero. Catches typos in `database` and
silent auth failures (Mongo returns empty results, not errors, when an auth
scope excludes a collection).

## Gotchas

- **Single shared resource**: Every method writes to `queryResults` /
  `queryResults`. Sequential calls on one instance clobber each other. Split
  across instances or copy to another model if you need history.
- **Default database is `test`**: Forgetting to set `database` silently queries
  the wrong DB. `diagnose` will not save you here unless you explicitly pass the
  right name in `databases`.
- **`find_user` regex by default**: With `exact: false`, `find_user` runs a
  case-insensitive `$regex`. On large unindexed collections this is a full scan.
  Set `exact: true` for production lookups against email/username.
- **`find_related` is schema-specific**: It hardcodes `account`, `organization`,
  `member` and matches on a `userId` field. If your schema differs, use `query`
  instead — don't try to bend it.
- **`mongodbUri` is a secret**: Connection strings include credentials. Always
  source from a vault.
- **Connection per call**: Each invocation opens and closes a fresh
  `MongoClient`. Loops over many calls pay the connection cost each time —
  prefer a single `query` with a larger `limit` over N `find_user` calls.
- **No upgrade path before `2026.03.10.1`**: The model declares an upgrade from
  `2026.03.10.1` to `2026.03.29.1` (added `insert`). Older instances must
  upgrade through that path.
- **`insert` always uses `insertMany`**: Even one document. The result shape is
  always `insertedCount` + `insertedIds[]`, not `insertedId`.
- **15s connect timeout**: Slow DNS or unreachable clusters fail in 15s rather
  than hanging. Wrap critical workflows in retries if the network is flaky.
