/**
 * Database Connection — Neon PostgreSQL via Drizzle ORM
 * Provides a shared db instance for all server modules.
 */

import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("[DB] DATABASE_URL must be set in .env");
}

export const db = drizzle(process.env.DATABASE_URL, { schema });
