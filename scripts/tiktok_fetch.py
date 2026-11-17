#!/usr/bin/env python3
"""Fetch a public TikTok profile's videos and stats with yt-dlp, printing JSON for the dashboard.

Usage:  python scripts/tiktok_fetch.py <username> [max_videos] [since_iso]
Output: {"profile": {...}, "posts": [...]} on stdout, diagnostics on stderr. Exit code 0 on success.

Requires:  pip install yt-dlp
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def fail(message, code=2):
    print(json.dumps({"error": message}))
    sys.exit(code)


def to_iso(ts):
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OSError):
        return None


def num(v):
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def parse_profile(html, username):
    """Follower / like / video counts from the profile page's embedded JSON (no login, no API)."""
    m = re.search(r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">(.*?)</script>', html, re.S)
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except ValueError:
        return None
    info = data.get("__DEFAULT_SCOPE__", {}).get("webapp.user-detail", {}).get("userInfo", {})
    user, stats = info.get("user", {}), info.get("stats", {}) or info.get("statsV2", {})
    if not user:
        return None
    return {
        "externalId": user.get("id") or username,
        "displayName": user.get("nickname") or username,
        "avatarUrl": user.get("avatarThumb") or user.get("avatarMedium"),
        "profileUrl": f"https://www.tiktok.com/@{user.get('uniqueId') or username}",
        "followers": num(stats.get("followerCount")),
        "following": num(stats.get("followingCount")),
        "postsCount": num(stats.get("videoCount")),
        "totalViews": None,
        "totalLikes": num(stats.get("heartCount") or stats.get("heart")),
        "private": bool(user.get("privateAccount")),
    }


def fetch_profile(username):
    req = urllib.request.Request(f"https://www.tiktok.com/@{username}?lang=en", headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return parse_profile(res.read().decode("utf-8", "replace"), username)
    except Exception as exc:  # profile stats are optional; the videos still count
        print(f"profile page: {exc}", file=sys.stderr)
        return None


def map_entries(entries, username, since=None):
    posts = []
    for e in entries or []:
        vid = e.get("id")
        if not vid:
            continue
        published = to_iso(e.get("timestamp")) or (e.get("upload_date") and f"{e['upload_date'][:4]}-{e['upload_date'][4:6]}-{e['upload_date'][6:8]}T00:00:00Z")
        if not published or (since and published < since):
            continue
        thumbs = e.get("thumbnails") or []
        posts.append({
            "externalId": str(vid),
            "publishedAt": published,
            "type": "video",
            "url": e.get("webpage_url") or e.get("url") or f"https://www.tiktok.com/@{username}/video/{vid}",
            "caption": e.get("title") or e.get("description") or "",
            "thumbnailUrl": e.get("thumbnail") or (thumbs[-1].get("url") if thumbs else None),
            "views": num(e.get("view_count")) or 0,
            "likes": num(e.get("like_count")) or 0,
            "comments": num(e.get("comment_count")) or 0,
            "shares": num(e.get("repost_count")) or 0,
            "saves": 0,
        })
    return posts


def fetch_videos(username, max_videos):
    try:
        import yt_dlp  # noqa: WPS433
    except ImportError:
        fail("yt-dlp is not installed. Run:  pip install yt-dlp")
    opts = {"quiet": True, "no_warnings": True, "extract_flat": True, "playlist_items": f"1:{max_videos}", "skip_download": True, "http_headers": {"User-Agent": UA}}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.tiktok.com/@{username}", download=False)
    except Exception as exc:
        fail(f"yt-dlp could not read @{username}: {str(exc).splitlines()[0][:300]}")
    return info or {}


def main(argv):
    if len(argv) < 2:
        fail("usage: tiktok_fetch.py <username> [max_videos] [since_iso]", 1)
    if argv[1] == "--selftest":
        try:
            import yt_dlp
            print(json.dumps({"ok": True, "ytdlp": getattr(yt_dlp.version, "__version__", "installed")}))
        except ImportError:
            fail("yt-dlp is not installed. Run:  pip install yt-dlp")
        return
    if argv[1] == "--map-stdin":  # test hook: map yt-dlp JSON from stdin
        data = json.load(sys.stdin)
        print(json.dumps({"profile": parse_profile(data.get("html", ""), data.get("username", "x")), "posts": map_entries(data.get("entries"), data.get("username", "x"), data.get("since"))}))
        return
    username = argv[1].strip().lstrip("@").lower()
    max_videos = int(argv[2]) if len(argv) > 2 and argv[2].isdigit() else 100
    since = argv[3] if len(argv) > 3 and argv[3] not in ("", "null") else None
    info = fetch_videos(username, max_videos)
    posts = map_entries(info.get("entries"), username, since)
    profile = fetch_profile(username) or {
        "externalId": username, "displayName": info.get("uploader") or info.get("title") or username, "avatarUrl": None,
        "profileUrl": f"https://www.tiktok.com/@{username}", "followers": num(info.get("channel_follower_count")), "following": None,
        "postsCount": num(info.get("playlist_count")), "totalViews": None, "totalLikes": None,
    }
    print(json.dumps({"profile": profile, "posts": posts, "source": "yt-dlp"}))


if __name__ == "__main__":
    main(sys.argv)
