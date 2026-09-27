#!/usr/bin/env python3
"""Download original reference assets for local design research, never production.

The manifest and source links are versioned; third-party files stay local.
Run explicitly: python3 design/logo-research/download-references.py
"""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
SOURCES = [
    ("guides/apple-app-icons.json", "https://developer.apple.com/tutorials/data/design/human-interface-guidelines/app-icons.json"),
    ("guides/apple-icon-composer.md", "https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer.md"),
    ("guides/apple-design-resources.html", "https://developer.apple.com/design/resources/"),
    ("guides/windows-design.html", "https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-design"),
    ("guides/windows-dimensions.html", "https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction"),
    ("guides/gnome-app-icons.html", "https://developer.gnome.org/hig/guidelines/app-icons.html"),
    ("guides/github-brand.pdf", "https://brand.github.com/GitHub-BrandGuidelines-2025.pdf"),
    ("guides/github-logo.html", "https://brand.github.com/foundations/logo"),
    ("guides/figma-brand.pdf", "https://static.figma.com/uploads/35bc6db4415269cfeace41c8c4637945a85732b2.pdf"),
    ("guides/linear-brand.html", "https://linear.app/brand"),
    ("guides/discord-brand.html", "https://discord.com/branding"),
    ("guides/docker-brand.html", "https://www.docker.com/company/newsroom/media-resources/"),
    ("guides/zed-brand.html", "https://zed.dev/brand"),
    ("guides/vscode-brand.html", "https://code.visualstudio.com/brand"),
    ("guides/raycast-press.html", "https://www.raycast.com/press"),
    ("packs/github.zip", "https://brand.github.com/GitHub_Logos.zip"),
    ("packs/linear.zip", "https://static.linear.app/design-assets/Linear-Brand-Assets.zip?v=3"),
    ("packs/docker.zip", "https://www.docker.com/static/Docker-Logos-1.zip"),
    ("marks/discord.svg", "https://cdn.prod.website-files.com/6257adef93867e50d84d30e2/66e3d7f4ef6498ac018f2c55_Symbol.svg"),
    ("marks/raycast.svg", "https://fz1sd71lwhbqy6sh.public.blob.vercel-storage.com/press/images/logo/raycast-logo-dark.svg?download=1"),
    ("marks/raycast-app.png", "https://fz1sd71lwhbqy6sh.public.blob.vercel-storage.com/press/images/logo/raycast-appicon.png?download=1"),
    ("marks/zed-app.png", "https://zed.dev/_next/static/media/stable-app-logo.0lgsg40_u_1r5.png"),
    ("marks/vscode.png", "https://code.visualstudio.com/assets/branding/code-stable.png"),
    ("marks/figma.svg", "https://static.figma.com/app/icon/2/favicon.svg"),
    ("marks/notion.png", "https://www.notion.com/front-static/logo-ios.png"),
    ("marks/ghostty-32.png", "https://ghostty.org/favicon-32.png"),
    ("marks/slack-reference.png", "https://a.slack-edge.com/a533fe3/marketing/img/media-kit/img-logos-alt.png"),
]


def download(item):
    filename, url = item
    target = ROOT / "downloads" / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 BoxHavenDesignResearch"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            content = response.read(30 * 1024 * 1024 + 1)
            if len(content) > 30 * 1024 * 1024:
                raise ValueError("Reference exceeded 30 MB limit")
            if target.suffix == ".pdf" and not content.startswith(b"%PDF"):
                raise ValueError("Expected PDF")
            if target.suffix == ".zip" and not content.startswith(b"PK"):
                raise ValueError("Expected ZIP")
            if target.suffix == ".png" and not content.startswith(b"\x89PNG"):
                raise ValueError("Expected PNG")
            if target.suffix == ".svg" and b"<svg" not in content:
                raise ValueError("Expected SVG")
            target.write_bytes(content)
            return {"file": filename, "source": url, "resolved_url": response.url,
                    "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(),
                    "content_type": response.headers.get("Content-Type"), "status": "downloaded"}
    except Exception as error:
        return {"file": filename, "source": url, "status": "failed", "error": str(error)}


if __name__ == "__main__":
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(download, SOURCES))
    (ROOT / "downloads" / "manifest.json").write_text(json.dumps(results, indent=2) + "\n")
    members = [
        ("github", "GitHub Logos/SVG/GitHub_Invertocat_Black.svg", "github.svg"),
        ("linear", "logo-dark.svg", "linear.svg"),
        ("linear", "linear-app-icon.png", "linear-app.png"),
        ("docker", "docker-logos/SVG/docker-mark-ocean-blue.svg", "docker.svg"),
    ]
    for pack, member, filename in members:
        archive = ROOT / "downloads" / "packs" / f"{pack}.zip"
        if archive.exists():
            with zipfile.ZipFile(archive) as zipped:
                # Extract only named files to fixed paths, never archive paths.
                (ROOT / "downloads" / "marks" / filename).write_bytes(zipped.read(member))
    for result in results:
        print(result["status"], result["file"], result.get("bytes", result.get("error")))
    raise SystemExit(any(result["status"] != "downloaded" for result in results))
