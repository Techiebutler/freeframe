#!/usr/bin/env python3
"""One-shot script: generate short codes for existing share links that have none.

Usage (from project root):
  python scripts/backfill_short_codes.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))

from database import SessionLocal
from models.share import ShareLink
from utils.short_code import generate_short_code

MAX_RETRIES = 3


def main():
    db = SessionLocal()
    try:
        links = db.query(ShareLink).filter(
            ShareLink.short_code.is_(None),
            ShareLink.deleted_at.is_(None),
        ).all()

        if not links:
            print("No share links need short codes.")
            return

        successes = 0
        failures = 0

        for link in links:
            for attempt in range(MAX_RETRIES):
                code = generate_short_code()
                existing = db.query(ShareLink).filter(
                    ShareLink.short_code == code
                ).first()
                if not existing:
                    link.short_code = code
                    try:
                        db.commit()
                        successes += 1
                        break
                    except Exception:
                        db.rollback()
                        if attempt == MAX_RETRIES - 1:
                            failures += 1
                            print(
                                f"FAILED: link {link.id} (attempt {attempt + 1}/{MAX_RETRIES})"
                            )
                elif attempt == MAX_RETRIES - 1:
                    failures += 1
                    print(f"FAILED: link {link.id} — collision after {MAX_RETRIES} retries")

        print(f"\nDone: {successes} assigned, {failures} failed, {len(links)} total")
    finally:
        db.close()


if __name__ == "__main__":
    main()
