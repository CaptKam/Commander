/**
 * Pattern Bot Hybrid Entry Point
 * Boots both the 24/7 Trading Engine and the Express API
 * for the Visual Dashboard in a single process.
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { startEngine } from "./orchestrator";
import apiRouter from "./api";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Dashboard API
app.use(express.json());
app.use("/api", apiRouter);

// 2. Serve static frontend files (if they exist)
const distPath = path.join(__dirname, "../dist");
app.use(express.static(distPath));

// Fallback for React routing
app.get("*", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"), (err) => {
    if (err) {
      res.status(200).send("Pattern Bot is running. Dashboard not built yet.");
    }
  });
});

// 3. Hybrid Boot
async function boot() {
  console.log("-----------------------------------------");
  console.log("  PATTERN BOT HYBRID BOOT INITIALIZED");
  console.log("-----------------------------------------");

  // Start the 24/7 Trading Engine
  try {
    await startEngine();
    console.log("[Boot] Trading Engine: ACTIVE");
  } catch (err) {
    console.error("[Boot] Trading Engine: FAILED TO START", err);
  }

  // Start the Web Server
  app.listen(PORT, () => {
    console.log(`[Boot] Visual Dashboard: ACTIVE on port ${PORT}`);
  });
}

boot();
