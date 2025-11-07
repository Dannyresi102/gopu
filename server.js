// server.js
/**
 * Mini npm-like registry server (development/test only).
 *
 * Features:
 *  - GET /:pkg => returns package metadata JSON
 *  - PUT /:pkg => publish or update package metadata (requires auth)
 *  - PUT /:pkg/-/:filename.tgz => upload package tarball (requires auth)
 *  - GET /:pkg/-/:filename.tgz => download tarball
 *  - GET /-/all => list all packages metadata (simple)
 *
 * Storage: filesystem under ./storage/
 *
 * Authentication: simple token via Authorization: Bearer <TOKEN>
 *   default token can be set with REGISTRY_TOKEN env var (or reads ./token file)
 *
 * NOT production-ready. Intended as educational / development server.
 */

import express from "express";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import morgan from "morgan";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { ensurePackageDir, readPackageMeta, writePackageMeta, listAllPackages, saveTarball, getTarballPath } from "./lib/storage.js";
import { authMiddleware, readTokenFromEnvOrFile } from "./lib/auth.js";

const STORAGE_DIR = process.env.STORAGE_DIR || path.resolve(process.cwd(), "storage");
const PORT = process.env.PORT ? Number(process.env.PORT) : 4873;

await fs.mkdir(STORAGE_DIR, { recursive: true });

// Express app
const app = express();
app.use(helmet());
app.use(cors());
app.use(morgan("combined"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500
});
app.use(limiter);

// multer for file uploads (store in memory then write to disk)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// read token once (or fallback to ./token)
const AUTH_TOKEN = await readTokenFromEnvOrFile();

// Health check
app.get("/-/ping", (req, res) => {
  res.setHeader("cache-control", "no-cache");
  return res.status(200).send("pong");
});

// List all packages (very simple)
app.get("/-/all", async (req, res) => {
  try {
    const packages = await listAllPackages(STORAGE_DIR);
    res.json(packages);
  } catch (err) {
    res.status(500).json({ error: "failed_to_list_packages", message: String(err) });
  }
});

// Get package metadata
app.get("/:pkg", async (req, res) => {
  const pkg = req.params.pkg;
  try {
    const meta = await readPackageMeta(STORAGE_DIR, pkg);
    if (!meta) return res.status(404).json({ error: "not_found", reason: "package not found" });
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.json(meta);
  } catch (err) {
    res.status(500).json({ error: "server_error", message: String(err) });
  }
});

// Publish/update package metadata (npm uses PUT on /:pkg)
app.put("/:pkg", authMiddleware(AUTH_TOKEN), async (req, res) => {
  const pkg = req.params.pkg;
  const body = req.body;
  if (!body || typeof body !== "object") return res.status(400).json({ error: "invalid_body", reason: "expected JSON metadata" });

  try {
    await ensurePackageDir(STORAGE_DIR, pkg);
    await writePackageMeta(STORAGE_DIR, pkg, body);
    // emulate npm: respond with ok and e.g. created date
    res.status(201).json({ ok: true, id: uuidv4() });
  } catch (err) {
    res.status(500).json({ error: "server_error", message: String(err) });
  }
});

// Upload tarball for package
// Endpoint pattern: PUT /:pkg/-/:filename.tgz
app.put("/:pkg/-/:filename", authMiddleware(AUTH_TOKEN), upload.single("file"), async (req, res) => {
  const pkg = req.params.pkg;
  const filename = req.params.filename;
  const buffer = req.file ? req.file.buffer : null;

  // npm clients may send the tarball raw in body with content-type application/octet-stream.
  // multer won't pick that up. Check raw body buffer by reading req if needed. Here we support 'file' field and raw body.
  let dataBuffer = buffer;
  if (!dataBuffer) {
    // try to read raw body (stream)
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      dataBuffer = Buffer.concat(chunks);
      if (dataBuffer.length === 0) dataBuffer = null;
    } catch (err) {
      dataBuffer = null;
    }
  }

  if (!dataBuffer) return res.status(400).json({ error: "no_tarball", reason: "no tarball body received" });

  try {
    await ensurePackageDir(STORAGE_DIR, pkg);
    const saved = await saveTarball(STORAGE_DIR, pkg, filename, dataBuffer);
    // Update package metadata to include dist tarball reference (simple)
    const meta = (await readPackageMeta(STORAGE_DIR, pkg)) || { name: pkg, versions: {} };
    meta.versions = meta.versions || {};
    // create a synthetic version if none
    const version = meta["dist-tags"] && meta["dist-tags"].latest ? meta["dist-tags"].latest : "0.0.0";
    meta.versions[version] = meta.versions[version] || {};
    meta.versions[version].dist = meta.versions[version].dist || {};
    meta.versions[version].dist.tarball = `${req.protocol}://${req.get("host")}/${encodeURIComponent(pkg)}/-/${encodeURIComponent(filename)}`;
    await writePackageMeta(STORAGE_DIR, pkg, meta);
    res.status(201).json({ ok: true, filename });
  } catch (err) {
    res.status(500).json({ error: "server_error", message: String(err) });
  }
});

// Download tarball
app.get("/:pkg/-/:filename", async (req, res) => {
  const pkg = req.params.pkg;
  const filename = req.params.filename;
  try {
    const p = await getTarballPath(STORAGE_DIR, pkg, filename);
    if (!p) return res.status(404).json({ error: "not_found", reason: "tarball not found" });
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-disposition", `attachment; filename="${path.basename(filename)}"`);
    const stream = fsSync.createReadStream(p);
    stream.pipe(res);
    stream.on("error", (err) => {
      res.destroy(err);
    });
  } catch (err) {
    res.status(500).json({ error: "server_error", message: String(err) });
  }
});

// Simple login endpoint that returns token (for demo only)
app.post("/-/user/org.couchdb.user:_:name", express.json(), async (req, res) => {
  // This emulates npm adduser — returns token that client can use.
  // For simplicity, if no password is set we return server token.
  const username = req.params.name || req.body.name || req.body.username || "user";
  // respond with token
  res.status(201).json({ ok: "created", token: AUTH_TOKEN || uuidv4() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Mini registry listening on http://localhost:${PORT}`);
  console.log(`Storage dir: ${STORAGE_DIR}`);
});
