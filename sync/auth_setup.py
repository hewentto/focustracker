#!/usr/bin/env python3
"""
One-time local Garmin login. Run this on YOUR machine, not in CI.

Why local: a fresh SSO login from a datacenter IP is what trips Garmin's
Cloudflare bot detection, and MFA prompts are interactive. Log in once here,
then ship the resulting *token* to GitHub Actions as a secret.

Usage:
    pip install -r requirements.txt
    python auth_setup.py

Prompts for email, password, and an MFA code if 2FA is on. On success it
prints a base64 blob -- paste that into the repo secret GARMIN_TOKENS
(Settings -> Secrets and variables -> Actions -> New repository secret).

The OAuth1 token lasts roughly a year. When the workflow starts failing with
an auth error, re-run this and update the secret. That is the whole
maintenance burden.
"""

import base64
import getpass
import io
import os
import sys
import tarfile
from pathlib import Path

TOKENSTORE = Path(os.environ.get("GARMINTOKENS", Path.home() / ".garminconnect"))


def main() -> int:
    try:
        from garminconnect import Garmin
    except ImportError:
        print("Run: pip install -r requirements.txt", file=sys.stderr)
        return 1

    email = input("Garmin email: ").strip()
    password = getpass.getpass("Garmin password: ")

    def prompt_mfa() -> str:
        return input("MFA code: ").strip()

    print("\nLogging in...")
    TOKENSTORE.mkdir(parents=True, exist_ok=True)
    try:
        client = Garmin(email=email, password=password, prompt_mfa=prompt_mfa)
        # Handing login() the tokenstore is what persists the session -- it
        # writes garmin_tokens.json itself, mode 0600. There is no
        # client.garth.dump() any more: garth stopped being a dependency when
        # the library rebuilt auth natively in 2026.
        client.login(str(TOKENSTORE))
    except Exception as exc:  # noqa: BLE001
        print(f"Login failed: {exc}", file=sys.stderr)
        print(
            "\nIf this is a 429, you are rate limited at the ACCOUNT level. "
            "Wait 48-72h and do NOT retry -- retrying extends the block.",
            file=sys.stderr,
        )
        return 1

    written = sorted(p for p in TOKENSTORE.iterdir() if p.is_file())
    if not written:
        print(f"Login reported success but nothing landed in {TOKENSTORE}. "
              "Check the library version.", file=sys.stderr)
        return 1
    print(f"Tokens written to {TOKENSTORE}: "
          + ", ".join(p.name for p in written))

    # Pack the whole token directory so this keeps working if the library
    # changes how many files it writes.
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for path in sorted(TOKENSTORE.iterdir()):
            if path.is_file():
                tar.add(path, arcname=path.name)
    blob = base64.b64encode(buf.getvalue()).decode()

    print("\n" + "=" * 70)
    print("Copy everything between the lines into the GARMIN_TOKENS secret:")
    print("=" * 70)
    print(blob)
    print("=" * 70)
    print(f"\n({len(blob)} characters)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
