import { MongoClient } from "mongodb";

const uri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB_NAME || "dhwaniastroV2";

let client;
let db;

export async function connectMongo() {
  try {
    if (!uri) {
      throw new Error("MONGO_URI is not defined in environment variables");
    }

    if (db) {
      return db;
    }

    client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    await client.connect();

    db = client.db(dbName);

    console.log("MongoDB connected successfully");

    return db;
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    throw error;
  }
}

export function getDb() {
  if (!db) {
    throw new Error("MongoDB not connected. Call connectMongo() first.");
  }
  return db;
}

export async function closeMongo() {
  if (client) {
    await client.close();
    console.log("MongoDB connection closed");
  }
}