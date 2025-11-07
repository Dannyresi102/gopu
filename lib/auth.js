// lib/auth.js
import fs from "fs/promises";
import path from "path";

/**
 * Simple token-based auth utilities.
 * Reads token from REGISTRY_TOKEN env or ./token file (if present).
 */

export async function readTokenFromEnvOrFile() {
  if (process.env.REGISTRY_TOKEN) return process.env.REGISTRY_TOKEN;
  const tokenFile = path.resolve(process.cwd(), "token");
  try {
    const t = (await fs.readFile(tokenFile, "utf8")).trim();
    if (t) return t;
  } catch {}
  // fallback to a generated token written to token file for convenience (dev only)
  const fallback = "dev-token-" + Math.random().toString(36).slice(2, 10);
  try {
    await fs.writeFile(tokenFile, fallback, "utf8");
  } catch {}
  return fallback;
}

export function authMiddleware(token) {
  return async (req, res, next) => {
    try {
      const auth = req.get("authorization") || "";
      if (!token) {
        // if no token configured, allow all
        return next();
      }
      if (!auth.startsWith("Bearer ")) {
        return res.status(401).json({ error: "unauthorized", reason: "missing Bearer token" });
      }
      const supplied = auth.slice("Bearer ".length).trim();
      if (!supplied || supplied !== token) {
        return res.status(403).json({ error: "forbidden", reason: "invalid token" });
      }
      return next();
    } catch (err) {
      return res.status(500).json({ error: "server_error", message: String(err) });
    }
  };
}
