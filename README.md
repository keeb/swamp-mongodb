# @keeb/mongodb

[Swamp](https://github.com/systeminit/swamp) extension for querying MongoDB databases.

## Models

### `mongodb`

Query MongoDB collections, search users, and explore related records.

| Method | Description |
|--------|-------------|
| `diagnose` | Check connectivity and list collections across databases |
| `query` | Query any collection with filter, projection, sort, and limit |
| `find_user` | Search for a user by username or email |
| `find_related` | Find related records in account, organization, and member collections |

## Install

```bash
swamp extension pull @keeb/mongodb
```

## License

MIT
