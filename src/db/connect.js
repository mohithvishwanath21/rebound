import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_URI = 'mongodb://127.0.0.1:27017/rebound';

let connected = false;

export async function connectDb(uri = process.env.MONGO_URI ?? DEFAULT_URI) {
  if (connected) return mongoose.connection;

  mongoose.set('strictQuery', true);

  // Fail fast rather than hanging for 30s. During a 13-day build the most common
  // "bug" is simply that mongod is not running, and a clear error saves minutes
  // every single time.
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
  });

  connected = true;
  return mongoose.connection;
}

export async function disconnectDb() {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}

export function isConnected() {
  return connected && mongoose.connection.readyState === 1;
}
