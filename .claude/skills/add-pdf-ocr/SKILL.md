---
name: add-pdf-ocr
description: Add OCR support to the pdf-reader container skill. Uses Tesseract to extract text from scanned/image PDFs.
---

# Add PDF OCR Support

Adds an `ocr` command to the existing `pdf-reader` CLI tool, plus Tesseract OCR in the container Dockerfile.

## Pre-flight

Check if already applied:
```bash
grep -q 'tesseract-ocr' container/Dockerfile && echo "ALREADY APPLIED" || echo "NOT APPLIED"
```

If already applied, tell the user and stop.

## Phase 1: Apply code changes

Merge the skill branch:
```bash
git fetch origin skill/pdf-ocr
git merge origin/skill/pdf-ocr
```

If there are merge conflicts:
```bash
git checkout --theirs package-lock.json 2>/dev/null; git add package-lock.json 2>/dev/null
git merge --continue
```

## Phase 2: Build container

```bash
./container/build.sh
```

No configuration needed — Tesseract is installed as a system package.

## Phase 3: Test

Restart NanoClaw and test from any agent:
- Send a scanned PDF and ask the agent to read it
- Run `pdf-reader ocr scanned.pdf` directly

## What This Adds

- **`tesseract-ocr`** package in the Dockerfile
- **`ocr` command** in `container/skills/pdf-reader/pdf-reader` — converts pages to images via `pdftoppm` (300 DPI) then runs Tesseract
- **`--pages` option** for OCR to limit which pages are processed
- Updated SKILL.md with OCR documentation
