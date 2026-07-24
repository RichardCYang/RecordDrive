#!/usr/bin/env python3
"""Chromium-backed cookie ordering and __Host- prefix reproduction.

Requires Python Playwright and a Chromium executable. This script does not make
network requests; it validates the browser cookie store and retrieval rules.
"""
import json
import os
from playwright.sync_api import sync_playwright

CHROMIUM = os.environ.get("CHROMIUM_BIN", "/usr/bin/chromium")
TARGET = "https://app.example.test/repositories/42/upload"

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=CHROMIUM, headless=True)
    try:
        vulnerable_context = browser.new_context(ignore_https_errors=True)
        vulnerable_context.add_cookies([
            {
                "name": "recorddrive.sid",
                "value": "attacker-session",
                "domain": "example.test",
                "path": "/repositories",
                "secure": True,
                "httpOnly": True,
                "sameSite": "Strict",
            },
            {
                "name": "recorddrive.sid",
                "value": "victim-session",
                "domain": "app.example.test",
                "path": "/",
                "secure": True,
                "httpOnly": True,
                "sameSite": "Strict",
            },
        ])
        vulnerable_cookies = vulnerable_context.cookies(TARGET)

        patched_context = browser.new_context(ignore_https_errors=True)
        prefix_error = None
        try:
            patched_context.add_cookies([{
                "name": "__Host-recorddrive.sid",
                "value": "attacker-session",
                "domain": "example.test",
                "path": "/repositories",
                "secure": True,
                "httpOnly": True,
                "sameSite": "Strict",
            }])
        except Exception as error:  # Playwright surfaces Chromium's rejection.
            prefix_error = str(error).splitlines()[0]

        patched_context.add_cookies([{
            "name": "__Host-recorddrive.sid",
            "value": "victim-session",
            "url": "https://app.example.test/",
            "secure": True,
            "httpOnly": True,
            "sameSite": "Strict",
        }])
        patched_cookies = patched_context.cookies(TARGET)

        result = {
            "browser": browser.version,
            "target": TARGET,
            "vulnerable": {
                "cookiesInRequestOrder": vulnerable_cookies,
                "firstCookieValue": vulnerable_cookies[0]["value"],
            },
            "patched": {
                "siblingDomainInjectionError": prefix_error,
                "cookiesInRequestOrder": patched_cookies,
                "firstCookieValue": patched_cookies[0]["value"],
            },
            "verified": {
                "longerPathAttackerCookieIsFirst": vulnerable_cookies[0]["value"] == "attacker-session",
                "invalidHostPrefixCookieRejected": prefix_error is not None,
                "onlyVictimHostCookieRemains": [cookie["value"] for cookie in patched_cookies] == ["victim-session"],
            },
        }
        print(json.dumps(result, indent=2, sort_keys=True))
        if not all(result["verified"].values()):
            raise SystemExit(1)
    finally:
        browser.close()
