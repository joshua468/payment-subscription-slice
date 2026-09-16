import { loadEnvFile } from "node:process";

// Load DATABASE_URL from the project .env before the Prisma client is imported.
loadEnvFile();