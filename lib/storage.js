// lib/storage.js
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";

/**
 * Storage helpers for filesystem-backed package storage.
 * Directory layout:
 *  storage/
 *    packages/
 *      <pkg>/
 *        meta.json
 *        tarballs/
 *          <filename>.tgz
 */

export async function ensurePackageDir(base, pkg) {
  const pkgDir = path.join(base, "packages", sanitizePkgName(pkg));
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.mkdir(path.join(pkgDir, "tarballs"), { recursive: true });
  return pkgDir;
}

export async function readPackageMeta(base, pkg) {
  const pkgDir = path.join(base, "packages", sanitizePkgName(pkg));
  const metaPath = path.join(pkgDir, "meta.json");
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

export async function writePackageMeta(base, pkg, meta) {
  const pkgDir = await ensurePackageDir(base, pkg);
  const metaPath = path.join(pkgDir, "meta.json");
  const normalized = Object.assign({}, meta);
  // write atomically
  const tmp = metaPath + ".tmp-" + Date.now();
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2), "utf8");
  await fs.rename(tmp, metaPath);
  return metaPath;
}

export async function listAllPackages(base) {
  const pkgsRoot = path.join(base, "packages");
  try {
    const entries = await fs.readdir(pkgsRoot, { withFileTypes: true });
    const packages = {};
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue;
      const pkgName = dirent.name;
      const meta = await readPackageMeta(base, pkgName);
      packages[pkgName] = meta || { name: pkgName, versions: {} };
    }
    return packages;
  } catch (err) {
    return {};
  }
}

export async function saveTarball(base, pkg, filename, buffer) {
  const pkgDir = await ensurePackageDir(base, pkg);
  const tarDir = path.join(pkgDir, "tarballs");
  const safeName = sanitizeFilename(filename);
  const outPath = path.join(tarDir, safeName);
  await fs.writeFile(outPath, buffer);
  return outPath;
}

export async function getTarballPath(base, pkg, filename) {
  const pkgDir = path.join(base, "packages", sanitizePkgName(pkg));
  const outPath = path.join(pkgDir, "tarballs", sanitizeFilename(filename));
  try {
    await fs.access(outPath);
    return outPath;
  } catch {
    return null;
  }
}

// simple sanitizers
function sanitizePkgName(name) {
  // allow @scoped/pkg or pkg
  return name.replace(/\.\./g, "").replace(/[^@\/a-zA-Z0-9\-\_\.]/g, "_");
}
function sanitizeFilename(name) {
  return name.replace(/\.\./g, "").replace(/[\/\\]/g, "_");
}
