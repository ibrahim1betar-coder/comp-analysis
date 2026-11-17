import json, sys
# Stand-in for scripts/tiktok_fetch.py used by the Node runner tests.
if sys.argv[1] == "boom":
    print(json.dumps({"error": "yt-dlp could not read @boom: 404"})); sys.exit(2)
if sys.argv[1] == "crash":
    print("Traceback (most recent call last): ValueError: bad", file=sys.stderr); sys.exit(1)
print("some log line")
print(json.dumps({"profile": {"followers": 123, "displayName": sys.argv[1]}, "posts": [{"externalId": "1", "publishedAt": "2026-11-10T00:00:00Z", "type": "video", "views": 5, "likes": 1, "comments": 0, "shares": 0, "saves": 0}], "args": sys.argv[1:]}))
