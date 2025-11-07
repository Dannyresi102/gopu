// README.md
# Mini npm-like Registry

This project provides a minimal HTTP registry server that mimics a subset of npm's registry API for development and testing.

## Features
- Publish package metadata (`PUT /:pkg`)
- Upload tarballs (`PUT /:pkg/-/:file.tgz`)
- Download tarballs (`GET /:pkg/-/:file.tgz`)
- Fetch package metadata (`GET /:pkg`)
- List all packages (`GET /-/all`)
- Simple token-based auth for publishing/uploading

## Quick start
1. Install:
```bash
npm install
