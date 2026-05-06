import { z } from "npm:zod@4";
import { MongoClient } from "npm:mongodb@6.12.0";

const GlobalArgsSchema = z.object({
  mongodbUri: z.string().describe("MongoDB connection URI"),
  database: z
    .string()
    .default("test")
    .describe("Database name to query (default: test)"),
});

async function withClient(context, fn) {
  const uri = context.globalArgs.mongodbUri;
  // Log redacted host for debugging connectivity
  const hostMatch = uri.match(/@([^/]+)/);
  const host = hostMatch ? hostMatch[1] : "unknown";
  context.logger.info("Connecting to MongoDB host: {host}", { host });

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
  });
  try {
    await client.connect();
    context.logger.info("Connected to MongoDB");
    return await fn(client);
  } finally {
    await client.close();
    context.logger.info("Disconnected from MongoDB");
  }
}

export const model = {
  type: "@keeb/mongodb",
  version: "2026.03.29.1",
  upgrades: [
    {
      fromVersion: "2026.03.10.1",
      toVersion: "2026.03.29.1",
      description: "Add insert method for writing documents",
      upgradeAttributes: (old) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    queryResults: {
      description: "Query results from MongoDB",
      schema: z.object({}).passthrough(),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    diagnose: {
      description:
        "Check connectivity and list collections in a specific database. Tries the default DB from URI, plus common alternatives.",
      arguments: z.object({
        databases: z
          .array(z.string())
          .default([])
          .describe("Additional database names to check beyond the default"),
      }),
      execute: async (args, context) => {
        const results = await withClient(context, async (client) => {
          const defaultDb = client.db();
          const dbNames = [
            defaultDb.databaseName,
            ...args.databases.filter((n) => n !== defaultDb.databaseName),
          ];
          const details = {};
          for (const name of dbNames) {
            const db = client.db(name);
            const collections = await db.listCollections().toArray();
            const counts = {};
            for (const col of collections) {
              counts[col.name] = await db
                .collection(col.name)
                .estimatedDocumentCount();
            }
            details[name] = {
              collectionCount: collections.length,
              collections: counts,
            };
          }
          return {
            defaultDatabase: defaultDb.databaseName,
            databases: details,
          };
        });

        const handle = await context.writeResource(
          "queryResults",
          "queryResults",
          results,
        );
        return { dataHandles: [handle] };
      },
    },
    query: {
      description:
        "Query any collection with a filter, projection, sort, and limit.",
      arguments: z.object({
        collection: z.string().describe("Collection name"),
        filter: z
          .record(z.string(), z.any())
          .default({})
          .describe("MongoDB filter document"),
        projection: z
          .record(z.string(), z.number())
          .default({})
          .describe("Fields to include (1) or exclude (0)"),
        sort: z
          .record(z.string(), z.number())
          .default({})
          .describe("Sort specification"),
        limit: z.number().default(20).describe("Max documents to return"),
      }),
      execute: async (args, context) => {
        const results = await withClient(context, async (client) => {
          const db = client.db(context.globalArgs.database);
          context.logger.info(
            "Querying {collection} with filter {filter}",
            {
              collection: args.collection,
              filter: JSON.stringify(args.filter),
            },
          );
          return await db
            .collection(args.collection)
            .find(args.filter)
            .project(args.projection)
            .sort(args.sort)
            .limit(args.limit)
            .toArray();
        });

        const handle = await context.writeResource(
          "queryResults",
          "queryResults",
          {
            collection: args.collection,
            filter: args.filter,
            count: results.length,
            results,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    find_user: {
      description:
        "Search for a user by username or email. Supports exact and case-insensitive regex matching.",
      arguments: z.object({
        query: z.string().describe("Search term (username or email pattern)"),
        field: z
          .enum(["username", "email"])
          .default("username")
          .describe("Field to search"),
        exact: z
          .boolean()
          .default(false)
          .describe("Exact match (true) or case-insensitive regex (false)"),
      }),
      execute: async (args, context) => {
        const results = await withClient(context, async (client) => {
          const db = client.db(context.globalArgs.database);
          const collection = db.collection("user");

          const filter = args.exact
            ? { [args.field]: args.query }
            : { [args.field]: { $regex: args.query, $options: "i" } };

          context.logger.info("Querying user collection with filter {filter}", {
            filter: JSON.stringify(filter),
          });

          return await collection.find(filter).toArray();
        });

        const handle = await context.writeResource(
          "queryResults",
          "queryResults",
          {
            query: args.query,
            field: args.field,
            exact: args.exact,
            collection: "user",
            count: results.length,
            results,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    insert: {
      description: "Insert one or more documents into a collection.",
      arguments: z.object({
        collection: z.string().describe("Collection name"),
        documents: z
          .array(z.record(z.string(), z.any()))
          .describe("Array of documents to insert"),
      }),
      execute: async (args, context) => {
        const results = await withClient(context, async (client) => {
          const db = client.db(context.globalArgs.database);
          context.logger.info(
            "Inserting {count} document(s) into {collection}",
            { count: args.documents.length, collection: args.collection },
          );
          const result = await db
            .collection(args.collection)
            .insertMany(args.documents);
          return {
            collection: args.collection,
            insertedCount: result.insertedCount,
            insertedIds: Object.values(result.insertedIds).map(String),
          };
        });

        const handle = await context.writeResource(
          "queryResults",
          "queryResults",
          results,
        );
        return { dataHandles: [handle] };
      },
    },
    find_related: {
      description:
        "Given a user ID, search for related records in account, organization, and member collections.",
      arguments: z.object({
        userId: z.string().describe("User ID to search for related records"),
      }),
      execute: async (args, context) => {
        const results = await withClient(context, async (client) => {
          const db = client.db(context.globalArgs.database);
          const collections = ["account", "organization", "member"];
          const related = {};

          for (const name of collections) {
            context.logger.info(
              "Searching {collection} for userId {userId}",
              { collection: name, userId: args.userId },
            );

            const docs = await db
              .collection(name)
              .find({ userId: args.userId })
              .toArray();
            related[name] = { count: docs.length, documents: docs };
          }

          return related;
        });

        const handle = await context.writeResource(
          "queryResults",
          "queryResults",
          {
            userId: args.userId,
            related: results,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
